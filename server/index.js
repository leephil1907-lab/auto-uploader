import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import pg from 'pg';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false }, max: 10 });
const PORT = Number(process.env.PORT || 8080);
const MEDIA_DIR = process.env.MEDIA_DIR || '/var/data/media';
const APP_URL = (process.env.APP_URL || '').replace(/\/$/, '');
const TOKEN_KEY = process.env.TOKEN_ENCRYPTION_KEY || '';
const COOKIE_NAME = 'orbit_session';
const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_BYTES || 536870912);
const allowedOrigins = (process.env.ALLOWED_ORIGINS || APP_URL).split(',').map(x => x.trim()).filter(Boolean);

const schema = `
CREATE TABLE IF NOT EXISTS users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL UNIQUE, password_hash text NOT NULL,
 display_name text NOT NULL DEFAULT 'Creator', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 token_hash text NOT NULL UNIQUE, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS oauth_states (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 platform text NOT NULL, state_hash text NOT NULL UNIQUE, expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS social_accounts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 platform text NOT NULL, provider_user_id text NOT NULL, display_name text, username text,
 access_token_enc text NOT NULL, refresh_token_enc text, token_expires_at timestamptz,
 metadata jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id, platform, provider_user_id)
);
CREATE TABLE IF NOT EXISTS media_assets (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 filename text NOT NULL, mime_type text NOT NULL, size_bytes bigint NOT NULL,
 storage_path text NOT NULL, public_token_hash text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS posts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 media_id uuid REFERENCES media_assets(id) ON DELETE SET NULL, caption text NOT NULL DEFAULT '',
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','scheduled','publishing','published','partial','failed')),
 scheduled_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS public_token_enc text;
CREATE TABLE IF NOT EXISTS publish_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 post_id uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE, account_id uuid NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','published','failed')),
 run_at timestamptz NOT NULL DEFAULT now(), attempts integer NOT NULL DEFAULT 0, max_attempts integer NOT NULL DEFAULT 4,
 remote_id text, last_error text, locked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(post_id, account_id)
);
CREATE INDEX IF NOT EXISTS publish_jobs_due_idx ON publish_jobs(status, run_at);
CREATE TABLE IF NOT EXISTS activity_events (
 id bigserial PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 post_id uuid REFERENCES posts(id) ON DELETE SET NULL, kind text NOT NULL, detail jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_at timestamptz NOT NULL DEFAULT now()
);
`;

function randomToken(bytes=32){return crypto.randomBytes(bytes).toString('base64url')}
function hash(value){return crypto.createHash('sha256').update(value).digest('hex')}
function encrypt(value){
 if(!TOKEN_KEY) throw new Error('TOKEN_ENCRYPTION_KEY is not configured');
 const key=Buffer.from(TOKEN_KEY,'base64');
 if(key.length!==32) throw new Error('TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
 const iv=crypto.randomBytes(12), cipher=crypto.createCipheriv('aes-256-gcm',key,iv);
 const data=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
 return [iv.toString('base64'),cipher.getAuthTag().toString('base64'),data.toString('base64')].join('.');
}
function decrypt(value){
 const [iv,tag,data]=value.split('.');
 const decipher=crypto.createDecipheriv('aes-256-gcm',Buffer.from(TOKEN_KEY,'base64'),Buffer.from(iv,'base64'));
 decipher.setAuthTag(Buffer.from(tag,'base64'));
 return Buffer.concat([decipher.update(Buffer.from(data,'base64')),decipher.final()]).toString('utf8');
}
function passwordHash(password,salt=randomToken(16)){
 const key=crypto.scryptSync(password,salt,64);
 return `scrypt:${salt}:${key.toString('base64')}`;
}
function passwordMatches(password,stored){
 const [scheme,salt,encoded]=stored.split(':');
 if(scheme!=='scrypt'||!salt||!encoded)return false;
 const actual=crypto.scryptSync(password,salt,64), expected=Buffer.from(encoded,'base64');
 return actual.length===expected.length&&crypto.timingSafeEqual(actual,expected);
}
function cookie(res,value,maxAge=60*60*24*30){
 res.cookie(COOKIE_NAME,value,{httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'lax',path:'/',maxAge});
}
function clearCookie(res){res.clearCookie(COOKIE_NAME,{httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'lax',path:'/'})}
async function auth(req,res,next){
 try{
  const token=req.cookies?.[COOKIE_NAME];
  if(!token)return res.status(401).json({error:'Sign in to continue'});
  const result=await pool.query('SELECT s.id AS session_id,u.id,u.email,u.display_name FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()',[hash(token)]);
  if(!result.rowCount){clearCookie(res);return res.status(401).json({error:'Session expired'});}
  req.user=result.rows[0];next();
 }catch(e){next(e)}
}
app.use(helmet({crossOriginResourcePolicy:{policy:'cross-origin'},contentSecurityPolicy:false}));
app.use(cors({origin:(origin,cb)=>{if(!origin||allowedOrigins.includes(origin)||!allowedOrigins.length)return cb(null,true);return cb(new Error('Origin not allowed'));},credentials:true}));
app.use(express.json({limit:'2mb'}));
app.use((req,res,next)=>{const c=req.headers.cookie||'';const m=c.match(new RegExp('(?:^|; )'+COOKIE_NAME+'=([^;]*)'));req.cookies=req.cookies||{};if(m)req.cookies[COOKIE_NAME]=decodeURIComponent(m[1]);next()});
app.use('/api/auth',rateLimit({windowMs:15*60*1000,limit:25,standardHeaders:true,legacyHeaders:false}));
const upload=multer({storage:multer.diskStorage({destination:async(req,file,cb)=>{try{await fs.mkdir(MEDIA_DIR,{recursive:true});cb(null,MEDIA_DIR)}catch(e){cb(e)}},filename:(req,file,cb)=>cb(null,crypto.randomUUID()+path.extname(file.originalname).toLowerCase())}),limits:{fileSize:MAX_UPLOAD,files:1},fileFilter:(req,file,cb)=>cb(null,['video/mp4','video/quicktime','video/webm'].includes(file.mimetype))});

async function event(userId,kind,detail={},postId=null){await pool.query('INSERT INTO activity_events(user_id,kind,detail,post_id) VALUES($1,$2,$3,$4)',[userId,kind,detail,postId])}
function publicMediaUrl(mediaId,token){if(!APP_URL)throw new Error('APP_URL must be configured before publishing media');return `${APP_URL}/public/media/${mediaId}?token=${encodeURIComponent(token)}`}

app.get('/api/health',async(req,res)=>{try{await pool.query('SELECT 1');res.json({ok:true,database:'connected',time:new Date().toISOString()})}catch(e){res.status(503).json({ok:false,database:'unavailable'})}});
app.post('/api/auth/register',async(req,res,next)=>{try{
 const email=String(req.body.email||'').trim().toLowerCase(),password=String(req.body.password||''),displayName=String(req.body.displayName||'Creator').trim().slice(0,80);
 if(!/^\S+@\S+\.\S+$/.test(email)||password.length<10)return res.status(400).json({error:'Use a valid email and a password of at least 10 characters.'});
 const user=(await pool.query('INSERT INTO users(email,password_hash,display_name) VALUES($1,$2,$3) RETURNING id,email,display_name',[email,passwordHash(password),displayName||'Creator'])).rows[0];
 const token=randomToken();await pool.query('INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval \'30 days\')',[user.id,hash(token)]);cookie(res,token);res.status(201).json({user});
 }catch(e){if(e.code==='23505')return res.status(409).json({error:'An account with this email already exists.'});next(e)}});
app.post('/api/auth/login',async(req,res,next)=>{try{
 const email=String(req.body.email||'').trim().toLowerCase(),password=String(req.body.password||'');
 const r=await pool.query('SELECT id,email,display_name,password_hash FROM users WHERE email=$1',[email]);
 if(!r.rowCount||!passwordMatches(password,r.rows[0].password_hash))return res.status(401).json({error:'Email or password is incorrect.'});
 const u=r.rows[0],token=randomToken();await pool.query('INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval \'30 days\')',[u.id,hash(token)]);cookie(res,token);delete u.password_hash;res.json({user:u});
 }catch(e){next(e)}});
app.get('/api/auth/me',auth,(req,res)=>res.json({user:{id:req.user.id,email:req.user.email,displayName:req.user.display_name}}));
app.post('/api/auth/logout',auth,async(req,res,next)=>{try{await pool.query('DELETE FROM sessions WHERE id=$1',[req.user.session_id]);clearCookie(res);res.json({ok:true})}catch(e){next(e)}});

const oauthConfig={
 youtube:{client:()=>[process.env.YOUTUBE_CLIENT_ID,process.env.YOUTUBE_CLIENT_SECRET],authorize:'https://accounts.google.com/o/oauth2/v2/auth',token:'https://oauth2.googleapis.com/token',scope:'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly',redirect:'/api/oauth/youtube/callback'},
 tiktok:{client:()=>[process.env.TIKTOK_CLIENT_KEY,process.env.TIKTOK_CLIENT_SECRET],authorize:'https://www.tiktok.com/v2/auth/authorize/',token:'https://open.tiktokapis.com/v2/oauth/token/',scope:'user.info.basic,video.publish',redirect:'/api/oauth/tiktok/callback'},
 facebook:{client:()=>[process.env.META_APP_ID,process.env.META_APP_SECRET],authorize:'https://www.facebook.com/v22.0/dialog/oauth',token:'https://graph.facebook.com/v22.0/oauth/access_token',scope:'pages_show_list,pages_read_engagement,pages_manage_posts,instagram_basic,instagram_content_publish',redirect:'/api/oauth/facebook/callback'}
};
function callbackUrl(platform){return APP_URL+oauthConfig[platform].redirect}
app.get('/api/oauth/:platform/start',auth,async(req,res,next)=>{try{
 const p=req.params.platform,c=oauthConfig[p];if(!c)return res.status(404).json({error:'Platform not supported'});
 const [clientId,secret]=c.client();if(!clientId||!secret)return res.status(503).json({error:`${p} OAuth credentials are not configured on the server`});
 const state=randomToken(24);await pool.query('INSERT INTO oauth_states(user_id,platform,state_hash,expires_at) VALUES($1,$2,$3,now()+interval \'10 minutes\')',[req.user.id,p,hash(state)]);
 const u=new URL(c.authorize);
 if(p==='youtube'){u.searchParams.set('client_id',clientId);u.searchParams.set('redirect_uri',callbackUrl(p));u.searchParams.set('response_type','code');u.searchParams.set('scope',c.scope);u.searchParams.set('access_type','offline');u.searchParams.set('prompt','consent');u.searchParams.set('state',state);}
 if(p==='tiktok'){u.searchParams.set('client_key',clientId);u.searchParams.set('redirect_uri',callbackUrl(p));u.searchParams.set('response_type','code');u.searchParams.set('scope',c.scope);u.searchParams.set('state',state);}
 if(p==='facebook'){u.searchParams.set('client_id',clientId);u.searchParams.set('redirect_uri',callbackUrl(p));u.searchParams.set('response_type','code');u.searchParams.set('scope',c.scope);u.searchParams.set('state',state);}
 res.redirect(u.toString());
 }catch(e){next(e)}});
async function exchangeCode(platform,code){
 const c=oauthConfig[platform],[clientId,secret]=c.client();
 if(platform==='youtube'){
  const r=await fetch(c.token,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({code,client_id:clientId,client_secret:secret,redirect_uri:callbackUrl(platform),grant_type:'authorization_code'})});
  const d=await r.json();if(!r.ok)throw new Error(d.error_description||d.error||'Google token exchange failed');
  const ch=await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',{headers:{authorization:`Bearer ${d.access_token}`}}).then(x=>x.json());
  const channel=ch.items?.[0];if(!channel)throw new Error('No YouTube channel was returned for this Google account');
  return [{platform:'youtube',id:channel.id,name:channel.snippet?.title||'YouTube channel',username:channel.snippet?.customUrl||channel.id,access:d.access_token,refresh:d.refresh_token,expires:d.expires_in,metadata:{channelId:channel.id}}];
 }
 if(platform==='tiktok'){
  const r=await fetch(c.token,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_key:clientId,client_secret:secret,code,grant_type:'authorization_code',redirect_uri:callbackUrl(platform)})});
  const d=await r.json();if(!r.ok||d.error)throw new Error(d.error_description||d.message||'TikTok token exchange failed');
  const info=await fetch('https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,avatar_url',{headers:{authorization:`Bearer ${d.access_token}`}}).then(x=>x.json());
  const user=info.data?.user;if(!user)throw new Error('TikTok did not return a user profile');
  return [{platform:'tiktok',id:d.open_id||user.open_id,name:user.display_name||'TikTok account',username:user.display_name,access:d.access_token,refresh:d.refresh_token,expires:d.expires_in,metadata:{openId:d.open_id||user.open_id,avatarUrl:user.avatar_url}}];
 }
 const tokenUrl=new URL(c.token);tokenUrl.search=new URLSearchParams({client_id:clientId,client_secret:secret,redirect_uri:callbackUrl(platform),code}).toString();
 const t=await fetch(tokenUrl).then(x=>x.json());if(t.error)throw new Error(t.error.message||'Meta token exchange failed');
 const me=await fetch(`https://graph.facebook.com/v22.0/me/accounts?fields=id,name,access_token,instagram_business_account{id,username}&access_token=${encodeURIComponent(t.access_token)}`).then(x=>x.json());
 if(me.error)throw new Error(me.error.message);
 const accounts=[];
 for(const page of me.data||[]){
  if(page.instagram_business_account)accounts.push({platform:'instagram',id:page.instagram_business_account.id,name:page.instagram_business_account.username||'Instagram account',username:page.instagram_business_account.username,access:page.access_token,refresh:null,expires: t.expires_in,metadata:{pageId:page.id,pageName:page.name,instagramUserId:page.instagram_business_account.id}});
  accounts.push({platform:'facebook',id:page.id,name:page.name,username:page.name,access:page.access_token,refresh:null,expires:t.expires_in,metadata:{pageId:page.id}});
 }
 if(!accounts.length)throw new Error('No Facebook Pages or linked Instagram professional accounts were found. Link an Instagram professional account to a Facebook Page first.');
 return accounts;
}
app.get('/api/oauth/:platform/callback',async(req,res,next)=>{try{
 const p=req.params.platform,state=String(req.query.state||''),code=String(req.query.code||'');
 const st=await pool.query('DELETE FROM oauth_states WHERE state_hash=$1 AND platform=$2 AND expires_at>now() RETURNING user_id',[hash(state),p]);
 if(!st.rowCount)return res.redirect('/?oauth=invalid_state');
 if(req.query.error)return res.redirect('/?oauth=denied');
 if(!code)return res.redirect('/?oauth=missing_code');
 const accounts=await exchangeCode(p,code),userId=st.rows[0].user_id;
 for(const a of accounts)await pool.query(`INSERT INTO social_accounts(user_id,platform,provider_user_id,display_name,username,access_token_enc,refresh_token_enc,token_expires_at,metadata)
 VALUES($1,$2,$3,$4,$5,$6,$7,CASE WHEN $8::int IS NULL THEN NULL ELSE now()+($8::text||' seconds')::interval END,$9)
 ON CONFLICT(user_id,platform,provider_user_id) DO UPDATE SET display_name=EXCLUDED.display_name,username=EXCLUDED.username,access_token_enc=EXCLUDED.access_token_enc,refresh_token_enc=COALESCE(EXCLUDED.refresh_token_enc,social_accounts.refresh_token_enc),token_expires_at=EXCLUDED.token_expires_at,metadata=EXCLUDED.metadata,updated_at=now()`,
 [userId,a.platform,a.id,a.name,a.username,encrypt(a.access),a.refresh?encrypt(a.refresh):null,a.expires||null,a.metadata]);
 await event(userId,'account_connected',{platform:p,accounts:accounts.map(a=>a.platform)});
 res.redirect('/?connected='+encodeURIComponent(p));
 }catch(e){next(e)}});
app.get('/api/accounts',auth,async(req,res,next)=>{try{const r=await pool.query('SELECT id,platform,provider_user_id,display_name,username,token_expires_at,created_at FROM social_accounts WHERE user_id=$1 ORDER BY platform,created_at',[req.user.id]);res.json({accounts:r.rows})}catch(e){next(e)}});
app.delete('/api/accounts/:id',auth,async(req,res,next)=>{try{const r=await pool.query('DELETE FROM social_accounts WHERE id=$1 AND user_id=$2 RETURNING id,platform',[req.params.id,req.user.id]);if(!r.rowCount)return res.status(404).json({error:'Account not found'});await event(req.user.id,'account_disconnected',r.rows[0]);res.json({ok:true})}catch(e){next(e)}});

app.post('/api/media',auth,(req,res,next)=>upload.single('video')(req,res,async(err)=>{try{
 if(err){if(err.code==='LIMIT_FILE_SIZE')return res.status(413).json({error:'Video exceeds the configured upload size'});return res.status(400).json({error:err.message||'Video upload failed'});}
 if(!req.file)return res.status(400).json({error:'Choose an MP4, MOV or WebM video'});
 const token=randomToken(24),r=await pool.query('INSERT INTO media_assets(user_id,filename,mime_type,size_bytes,storage_path,public_token_hash,public_token_enc) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,filename,mime_type,size_bytes,created_at',[req.user.id,req.file.originalname,req.file.mimetype,req.file.size,req.file.path,hash(token),encrypt(token)]);
 res.status(201).json({media:{...r.rows[0],publicUrl:publicMediaUrl(r.rows[0].id,token)}})
 }catch(e){next(e)}}));
app.get('/public/media/:id',async(req,res,next)=>{try{
 const r=await pool.query('SELECT storage_path,mime_type,size_bytes,public_token_hash FROM media_assets WHERE id=$1',[req.params.id]);
 if(!r.rowCount||!crypto.timingSafeEqual(Buffer.from(r.rows[0].public_token_hash),Buffer.from(hash(String(req.query.token||'')))))return res.sendStatus(404);
 res.setHeader('Content-Type',r.rows[0].mime_type);res.setHeader('Content-Length',r.rows[0].size_bytes);res.setHeader('Cache-Control','private, max-age=300');res.sendFile(path.resolve(r.rows[0].storage_path));
 }catch(e){next(e)}});
app.post('/api/posts',auth,async(req,res,next)=>{const client=await pool.connect();try{
 const caption=String(req.body.caption||'').slice(0,2200),mediaId=req.body.mediaId||null,platforms=Array.isArray(req.body.platforms)?[...new Set(req.body.platforms.map(String))]:[],scheduledAt=req.body.scheduledAt?new Date(req.body.scheduledAt):null;
 if(!caption.trim()&&!mediaId)return res.status(400).json({error:'Add a caption or video before saving'});
 if(platforms.length&& !mediaId)return res.status(400).json({error:'Video media is required for social video publishing'});
 if(scheduledAt&&Number.isNaN(scheduledAt.getTime()))return res.status(400).json({error:'Invalid schedule date'});
 await client.query('BEGIN');
 if(mediaId){const m=await client.query('SELECT id FROM media_assets WHERE id=$1 AND user_id=$2',[mediaId,req.user.id]);if(!m.rowCount)throw new Error('Media not found for this account');}
 const post=(await client.query('INSERT INTO posts(user_id,media_id,caption,status,scheduled_at) VALUES($1,$2,$3,$4,$5) RETURNING *',[req.user.id,mediaId,caption,platforms.length?(scheduledAt?'scheduled':'publishing'):'draft',scheduledAt])).rows[0];
 for(const platform of platforms){
  const account=await client.query('SELECT id FROM social_accounts WHERE user_id=$1 AND platform=$2',[req.user.id,platform]);
  if(!account.rowCount)throw new Error(`Connect a ${platform} account before publishing`);
  await client.query('INSERT INTO publish_jobs(user_id,post_id,account_id,run_at) VALUES($1,$2,$3,$4)',[req.user.id,post.id,account.rows[0].id,scheduledAt||new Date()]);
 }
 await client.query('COMMIT');await event(req.user.id,platforms.length?'publish_queued':'draft_created',{platforms,scheduledAt},post.id);
 res.status(201).json({post});
 }catch(e){await client.query('ROLLBACK');if(e.code==='23503')return res.status(400).json({error:'Selected media or account is no longer available'});next(e)}finally{client.release()}});
app.get('/api/posts',auth,async(req,res,next)=>{try{
 const r=await pool.query(`SELECT p.id,p.caption,p.status,p.scheduled_at,p.created_at,m.id AS media_id,m.filename,
 COALESCE(json_agg(json_build_object('platform',a.platform,'accountName',a.display_name,'status',j.status,'remoteId',j.remote_id,'error',j.last_error)) FILTER(WHERE j.id IS NOT NULL),'[]') AS targets
 FROM posts p LEFT JOIN media_assets m ON m.id=p.media_id LEFT JOIN publish_jobs j ON j.post_id=p.id LEFT JOIN social_accounts a ON a.id=j.account_id
 WHERE p.user_id=$1 GROUP BY p.id,m.id ORDER BY p.created_at DESC LIMIT 100`,[req.user.id]);res.json({posts:r.rows})
 }catch(e){next(e)}});
app.get('/api/activity',auth,async(req,res,next)=>{try{const r=await pool.query('SELECT id,kind,detail,created_at FROM activity_events WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50',[req.user.id]);res.json({events:r.rows})}catch(e){next(e)}});
app.get('/api/config/status',auth,(req,res)=>res.json({platforms:Object.fromEntries(Object.entries(oauthConfig).map(([k,v])=>[k,!!v.client()[0]&&!!v.client()[1]])),uploadLimitBytes:MAX_UPLOAD,queue:'postgresql'}));

async function getAccessToken(account){
 if(account.token_expires_at&&new Date(account.token_expires_at).getTime()>Date.now()+60000)return decrypt(account.access_token_enc);
 if(account.platform==='youtube'&&account.refresh_token_enc){
  const r=await fetch(oauthConfig.youtube.token,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:process.env.YOUTUBE_CLIENT_ID,client_secret:process.env.YOUTUBE_CLIENT_SECRET,refresh_token:decrypt(account.refresh_token_enc),grant_type:'refresh_token'})});
  const d=await r.json();if(!r.ok)throw new Error(d.error_description||'YouTube token refresh failed');
  await pool.query('UPDATE social_accounts SET access_token_enc=$1,token_expires_at=now()+($2::text||\' seconds\')::interval,updated_at=now() WHERE id=$3',[encrypt(d.access_token),d.expires_in,account.id]);return d.access_token;
 }
 if(account.platform==='tiktok'&&account.refresh_token_enc){
  const r=await fetch(oauthConfig.tiktok.token,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_key:process.env.TIKTOK_CLIENT_KEY,client_secret:process.env.TIKTOK_CLIENT_SECRET,grant_type:'refresh_token',refresh_token:decrypt(account.refresh_token_enc)})});
  const d=await r.json();if(!r.ok||d.error)throw new Error(d.error_description||'TikTok token refresh failed');
  await pool.query('UPDATE social_accounts SET access_token_enc=$1,refresh_token_enc=$2,token_expires_at=now()+($3::text||\' seconds\')::interval,updated_at=now() WHERE id=$4',[encrypt(d.access_token),encrypt(d.refresh_token),d.expires_in,account.id]);return d.access_token;
 }
 if(account.token_expires_at&&new Date(account.token_expires_at).getTime()<Date.now())throw new Error('This social connection has expired. Reconnect the account.');
 return decrypt(account.access_token_enc);
}
async function publishYoutube(job,post,media,account,token){
 const file=await fs.readFile(media.storage_path),init=await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json; charset=UTF-8','x-upload-content-length':String(file.length),'x-upload-content-type':media.mime_type},body:JSON.stringify({snippet:{title:(post.caption||media.filename).slice(0,100),description:post.caption,categoryId:'22'},status:{privacyStatus:'private'}})});
 if(!init.ok)throw new Error('YouTube upload initialization failed: '+(await init.text()).slice(0,400));
 const location=init.headers.get('location');if(!location)throw new Error('YouTube did not return a resumable upload URL');
 const done=await fetch(location,{method:'PUT',headers:{'content-length':String(file.length),'content-type':media.mime_type},body:file});
 const data=await done.json();if(!done.ok)throw new Error(data.error?.message||'YouTube video upload failed');return data.id;
}
async function publishTikTok(job,post,media,account,token){
 const info=await fetch('https://open.tiktokapis.com/v2/post/publish/creator_info/query/',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'}});
 const creator=await info.json();if(!info.ok||creator.error?.code!=='ok')throw new Error(creator.error?.message||'Could not retrieve TikTok creator settings');
 const privacy=creator.data?.privacy_level_options?.includes('SELF_ONLY')?'SELF_ONLY':creator.data?.privacy_level_options?.[0];if(!privacy)throw new Error('TikTok returned no available privacy setting');
 const size=Number(media.size_bytes),chunk=10*1024*1024,count=Math.ceil(size/chunk);
 const init=await fetch('https://open.tiktokapis.com/v2/post/publish/video/init/',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({post_info:{title:post.caption.slice(0,2200),privacy_level:privacy},source_info:{source:'FILE_UPLOAD',video_size:size,chunk_size:Math.min(chunk,size),total_chunk_count:count}})});
 const started=await init.json();if(!init.ok||started.error?.code!=='ok')throw new Error(started.error?.message||'TikTok publish initialization failed');
 const handle=await fs.open(media.storage_path,'r');try{for(let i=0;i<count;i++){const length=Math.min(chunk,size-i*chunk),buffer=Buffer.alloc(length);await handle.read(buffer,0,length,i*chunk);const end=i*chunk+length-1;const put=await fetch(started.data.upload_url,{method:'PUT',headers:{'content-type':media.mime_type,'content-length':String(length),'content-range':`bytes ${i*chunk}-${end}/${size}`},body:buffer});if(!put.ok)throw new Error('TikTok video transfer failed at chunk '+(i+1));}}finally{await handle.close()}
 return started.data.publish_id;
}
async function publishInstagram(job,post,media,account,token){
 const igId=account.metadata.instagramUserId||account.provider_user_id,url=publicMediaUrl(media.id,media.public_token);
 const params=new URLSearchParams({media_type:'REELS',video_url:url,caption:post.caption,share_to_feed:'true',access_token:token});
 const created=await fetch(`https://graph.facebook.com/v22.0/${igId}/media`,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:params}).then(x=>x.json());
 if(created.error)throw new Error(created.error.message||'Instagram media container creation failed');
 let state='IN_PROGRESS';for(let i=0;i<30&&state==='IN_PROGRESS';i++){await sleep(5000);const status=await fetch(`https://graph.facebook.com/v22.0/${created.id}?fields=status_code&access_token=${encodeURIComponent(token)}`).then(x=>x.json());if(status.error)throw new Error(status.error.message);state=status.status_code;if(state==='ERROR')throw new Error('Instagram could not process this Reel');}
 if(state!=='FINISHED')throw new Error('Instagram video is still processing; retry the publication later');
 const published=await fetch(`https://graph.facebook.com/v22.0/${igId}/media_publish`,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({creation_id:created.id,access_token:token})}).then(x=>x.json());
 if(published.error)throw new Error(published.error.message);return published.id;
}
async function publishFacebook(job,post,media,account,token){
 const url=publicMediaUrl(media.id,media.public_token),pageId=account.metadata.pageId||account.provider_user_id;
 const result=await fetch(`https://graph.facebook.com/v22.0/${pageId}/videos`,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({file_url:url,description:post.caption,access_token:token})}).then(x=>x.json());
 if(result.error)throw new Error(result.error.message);return result.id;
}
async function executeJob(job){
 const data=await pool.query(`SELECT j.*,p.caption,p.media_id,a.platform,a.provider_user_id,a.access_token_enc,a.refresh_token_enc,a.token_expires_at,a.metadata,m.storage_path,m.mime_type,m.size_bytes,m.filename,m.public_token_hash
 FROM publish_jobs j JOIN posts p ON p.id=j.post_id JOIN social_accounts a ON a.id=j.account_id LEFT JOIN media_assets m ON m.id=p.media_id
 WHERE j.id=$1`,[job.id]);
 if(!data.rowCount)throw new Error('Publish job data is missing');
 const row=data.rows[0];if(!row.storage_path)throw new Error('The post has no uploaded video');
 const account={...row,id:row.account_id},token=await getAccessToken(account);
 if(row.platform==='youtube')return publishYoutube(row,row,{...row,storage_path:row.storage_path,mime_type:row.mime_type},account,token);
 if(row.platform==='tiktok')return publishTikTok(row,row,row,account,token);
 if(row.platform==='instagram')return publishInstagram(row,row,{...row,id:row.media_id,public_token:await getMediaPublicToken(row.media_id)},account,token);
 if(row.platform==='facebook')return publishFacebook(row,row,{...row,id:row.media_id,public_token:await getMediaPublicToken(row.media_id)},account,token);
 throw new Error('No publisher is available for '+row.platform);
}
async function getMediaPublicToken(id){const r=await pool.query('SELECT public_token_enc FROM media_assets WHERE id=$1',[id]);if(!r.rowCount||!r.rows[0].public_token_enc)throw new Error('Media access URL is unavailable');return decrypt(r.rows[0].public_token_enc)}

async function refreshPostStatus(postId){
 const r=await pool.query("SELECT count(*)::int AS total,count(*) FILTER(WHERE status='published')::int AS published,count(*) FILTER(WHERE status='failed')::int AS failed,count(*) FILTER(WHERE status IN ('queued','processing'))::int AS pending FROM publish_jobs WHERE post_id=$1",[postId]);
 const x=r.rows[0];let status='publishing';if(x.pending===0){status=x.published===x.total?'published':x.published>0?'partial':'failed';}
 await pool.query('UPDATE posts SET status=$1,updated_at=now() WHERE id=$2',[status,postId]);
}
async function workerLoop(){
 while(true){
  let job=null;
  try{
   const claim=await pool.query(`WITH picked AS (
    SELECT id FROM publish_jobs WHERE status='queued' AND run_at<=now()
    ORDER BY run_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1
   ) UPDATE publish_jobs j SET status='processing',attempts=attempts+1,locked_at=now()
   FROM picked WHERE j.id=picked.id RETURNING j.id,j.post_id,j.user_id,j.attempts,j.max_attempts`);
   if(!claim.rowCount){await sleep(1800);continue;}
   job=claim.rows[0];
   try{
    const remoteId=await executeJob(job);
    await pool.query("UPDATE publish_jobs SET status='published',remote_id=$1,last_error=NULL,locked_at=NULL WHERE id=$2",[String(remoteId||''),job.id]);
    await event(job.user_id,'post_published',{jobId:job.id,remoteId},job.post_id);
    await refreshPostStatus(job.post_id);
   }catch(error){
    const message=String(error?.message||error).slice(0,1800);
    if(job.attempts<job.max_attempts){
     const delay=Math.min(60*60,30*Math.pow(2,job.attempts-1));
     await pool.query("UPDATE publish_jobs SET status='queued',run_at=now()+($1::text||' seconds')::interval,last_error=$2,locked_at=NULL WHERE id=$3",[delay,message,job.id]);
    }else{
     await pool.query("UPDATE publish_jobs SET status='failed',last_error=$1,locked_at=NULL WHERE id=$2",[message,job.id]);
     await event(job.user_id,'post_failed',{jobId:job.id,error:message},job.post_id);
     await refreshPostStatus(job.post_id);
    }
   }
  }catch(error){console.error('Publisher worker error:',error);await sleep(2500);}
 }
}
app.use(express.static(path.join(__dirname,'..','dist'),{index:false,fallthrough:true}));
app.get('*',(req,res,next)=>{if(req.path.startsWith('/api/')||req.path.startsWith('/public/'))return next();res.sendFile(path.join(__dirname,'..','dist','index.html'),err=>{if(err)next(err)})});
app.use((err,req,res,next)=>{console.error(err);if(res.headersSent)return next(err);res.status(500).json({error:process.env.NODE_ENV==='production'?'Something went wrong. Check server logs for details.':String(err.message||err)})});

async function start(){
 await fs.mkdir(MEDIA_DIR,{recursive:true});
 await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
 await pool.query(schema);
 const server=app.listen(PORT,'0.0.0.0',()=>console.log(`Orbit API listening on ${PORT}`));
 workerLoop().catch(e=>console.error('Worker stopped unexpectedly:',e));
 const shutdown=()=>{server.close(()=>pool.end().finally(()=>process.exit(0)));setTimeout(()=>process.exit(1),10000).unref()};
 process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
}
start().catch(error=>{console.error('Startup failed:',error);process.exit(1)});
