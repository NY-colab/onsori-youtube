// Isolated unsigned MV3 fixture: never opens or connects to the user's browser.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const qa=path.resolve(root,'../../work/onsori/browser-store/engine-qa'),fixture=path.join(qa,'extension');
const long=process.argv.includes('--long');
// Evaluation mode (eval/README.ko.md): --audio <wav> --duration <s> --out <json> [--video-id <id>]
// runs any original or stem WAV through the same full-video call offscreen.js makes.
const arg=name=>{const i=process.argv.indexOf(name);return i>0?process.argv[i+1]:undefined;};
const evalAudio=arg('--audio'),evalDuration=Number(arg('--duration')),evalVideo=arg('--video-id')||'-wbEQJ_ZXyk';
if(evalAudio&&!(evalDuration>0&&arg('--out')))throw new Error('--audio needs --duration and --out');
const audioName=evalAudio?'eval-input.wav':long?'korean-60.wav':'korean.wav';
await fs.mkdir(fixture,{recursive:true});
// Copy the full production extension, including its unchanged manifest and
// permission/CSP boundaries. Only the local QA page and fixtures are added.
await fs.cp(path.join(root,'extension'),fixture,{recursive:true});
await fs.writeFile(path.join(fixture,'qa.html'),'<!doctype html><meta charset="utf-8"><title>OnSori isolated QA</title><script type="module" src="qa.js"></script>');
await fs.copyFile(evalAudio?path.resolve(evalAudio):path.join(qa,audioName),path.join(fixture,audioName));
const frames=[];
for(const name of (await fs.readdir(qa)).filter(n=>/^frame-\d+\.jpg$/.test(n)).sort()){const index=Number(name.match(/\d+/)[0]);frames.push({video_id:'-wbEQJ_ZXyk',time:5+(index-.5)*.25,jpeg:'data:image/jpeg;base64,'+(await fs.readFile(path.join(qa,name))).toString('base64')});}
await fs.writeFile(path.join(fixture,'frames.json'),JSON.stringify(frames));
const call=evalAudio
  ?`videoId:${JSON.stringify(evalVideo)},title:'온소리 평가 입력',startTime:0,scope:'full-video',expectedDuration:${evalDuration},options:{language:'ko',music_detail:true,capture_frames:false},references:[],frames:[]`
  :`videoId:'-wbEQJ_ZXyk',title:'실제 한국어 브라우저 QA',startTime:${long?0:5},options:{language:'ko',capture_frames:${!long}},frames:${long?'[]':"await(await fetch('./frames.json')).json()"}`;
await fs.writeFile(path.join(fixture,'qa.js'),`import {analyzeRecording,browserEngineAvailability} from './browser-engine.js';
globalThis.qaProgress=[];globalThis.qaStart=performance.now();globalThis.qaState='running';
try{globalThis.qaAvailable=await browserEngineAvailability();globalThis.qaResult=await analyzeRecording({blob:await(await fetch('./${audioName}')).blob(),${call},onProgress:p=>{globalThis.qaProgress.push({...p,time:performance.now()});console.log('PROGRESS',JSON.stringify(p));}});globalThis.qaState='done';}catch(e){globalThis.qaState='error';globalThis.qaError=e.message;console.error(e);}globalThis.qaElapsed=performance.now()-globalThis.qaStart;
`);
const context=await chromium.launchPersistentContext(path.join(qa,'profile-production'),{headless:true,executablePath:process.env.ONSORI_CHROMIUM_PATH||chromium.executablePath(),ignoreDefaultArgs:['--disable-extensions'],args:[`--disable-extensions-except=${fixture}`,`--load-extension=${fixture}`]});
const network=[],errors=[];context.on('request',r=>network.push({url:r.url(),method:r.method(),resource:r.resourceType()}));
const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');const extensionId=new URL(worker.url()).host;
const page=await context.newPage();let lastConsole=0;page.on('console',m=>{if(m.type()==='error'||Date.now()-lastConsole>1000){console.log(m.type()+': '+m.text());lastConsole=Date.now();}});page.on('pageerror',e=>errors.push(e.message));
try{
  await page.goto(`chrome-extension://${extensionId}/qa.html`);
  await page.waitForFunction(()=>globalThis.qaState==='done'||globalThis.qaState==='error',{},{timeout:(evalAudio?60:15)*60*1000});
  const result=await page.evaluate(async()=>({state:qaState,result:globalThis.qaResult,error:globalThis.qaError,progress:qaProgress,elapsed_ms:qaElapsed,available:qaAvailable,permissions:await chrome.permissions.getAll()}));
  result.network=network;result.page_errors=errors;result.extension_csp=JSON.parse(await fs.readFile(path.join(fixture,'manifest.json'),'utf8')).content_security_policy;
  result.remote_executable_requests=network.filter(r=>/https?:/.test(r.url)&&(/\.(js|mjs|wasm)(\?|$)/.test(r.url)||['script','worker'].includes(r.resource)));
  result.upload_requests=network.filter(r=>/https?:/.test(r.url)&&['POST','PUT','PATCH'].includes(r.method));
  await fs.writeFile(evalAudio?path.resolve(arg('--out')):path.join(qa,long?'actual-inference-60.json':'actual-inference.json'),JSON.stringify(result,null,2));
  console.log('RESULT '+JSON.stringify({state:result.state,error:result.error,elapsed_ms:result.elapsed_ms,cues:result.result?.cues.map(c=>({text:c.text,kind:c.kind,start:c.start,end:c.end})),ocr:result.result?.metadata.screen_correction,remote_executables:result.remote_executable_requests.length}));
  const corrected=long||evalAudio||result.result?.cues.some(c=>c.text==='이것은 옷이오, 이불이오?'&&c.speech_correction?.reference_source==='youtube-screen-ocr');
  if(result.state!=='done'||!corrected||result.remote_executable_requests.length||result.upload_requests.length||errors.length||result.permissions.permissions.includes('unlimitedStorage'))process.exitCode=1;
}finally{await context.close();}
