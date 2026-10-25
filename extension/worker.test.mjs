import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import * as core from './core.js';
const baseDoc={schema_version:'1.0',video_id:'abcdefghijk',title:'테스트 영상',duration:30,cues:[{id:'a',start:2,end:4,text:'실제 서버 결과 자리',kind:'speech',scale:1,dbfs:null,relative_db:null,confidence:null,source:'test',review_required:true}],warnings:[],metadata:{}};
async function harness(config={}){let receiver;const storage=structuredClone(config.storage||{}),calls=[],messages=[],timers=[];const chrome={storage:{local:{async get(keys){const list=typeof keys==='string'?[keys]:keys;return Object.fromEntries(list.map(k=>[k,storage[k]]));},async set(value){Object.assign(storage,structuredClone(value));}}},runtime:{getURL:file=>`chrome-extension://test/${file}`,async getContexts(){return [];},async sendMessage(message){messages.push(message);if(message.type==='CAPTURE_PREPARE'&&config.prepareGate)await config.prepareGate;if(message.type==='CAPTURE_RECORD')return {ok:true,startedAt:Date.now(),startTime:message.startTime+0.04};return {ok:true};},onMessage:{addListener(fn){receiver=fn;}}},tabs:{async get(id){if(config.closedTab)throw new Error('No tab');return {id,url:`https://www.youtube.com/watch?v=${id===9?'zzzzzzzzzzz':'abcdefghijk'}`,title:id===9?'두 번째 영상 - YouTube':'테스트 - YouTube'};},async query(){return [{id:7,url:'https://www.youtube.com/watch?v=abcdefghijk',title:'테스트 - YouTube'}];},async sendMessage(id,payload){messages.push(payload);if(payload.type==='NATIVE_CAPTIONS')return {references:config.references||[]};if(['VIDEO_STATE','PREPARE_CAPTURE'].includes(payload.type))return {videoId:id===9?'zzzzzzzzzzz':'abcdefghijk',time:config.time??10,duration:300,ended:false,paused:payload.type==='VIDEO_STATE'&&Boolean(config.paused),rate:payload.type==='VIDEO_STATE'?(config.rate||1):1,ad:Boolean(config.ad),sampledAt:Date.now(),title:'테스트'};return {ok:true};},async create(){},onUpdated:{addListener(){}},onRemoved:{addListener(){}}},tabCapture:{async getMediaStreamId(options){messages.push({type:'GET_STREAM',...options});if(config.permissionDenied)throw new Error('Extension has not been invoked for the current page');return 'mock-stream';}},offscreen:{async createDocument(){}}};
  const context=vm.createContext({core,chrome,console,AbortSignal,setTimeout:fn=>{timers.push(fn);return timers.length;},clearTimeout(){},Date,JSON,Number,Object,Array,String,Math,crypto,fetch:async(url,options={})=>{calls.push({url,options});let body;if(url.endsWith('/api/health')){if(config.offline)throw new Error('offline');body={status:'ok'};}else if(url.endsWith('/api/jobs/youtube')){if(config.youtubeGate)await config.youtubeGate;body={id:'job1',status:'queued',progress:0,message:'대기'};}else if(options.method==='DELETE')body={status:'cancelled'};else body=config.jobError?{id:'job1',status:'error',error:'download denied'}:{id:'job1',status:'done',progress:1,result:config.jobResult||baseDoc};return {ok:true,json:async()=>body};}});
  let source=await readFile(new URL('./worker.js',import.meta.url),'utf8');source=source.replace(/^import[^\n]+\n/,"const {DEFAULT_SETTINGS,normalizeSettings,validateDocument,youtubeId,readyDocument}=core;\n");vm.runInContext(source,context);await new Promise(r=>setImmediate(r));
  const send=(payload,sender={})=>new Promise(resolve=>receiver(payload,sender,resolve));return {storage,calls,messages,timers,send,poll:()=>vm.runInContext('poll()',context)};
}
test('worker analysis persists and applies result without a popup lifetime dependency',async()=>{const h=await harness();const answer=await h.send({type:'ANALYZE_URL',options:{language:'auto',audio_captioning:true}});assert.equal(answer.ok,true);assert.equal(h.storage.operation.phase,'queued');assert.equal(h.storage.operation.tabId,7);const request=JSON.parse(h.calls.find(c=>c.url.endsWith('youtube')).options.body);assert.equal(request.audio_captioning,true);assert.equal(request.language,'auto');assert.equal(h.calls[0].options.headers['X-OnSori-Client'],'onsori-local-v1');await h.poll();assert.equal(h.storage.operation.phase,'done');assert.equal(h.storage.captionCache.abcdefghijk.document.cues.length,1);assert.ok(h.messages.some(m=>m.type==='DOCUMENT_UPDATED'));});
test('worker rejects mismatched imports and preserves existing captions',async()=>{const h=await harness();const good=await h.send({type:'IMPORT',document:baseDoc});assert.equal(good.ok,true);const result=await h.send({type:'IMPORT',document:{...baseDoc,video_id:'zzzzzzzzzzz'}});assert.equal(result.ok,false);assert.match(result.error,/영상 ID/);assert.ok(h.storage.captionCache.abcdefghijk);assert.equal(h.storage.captionCache.zzzzzzzzzzz,undefined);});
test('capture pipeline snapshots video time, preserves options and stops when interrupted',async()=>{const h=await harness();assert.equal((await h.send({type:'START_CAPTURE',options:{language:'en',audio_captioning:true}})).ok,true);assert.equal(h.storage.operation.phase,'capturing');const record=h.messages.find(m=>m.type==='CAPTURE_RECORD');assert.equal(record.startTime,10);assert.equal(record.videoId,'abcdefghijk');assert.equal(record.options.language,'en');assert.equal(record.options.audio_captioning,true);await h.send({type:'CAPTURE_INTERRUPTED',reason:'영상 위치 변경'},{tab:{id:7}});assert.equal(h.storage.operation.phase,'uploading');assert.ok(h.messages.some(m=>m.type==='CAPTURE_STOP'));assert.ok(h.messages.some(m=>m.type==='CAPTURE_ACTIVE'&&m.active===false));});
test('cancellation is terminal and a late job result cannot replace it',async()=>{const h=await harness();await h.send({type:'ANALYZE_URL'});await h.send({type:'CANCEL'});await h.poll();assert.equal(h.storage.operation.phase,'cancelled');assert.equal(h.storage.captionCache,undefined);assert.ok(h.calls.some(c=>c.options.method==='DELETE'));});
test('cancellation stays responsive during the initial server request',async()=>{let release;const gate=new Promise(resolve=>release=resolve),h=await harness({youtubeGate:gate});const pending=h.send({type:'ANALYZE_URL'});await new Promise(r=>setImmediate(r));assert.equal(h.storage.operation.phase,'requesting');const snapshot=await h.send({type:'GET_STATE'});assert.equal(snapshot.operation.phase,'requesting');await h.send({type:'CANCEL'});assert.equal(h.storage.operation.phase,'cancelled');release();await pending;assert.equal(h.storage.operation.phase,'cancelled');assert.ok(h.calls.some(c=>c.options.method==='DELETE'));});

const recorderSender={url:'chrome-extension://test/offscreen.html'};
const videoSender={tab:{id:7,url:'https://www.youtube.com/watch?v=abcdefghijk'},url:'https://www.youtube.com/watch?v=abcdefghijk'};

test('reanalyzing hides previous captions through reload, cancellation and failure; only final success publishes',async()=>{
  const h=await harness();await h.send({type:'IMPORT',document:baseDoc});
  assert.ok((await h.send({type:'GET_STATE'})).document);
  await h.send({type:'ANALYZE_URL'});
  assert.equal(h.storage.captionCache.abcdefghijk.ready,false);
  assert.equal((await h.send({type:'GET_STATE'})).document,null);
  // Simulate a worker restart/page refresh with persisted storage.
  const restarted=await harness({storage:h.storage,jobError:true});
  assert.equal((await restarted.send({type:'GET_STATE'})).document,null);
  await restarted.poll();assert.equal(restarted.storage.operation.phase,'error');
  assert.equal((await restarted.send({type:'GET_STATE'})).document,null);
  await h.send({type:'CANCEL'});assert.equal((await h.send({type:'GET_STATE'})).document,null);
  await h.send({type:'ANALYZE_URL'});await h.poll();
  assert.equal(h.storage.captionCache.abcdefghijk.ready,true);
  assert.ok((await h.send({type:'GET_STATE'})).document);
  assert.equal(h.storage.operation.phase,'done');
});

test('transcript-only server completion stays hidden and automatically falls back to tab capture',async()=>{
  const partial={...baseDoc,metadata:{partial:true,audio_analyzed:false}};
  const h=await harness({jobResult:partial});
  await h.send({type:'AUTO_START'},videoSender);await h.poll();
  assert.equal(h.storage.operation.phase,'error');assert.equal((await h.send({type:'GET_STATE'})).document,null);
  assert.equal(h.storage.captionCache,undefined);
  await h.send({type:'AUTO_START'},videoSender);assert.equal(h.storage.operation.phase,'capturing');
});

test('legacy cached errors are hidden and receive a new analysis despite previous auto coverage',async()=>{
  const h=await harness({storage:{captionCache:{abcdefghijk:{document:baseDoc,ranges:[[0,30]]}},autoHistory:{'7:abcdefghijk':{urlAttempted:true,windows:[0]}}}});
  assert.equal((await h.send({type:'GET_STATE'})).document,null);
  await h.send({type:'AUTO_START'},videoSender);assert.equal(h.storage.operation.phase,'queued');
  assert.equal(h.calls.filter(c=>c.url.endsWith('/youtube')).length,1);
  await h.poll();assert.ok((await h.send({type:'GET_STATE'})).document);
});

test('successful capture never merges unverified legacy text outside the recorded interval',async()=>{
  const stale={...baseDoc,cues:[{...baseDoc.cues[0],id:'stale',start:0,end:1,text:'이것은 오시오'}]};
  const h=await harness({storage:{captionCache:{abcdefghijk:{document:stale}}}});
  await h.send({type:'START_CAPTURE'});const captureId=h.storage.operation.captureId;
  await h.send({type:'STOP_CAPTURE'});await h.send({type:'CAPTURE_JOB',captureId,job:{id:'job1',status:'queued'}},recorderSender);await h.poll();
  assert.ok(h.storage.captionCache.abcdefghijk.document.cues.every(c=>c.id!=='stale'));
});

test('import cannot publish a different result while an analysis is running',async()=>{
  const h=await harness();await h.send({type:'ANALYZE_URL'});
  assert.equal((await h.send({type:'IMPORT',document:baseDoc})).ok,false);
  assert.equal((await h.send({type:'GET_STATE'})).document,null);
});
test('automatic playback requests URL analysis once, applies result and reuses silent coverage',async()=>{
  const h=await harness();await h.send({type:'AUTO_START'},videoSender);assert.equal(h.storage.operation.automatic,true);assert.equal(h.storage.operation.phase,'queued');
  await h.send({type:'AUTO_START'},videoSender);assert.equal(h.calls.filter(x=>x.url.endsWith('/youtube')).length,1);
  await h.poll();const result=await h.send({type:'AUTO_START'},videoSender);assert.equal(result.cached,true);
  assert.deepEqual(h.storage.captionCache.abcdefghijk.ranges,[[0,30]]);
});
test('automation respects pause, ads, settings, background tabs and cancellation',async()=>{
  for(const config of [{paused:true},{ad:true},{storage:{settings:{...core.DEFAULT_SETTINGS,autoAnalyze:false}}},{storage:{settings:{...core.DEFAULT_SETTINGS,enabled:false}}}]){
    const h=await harness(config);await h.send({type:'AUTO_START'},videoSender);assert.equal(h.calls.length,0);
  }
  const h=await harness();await h.send({type:'AUTO_START'}, {tab:{id:9}});assert.equal(h.calls.length,0);
  await h.send({type:'AUTO_START'},videoSender);await h.send({type:'CANCEL'},videoSender);await h.send({type:'AUTO_START'},videoSender);
  assert.equal(h.storage.operation.phase,'cancelled');assert.equal(h.calls.filter(x=>x.url.endsWith('/youtube')).length,1);
});
test('URL failure falls back to capture, permission retry requires the real extension popup',async()=>{
  const h=await harness({jobError:true,permissionDenied:true});await h.send({type:'AUTO_START'},videoSender);await h.poll();
  await h.send({type:'AUTO_START'},videoSender);assert.equal(h.storage.operation.phase,'waiting_permission');
  const count=h.messages.filter(x=>x.type==='GET_STREAM').length;
  await h.send({type:'AUTO_START',invoked:true},videoSender);assert.equal(h.messages.filter(x=>x.type==='GET_STREAM').length,count);
  await h.send({type:'AUTO_START',invoked:true},{url:'chrome-extension://test/popup.html'});assert.equal(h.messages.filter(x=>x.type==='GET_STREAM').length,count+1);
});
test('automatic fallback captures playing video without a minute button; native references reach uploader',async()=>{
  const refs=[{video_id:'abcdefghijk',start:10,end:13,text:'입는 옷이에요.',source:'youtube-native-caption'}];
  const h=await harness({jobError:true,references:refs});await h.send({type:'AUTO_START'},videoSender);await h.poll();await h.send({type:'AUTO_START'},videoSender);
  assert.equal(h.storage.operation.phase,'capturing');assert.equal(h.storage.operation.automatic,true);
  const evidence=await h.send({type:'CAPTURE_REFERENCES',captureId:h.storage.operation.captureId},recorderSender);assert.deepEqual(evidence.references,refs);
  assert.equal((await h.send({type:'CAPTURE_REFERENCES',captureId:h.storage.operation.captureId},videoSender)).ok,false);
});
test('offline auto mode backs off and existing stored size migrates exactly once',async()=>{
  const h=await harness({offline:true,storage:{settings:{baseSize:40}}});assert.equal(h.storage.settings.baseSize,20);
  await h.send({type:'AUTO_START'},videoSender);await h.send({type:'AUTO_START'},videoSender);
  assert.equal(h.calls.length,1);assert.equal(h.storage.operation.phase,'waiting_server');
});
test('toolbar invocation on a paused video clears only the permission wait for later playback',async()=>{
  const config={paused:true,storage:{autoHistory:{'7:abcdefghijk':{urlAttempted:true,permissionRequired:true,windows:[0]}}}};
  const h=await harness(config);await h.send({type:'AUTO_START',invoked:true},{url:'chrome-extension://test/popup.html'});
  assert.equal(h.storage.autoHistory['7:abcdefghijk'].permissionRequired,false);assert.equal(h.calls.length,0);
  config.paused=false;await h.send({type:'AUTO_START'},videoSender);assert.equal(h.storage.operation.phase,'capturing');
});
test('adding recorded audio to transcript-only cache does not claim unrecorded regions as analyzed',async()=>{
  const h=await harness({storage:{captionCache:{abcdefghijk:{document:{...baseDoc,duration:300,metadata:{partial:true,audio_analyzed:false}},ranges:[[0,300]]}}}});
  await h.send({type:'START_CAPTURE'});const captureId=h.storage.operation.captureId;
  await h.send({type:'STOP_CAPTURE'});await h.send({type:'CAPTURE_JOB',captureId,job:{id:'job1',status:'queued'}},recorderSender);await h.poll();
  assert.deepEqual(h.storage.captionCache.abcdefghijk.ranges,[[10.04,30]]);
});
test('one-click capture starts a paused 2x video and stores the actual recording origin',async()=>{const h=await harness({paused:true,rate:2});assert.equal((await h.send({type:'START_CAPTURE'})).ok,true);assert.ok(h.messages.some(m=>m.type==='PREPARE_CAPTURE'));assert.equal(h.storage.operation.startTime,10.04);assert.ok(Number.isFinite(h.storage.operation.startedAt));const record=h.messages.find(m=>m.type==='CAPTURE_RECORD');assert.ok(record.captureId);assert.ok(record.snapshotAt);assert.equal(record.captureId,h.storage.operation.captureId);assert.ok(h.messages.some(m=>m.type==='OPERATION_UPDATED'&&m.operation.phase==='capturing'));});
test('server offline and ads fail before requesting capture permission',async()=>{for(const config of [{offline:true},{ad:true}]){const h=await harness(config);const result=await h.send({type:'START_CAPTURE'});assert.equal(result.ok,false);assert.equal(h.storage.operation.phase,'error');assert.equal(h.storage.operation.videoId,'abcdefghijk');assert.ok(!h.messages.some(m=>m.type==='GET_STREAM'));if(config.offline)assert.match(result.error,/Start-OnSori.cmd/);}});
test('cancel during stream preparation never starts playback or recording',async()=>{let release;const gate=new Promise(r=>release=r),h=await harness({prepareGate:gate});const pending=h.send({type:'START_CAPTURE'});await new Promise(r=>setImmediate(r));await h.send({type:'CANCEL'});release();await pending;assert.equal(h.storage.operation.phase,'cancelled');assert.ok(!h.messages.some(m=>m.type==='CAPTURE_RECORD'||m.type==='PREPARE_CAPTURE'));assert.ok(h.messages.some(m=>m.type==='CAPTURE_DISCARD'&&m.captureId));});
test('late errors and jobs from an old recording cannot alter a new recording',async()=>{const h=await harness();await h.send({type:'START_CAPTURE'});const oldId=h.storage.operation.captureId;await h.send({type:'CANCEL'});await h.send({type:'START_CAPTURE'});const newId=h.storage.operation.captureId;assert.notEqual(oldId,newId);await h.send({type:'CAPTURE_ERROR',captureId:oldId,error:'old failure'},recorderSender);await h.send({type:'CAPTURE_JOB',captureId:oldId,job:{id:'old-job',status:'queued'}},recorderSender);assert.equal(h.storage.operation.phase,'capturing');assert.equal(h.storage.operation.captureId,newId);assert.ok(h.calls.some(c=>c.url.endsWith('/old-job')&&c.options.method==='DELETE'));});
test('audio telemetry accepts only the current offscreen recording and remains terminal after cancel',async()=>{const h=await harness();await h.send({type:'START_CAPTURE'});const payload={type:'CAPTURE_LEVEL',captureId:h.storage.operation.captureId,rms:0.1,peak:0.3,elapsed:6,bytes:4000,silentSeconds:0};assert.equal((await h.send(payload,{})).ok,false);await h.send(payload,recorderSender);assert.equal(h.storage.operation.level.bytes,4000);assert.ok(h.messages.some(m=>m.type==='OPERATION_UPDATED'&&m.operation.level?.rms===0.1));await h.send({type:'CANCEL'});await h.send({...payload,type:'CAPTURE_ERROR',error:'late'},recorderSender);await h.send(payload,recorderSender);assert.equal(h.storage.operation.phase,'cancelled');});
test('replay is available only after success and on the analyzed video tab',async()=>{const h=await harness();assert.equal((await h.send({type:'REPLAY_CAPTURE'})).ok,false);h.storage.operation={phase:'done',capture:true,tabId:7,videoId:'abcdefghijk',startTime:12.25};assert.equal((await h.send({type:'REPLAY_CAPTURE'},{tab:{id:9,url:'https://www.youtube.com/watch?v=abcdefghijk'}})).ok,false);assert.equal((await h.send({type:'REPLAY_CAPTURE'})).ok,true);assert.ok(h.messages.some(m=>m.type==='VIDEO_SEEK'&&m.time===12.25));});

const panelSender={tab:{id:9,url:'https://www.youtube.com/watch?v=zzzzzzzzzzz'},url:'chrome-extension://test/popup.html?view=panel'};
test('embedded panel reads its own video while a different tab is active',async()=>{
  const h=await harness();h.storage.captionCache={zzzzzzzzzzz:{ready:true,displayVersion:2,document:{...baseDoc,video_id:'zzzzzzzzzzz'}}};
  const result=await h.send({type:'GET_STATE'},panelSender);
  assert.equal(result.videoId,'zzzzzzzzzzz');assert.equal(result.tabId,9);assert.equal(result.document.video_id,'zzzzzzzzzzz');
  assert.equal((await h.send({type:'GET_STATE'})).videoId,'abcdefghijk');
});
test('panel analysis and capture target the sender tab instead of the focused tab',async()=>{
  const h=await harness();await h.send({type:'ANALYZE_URL'},panelSender);
  assert.equal(JSON.parse(h.calls.find(c=>c.url.endsWith('youtube')).options.body).url,panelSender.tab.url);
  assert.equal(h.storage.operation.tabId,9);await h.send({type:'CANCEL'},panelSender);
  assert.equal((await h.send({type:'START_CAPTURE'},panelSender)).ok,true);
  assert.equal(h.storage.operation.videoId,'zzzzzzzzzzz');assert.equal(h.messages.find(m=>m.type==='GET_STREAM').targetTabId,9);
  assert.equal((await h.send({type:'STOP_CAPTURE'},{tab:{id:7,url:'https://www.youtube.com/watch?v=abcdefghijk'}})).ok,false);
});
test('panel import and remove cannot change another tab captions',async()=>{
  const h=await harness();await h.send({type:'IMPORT',document:baseDoc});
  assert.equal((await h.send({type:'IMPORT',document:baseDoc},panelSender)).ok,false);
  assert.equal((await h.send({type:'IMPORT',document:{...baseDoc,video_id:'zzzzzzzzzzz'}},panelSender)).ok,true);
  await h.send({type:'REMOVE_DOCUMENT'},panelSender);
  assert.ok(h.storage.captionCache.abcdefghijk);assert.equal(h.storage.captionCache.zzzzzzzzzzz,undefined);
});
test('a stale panel from a closed tab cannot fall back to the focused tab',async()=>{
  const h=await harness({closedTab:true});const state=await h.send({type:'GET_STATE'},panelSender);
  assert.equal(state.videoId,null);assert.equal((await h.send({type:'ANALYZE_URL'},panelSender)).ok,false);
  assert.equal(h.calls.length,0);
});
