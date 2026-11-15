// Isolated unsigned MV3 fixture: never opens or connects to the user's browser.
// Caption mode end to end on a real video: the extension page fetches a player caption
// request (ONSORI_QA_CAPTION_URL, copied from the player's own /api/timedtext request with
// its pot value) without cookies, turns json3 into caption lines, then streams the
// video's audio through the production engine with speech recognition skipped.
// Usage: ONSORI_QA_CAPTION_URL=<url> ONSORI_QA_AUDIO=<16 kHz wav> node browser-build/qa-captions.mjs <out.json>
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const qa=path.resolve(root,'../../work/onsori/browser-store/engine-qa'),fixture=path.join(qa,'extension-captions');
const captionUrl=process.env.ONSORI_QA_CAPTION_URL,audio=process.env.ONSORI_QA_AUDIO,out=process.argv[2];
if(!captionUrl||!audio||!out)throw new Error('ONSORI_QA_CAPTION_URL, ONSORI_QA_AUDIO and an output path are required');
await fs.rm(fixture,{recursive:true,force:true});await fs.mkdir(fixture,{recursive:true});
await fs.cp(path.join(root,'extension'),fixture,{recursive:true});
await fs.copyFile(audio,path.join(fixture,'qa-audio.wav'));
await fs.writeFile(path.join(fixture,'qa-captions.html'),'<!doctype html><meta charset="utf-8"><title>OnSori caption QA</title><script type="module" src="qa-captions.js"></script>');
await fs.writeFile(path.join(fixture,'qa-captions.js'),`import {analyzeFullStreaming} from './browser-engine.js';
import {selectFullSource,boundedDownload,captionWords,captionLines} from './full-source.js';
const qa=globalThis.qa={state:'running',chunks:[],start:performance.now()};
try{
  const p=new URL(location.href).searchParams,videoId=p.get('v'),duration=Number(p.get('d'));
  const source=selectFullSource({videoId,title:'caption QA',duration,formats:[{url:'https://r1.googlevideo.com/videoplayback?id=qa',mimeType:'audio/mp4'}],tracks:[],captionRequest:{url:p.get('caption'),language:'ko',kind:'asr'}},videoId);
  qa.track={attested:source.track?.attested===true,kind:source.track?.kind};
  const t0=performance.now(),data=await boundedDownload(source.track.url,{maxBytes:2*1024*1024}),json=JSON.parse(await data.text());
  const {words,tags}=captionWords(json,duration),lines=captionLines(words);
  qa.caption={bytes:data.size,fetch_ms:Math.round(performance.now()-t0),words:words.length,tags:tags.map(t=>[t.start,t.text]),lines:lines.length};
  const blob=await(await fetch('./qa-audio.wav')).blob();
  qa.result=await analyzeFullStreaming({blob,videoId,title:'caption QA',expectedDuration:duration,options:{language:'ko',music_detail:true,capture_frames:false},captions:{kind:'auto',lines,tags},position:async()=>0,
    onChunk:d=>{qa.chunks.push({at_ms:Math.round(performance.now()-qa.start),ranges:d.metadata.analyzed_ranges});console.log('CHUNK',JSON.stringify(qa.chunks.at(-1)));}});
  qa.state='done';
}catch(e){qa.state='error';qa.error=e.message;console.error(e);}
qa.elapsed_ms=Math.round(performance.now()-qa.start);
`);
const context=await chromium.launchPersistentContext(path.join(qa,'profile-production'),{headless:true,executablePath:process.env.ONSORI_CHROMIUM_PATH||chromium.executablePath(),ignoreDefaultArgs:['--disable-extensions'],args:[`--disable-extensions-except=${fixture}`,`--load-extension=${fixture}`]});
const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');const extensionId=new URL(worker.url()).host;
const page=await context.newPage();const errors=[];page.on('console',m=>{if(m.type()==='error'||/^CHUNK/.test(m.text()))console.log(m.type()+': '+m.text());});page.on('pageerror',e=>errors.push(e.message));
try{
  const id=new URL(captionUrl).searchParams.get('v'),duration=Number(process.env.ONSORI_QA_DURATION||361.256);
  await page.goto(`chrome-extension://${extensionId}/qa-captions.html?v=${encodeURIComponent(id)}&d=${duration}&caption=${encodeURIComponent(captionUrl)}`);
  await page.waitForFunction(()=>globalThis.qa?.state&&globalThis.qa.state!=='running',{},{timeout:25*60*1000});
  const result=await page.evaluate(()=>({state:qa.state,error:qa.error,elapsed_ms:qa.elapsed_ms,track:qa.track,caption:qa.caption,chunks:qa.chunks,document:qa.result}));
  result.page_errors=errors;
  await fs.writeFile(out,JSON.stringify(result,null,1));
  const speech=result.document?.cues.filter(c=>c.kind==='speech')||[];
  console.log('RESULT '+JSON.stringify({state:result.state,error:result.error,elapsed_ms:result.elapsed_ms,track:result.track,caption:result.caption&&{...result.caption,tags:result.caption.tags.length},speech:speech.length,sources:[...new Set(speech.map(c=>c.source))],music:result.document?.cues.filter(c=>c.kind==='music').length,sound:result.document?.cues.filter(c=>c.kind==='sound').length,speech_source:result.document?.metadata.speech_source,chunks:result.chunks.length}));
  if(result.state!=='done'||!result.track.attested||!speech.length||errors.length)process.exitCode=1;
}finally{await context.close();}
