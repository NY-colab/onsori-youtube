import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import * as core from './core.js';
const baseDoc={schema_version:'1.0',video_id:'abcdefghijk',title:'영상',duration:30,cues:[{id:'a',start:12,end:14,text:'분석 결과',kind:'speech',scale:1,dbfs:null,relative_db:null,confidence:null,source:'test',review_required:true}],warnings:[],metadata:{audio_analyzed:true,partial:false}};
const toolbar={url:'chrome-extension://test/popup.html'},recorder={url:'chrome-extension://test/offscreen.html'},video={tab:{id:7,url:'https://www.youtube.com/watch?v=abcdefghijk'}};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
async function harness(config={}){
  let receiver,onUpdated,onRemoved,url=config.url||'https://www.youtube.com/watch?v=abcdefghijk';
  const storage=structuredClone(config.storage||{}),session=structuredClone(config.session||{}),messages=[],writes=[],network=[];
  const area=data=>({async get(keys){if(config.readGate&&keys==='captionCache'&&storage.operation?.phase==='running')await config.readGate;return Object.fromEntries((typeof keys==='string'?[keys]:keys).map(k=>[k,structuredClone(data[k])]));},async set(value){if(config.finalWriteGate&&value.operation?.phase==='done')await config.finalWriteGate;Object.assign(data,structuredClone(value));writes.push(structuredClone(value));}});
  const chrome={storage:{local:area(storage),session:area(session)},runtime:{getURL:file=>'chrome-extension://test/'+file,async getContexts(){return [];},async sendMessage(message){messages.push(message);if(message.type==='GET_SESSION')return config.activeSession||{ok:true};if(message.type==='CAPTURE_PREPARE'&&config.prepareGate)await config.prepareGate;if(message.type==='CAPTURE_RECORD')return {ok:true,startedAt:Date.now(),startTime:message.startTime+.04};return {ok:true};},onMessage:{addListener(fn){receiver=fn;}}},tabs:{async get(id){if(config.closedTab)throw new Error('No tab');return {id,url:id===9?'https://www.youtube.com/watch?v=zzzzzzzzzzz':url,title:'영상'};},async query(){return [{id:7,url,title:'영상'}];},async sendMessage(id,payload){messages.push({...payload,tabId:id});if(payload.type==='NATIVE_CAPTIONS')return {references:config.references||[],frames:config.frames||[]};if(['VIDEO_STATE','PREPARE_CAPTURE'].includes(payload.type))return {videoId:id===9?'zzzzzzzzzzz':core.youtubeId(url),time:config.time??10,duration:config.duration??300,ended:false,paused:payload.type==='VIDEO_STATE'&&Boolean(config.paused),rate:payload.type==='VIDEO_STATE'?(config.rate||1):1,ad:Boolean(config.ad),sampledAt:Date.now(),title:'영상'};return {ok:true};},async create(o){messages.push({type:'TAB_CREATE',...o});},onUpdated:{addListener(fn){onUpdated=fn;}},onRemoved:{addListener(fn){onRemoved=fn;}}},tabCapture:{async getMediaStreamId(options){messages.push({type:'GET_STREAM',...options});if(config.permissionDenied)throw new Error('Extension has not been invoked for the current page');return 'stream';}},offscreen:{async createDocument(o){messages.push({type:'CREATE_OFFSCREEN',...o});}}};
  let source=await readFile(new URL('./worker.js',import.meta.url),'utf8');source=source.replace(/^import[^\n]+\n/,"const {normalizeSettings,validateDocument,youtubeId,readyDocument}=core;\n");
  vm.runInNewContext(source,{core,chrome,console,Date,JSON,Number,Object,Array,String,Math,crypto,fetch:(...args)=>{network.push(args);throw new Error('network forbidden');}});await tick();
  const send=(message,sender=toolbar)=>new Promise(resolve=>receiver(message,sender,resolve));
  const enable=()=>send({type:'ENABLE_LOCAL'});const complete=(doc=baseDoc,captureId=storage.operation.captureId)=>send({type:'ANALYSIS_COMPLETE',captureId,document:doc},recorder);
  return {storage,session,messages,writes,network,send,enable,complete,navigate(next){url=next;onUpdated(7,{url:next});},reload(){onUpdated(7,{status:'loading'});},close(){onRemoved(7);}};
}
test('install and content automation never record before explicit toolbar consent',async()=>{
  const h=await harness();await h.send({type:'AUTO_START'},video);await h.send({type:'TOOLBAR_OPEN'});assert.equal(h.messages.some(m=>m.type==='GET_STREAM'),false);assert.equal((await h.send({type:'GET_STATE'})).localEnabled,false);
  assert.equal((await h.send({type:'ENABLE_LOCAL'},video)).ok,false);assert.equal((await h.send({type:'ENABLE_LOCAL'},{url:'chrome-extension://test/popup.html?view=panel'})).ok,false);
  await h.enable();assert.equal(h.storage.localConsent.enabled,true);assert.equal(h.storage.operation.phase,'capturing');assert.equal(h.network.length,0);
});
test('capture uses browser-only analysis and publishes one atomic final document',async()=>{
  const h=await harness();await h.enable();const id=h.storage.operation.captureId,record=h.messages.find(m=>m.type==='CAPTURE_RECORD');assert.equal(record.options.capture_frames,false);assert.equal(record.startTime,10);
  await h.send({type:'STOP_CAPTURE'});assert.equal(h.storage.operation.phase,'running');await h.send({type:'ANALYSIS_PROGRESS',captureId:id,progress:.4,message:'모델 다운로드 중'},recorder);assert.equal(h.storage.operation.progress,.4);assert.equal((await h.send({type:'GET_STATE'})).document,null);
  await h.complete();const state=await h.send({type:'GET_STATE'});assert.equal(state.operation.phase,'done');assert.equal(state.document.cues[0].text,'분석 결과');assert.deepEqual(h.storage.captionCache.abcdefghijk.ranges,[[10.04,30]]);
  const publish=h.writes.find(w=>w.operation?.phase==='done');assert.equal(publish.captionCache.abcdefghijk.ready,true);assert.equal(h.network.length,0);
});
test('language, AST detail, and optional frames reach offscreen; no CoNeTTE option',async()=>{
  const h=await harness();await h.send({type:'ENABLE_LOCAL',options:{language:'en',music_detail:false,capture_frames:true}});const request=h.messages.find(m=>m.type==='CAPTURE_RECORD');assert.equal(request.options.language,'en');assert.equal(request.options.music_detail,false);assert.equal(request.options.capture_frames,true);assert.equal(request.options.audio_captioning,undefined);assert.equal(h.messages.find(m=>m.type==='CAPTURE_ACTIVE'&&m.active).captureFrames,true);
});
test('cancel is responsive during prepare and late continuation cannot record',async()=>{
  const gate=deferred(),h=await harness({prepareGate:gate.promise}),pending=h.enable();await tick();assert.equal(h.storage.operation.phase,'preparing');await h.send({type:'CANCEL'});assert.equal(h.storage.operation.phase,'cancelled');gate.resolve();await pending;assert.equal(h.storage.operation.phase,'cancelled');assert.equal(h.messages.some(m=>m.type==='CAPTURE_RECORD'),false);
});
test('cancel during model loading/inference rejects late progress, final results and errors',async()=>{
  const h=await harness();await h.enable();await h.send({type:'STOP_CAPTURE'});const id=h.storage.operation.captureId;await h.send({type:'CANCEL'});
  for(const payload of [{type:'ANALYSIS_PROGRESS',progress:.9},{type:'ANALYSIS_COMPLETE',document:baseDoc},{type:'CAPTURE_ERROR',error:'late'}])await h.send({...payload,captureId:id},recorder);
  assert.equal(h.storage.operation.phase,'cancelled');assert.equal((await h.send({type:'GET_STATE'})).document,null);assert.equal(h.storage.captionCache,undefined);assert.ok(h.messages.some(m=>m.type==='CAPTURE_DISCARD'&&m.captureId===id));
});
test('cancel racing the final storage write remains terminal and hides the result',async()=>{
  const gate=deferred(),h=await harness({finalWriteGate:gate.promise});await h.enable();await h.send({type:'STOP_CAPTURE'});const completion=h.complete();await tick();const cancelled=h.send({type:'CANCEL'});await tick();gate.resolve();await Promise.all([completion,cancelled]);assert.equal(h.storage.operation.phase,'cancelled');assert.equal(h.storage.captionCache.abcdefghijk.ready,false);assert.equal((await h.send({type:'GET_STATE'})).document,null);
});
test('starting another analysis hides old captions; errors never restore them',async()=>{
  const h=await harness();await h.send({type:'IMPORT',document:baseDoc});assert.ok((await h.send({type:'GET_STATE'})).document);await h.enable();await h.send({type:'START_CAPTURE'});assert.equal(h.storage.captionCache.abcdefghijk.ready,false);await h.send({type:'CAPTURE_ERROR',captureId:h.storage.operation.captureId,error:'모델 다운로드 실패'},recorder);assert.equal(h.storage.operation.phase,'error');assert.equal((await h.send({type:'GET_STATE'})).document,null);
});
test('partial, transcript-only, mismatched and malformed final results never publish',async()=>{
  for(const doc of [{...baseDoc,metadata:{partial:true,audio_analyzed:true}},{...baseDoc,metadata:{audio_analyzed:false}},{...baseDoc,video_id:'zzzzzzzzzzz'},{...baseDoc,cues:[{...baseDoc.cues[0],end:31}]}]){const h=await harness();await h.enable();await h.send({type:'STOP_CAPTURE'});assert.equal((await h.complete(doc)).ok,false);assert.equal(h.storage.captionCache,undefined);assert.equal((await h.send({type:'GET_STATE'})).document,null);}
});
test('foreign sender and stale capture cannot update an active analysis',async()=>{
  const h=await harness();await h.enable();await h.send({type:'STOP_CAPTURE'});const id=h.storage.operation.captureId;assert.equal((await h.send({type:'ANALYSIS_COMPLETE',captureId:id,document:baseDoc},video)).ok,false);await h.send({type:'ANALYSIS_COMPLETE',captureId:'old',document:baseDoc},recorder);assert.equal(h.storage.operation.phase,'running');assert.equal(h.storage.captionCache,undefined);
});
test('SPA navigation, full reload and tab removal cancel inference as well as recording',async()=>{
  for(const action of ['navigate','reload','close']){const h=await harness();await h.enable();await h.send({type:'STOP_CAPTURE'});const id=h.storage.operation.captureId;h[action]('https://www.youtube.com/watch?v=zzzzzzzzzzz');await tick();assert.equal(h.storage.operation.phase,'cancelled');await h.complete(baseDoc,id);assert.equal(h.storage.captionCache,undefined);}
  const h=await harness();await h.enable();await h.send({type:'STOP_CAPTURE'});await h.send({type:'VIDEO_NAVIGATED',videoId:'zzzzzzzzzzz'},video);assert.equal(h.storage.operation.phase,'cancelled');
});
test('background autoplay, pause, ads, rate and disabled setting suppress automatic capture',async()=>{
  for(const config of [{paused:true},{ad:true},{rate:2},{storage:{settings:{enabled:false}}},{storage:{settings:{autoAnalyze:false}}}]){const h=await harness(config);await h.enable();assert.equal(h.messages.some(m=>m.type==='GET_STREAM'),false);}
  const h=await harness({storage:{localConsent:{enabled:true}}});await h.send({type:'AUTO_START'},{tab:{id:9,url:'https://www.youtube.com/watch?v=zzzzzzzzzzz'}});assert.equal(h.messages.some(m=>m.type==='GET_STREAM'),false);
});
test('new browser/tab video requires toolbar grant and content cannot forge it',async()=>{
  const h=await harness({storage:{localConsent:{enabled:true}}});await h.send({type:'AUTO_START',invoked:true},video);assert.equal(h.storage.operation.phase,'waiting_permission');assert.equal(h.messages.some(m=>m.type==='GET_STREAM'),false);await h.send({type:'TOOLBAR_OPEN'});assert.equal(h.storage.operation.phase,'capturing');
});
test('cancelled autoplay stays suppressed but manual capture can restart',async()=>{
  const h=await harness();await h.enable();await h.send({type:'CANCEL'});await h.send({type:'AUTO_START'},video);assert.equal(h.storage.operation.phase,'cancelled');await h.send({type:'START_CAPTURE'});assert.equal(h.storage.operation.phase,'capturing');
});
test('completed silence coverage suppresses repeat auto recording',async()=>{
  const config={time:10},h=await harness(config);await h.enable();await h.send({type:'STOP_CAPTURE'});await h.complete({...baseDoc,cues:[]});config.time=15;assert.equal((await h.send({type:'AUTO_START'},video)).cached,true);assert.equal(h.messages.filter(m=>m.type==='GET_STREAM').length,1);
});
test('embedded panel reads and imports its own video without changing active tab captions',async()=>{
  const h=await harness(),panel={tab:{id:9,url:'https://www.youtube.com/watch?v=zzzzzzzzzzz'},url:'chrome-extension://test/popup.html?view=panel'};await h.send({type:'IMPORT',document:baseDoc});assert.equal((await h.send({type:'IMPORT',document:baseDoc},panel)).ok,false);await h.send({type:'IMPORT',document:{...baseDoc,video_id:'zzzzzzzzzzz'}},panel);assert.equal((await h.send({type:'GET_STATE'},panel)).videoId,'zzzzzzzzzzz');await h.send({type:'REMOVE_DOCUMENT'},panel);assert.ok(h.storage.captionCache.abcdefghijk);assert.equal(h.storage.captionCache.zzzzzzzzzzz,undefined);
});
test('service-worker restart resumes existing offscreen analysis without recording anew',async()=>{
  const operation={phase:'running',captureId:'one',videoId:'abcdefghijk',tabId:7,startTime:10,capture:true};const h=await harness({storage:{operation,localConsent:{enabled:true}},activeSession:{ok:true,captureId:'one',analyzing:true}});assert.equal(h.storage.operation.phase,'running');await h.send({type:'ANALYSIS_PROGRESS',captureId:'one',progress:.5,message:'분석 중'},recorder);await h.complete(baseDoc,'one');assert.equal(h.storage.operation.phase,'done');assert.equal(h.messages.some(m=>m.type==='GET_STREAM'),false);
});
test('orphaned operation becomes actionable error with no automatic recording',async()=>{
  const h=await harness({storage:{operation:{phase:'running',captureId:'lost',videoId:'abcdefghijk',tabId:7}}});assert.equal(h.storage.operation.phase,'error');assert.equal(h.messages.some(m=>m.type==='GET_STREAM'),false);
});
test('URL analysis removed and help opens bundled local page',async()=>{const h=await harness();assert.equal((await h.send({type:'ANALYZE_URL'})).ok,false);await h.send({type:'OPEN_HELP'});assert.ok(h.messages.some(m=>m.type==='TAB_CREATE'&&m.url==='chrome-extension://test/help.html'));assert.equal(h.network.length,0);});

test('browser permission failure waits for a real toolbar retry instead of looping',async()=>{
  const config={permissionDenied:true},h=await harness(config);await h.enable();assert.equal(h.storage.operation.phase,'waiting_permission');const before=h.messages.filter(m=>m.type==='GET_STREAM').length;await h.send({type:'AUTO_START',invoked:true},video);assert.equal(h.messages.filter(m=>m.type==='GET_STREAM').length,before);config.permissionDenied=false;await h.send({type:'TOOLBAR_OPEN'});assert.equal(h.storage.operation.phase,'capturing');assert.equal(h.messages.filter(m=>m.type==='GET_STREAM').length,before+1);
});
test('range merge retains only verified cues outside new interval and remaps music evidence',async()=>{
  const music={...baseDoc,cues:[{...baseDoc.cues[0],id:'old-music',kind:'music',start:1,end:3}],metadata:{audio_analyzed:true,music_analysis:{'old-music':{tags:['Music']}}}};
  const h=await harness();await h.send({type:'IMPORT',document:music});await h.enable();await h.send({type:'START_CAPTURE'});await h.send({type:'STOP_CAPTURE'});await h.complete({...baseDoc,cues:[{...baseDoc.cues[0],id:'new-music',kind:'music'}],metadata:{audio_analyzed:true,music_analysis:{'new-music':{tags:['Piano']}}}});const doc=h.storage.captionCache.abcdefghijk.document;assert.equal(doc.cues.length,2);assert.deepEqual(doc.metadata.music_analysis['old-music'].tags,['Music']);const added=doc.cues.find(c=>c.start===12);assert.deepEqual(doc.metadata.music_analysis[added.id].tags,['Piano']);
});

test('disabling autoplay cancels an existing automatic analysis and clears capture evidence',async()=>{
  const h=await harness();await h.enable();await h.send({type:'STOP_CAPTURE'});await h.send({type:'SET_SETTINGS',settings:{...core.DEFAULT_SETTINGS,autoAnalyze:false}});assert.equal(h.storage.operation.phase,'cancelled');assert.ok(h.messages.some(m=>m.type==='CAPTURE_CLEAR'));assert.ok(h.messages.some(m=>m.type==='CAPTURE_DISCARD'));
});
