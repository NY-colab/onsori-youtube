import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import * as core from './core.js';
import {selectFullSource} from './full-source.js';
import {CLOUD} from './cloud-config.js';
import * as aiConfig from './ai-config.js';
const baseDoc={schema_version:'1.0',video_id:'abcdefghijk',title:'영상',duration:30,cues:[{id:'a',start:12,end:14,text:'분석 결과',kind:'speech',scale:1,dbfs:null,relative_db:null,confidence:null,source:'test',review_required:true}],warnings:[],metadata:{audio_analyzed:true,partial:false}};
const toolbar={url:'chrome-extension://test/popup.html'},recorder={url:'chrome-extension://test/offscreen.html'},video={tab:{id:7,url:'https://www.youtube.com/watch?v=abcdefghijk'}};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
// Only the public cloud availability check may leave the worker in local analysis.
const uploads=h=>h.network.map(([u,o])=>[String(u),o?.method||'GET']).filter(([u,m])=>!(m==='GET'&&u===`${CLOUD.origin}/v1/availability`));

test('background panel setup succeeds when foreground tab is not YouTube or no tab is active',async()=>{
  for(const focusedTabs of [[],[{id:42,url:'chrome://extensions/'}]]){
    const h=await harness({focusedTabs});
    const sender={...video,id:'test',frameId:0,url:video.tab.url};
    const result=await h.send({type:'ENABLE_LOCAL'},sender);
    assert.equal(result.ok,true);assert.equal(result.skipped,true);
    assert.equal(h.storage.localConsent.enabled,true);
    assert.equal(h.messages.some(m=>m.type==='FULL_ANALYZE'),false);
    assert.equal((await h.send({type:'ANALYZE_URL'},sender)).ok,true);
    assert.equal(h.storage.operation.mode,'full');
  }
});
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
async function harness(config={}){
  let receiver,onUpdated,onRemoved,url=config.url||'https://www.youtube.com/watch?v=abcdefghijk';
  const storage=structuredClone(config.storage||{}),session=structuredClone(config.session||{}),messages=[],writes=[],network=[];
  const area=data=>({async get(keys){if(config.readGate&&typeof keys==='string'&&keys.startsWith('cc:')&&storage.operation?.phase==='running')await config.readGate;return Object.fromEntries((typeof keys==='string'?[keys]:keys).map(k=>[k,structuredClone(data[k])]));},async set(value){if(config.finalWriteGate&&value.operation?.phase==='done')await config.finalWriteGate;Object.assign(data,structuredClone(value));writes.push(structuredClone(value));},async remove(keys){for(const key of typeof keys==='string'?[keys]:keys)delete data[key];}});
  const chrome={permissions:{async contains(query){return query?.permissions?.includes('nativeMessaging')&&config.nativeGranted===true;}},storage:{local:area(storage),session:area(session)},runtime:{...(config.native?{async sendNativeMessage(host,message){messages.push({type:'NATIVE',host,message});return config.native(host,message);}}:{}),id:'test',getURL:file=>'chrome-extension://test/'+file,async getContexts(){return [];},async sendMessage(message){messages.push(message);if(message.type==='GET_SESSION')return config.activeSession||{ok:true};if(message.type==='CAPTURE_PREPARE'&&config.prepareGate)await config.prepareGate;if(message.type==='CAPTURE_RECORD')return {ok:true,startedAt:Date.now(),startTime:message.startTime+.04};return {ok:true};},onMessage:{addListener(fn){receiver=fn;}}},tabs:{async get(id){if(config.closedTab)throw new Error('No tab');return {id,url:id===9?'https://www.youtube.com/watch?v=zzzzzzzzzzz':url,title:'영상'};},async query(){return config.focusedTabs??[{id:7,url,title:'영상'}];},async sendMessage(id,payload){messages.push({...payload,tabId:id});if(payload.type==='GET_FULL_SOURCE'){if(config.sourceGate)await config.sourceGate;return config.noSource?null:{videoId:core.youtubeId(url),title:'영상',duration:config.duration??300,formats:config.emptyFormats?[]:[{url:'https://r1.googlevideo.com/videoplayback?id=test',mimeType:'audio/mp4',bitrate:64000}],tracks:[]};}if(payload.type==='LOOKUP_FULL_AUDIO'){if(config.lookupGate)await config.lookupGate;return {ok:true,source:{videoId:config.wrongLookup?'zzzzzzzzzzz':core.youtubeId(url),duration:300,url:'https://r1.googlevideo.com/videoplayback?id=fresh',mimeType:'audio/mp4',bytes:4}};}if(payload.type==='NATIVE_CAPTIONS')return {references:config.references||[],frames:config.frames||[]};if(['VIDEO_STATE','PREPARE_CAPTURE'].includes(payload.type))return {videoId:id===9?'zzzzzzzzzzz':core.youtubeId(url),time:config.time??10,duration:config.duration??300,ended:false,paused:payload.type==='VIDEO_STATE'&&Boolean(config.paused),rate:payload.type==='VIDEO_STATE'?(config.rate||1):1,ad:Boolean(config.ad),sampledAt:Date.now(),title:'영상'};return {ok:true};},async create(o){messages.push({type:'TAB_CREATE',...o});},onUpdated:{addListener(fn){onUpdated=fn;}},onRemoved:{addListener(fn){onRemoved=fn;}}},tabCapture:{async getMediaStreamId(options){messages.push({type:'GET_STREAM',...options});if(config.permissionDenied)throw new Error('Extension has not been invoked for the current page');return 'stream';}},offscreen:{async createDocument(o){messages.push({type:'CREATE_OFFSCREEN',...o});}}};
  let source=await readFile(new URL('./worker.js',import.meta.url),'utf8');source="const {normalizeSettings,validateDocument,youtubeId,readyDocument,captionKey}=core;const {AI_CORRECTION,API_KEY_PATTERN,MODEL_ID_PATTERN,apiKeyHint,normalizeCorrection,effectiveCorrection,correctionPayload,serverCorrectionLabel,BRIDGE_HOST,PROVIDERS}=aiConfig;\n"+source.replace(/^import[^\n]+\n/gm,'');
  vm.runInNewContext(source,{core,aiConfig,selectFullSource,CLOUD,AbortSignal,URL,chrome,console,Date,JSON,Number,Object,Array,String,Math,crypto,fetch:async(...args)=>{network.push(args);if(config.cloudFetch)return config.cloudFetch(...args);throw new Error('network forbidden');}});await tick();
  const send=(message,sender=toolbar)=>new Promise(resolve=>receiver(message,sender,resolve));
  const enable=()=>{storage.localConsent={enabled:true};return send({type:'START_CAPTURE'});};const complete=(doc=baseDoc,captureId=storage.operation.captureId)=>send({type:'ANALYSIS_COMPLETE',captureId,document:doc},recorder);
  return {storage,session,messages,writes,network,send,enable,complete,navigate(next){url=next;onUpdated(7,{url:next});},reload(){onUpdated(7,{status:'loading'});},close(){onRemoved(7);}};
}
test('consent is required; embedded extension panel can enable whole analysis without recording',async()=>{
  const h=await harness();await h.send({type:'AUTO_START'},video);await h.send({type:'TOOLBAR_OPEN'});assert.equal(h.messages.some(m=>m.type==='GET_STREAM'),false);
  assert.equal((await h.send({type:'ENABLE_LOCAL'},video)).ok,false);
  const panel={...video,url:'chrome-extension://test/popup.html?view=panel'};
  assert.equal((await h.send({type:'ENABLE_LOCAL'},panel)).ok,true);assert.equal(h.storage.localConsent.enabled,true);assert.equal(h.storage.operation.mode,'full');assert.equal(h.storage.operation.phase,'running');assert.equal(h.messages.some(m=>m.type==='GET_STREAM'),false);
});
test('capture uses browser-only analysis and publishes one atomic final document',async()=>{
  const h=await harness();await h.enable();const id=h.storage.operation.captureId,record=h.messages.find(m=>m.type==='CAPTURE_RECORD');assert.equal(record.options.capture_frames,false);assert.equal(record.startTime,10);
  await h.send({type:'STOP_CAPTURE'});assert.equal(h.storage.operation.phase,'running');await h.send({type:'ANALYSIS_PROGRESS',captureId:id,progress:.4,message:'모델 다운로드 중'},recorder);assert.equal(h.storage.operation.progress,.4);assert.equal((await h.send({type:'GET_STATE'})).document,null);
  await h.complete();const state=await h.send({type:'GET_STATE'});assert.equal(state.operation.phase,'done');assert.equal(state.document.cues[0].text,'분석 결과');assert.deepEqual(h.storage['cc:abcdefghijk'].ranges,[[10.04,30]]);
  const publish=h.writes.find(w=>w.operation?.phase==='done');assert.equal(publish['cc:abcdefghijk'].ready,true);assert.deepEqual(uploads(h),[]);
});
test('language and music options reach full analysis; recording is explicit',async()=>{
  const h=await harness();await h.send({type:'ENABLE_LOCAL',options:{language:'en',music_detail:false,capture_frames:true}});const request=h.messages.find(m=>m.type==='FULL_ANALYZE');assert.equal(request.options.language,'en');assert.equal(request.options.music_detail,false);assert.equal(h.messages.some(m=>m.type==='CAPTURE_RECORD'),false);
});
test('cancel is responsive during prepare and late continuation cannot record',async()=>{
  const gate=deferred(),h=await harness({prepareGate:gate.promise}),pending=h.enable();await tick();assert.equal(h.storage.operation.phase,'preparing');await h.send({type:'CANCEL'});assert.equal(h.storage.operation.phase,'cancelled');gate.resolve();await pending;assert.equal(h.storage.operation.phase,'cancelled');assert.equal(h.messages.some(m=>m.type==='CAPTURE_RECORD'),false);
});
test('cancel during model loading/inference rejects late progress, final results and errors',async()=>{
  const h=await harness();await h.enable();await h.send({type:'STOP_CAPTURE'});const id=h.storage.operation.captureId;await h.send({type:'CANCEL'});
  for(const payload of [{type:'ANALYSIS_PROGRESS',progress:.9},{type:'ANALYSIS_COMPLETE',document:baseDoc},{type:'CAPTURE_ERROR',error:'late'}])await h.send({...payload,captureId:id},recorder);
  assert.equal(h.storage.operation.phase,'cancelled');assert.equal((await h.send({type:'GET_STATE'})).document,null);assert.equal(h.storage['cc:abcdefghijk'],undefined);assert.ok(h.messages.some(m=>m.type==='CAPTURE_DISCARD'&&m.captureId===id));
});
test('cancel racing the final storage write remains terminal and hides the result',async()=>{
  const gate=deferred(),h=await harness({finalWriteGate:gate.promise});await h.enable();await h.send({type:'STOP_CAPTURE'});const completion=h.complete();await tick();const cancelled=h.send({type:'CANCEL'});await tick();gate.resolve();await Promise.all([completion,cancelled]);assert.equal(h.storage.operation.phase,'cancelled');assert.equal(h.storage['cc:abcdefghijk'].ready,false);assert.equal((await h.send({type:'GET_STATE'})).document,null);
});
test('starting another analysis hides old captions; errors never restore them',async()=>{
  const h=await harness();await h.send({type:'IMPORT',document:baseDoc});assert.ok((await h.send({type:'GET_STATE'})).document);await h.enable();await h.send({type:'START_CAPTURE'});assert.equal(h.storage['cc:abcdefghijk'].ready,false);await h.send({type:'CAPTURE_ERROR',captureId:h.storage.operation.captureId,error:'모델 다운로드 실패'},recorder);assert.equal(h.storage.operation.phase,'error');assert.equal((await h.send({type:'GET_STATE'})).document,null);
});
test('partial, transcript-only, mismatched and malformed final results never publish',async()=>{
  for(const doc of [{...baseDoc,metadata:{partial:true,audio_analyzed:true}},{...baseDoc,metadata:{audio_analyzed:false}},{...baseDoc,video_id:'zzzzzzzzzzz'},{...baseDoc,cues:[{...baseDoc.cues[0],end:31}]}]){const h=await harness();await h.enable();await h.send({type:'STOP_CAPTURE'});assert.equal((await h.complete(doc)).ok,false);assert.equal(h.storage['cc:abcdefghijk'],undefined);assert.equal((await h.send({type:'GET_STATE'})).document,null);}
});
test('foreign sender and stale capture cannot update an active analysis',async()=>{
  const h=await harness();await h.enable();await h.send({type:'STOP_CAPTURE'});const id=h.storage.operation.captureId;assert.equal((await h.send({type:'ANALYSIS_COMPLETE',captureId:id,document:baseDoc},video)).ok,false);await h.send({type:'ANALYSIS_COMPLETE',captureId:'old',document:baseDoc},recorder);assert.equal(h.storage.operation.phase,'running');assert.equal(h.storage['cc:abcdefghijk'],undefined);
});
test('SPA navigation, full reload and tab removal cancel inference as well as recording',async()=>{
  for(const action of ['navigate','reload','close']){const h=await harness();await h.enable();await h.send({type:'STOP_CAPTURE'});const id=h.storage.operation.captureId;h[action]('https://www.youtube.com/watch?v=zzzzzzzzzzz');await tick();assert.equal(h.storage.operation.phase,'cancelled');await h.complete(baseDoc,id);assert.equal(h.storage['cc:abcdefghijk'],undefined);}
  const h=await harness();await h.enable();await h.send({type:'STOP_CAPTURE'});await h.send({type:'VIDEO_NAVIGATED',videoId:'zzzzzzzzzzz'},video);assert.equal(h.storage.operation.phase,'cancelled');
});
test('whole auto analysis works while paused or accelerated and never obtains a tab stream',async()=>{
  for(const config of [{paused:true},{rate:2}]){const h=await harness(config);await h.send({type:'ENABLE_LOCAL'});assert.equal(h.storage.operation.mode,'full');assert.equal(h.messages.some(m=>m.type==='GET_STREAM'),false);}
  for(const config of [{ad:true},{storage:{settings:{enabled:false}}},{storage:{settings:{autoAnalyze:false}}}]){const h=await harness(config);await h.send({type:'ENABLE_LOCAL'});assert.equal(h.messages.some(m=>m.type==='FULL_ANALYZE'),false);}
  const h=await harness({storage:{localConsent:{enabled:true}}});await h.send({type:'AUTO_START'},{tab:{id:9,url:'https://www.youtube.com/watch?v=zzzzzzzzzzz'}});assert.equal(h.messages.some(m=>m.type==='FULL_ANALYZE'),false);
});
test('source unavailable does not automatically record or retry, manual retry allowed',async()=>{
  const config={noSource:true,storage:{localConsent:{enabled:true}}},h=await harness(config);await h.send({type:'AUTO_START'},video);assert.equal(h.storage.operation.phase,'error');await h.send({type:'AUTO_START'},video);assert.equal(h.messages.filter(m=>m.type==='GET_FULL_SOURCE').length,1);assert.equal(h.messages.some(m=>m.type==='GET_STREAM'),false);config.noSource=false;assert.equal((await h.send({type:'ANALYZE_URL'})).ok,true);assert.equal(h.storage.operation.mode,'full');
});
test('cancelled autoplay stays suppressed but manual capture can restart',async()=>{
  const h=await harness();await h.enable();await h.send({type:'CANCEL'});await h.send({type:'AUTO_START'},video);assert.equal(h.storage.operation.phase,'cancelled');await h.send({type:'START_CAPTURE'});assert.equal(h.storage.operation.phase,'capturing');
});
test('completed silence coverage suppresses repeat auto recording',async()=>{
  const config={time:10},h=await harness(config);await h.enable();await h.send({type:'STOP_CAPTURE'});await h.complete({...baseDoc,cues:[]});config.time=15;assert.equal((await h.send({type:'AUTO_START'},video)).skipped,true);assert.equal(h.messages.filter(m=>m.type==='GET_STREAM').length,1);
});
test('embedded panel reads and imports its own video without changing active tab captions',async()=>{
  const h=await harness(),panel={tab:{id:9,url:'https://www.youtube.com/watch?v=zzzzzzzzzzz'},url:'chrome-extension://test/popup.html?view=panel'};await h.send({type:'IMPORT',document:baseDoc});assert.equal((await h.send({type:'IMPORT',document:baseDoc},panel)).ok,false);await h.send({type:'IMPORT',document:{...baseDoc,video_id:'zzzzzzzzzzz'}},panel);assert.equal((await h.send({type:'GET_STATE'},panel)).videoId,'zzzzzzzzzzz');await h.send({type:'REMOVE_DOCUMENT'},panel);assert.ok(h.storage['cc:abcdefghijk']);assert.equal(h.storage['cc:zzzzzzzzzzz'],undefined);
});
test('service-worker restart resumes existing offscreen analysis without recording anew',async()=>{
  const operation={phase:'running',captureId:'one',videoId:'abcdefghijk',tabId:7,startTime:10,capture:true};const h=await harness({storage:{operation,localConsent:{enabled:true}},activeSession:{ok:true,captureId:'one',analyzing:true}});assert.equal(h.storage.operation.phase,'running');await h.send({type:'ANALYSIS_PROGRESS',captureId:'one',progress:.5,message:'분석 중'},recorder);await h.complete(baseDoc,'one');assert.equal(h.storage.operation.phase,'done');assert.equal(h.messages.some(m=>m.type==='GET_STREAM'),false);
});
test('orphaned operation becomes actionable error with no automatic recording',async()=>{
  const h=await harness({storage:{operation:{phase:'running',captureId:'lost',videoId:'abcdefghijk',tabId:7}}});assert.equal(h.storage.operation.phase,'error');assert.equal(h.messages.some(m=>m.type==='GET_STREAM'),false);
});
test('full analysis requires consent and help opens bundled local page',async()=>{const h=await harness();assert.equal((await h.send({type:'ANALYZE_URL'})).ok,false);await h.send({type:'OPEN_HELP'});assert.ok(h.messages.some(m=>m.type==='TAB_CREATE'&&m.url==='chrome-extension://test/help.html'));assert.deepEqual(uploads(h),[]);});

test('explicit recording permission failure waits and never starts automatic recording',async()=>{
  const config={permissionDenied:true},h=await harness(config);await h.enable();assert.equal(h.storage.operation.phase,'waiting_permission');const before=h.messages.filter(m=>m.type==='GET_STREAM').length;await h.send({type:'AUTO_START'},video);assert.equal(h.messages.filter(m=>m.type==='GET_STREAM').length,before);config.permissionDenied=false;await h.send({type:'START_CAPTURE'});assert.equal(h.storage.operation.phase,'capturing');
});
test('range merge retains only verified cues outside new interval and remaps music evidence',async()=>{
  const music={...baseDoc,cues:[{...baseDoc.cues[0],id:'old-music',kind:'music',start:1,end:3}],metadata:{audio_analyzed:true,music_analysis:{'old-music':{tags:['Music']}}}};
  const h=await harness();await h.send({type:'IMPORT',document:music});await h.enable();await h.send({type:'START_CAPTURE'});await h.send({type:'STOP_CAPTURE'});await h.complete({...baseDoc,cues:[{...baseDoc.cues[0],id:'new-music',kind:'music'}],metadata:{audio_analyzed:true,music_analysis:{'new-music':{tags:['Piano']}}}});const doc=h.storage['cc:abcdefghijk'].document;assert.equal(doc.cues.length,2);assert.deepEqual(doc.metadata.music_analysis['old-music'].tags,['Music']);const added=doc.cues.find(c=>c.start===12);assert.deepEqual(doc.metadata.music_analysis[added.id].tags,['Piano']);
});

test('disabling autoplay cancels an existing automatic analysis and clears capture evidence',async()=>{
  const h=await harness();await h.send({type:'ENABLE_LOCAL'});await h.send({type:'SET_SETTINGS',settings:{...core.DEFAULT_SETTINGS,autoAnalyze:false}});assert.equal(h.storage.operation.phase,'cancelled');assert.ok(h.messages.some(m=>m.type==='CAPTURE_CLEAR'));assert.ok(h.messages.some(m=>m.type==='CAPTURE_DISCARD'));
});

test('whole result is complete and atomic, and wrong length/clip result cannot publish',async()=>{
 const h=await harness();await h.send({type:'ENABLE_LOCAL'});const d={...baseDoc,duration:300,metadata:{audio_analyzed:true,partial:false,analysis_scope:'full-video'}};
 assert.equal((await h.complete(baseDoc)).ok,false);assert.equal((await h.complete({...d,duration:30})).ok,false);assert.equal((await h.send({type:'GET_STATE'})).document,null);
 await h.complete(d);assert.equal(h.storage.operation.phase,'done');assert.equal(h.storage['cc:abcdefghijk'].document.duration,300);assert.deepEqual(h.storage['cc:abcdefghijk'].ranges,[[0,300]]);assert.equal((await h.send({type:'AUTO_START'},video)).cached,true);assert.equal(h.messages.some(m=>m.type==='GET_STREAM'),false);
});
test('cancel while full source pending cannot launch a late download',async()=>{
 const gate=deferred(),h=await harness({sourceGate:gate.promise}),pending=h.send({type:'ENABLE_LOCAL'});await tick();await h.send({type:'CANCEL'});gate.resolve();await pending;assert.equal(h.storage.operation.phase,'cancelled');assert.equal(h.messages.some(m=>m.type==='FULL_ANALYZE'),false);
});

test('direct panel consent accepts only own top-level YouTube content script',async()=>{
  const good={id:'test',frameId:0,url:'https://www.youtube.com/watch?v=abcdefghijk',...video};
  for(const overrides of [{id:'foreign'},{frameId:2},{url:'https://example.com/watch?v=abcdefghijk'}]){
    const h=await harness();assert.equal((await h.send({type:'ENABLE_LOCAL'},{...good,...overrides})).ok,false);
    assert.equal(h.storage.localConsent,undefined);
  }
  const h=await harness();assert.equal((await h.send({type:'ENABLE_LOCAL'},good)).ok,true);
  assert.equal(h.storage.localConsent.enabled,true);assert.equal(h.storage.operation.mode,'full');
  assert.equal(h.messages.some(m=>m.type==='GET_STREAM'),false);
});

test('empty streaming formats still launch direct lookup while video is paused',async()=>{
 const h=await harness({emptyFormats:true,paused:true});await h.send({type:'ENABLE_LOCAL'});
 assert.equal(h.storage.operation.phase,'running');const m=h.messages.find(m=>m.type==='FULL_ANALYZE');assert.equal(m.source.url,null);assert.equal(m.source.duration,300);
 assert.equal(h.messages.some(m=>['GET_STREAM','PREPARE_CAPTURE','CAPTURE_RECORD','VIDEO_SEEK'].includes(m.type)),false);
});

test('audio lookup runs in the owning YouTube tab and rejects foreign, stale and mismatched requests',async()=>{
 const h=await harness();await h.send({type:'ENABLE_LOCAL'});const captureId=h.storage.operation.captureId;
 assert.equal((await h.send({type:'FULL_AUDIO_LOOKUP',captureId},video)).ok,false);
 assert.equal((await h.send({type:'FULL_AUDIO_LOOKUP',captureId:'stale'},recorder)).ignored,true);
 const result=await h.send({type:'FULL_AUDIO_LOOKUP',captureId},recorder);assert.equal(result.ok,true);assert.equal(result.source.transport,'youtube-page-visionos');assert.equal(h.messages.find(m=>m.type==='LOOKUP_FULL_AUDIO').tabId,7);assert.deepEqual(uploads(h),[]);
 const bad=await harness({wrongLookup:true});await bad.send({type:'ENABLE_LOCAL'});assert.equal((await bad.send({type:'FULL_AUDIO_LOOKUP',captureId:bad.storage.operation.captureId},recorder)).ok,false);
});
test('cancellation aborts a pending page lookup and discards its late source',async()=>{
 const gate=deferred(),h=await harness({lookupGate:gate.promise});await h.send({type:'ENABLE_LOCAL'});const captureId=h.storage.operation.captureId;
 const pending=h.send({type:'FULL_AUDIO_LOOKUP',captureId},recorder);await tick();await h.send({type:'CANCEL'});gate.resolve();assert.equal((await pending).ok,false);assert.ok(h.messages.some(m=>m.type==='CANCEL_AUDIO_LOOKUP'&&m.captureId===captureId));assert.equal(h.storage.operation.phase,'cancelled');
});

const cloudServer=({available=true,synthetic=false,issue=[]}={})=>async(url,options={})=>{
  if(url===`${CLOUD.origin}/v1/availability`)return new Response(JSON.stringify({available,synthetic,scope:'speech-only',install_daily_audio_minutes:20}),{status:200});
  if(url===`${CLOUD.origin}/v1/installs`&&options.method==='POST'){const key='osi_'+String(issue.length).repeat(43).slice(0,43);issue.push(key);return new Response(JSON.stringify({install_key:key,daily_audio_minutes:20}),{status:201});}
  return new Response('{}',{status:404});
};

test('cloud speech is offered only for real analysis and only after consent from the panel',async()=>{
  const h=await harness({storage:{localConsent:{enabled:true}},cloudFetch:cloudServer()});
  let state=await h.send({type:'GET_STATE'});
  assert.equal(state.cloud.offered,true);assert.equal(state.cloud.consent,null);assert.equal(state.cloud.dailyMinutes,20);
  assert.equal((await h.send({type:'SET_CLOUD_CONSENT',choice:'granted'},{url:'https://evil.example/'})).ok,false);
  assert.equal((await h.send({type:'SET_CLOUD_CONSENT',choice:'maybe'})).ok,false);
  assert.equal((await h.send({type:'SET_CLOUD_CONSENT',choice:'granted'})).ok,true);
  assert.equal(h.storage.cloudConsent.choice,'granted');assert.equal(h.storage.cloudConsent.version,CLOUD.consentVersion);
  state=await h.send({type:'GET_STATE'});assert.equal(state.cloud.consent,'granted');
  await h.send({type:'ANALYZE_URL'});
  assert.equal(JSON.stringify(h.messages.find(m=>m.type==='FULL_ANALYZE').cloud),JSON.stringify({enabled:true,allowSynthetic:false}));
  assert.deepEqual(uploads(h),[]);
  const declined=await harness({storage:{localConsent:{enabled:true},cloudConsent:{choice:'declined',version:CLOUD.consentVersion}},cloudFetch:cloudServer()});
  await declined.send({type:'ANALYZE_URL'});assert.equal(declined.messages.find(m=>m.type==='FULL_ANALYZE').cloud.enabled,false);
});

test('a synthetic or unreachable server is never offered to users',async()=>{
  for(const config of [{cloudFetch:cloudServer({synthetic:true})},{cloudFetch:cloudServer({available:false})},{}]){
    const h=await harness({storage:{localConsent:{enabled:true},cloudConsent:{choice:'granted',version:CLOUD.consentVersion}},...config});
    assert.equal((await h.send({type:'GET_STATE'})).cloud.offered,false);
    await h.send({type:'ANALYZE_URL'});assert.equal(h.messages.find(m=>m.type==='FULL_ANALYZE').cloud.enabled,false);
  }
  const qa=await harness({storage:{localConsent:{enabled:true},cloudConsent:{choice:'granted',version:CLOUD.consentVersion},cloudTest:{allowSynthetic:true}},cloudFetch:cloudServer({synthetic:true})});
  await qa.send({type:'ANALYZE_URL'});assert.equal(JSON.stringify(qa.messages.find(m=>m.type==='FULL_ANALYZE').cloud),JSON.stringify({enabled:true,allowSynthetic:true}));
});

test('install keys are issued once, renewed on request and given only to the active analysis document',async()=>{
  const issue=[],h=await harness({storage:{localConsent:{enabled:true},cloudConsent:{choice:'granted',version:CLOUD.consentVersion}},cloudFetch:cloudServer({issue})});
  await h.send({type:'ANALYZE_URL'});const captureId=h.storage.operation.captureId;
  assert.equal((await h.send({type:'CLOUD_KEY',captureId},toolbar)).ok,false);
  assert.equal((await h.send({type:'CLOUD_KEY',captureId:'stale'},recorder)).ignored,true);
  const first=await h.send({type:'CLOUD_KEY',captureId},recorder);
  assert.equal(first.key,issue[0]);assert.equal(h.storage.cloudInstall.key,issue[0]);
  assert.equal((await h.send({type:'CLOUD_KEY',captureId},recorder)).key,issue[0]);
  assert.equal((await h.send({type:'CLOUD_KEY',captureId,renew:true},recorder)).key,issue[1]);
  assert.equal(issue.length,2);
});

// ---- 0.4.0: streamed minutes, resume, per-video storage, Claude Haiku key handling ----
const minute=(ranges,partial=true)=>({...baseDoc,duration:300,metadata:{audio_analyzed:true,partial,progressive:true,analysis_scope:'full-video',analyzed_ranges:ranges,speech_language:'ko'}});
const saveMinute=(h,doc)=>h.send({type:'ANALYSIS_CHUNK',captureId:h.storage.operation.captureId,document:doc},recorder);
const settle=async()=>{for(let i=0;i<6;i++)await tick();};
test('each streamed minute is saved and shown while the rest runs, and a reload keeps the analysis going',async()=>{
  const h=await harness();await h.send({type:'ENABLE_LOCAL'});assert.equal(h.storage.operation.phase,'running');
  assert.equal((await saveMinute(h,minute([[0,60]]))).ok,true);
  const entry=h.storage['cc:abcdefghijk'];assert.equal(entry.ready,true);assert.equal(entry.document.metadata.partial,true);assert.deepEqual(entry.ranges,[[0,60]]);
  assert.equal((await h.send({type:'GET_STATE'})).document.cues.length,1);
  assert.ok(h.messages.some(m=>m.type==='DOCUMENT_UPDATED'&&m.tabId===7));
  assert.equal((await saveMinute(h,{...minute([[0,60]]),video_id:'zzzzzzzzzzz'})).ok,false);
  assert.equal((await saveMinute(h,{...minute([[0,60]]),metadata:{...minute([[0,60]]).metadata,progressive:false}})).ok,false);
  assert.equal((await saveMinute(h,{...minute([[0,60]]),duration:30})).ok,false);
  h.reload();await settle();assert.equal(h.storage.operation.phase,'running');
  assert.equal((await h.send({type:'AUTO_START'},video)).skipped,true);
  await h.complete(minute([[0,300]],false));assert.equal(h.storage.operation.phase,'done');assert.deepEqual(h.storage['cc:abcdefghijk'].ranges,[[0,300]]);
  assert.equal((await h.send({type:'AUTO_START'},video)).cached,true);assert.equal(h.messages.filter(m=>m.type==='FULL_ANALYZE').length,1);
});
test('leaving the video pauses streaming; coming back analyzes only the remaining minutes',async()=>{
  const h=await harness();await h.send({type:'ENABLE_LOCAL'});await saveMinute(h,minute([[0,60]]));
  h.navigate('https://www.youtube.com/watch?v=zzzzzzzzzzz');await settle();
  assert.equal(h.storage.operation.phase,'cancelled');assert.equal(h.storage['cc:abcdefghijk'].ready,true);
  h.navigate('https://www.youtube.com/watch?v=abcdefghijk');await settle();
  assert.equal((await h.send({type:'AUTO_START'},video)).ok,true);
  const runs=h.messages.filter(m=>m.type==='FULL_ANALYZE');assert.equal(runs.length,2);assert.deepEqual(runs[1].resume.metadata.analyzed_ranges,[[0,60]]);assert.equal(h.storage.operation.resume,true);
  assert.equal((await h.send({type:'GET_STATE'})).document.cues.length,1);
  // A fresh run replaces a finished result: it hides the old one until its first minute is saved.
  await h.complete(minute([[0,300]],false));await h.send({type:'ANALYZE_URL'});assert.equal(h.storage.operation.resume,false);assert.equal(h.storage['cc:abcdefghijk'].ready,false);
});
test('a user cancel or a failure stops automatic resume; the saved minutes stay and a manual start resumes',async()=>{
  const h=await harness();await h.send({type:'ENABLE_LOCAL'});await saveMinute(h,minute([[0,60]]));await h.send({type:'CANCEL'});
  assert.equal(h.storage['cc:abcdefghijk'].ready,true);assert.equal((await h.send({type:'AUTO_START'},video)).skipped,true);
  await h.send({type:'ANALYZE_URL'});assert.ok(h.messages.filter(m=>m.type==='FULL_ANALYZE').at(-1).resume);
  await h.send({type:'CAPTURE_ERROR',captureId:h.storage.operation.captureId,error:'모델 실패'},recorder);assert.equal(h.storage.operation.phase,'error');assert.equal(h.storage['cc:abcdefghijk'].ready,true);
  assert.equal((await h.send({type:'AUTO_START'},video)).skipped,true);assert.equal(h.messages.filter(m=>m.type==='FULL_ANALYZE').length,2);
});
test('the analysis document asks the owning tab for its playhead only while it runs',async()=>{
  const h=await harness({time:95});await h.send({type:'ENABLE_LOCAL'});
  const position=await h.send({type:'PLAYBACK_POSITION',captureId:h.storage.operation.captureId},recorder);assert.equal(position.time,95);
  assert.equal((await h.send({type:'PLAYBACK_POSITION',captureId:'stale'},recorder)).ignored,true);
  assert.equal((await h.send({type:'PLAYBACK_POSITION',captureId:h.storage.operation.captureId},video)).ok,false);
});
test('the Anthropic key is stored only from the settings page and reaches only the analysis document',async()=>{
  const KEY='sk-ant-api03-'+'a'.repeat(32)+'wxyz',settings={id:'test',tab:{id:12,url:'chrome-extension://test/ai-settings.html'},url:'chrome-extension://test/ai-settings.html'},panel={...video,url:'chrome-extension://test/popup.html?view=panel'};
  const h=await harness();
  assert.equal((await h.send({type:'SET_CORRECTION_KEY',apiKey:KEY},video)).ok,false);assert.equal((await h.send({type:'SET_CORRECTION_KEY',apiKey:KEY},toolbar)).ok,false);
  assert.equal((await h.send({type:'SET_CORRECTION_KEY',apiKey:'not-a-key'},settings)).ok,false);assert.equal(h.storage.aiCorrection,undefined);
  assert.equal((await h.send({type:'SET_CORRECTION',enabled:true},panel)).ok,false);
  const saved=await h.send({type:'SET_CORRECTION_KEY',apiKey:KEY,enable:true},settings);assert.equal(saved.enabled,true);assert.equal(saved.keyHint,'sk-ant-api…wxyz');assert.equal(h.storage.aiCorrection.apiKey,KEY);
  const state=await h.send({type:'GET_STATE'});assert.equal(state.correction.enabled,true);assert.equal(state.correction.provider,'api');assert.equal(state.correction.hasKey,true);assert.equal(state.correction.model,'claude-haiku-5-5');assert.equal(JSON.stringify(state).includes(KEY),false);
  assert.equal((await h.send({type:'GET_CORRECTION'},video)).ok,false);assert.equal(JSON.stringify(await h.send({type:'GET_CORRECTION'},settings)).includes(KEY),false);
  await h.send({type:'ENABLE_LOCAL'});const full=h.messages.find(m=>m.type==='FULL_ANALYZE');assert.equal(full.correction.apiKey,KEY);assert.equal(full.correction.model,'claude-haiku-5-5');
  assert.equal((await h.send({type:'SET_CORRECTION',enabled:false},panel)).ok,true);await h.send({type:'CANCEL'});await h.send({type:'ANALYZE_URL'});assert.equal(h.messages.filter(m=>m.type==='FULL_ANALYZE').at(-1).correction,null);
  await h.send({type:'SET_CORRECTION_KEY',apiKey:''},settings);assert.equal(h.storage.aiCorrection.apiKey,'');assert.equal(h.storage.aiCorrection.provider,'cli');assert.equal((await h.send({type:'GET_STATE'})).correction.ready,false);
  assert.equal((await h.send({type:'SET_CORRECTION',enabled:true},panel)).ok,false);
  await h.send({type:'OPEN_AI_SETTINGS'},panel);assert.ok(h.messages.some(m=>m.type==='TAB_CREATE'&&m.url==='chrome-extension://test/ai-settings.html'));
});
test('0.3.x caption cache moves to per-video keys, and the oldest videos are evicted past the limit',async()=>{
  const old={abcdefghijk:{document:{...baseDoc,metadata:{audio_analyzed:true,partial:false}},ready:true,displayVersion:2,origin:'import',savedAt:5,ranges:[[0,30]]}};
  const h=await harness({storage:{captionCache:old}});const state=await h.send({type:'GET_STATE'});assert.equal(state.document.cues[0].text,'분석 결과');
  assert.equal(h.storage.captionCache,undefined);assert.equal(h.storage['cc:abcdefghijk'].savedAt,5);assert.equal(h.storage.captionIndex.abcdefghijk.complete,true);
  const storage={captionIndex:{}};for(let i=0;i<60;i++){const id=`v${String(i).padStart(10,'0')}`;storage.captionIndex[id]={savedAt:i+1,bytes:100,complete:true};storage['cc:'+id]={ready:true};}
  const full=await harness({storage});await full.send({type:'IMPORT',document:baseDoc});
  assert.equal(Object.keys(full.storage.captionIndex).length,60);assert.equal(full.storage['cc:v0000000000'],undefined);assert.ok(full.storage['cc:v0000000001']);assert.ok(full.storage['cc:abcdefghijk']);
  await full.send({type:'REMOVE_DOCUMENT'});assert.equal(full.storage['cc:abcdefghijk'],undefined);assert.equal(full.storage.captionIndex.abcdefghijk,undefined);
});
test('a tab recording on a partly streamed video keeps the saved minutes',async()=>{
  const h=await harness();await h.send({type:'ENABLE_LOCAL'});
  await saveMinute(h,{...minute([[60,120]]),cues:[{...baseDoc.cues[0],id:'m600-a',start:100,end:102,text:'저장된 분'}]});await h.send({type:'CANCEL'});
  await h.enable();await h.send({type:'STOP_CAPTURE'});await h.complete({...baseDoc,cues:[{...baseDoc.cues[0],start:20,end:22,text:'녹음 구간'}]});
  assert.deepEqual(h.storage['cc:abcdefghijk'].document.cues.map(c=>c.text),['녹음 구간','저장된 분']);
});

test('with the bridge on this PC, correction runs through Claude Code with no setup; only the analysis can relay text',async()=>{
  const settings={id:'test',tab:{id:12,url:'chrome-extension://test/ai-settings.html'},url:'chrome-extension://test/ai-settings.html'},panel={...video,url:'chrome-extension://test/popup.html?view=panel'};
  const replies={correct:{ok:true,corrections:[{id:'a',text:'고친 대사'}],model:'claude-haiku-5-5',usage:{input_tokens:1,output_tokens:1}},status:{ok:true,version:'2.1.89 (Claude Code)',loggedIn:true,authMethod:'claude.ai',subscription:'team'}};
  const h=await harness({native:(host,message)=>replies[message.type]});
  // Nothing stored, nothing chosen: the bridge alone turns correction on.
  const state=await h.send({type:'GET_STATE'});assert.equal(h.storage.aiCorrection,undefined);
  assert.equal(state.correction.enabled,true);assert.equal(state.correction.provider,'cli');assert.equal(state.correction.auto,true);assert.equal(state.correction.bridge.subscription,'team');
  await h.send({type:'ENABLE_LOCAL'});assert.deepEqual({...h.messages.find(m=>m.type==='FULL_ANALYZE').correction},{enabled:true,provider:'cli',model:'claude-haiku-5-5'});
  const payload={title:'영상',context:[],lines:[{id:'a',text:'고칠 대사'}]};
  assert.equal((await h.send({type:'CLI_CORRECT',captureId:h.storage.operation.captureId,payload},recorder)).corrections[0].text,'고친 대사');
  const relayed=h.messages.filter(m=>m.type==='NATIVE'&&m.message.type==='correct').at(-1);assert.equal(relayed.host,'com.onsori.claude_bridge');assert.deepEqual(relayed.message.payload,payload);
  const before=h.messages.filter(m=>m.type==='NATIVE').length;
  assert.equal((await h.send({type:'CLI_CORRECT',captureId:'stale',payload},recorder)).ignored,true);
  assert.equal((await h.send({type:'CLI_CORRECT',captureId:h.storage.operation.captureId,payload},video)).ok,false);
  assert.equal(h.messages.filter(m=>m.type==='NATIVE').length,before);
  // The status probe is cached: panels refreshing do not start claude.exe each time.
  const probes=()=>h.messages.filter(m=>m.type==='NATIVE'&&m.message.type==='status').length,cachedProbes=probes();
  await h.send({type:'GET_STATE'});await h.send({type:'GET_STATE'});assert.equal(probes(),cachedProbes);
  // Off from the panel is remembered; on again restores the automatic Claude Code path.
  assert.equal((await h.send({type:'SET_CORRECTION',enabled:false},panel)).correction.enabled,false);assert.equal(h.storage.aiCorrection.optOut,true);
  await h.send({type:'CANCEL'});await h.send({type:'ANALYZE_URL'});assert.equal(h.messages.filter(m=>m.type==='FULL_ANALYZE').at(-1).correction,null);
  assert.equal((await h.send({type:'SET_CORRECTION',enabled:true},panel)).correction.enabled,true);
  assert.equal((await h.send({type:'CLI_STATUS'},settings)).subscription,'team');assert.equal((await h.send({type:'CLI_STATUS'},panel)).ok,false);
  assert.equal((await h.send({type:'CLI_TEST'},settings)).corrections[0].text,'고친 대사');
  assert.equal((await h.send({type:'SET_CORRECTION_PROVIDER',provider:'api'},panel)).ok,false);
  const chosen=await h.send({type:'SET_CORRECTION_PROVIDER',provider:'api'},settings);assert.equal(chosen.provider,'cli','without a key the bridge still serves');assert.equal(chosen.extensionId,'test');
  // A PC without the bridge, or signed out of Claude Code: nothing runs and the panel says why.
  for(const native of [()=>{throw new Error('Specified native messaging host not found.');},()=>{throw new Error('Access to the specified native messaging host is forbidden.');},(host,message)=>message.type==='status'?{...replies.status,loggedIn:false}:replies.correct]){
    const other=await harness({native});const view=(await other.send({type:'GET_STATE'})).correction;assert.equal(view.ready,false);assert.equal(view.enabled,false);
    await other.send({type:'ENABLE_LOCAL'});assert.equal(other.messages.find(m=>m.type==='FULL_ANALYZE').correction,null);
  }
  assert.equal((await (await harness({native:()=>{throw new Error('Specified native messaging host not found.');}})).send({type:'CLI_STATUS'},settings)).code,'bridge_missing');
  assert.equal((await (await harness()).send({type:'CLI_STATUS'},settings)).code,'no_permission');
});
test('without Claude Code on the PC, the OnSori server corrects with its own key; the install sends only caption text',async()=>{
  const calls=[];let mode='ok';const json=(status,body)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
  const cloudFetch=async(url,init={})=>{const u=String(url);calls.push({url:u,method:init.method||'GET',auth:init.headers?.Authorization||null,body:init.body||null});
    if(u.endsWith('/v1/availability'))return json(200,{available:false,synthetic:false,corrections:true,corrections_synthetic:false,correction_provider:'deepinfra',correction_model:'deepseek-ai/DeepSeek-V4-Flash-0731'});
    if(u.endsWith('/v1/installs'))return json(201,{install_key:'osi_'+'k'.repeat(43)});
    if(u.endsWith('/v1/corrections'))return mode==='ok'?json(200,{corrections:[{id:'a',text:'고친 대사'}],model:'deepseek-ai/DeepSeek-V4-Flash-0731',usage:{input_tokens:3,output_tokens:2}}):mode==='limit'?json(429,{detail:'install_daily_correction_limit'}):json(503,{detail:'correction_disabled'});
    return json(404,{});};
  const h=await harness({cloudFetch});
  const state=await h.send({type:'GET_STATE'});assert.equal(state.correction.provider,'cloud');assert.equal(state.correction.enabled,true);assert.equal(state.correction.server.available,true);assert.equal(h.storage.aiCorrection,undefined);
  assert.deepEqual({...state.correction.server},{available:true,provider:'deepinfra',model:'deepseek-ai/DeepSeek-V4-Flash-0731'});
  assert.equal(state.correction.label,'DeepInfra · DeepSeek V4 Flash');assert.equal(state.correction.model,'deepseek-ai/DeepSeek-V4-Flash-0731');
  await h.send({type:'ENABLE_LOCAL'});assert.deepEqual({...h.messages.find(m=>m.type==='FULL_ANALYZE').correction},{enabled:true,provider:'cloud',model:'deepseek-ai/DeepSeek-V4-Flash-0731'});
  const captureId=h.storage.operation.captureId,payload={title:'영상',context:['앞'],lines:[{id:'a',text:'고칠 대사'}],system:'다른 지시'};
  const reply=await h.send({type:'CLOUD_CORRECT',captureId,payload},recorder);assert.equal(reply.ok,true);assert.equal(reply.corrections[0].text,'고친 대사');
  const post=calls.find(c=>c.url.endsWith('/v1/corrections'));assert.equal(post.method,'POST');assert.equal(post.auth,'Bearer osi_'+'k'.repeat(43));
  assert.deepEqual(JSON.parse(post.body),{title:'영상',context:['앞'],lines:[{id:'a',text:'고칠 대사'}]});assert.equal(post.body.includes('sk-ant'),false);
  const before=calls.length;assert.equal((await h.send({type:'CLOUD_CORRECT',captureId:'stale',payload},recorder)).ignored,true);assert.equal((await h.send({type:'CLOUD_CORRECT',captureId,payload},video)).ok,false);assert.equal(calls.length,before);
  mode='limit';assert.equal((await h.send({type:'CLOUD_CORRECT',captureId,payload},recorder)).code,'cloud_limit');
  mode='off';assert.equal((await h.send({type:'CLOUD_CORRECT',captureId,payload},recorder)).code,'cloud_unavailable');
  // This PC's Claude Code still comes first when the bridge answers.
  const both=await harness({cloudFetch,native:(host,message)=>message.type==='status'?{ok:true,version:'2.1.89',loggedIn:true,subscription:'team'}:{ok:true,corrections:[]}});
  assert.equal((await both.send({type:'GET_STATE'})).correction.provider,'cli');
});
