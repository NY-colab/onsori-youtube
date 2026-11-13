// Isolated unsigned MV3 fixture: never opens or connects to the user's browser.
// Streams a three-minute real Korean recording through the production engine one minute at
// a time, then checks that the bundled Anthropic SDK loads under the extension CSP and that
// api.anthropic.com answers a deliberately invalid key (401) instead of a CORS failure.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const qa=path.resolve(root,'../../work/onsori/browser-store/engine-qa'),fixture=path.join(qa,'extension');
await fs.mkdir(fixture,{recursive:true});
await fs.cp(path.join(root,'extension'),fixture,{recursive:true});
// Three copies of the 60-second fixture: 16 kHz mono PCM16 WAV.
const wav=await fs.readFile(path.join(qa,'korean-60.wav')),at=wav.indexOf('data',12),data=wav.subarray(at+8,at+8+wav.readUInt32LE(at+4)),joined=Buffer.concat([data,data,data]),header=Buffer.concat([wav.subarray(0,36),Buffer.from('data'),Buffer.alloc(4)]);header.writeUInt32LE(16,16);
header.writeUInt32LE(36+joined.length,4);header.writeUInt32LE(joined.length,40);
await fs.writeFile(path.join(fixture,'korean-180.wav'),Buffer.concat([header,joined]));
await fs.writeFile(path.join(fixture,'qa-stream.html'),'<!doctype html><meta charset="utf-8"><title>OnSori streaming QA</title><script type="module" src="qa-stream.js"></script>');
await fs.writeFile(path.join(fixture,'qa-stream.js'),`import {analyzeFullStreaming} from './browser-engine.js';
const qa=globalThis.qa={state:'running',chunks:[],progress:[],start:performance.now()};
try{
  const {verifyCorrectionKey}=await import('./ai-correction.js');
  try{await verifyCorrectionKey('sk-ant-api03-'+'0'.repeat(40));qa.anthropic='unexpected-ok';}catch(e){qa.anthropic=e.code||e.name;qa.anthropicMessage=e.message;}
  const blob=await(await fetch('./korean-180.wav')).blob();
  qa.result=await analyzeFullStreaming({blob,videoId:'-wbEQJ_ZXyk',title:'스트리밍 QA',expectedDuration:180,options:{language:'ko',music_detail:true,capture_frames:false},references:[],position:async()=>70,
    onChunk:d=>{qa.chunks.push({at_ms:Math.round(performance.now()-qa.start),ranges:d.metadata.analyzed_ranges,partial:d.metadata.partial,cues:d.cues.length,speech:d.cues.filter(c=>c.kind==='speech').map(c=>[c.start,c.end,c.text])});console.log('CHUNK',JSON.stringify(qa.chunks.at(-1).ranges));},
    onProgress:p=>{qa.progress.push({...p,at_ms:Math.round(performance.now()-qa.start)});}});
  qa.state='done';
}catch(e){qa.state='error';qa.error=e.message;console.error(e);}
qa.elapsed_ms=Math.round(performance.now()-qa.start);
`);
const context=await chromium.launchPersistentContext(path.join(qa,'profile-production'),{headless:true,executablePath:process.env.ONSORI_CHROMIUM_PATH||chromium.executablePath(),ignoreDefaultArgs:['--disable-extensions'],args:[`--disable-extensions-except=${fixture}`,`--load-extension=${fixture}`]});
const network=[],errors=[];context.on('request',r=>network.push({url:r.url(),method:r.method(),resource:r.resourceType()}));
const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');const extensionId=new URL(worker.url()).host;
const page=await context.newPage();page.on('console',m=>{if(m.type()==='error'||/^CHUNK/.test(m.text()))console.log(m.type()+': '+m.text());});page.on('pageerror',e=>errors.push(e.message));
try{
  await page.goto(`chrome-extension://${extensionId}/qa-stream.html`);
  await page.waitForFunction(()=>globalThis.qa?.state&&globalThis.qa.state!=='running',{},{timeout:25*60*1000});
  const result=await page.evaluate(()=>({...globalThis.qa,result:undefined,final:globalThis.qa.result&&{duration:qa.result.duration,partial:qa.result.metadata.partial,ranges:qa.result.metadata.analyzed_ranges,chunks:qa.result.metadata.stream_chunks,cues:qa.result.cues.map(c=>({kind:c.kind,start:c.start,end:c.end,text:c.text}))},progress:globalThis.qa.progress.filter((p,i,a)=>i===0||i===a.length-1||Math.floor(p.at_ms/15000)!==Math.floor(a[i-1].at_ms/15000))}));
  const settings=await context.newPage();await settings.goto(`chrome-extension://${extensionId}/ai-settings.html`);await settings.waitForFunction(()=>!/확인하고 있습니다/.test(document.getElementById('keyState').textContent)||document.getElementById('feedback').textContent,{},{timeout:60000}).catch(()=>null);
  result.settings_page={keyState:await settings.textContent('#keyState'),feedback:await settings.textContent('#feedback'),model:await settings.textContent('#model'),passwordInputs:await settings.locator('input[type=password]').count()};
  await settings.setViewportSize({width:720,height:1100});await settings.screenshot({path:path.join(qa,'ai-settings.png'),fullPage:true});
  result.page_errors=errors;result.permissions=await page.evaluate(async()=>chrome.permissions.getAll());
  result.remote_executable_requests=network.filter(r=>/https?:/.test(r.url)&&(/\.(js|mjs|wasm)(\?|$)/.test(r.url)||['script','worker'].includes(r.resource)));
  result.anthropic_requests=network.filter(r=>r.url.startsWith('https://api.anthropic.com/'));
  await fs.writeFile(path.join(qa,'actual-stream-180.json'),JSON.stringify(result,null,2));
  console.log('RESULT '+JSON.stringify({state:result.state,error:result.error,elapsed_ms:result.elapsed_ms,anthropic:result.anthropic,chunks:result.chunks.map(c=>({at_ms:c.at_ms,ranges:c.ranges,partial:c.partial,cues:c.cues})),final_ranges:result.final?.ranges,settings:result.settings_page,remote_executables:result.remote_executable_requests.length,page_errors:errors}));
  const firstHoldsPlayhead=result.chunks[0]?.ranges?.[0]?.[0]<=70&&result.chunks[0]?.ranges?.[0]?.[1]>70;
  if(result.state!=='done'||result.chunks.length!==3||!firstHoldsPlayhead||result.final?.partial!==false||result.anthropic!=='invalid_key'||result.remote_executable_requests.length||errors.length||result.settings_page.passwordInputs!==1)process.exitCode=1;
}finally{await context.close();}
