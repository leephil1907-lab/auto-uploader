# Orbit — Social Publishing Studio

Orbit is a responsive video publishing studio built with React, Vite, Framer Motion, Express and PostgreSQL. It includes account authentication, encrypted social OAuth credentials, media uploads, a durable PostgreSQL publishing queue and per-platform delivery records.

## Run locally

Use Node.js 20.11+ and PostgreSQL 15+.

```bash
cp .env.example .env
npm install
npm run dev
```

For local API use, run `npm start` in a second terminal after building the frontend. The API serves the built frontend and creates the database tables at startup.

## Render deployment

The included `render.yaml` configures a single Node web service, health check and persistent media disk. It does not provision a database automatically. Attach a PostgreSQL database (Render PostgreSQL or Supabase) and configure all required environment variables before deployment.

Required variables:
- `DATABASE_URL`: PostgreSQL connection string.
- `APP_URL`: public HTTPS URL of the deployed service.
- `ALLOWED_ORIGINS`: same public origin.
- `TOKEN_ENCRYPTION_KEY`: stable base64-encoded 32-byte key. Generate with `openssl rand -base64 32`.
- `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`.
- `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`.
- `META_APP_ID`, `META_APP_SECRET`.

Keep the encryption key stable. Losing it makes stored social tokens unreadable. Never place provider secrets or database credentials in frontend code.

Register these exact callback URLs with the relevant developer apps, replacing the hostname with the deployed service:
- `https://YOUR-SERVICE.onrender.com/api/oauth/youtube/callback`
- `https://YOUR-SERVICE.onrender.com/api/oauth/tiktok/callback`
- `https://YOUR-SERVICE.onrender.com/api/oauth/facebook/callback`

## Implemented backend capabilities

- Email/password registration and login with scrypt password hashing and HTTP-only session cookies.
- Tenant-scoped PostgreSQL records for users, sessions, social accounts, media, posts, jobs and activity.
- AES-256-GCM encryption for social access and refresh tokens at rest.
- Video upload to a persistent disk and token-protected public media URLs for platform ingestion.
- Durable scheduled jobs claimed using PostgreSQL `FOR UPDATE SKIP LOCKED`, retry backoff and per-platform outcomes.
- YouTube OAuth and resumable video uploads.
- TikTok Content Posting API Direct Post, creator privacy lookup, chunked upload and publish-status confirmation.
- Meta OAuth for Facebook Pages and linked Instagram professional accounts; Facebook Page video publishing and Instagram Reels publishing.

## Platform prerequisites and limitations

- **YouTube:** enable YouTube Data API v3 and configure the OAuth consent screen with the upload/read scopes.
- **TikTok:** enable the Content Posting API and obtain `video.publish` approval. TikTok documents that unaudited clients are restricted to private visibility.
- **Instagram/Facebook:** use a Meta app with the required Page and Instagram permissions. Instagram Reels publishing requires an eligible professional account linked to a Facebook Page.
- **Not yet implemented:** LinkedIn, X, Pinterest, Bilibili and the additional regional platforms exposed by the upstream CLI project. Platform analytics ingestion is also not implemented; the dashboard intentionally does not fabricate performance figures.

A platform is shown as connected only after a successful OAuth callback. Real publishing still depends on your own provider app approval, credentials and user authorization.

## API overview

- `GET /api/health`
- `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/auth/me`, `POST /api/auth/logout`
- `GET /api/oauth/:platform/start` for `youtube`, `tiktok`, `facebook`
- `GET /api/accounts`, `DELETE /api/accounts/:id`
- `POST /api/media` (multipart field: `video`)
- `POST /api/posts`, `GET /api/posts`, `DELETE /api/posts/:id`
- `GET /api/activity`, `GET /api/config/status`

## Upstream projects

The workflow takes inspiration from [dreammis/social-auto-upload](https://github.com/dreammis/social-auto-upload) and [Automated-video-uploader-for-multiple-social-media-platforms](https://github.com/ADITYATALEKAR/Automated-video-uploader-for-multiple-social-media-platforms). This repository is a separate web application, not a wholesale copy of either project.
