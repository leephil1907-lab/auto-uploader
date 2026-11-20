import React, { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, Film, ImagePlus, Play, Scissors, Sparkles, Type, Upload, Volume2, WandSparkles } from 'lucide-react';
import './creative-studio.css';

const fmt = (n) => { const s=Math.max(0,Math.floor(n||0)); return Math.floor(s/60)+':'+String(s%60).padStart(2,'0'); };
const supportedMime = () => ['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm'].find(x=>window.MediaRecorder?.isTypeSupported(x)) || '';

export default function CreativeStudio({ onPublish }) {
 const [file,setFile]=useState(null),[url,setUrl]=useState(''),[duration,setDuration]=useState(0),[start,setStart]=useState(0),[end,setEnd]=useState(0),[title,setTitle]=useState(''),[fit,setFit]=useState('cover'),[muted,setMuted]=useState(false),[busy,setBusy]=useState(false),[progress,setProgress]=useState(0),[error,setError]=useState(''),[ready,setReady]=useState(false);
 const video=useRef(null),canvas=useRef(null),input=useRef(null),raf=useRef(0),recorder=useRef(null),chunks=useRef([]);
 useEffect(()=>{if(!file){setUrl('');return}const u=URL.createObjectURL(file);setUrl(u);return()=>URL.revokeObjectURL(u)},[file]);
 useEffect(()=>()=>{cancelAnimationFrame(raf.current);if(recorder.current?.state==='recording')recorder.current.stop()},[]);
 const loadFile=f=>{if(!f)return;if(!f.type.startsWith('video/')){setError('Choose a video file.');return}setError('');setFile(f);setReady(false);setStart(0);setEnd(0);setTitle('');};
 const onMeta=()=>{const d=video.current?.duration||0;setDuration(d);setEnd(d);setReady(true)};
 const draw=()=>{const v=video.current,c=canvas.current;if(!v||!c||!v.videoWidth)return;const ctx=c.getContext('2d');const w=c.width,h=c.height;ctx.fillStyle='#090b10';ctx.fillRect(0,0,w,h);const scale=fit==='cover'?Math.max(w/v.videoWidth,h/v.videoHeight):Math.min(w/v.videoWidth,h/v.videoHeight);const dw=v.videoWidth*scale,dh=v.videoHeight*scale;ctx.drawImage(v,(w-dw)/2,(h-dh)/2,dw,dh);if(title){ctx.textAlign='center';ctx.textBaseline='bottom';ctx.font='700 54px Arial';ctx.lineWidth=8;ctx.strokeStyle='rgba(0,0,0,.72)';ctx.fillStyle='#fff';ctx.strokeText(title,w/2,h-90,w-120);ctx.fillText(title,w/2,h-90,w-120)}};
 useEffect(()=>{draw()},[title,fit,file]);
 const preview=()=>{const v=video.current;if(!v)return;v.currentTime=start;v.muted=muted;v.play().catch(()=>{});};
 const exportVideo=async()=>{
  const v=video.current,c=canvas.current;if(!v||!c||!ready)return;
  if(!window.MediaRecorder||!c.captureStream){setError('Video export is not supported by this browser. Open Orbit in a current desktop browser to export.');return}
  if(end<=start){setError('The end point must be after the start point.');return}
  setBusy(true);setProgress(0);setError('');chunks.current=[];
  try{
   const stream=c.captureStream(30);let sourceStream=null;
   if(v.captureStream){sourceStream=v.captureStream();sourceStream.getAudioTracks().forEach(t=>stream.addTrack(t))}
   const mime=supportedMime();const rec=new MediaRecorder(stream,mime?{mimeType:mime}:undefined);recorder.current=rec;
   rec.ondataavailable=e=>{if(e.data?.size)chunks.current.push(e.data)};
   const finished=new Promise((resolve,reject)=>{rec.onstop=resolve;rec.onerror=()=>reject(new Error('The browser encoder stopped unexpectedly'))});
   rec.start(250);v.muted=muted;await new Promise(resolve=>{if(Math.abs(v.currentTime-start)<0.04){resolve();return}const fn=()=>resolve();v.addEventListener('seeked',fn,{once:true});v.currentTime=start});await v.play();
   const render=()=>{draw();setProgress(Math.min(100,Math.round(((v.currentTime-start)/(end-start))*100)));if(v.currentTime>=end||v.ended){v.pause();if(rec.state==='recording')rec.stop();return}raf.current=requestAnimationFrame(render)};
   render();await finished;stream.getTracks().forEach(t=>t.stop());sourceStream?.getTracks().forEach(t=>t.stop());
   const blob=new Blob(chunks.current,{type:mime.split(';')[0]||'video/webm'});if(!blob.size)throw new Error('Export produced an empty video');
   const out=new File([blob],(file.name.replace(/\.[^.]+$/,'')||'orbit-edit')+'-orbit.webm',{type:blob.type});
   const link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download=out.name;link.click();URL.revokeObjectURL(link.href);
   setProgress(100);setFile(out);setUrl('');setReady(true);setDuration(end-start);setStart(0);setEnd(end-start);
   if(onPublish)onPublish(out);
  }catch(e){setError(e.message||'Export failed.');}finally{setBusy(false);if(video.current)video.current.pause()}
 };
 return <section className="creative-studio">
  <header className="creative-head"><div><span className="creative-kicker"><Sparkles size={13}/> ORBIT CREATIVE</span><h1>Creative Studio</h1><p>Shape your video, refine the framing and prepare a publish-ready cut.</p></div><div className="creative-actions"><button className="creative-secondary" onClick={()=>input.current?.click()}><Upload size={15}/> Import video</button><button className="creative-primary" disabled={!ready||busy} onClick={exportVideo}><ArrowDownToLine size={15}/>{busy?'Rendering '+progress+'%':'Render & export'}</button><input ref={input} hidden type="file" accept="video/*" onChange={e=>loadFile(e.target.files?.[0])}/></div></header>
  <div className="creative-workspace">
   <div className="creative-preview-panel"><div className="creative-panel-top"><span>PREVIEW CANVAS</span><span className="creative-live"><i/> LIVE PREVIEW</span></div><div className="creative-stage"><video ref={video} src={url||undefined} onLoadedMetadata={onMeta} onTimeUpdate={draw} playsInline controls={false} className="creative-source"/><canvas ref={canvas} width="1080" height="1920"/>{!file&&<button className="creative-empty" onClick={()=>input.current?.click()}><span><Film size={25}/></span><b>Bring your footage into Orbit</b><small>Import an MP4, MOV or WebM file to start editing</small></button>}</div><div className="creative-preview-controls"><button onClick={preview} disabled={!ready}><Play size={15} fill="currentColor"/> Preview selected cut</button><span>{fmt(start)} — {fmt(end)} <small>/ {fmt(duration)}</small></span></div></div>
   <aside className="creative-inspector"><div className="creative-panel-top">EDITING CONTROLS <span>01 / 03</span></div><div className="creative-control"><label><Scissors size={14}/> TRIM CLIP</label><div className="creative-time-row"><span>IN POINT</span><b>{fmt(start)}</b></div><input type="range" min="0" max={Math.max(duration,.1)} step=".1" value={start} onChange={e=>{const n=Number(e.target.value);setStart(Math.min(n,end-.1));if(video.current)video.current.currentTime=n}} disabled={!ready}/><div className="creative-time-row"><span>OUT POINT</span><b>{fmt(end)}</b></div><input type="range" min="0" max={Math.max(duration,.1)} step=".1" value={end} onChange={e=>setEnd(Math.max(Number(e.target.value),start+.1))} disabled={!ready}/><small className="creative-help">Choose the exact section to include in your export.</small></div>
    <div className="creative-control"><label><Type size={14}/> TITLE OVERLAY</label><input className="creative-text-input" value={title} onChange={e=>setTitle(e.target.value.slice(0,70))} placeholder="Add a headline to your video"/><small className="creative-help">Centered white title with a readable outline.</small></div>
    <div className="creative-control"><label><ImagePlus size={14}/> FRAME</label><div className="creative-choice"><button className={fit==='cover'?'selected':''} onClick={()=>setFit('cover')}>Fill frame</button><button className={fit==='contain'?'selected':''} onClick={()=>setFit('contain')}>Fit entire video</button></div></div>
    <div className="creative-control"><label><Volume2 size={14}/> AUDIO</label><div className="creative-audio-row"><span>Keep original audio</span><button className={'creative-toggle '+(!muted?'on':'')} onClick={()=>setMuted(!muted)} aria-label="Toggle original audio"><i/></button></div></div>
    {error&&<p className="creative-error" role="alert">{error}</p>}{busy&&<div className="creative-progress"><span style={{width:progress+'%'}}/></div>}
    <div className="creative-note"><WandSparkles size={16}/><p>Exports are rendered in your browser as WebM. The original source remains unchanged.</p></div>
    <button className="creative-publish" disabled={!ready||busy} onClick={()=>onPublish?.(file)}>Continue to publishing <ArrowDownToLine size={15}/></button>
   </aside>
  </div>
  <div className="creative-timeline"><div className="creative-panel-top"><span>SEQUENCE TIMELINE</span><span>{ready?fmt(end-start)+' SELECTED':'NO CLIP LOADED'}</span></div><div className="creative-track"><div className="creative-track-label">VIDEO 01</div><div className="creative-track-content"><div className="creative-clip" style={{left:(duration?start/duration*100:0)+'%',width:(duration?(end-start)/duration*100:0)+'%'}}><span>{file?.name||'Import a clip to begin'}</span></div></div></div><div className="creative-timeline-foot"><span>00:00</span><span>TRIM RANGE IS APPLIED DURING EXPORT</span><span>{fmt(duration)}</span></div></div>
 </section>;
}
