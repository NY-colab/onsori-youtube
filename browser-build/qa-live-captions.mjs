// Isolated unsigned MV3 fixture on a fresh profile: never opens or connects to the user's browser.
// Live check of caption mode on a real YouTube watch page: the built extension is loaded,
// on-device analysis and automatic analysis are switched on, the video plays muted, and the
// stored per-video document is read once the whole video is analyzed.
// Limit (2026-11-15): YouTube answers caption requests from an automated browser
// (navigator.webdriver) with an empty body, even the player's own. Here this script therefore
// checks the fallback path (speech recognition plus the reason shown in the warnings); the
// caption path itself has to be checked in an ordinary Chrome with the unpacked extension.
// Usage: node browser-build/qa-live-captions.mjs <videoId> <out.json>
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const qa=path.resolve(root,'../../work/onsori/browser-store/engine-qa');
const [videoId,out]=process.argv.slice(2);if(!/^[\w-]{11}$/.test(videoId||'')||!out)throw new Error('usage: qa-live-captions.mjs <videoId> <out.json>');
const profile=path.join(qa,'profile-live-captions');await fs.rm(profile,{recursive:true,force:true});
// Reuse the model cache of the production QA profile so AST is not downloaded again.
if(process.env.ONSORI_QA_FRESH!=='1')await fs.cp(path.join(qa,'profile-production'),profile,{recursive:true}).catch(()=>{});
const extension=path.join(root,'extension');
const context=await chromium.launchPersistentContext(profile,{headless:process.env.ONSORI_QA_HEADED!=='1',executablePath:process.env.ONSORI_CHROMIUM_PATH||chromium.executablePath(),ignoreDefaultArgs:['--disable-extensions','--mute-audio'],args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--autoplay-policy=no-user-gesture-required'],viewport:{width:1280,height:800},locale:'ko-KR'});
const log=[],started=Date.now(),t=()=>Math.round((Date.now()-started)/1000);
try{
  let worker=context.serviceWorkers().find(w=>w.url().includes('worker.js'))||await context.waitForEvent('serviceworker');
  // Correction stays off unless ONSORI_QA_CORRECTION=1 (it would use this PC's Claude Code bridge first).
  await worker.evaluate(async correct=>{await chrome.storage.local.clear();await chrome.storage.local.set({localConsent:{enabled:true,version:2,enabledAt:Date.now()},settings:{enabled:true,autoAnalyze:true},...(correct?{}:{aiCorrection:{provider:'cli',optOut:true}})});},process.env.ONSORI_QA_CORRECTION==='1');
  const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const timedtext=[];context.on('request',r=>{const u=r.url();if(u.includes('/api/timedtext'))timedtext.push({at:t(),pot:new URL(u).searchParams.has('pot'),frame:r.frame()?.url()?.slice(0,40)||r.serviceWorker()?.url()?.slice(0,40)||'other'});});
  await page.goto(`https://www.youtube.com/watch?v=${videoId}`,{waitUntil:'domcontentloaded'});
  const captionsBefore=async()=>page.evaluate(()=>{const p=document.querySelector('#movie_player');try{return JSON.stringify(p.getOption('captions','track'))}catch{return null}});
  let state=null,doc=null,lastMessage='';
  for(let i=0;i<300;i++){
    await page.waitForTimeout(3000);
    await page.evaluate(()=>{const v=document.querySelector('video');if(v){v.muted=true;if(v.paused)v.play().catch(()=>{});}document.querySelector('.ytp-skip-ad-button,.ytp-ad-skip-button-modern')?.click();for(const b of document.querySelectorAll('tp-yt-paper-dialog button,ytd-popup-container button'))if(/나중에|No thanks|거부/.test(b.textContent||''))b.click();}).catch(()=>{});
    worker=context.serviceWorkers().find(w=>w.url().includes('worker.js'))||worker;
    const snap=await worker.evaluate(async id=>{const all=await chrome.storage.local.get(null);const entry=Object.entries(all).find(([k,v])=>k.includes(id)&&v?.document);return {op:all.operation||all.state||null,keys:Object.keys(all),doc:entry?.[1]?.document||null};},videoId).catch(e=>({error:e.message}));
    state=snap.op;doc=snap.doc;if(doc&&!globalThis.warned){globalThis.warned=true;console.log('WARNINGS',JSON.stringify(doc.warnings),doc.metadata?.speech_source);}
    const message=JSON.stringify({phase:state?.phase,message:state?.message?.slice(0,80),progress:state?.progress});
    if(message!==lastMessage){log.push({at:t(),...JSON.parse(message)});console.log(t(),message);lastMessage=message;}
    if(doc&&doc.metadata?.partial===false&&doc.metadata?.analysis_scope==='full-video')break;
    if(state?.phase==='error')break;
  }
  const result={videoId,elapsed_s:t(),log,timedtext,errors,captions_track_after:await captionsBefore(),final_state:state,document:doc};
  await fs.writeFile(out,JSON.stringify(result,null,1));
  const speech=doc?.cues?.filter(c=>c.kind==='speech')||[];
  console.log('RESULT '+JSON.stringify({elapsed_s:result.elapsed_s,phase:state?.phase,partial:doc?.metadata?.partial,speech_source:doc?.metadata?.speech_source,speech:speech.length,sources:[...new Set(speech.map(c=>c.source))],music:doc?.cues?.filter(c=>c.kind==='music').length,sound:doc?.cues?.filter(c=>c.kind==='sound').length,ai_correction:doc?.metadata?.ai_correction||null,timedtext,captions_track_after:result.captions_track_after,errors:errors.length}));
}finally{await context.close();}
