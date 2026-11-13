import {selectFullSource} from './full-source.js';
import {normalizeSettings,validateDocument,youtubeId,readyDocument,captionKey} from './core.js';
import {CLOUD} from './cloud-config.js';
import {AI_CORRECTION,API_KEY_PATTERN,MODEL_ID_PATTERN,apiKeyHint,normalizeCorrection,effectiveCorrection,correctionPayload,serverCorrectionLabel,BRIDGE_HOST,PROVIDERS} from './ai-config.js';
const busyPhases=['requesting','preparing','capturing','uploading','queued','running'];
const captureMessages=['CLOUD_KEY','CLI_CORRECT','CLOUD_CORRECT','FULL_AUDIO_LOOKUP','PLAYBACK_POSITION','ANALYSIS_CHUNK','CAPTURE_REFERENCES','CAPTURE_LEVEL','CAPTURE_LIMIT','CAPTURE_ANALYZING','ANALYSIS_PROGRESS','ANALYSIS_COMPLETE','CAPTURE_ERROR'];
let creatingOffscreen,mutation=Promise.resolve(),writes=Promise.resolve(),operationEpoch=0;
const messageError=e=>/Extension has not been invoked|activeTab permission/i.test(e?.message||'')?'현재 YouTube 영상에서 Chrome 도구 모음의 온소리 아이콘을 직접 눌러 녹음을 연결해 주세요.':e?.message||String(e);
const state=async()=>(await chrome.storage.local.get('operation')).operation||{phase:'idle',message:'분석할 YouTube 영상을 선택해 주세요.'};
const write=task=>{const next=writes.then(task);writes=next.catch(()=>{});return next;};
async function notify(tabId,payload){try{return await chrome.tabs.sendMessage(tabId,payload);}catch{return null;}}
function analysisOptions(v={}){return {language:['ko','auto','en'].includes(v.language)?v.language:'ko',event_detection:true,use_caption_references:v.use_caption_references!==false,capture_frames:v.capture_frames===true,music_detail:v.music_detail!==false};}
async function activeTab(){const [tab]=await chrome.tabs.query({active:true,currentWindow:true});if(!tab?.id||!youtubeId(tab.url))throw new Error('YouTube 영상 페이지에서 열어 주세요. 설치 직후라면 페이지를 새로고침해 주세요.');return tab;}
async function requestTab(sender={}){if(!sender.tab)return activeTab();const tab=await chrome.tabs.get(sender.tab.id);if(!tab?.id||!youtubeId(tab.url))throw new Error('YouTube 영상 페이지에서 사용해 주세요.');return tab;}
const toolbarSender=sender=>!sender.tab&&sender.url===chrome.runtime.getURL('popup.html');
async function grant(tab){await chrome.storage.session.set({toolbarGrant:{tabId:tab.id,videoId:youtubeId(tab.url)}});}
async function hasGrant(tab){const {toolbarGrant}=await chrome.storage.session.get('toolbarGrant');return toolbarGrant?.tabId===tab.id&&toolbarGrant.videoId===youtubeId(tab.url);}
// Each video's captions live under their own key (cc:<videoId>) with a small index for
// eviction, so saving one minute never rewrites or re-broadcasts every other video.
const CACHE_LIMITS=Object.freeze({entries:60,bytes:40_000_000,entryBytes:8_000_000});
async function readEntry(id){if(!id)return null;const key=captionKey(id);return (await chrome.storage.local.get(key))[key]||null;}
async function cacheUpdate(id,entry,extra={}){
  const size=JSON.stringify(entry).length;if(size>CACHE_LIMITS.entryBytes)throw new Error('이 영상의 자막이 보관 한도를 넘었습니다. JSON으로 저장한 뒤 지워 주세요.');
  const {captionIndex={}}=await chrome.storage.local.get('captionIndex'),index={...captionIndex,[id]:{savedAt:entry.savedAt,bytes:size,complete:entry.document?.metadata?.partial!==true}};
  const keep={},drop=[];let total=0;
  for(const [video,meta] of Object.entries(index).sort((a,b)=>Number(b[0]===id)-Number(a[0]===id)||(b[1].savedAt||0)-(a[1].savedAt||0))){
    if(video===id||(Object.keys(keep).length<CACHE_LIMITS.entries&&total+(meta.bytes||0)<=CACHE_LIMITS.bytes)){keep[video]=meta;total+=meta.bytes||0;}else drop.push(video);
  }
  return {update:{[captionKey(id)]:entry,captionIndex:keep,...extra},drop};
}
async function commit({update,drop=[]}){await chrome.storage.local.set(update);if(drop.length)await chrome.storage.local.remove(drop.map(captionKey));}
// 0.3.x kept every video in one captionCache object (at most 8); move them to their own keys once.
async function migrateCache(){
  const {captionCache,captionIndex={}}=await chrome.storage.local.get(['captionCache','captionIndex']);if(!captionCache||typeof captionCache!=='object')return;
  const update={},index={...captionIndex};
  for(const [id,entry] of Object.entries(captionCache)){if(!/^[\w-]{11}$/.test(id)||!entry?.document)continue;update[captionKey(id)]=entry;index[id]={savedAt:entry.savedAt||0,bytes:JSON.stringify(entry).length,complete:entry.document.metadata?.partial!==true};}
  await chrome.storage.local.set({...update,captionIndex:index});await chrome.storage.local.remove('captionCache');
}
const migrated=write(migrateCache).catch(()=>{});
const progressiveEntry=entry=>entry?.origin==='analysis'&&entry.document?.metadata?.progressive===true;
async function setState(value,epoch=operationEpoch){return write(async()=>{
  if(epoch!==operationEpoch)return false;
  const operation={...value,updatedAt:Date.now()},update={operation};
  if(operation.videoId&&['requesting','preparing','cancelled','error'].includes(operation.phase)){
    const entry=await readEntry(operation.videoId);if(epoch!==operationEpoch)return false;
    // Minutes saved by a streaming analysis stay visible and resumable after a cancel or an
    // error; a fresh analysis (not a resume) still hides the previous result until it saves.
    const keep=progressiveEntry(entry)&&(operation.phase!=='preparing'||operation.resume===true);
    if(entry?.ready&&!keep)update[captionKey(operation.videoId)]={...entry,ready:false};
  }
  await chrome.storage.local.set(update);if(operation.tabId)await notify(operation.tabId,{type:'OPERATION_UPDATED',operation});return true;
});}
async function saveDocument(input,tabId,{completion=null,epoch=operationEpoch}={}){return write(async()=>{
  if(epoch!==operationEpoch)return null;
  let doc=validateDocument(input);if(!doc.video_id)throw new Error('JSON에 현재 YouTube 영상 ID를 지정해 주세요.');
  const latest=await state();
  if(completion&&(latest.captureId!==completion.captureId||!['running','uploading','capturing'].includes(latest.phase)))return null;
  if(completion?.mode==='full'&&(doc.metadata.analysis_scope!=='full-video'||Math.abs(doc.duration-completion.expectedDuration)>Math.max(2,completion.expectedDuration*.01)))throw new Error('전체 영상 분석 결과가 완성되지 않아 자막을 표시하지 않습니다.');
  if(completion&&(doc.video_id!==completion.videoId||doc.metadata.partial===true||doc.metadata.audio_analyzed!==true))throw new Error('완료된 소리 분석 결과가 없어 자막을 표시하지 않습니다. 다시 분석해 주세요.');
  const previous=await readEntry(doc.video_id);
  // A tab recording also keeps minutes already saved by a streaming whole-video analysis.
  const reusable=previous?.displayVersion===2&&previous.document?.metadata?.audio_analyzed!==false&&(previous.document?.metadata?.partial!==true||progressiveEntry(previous));
  const start=completion?.startTime||0,end=doc.duration;if(completion&&end<=start)throw new Error('분석 결과의 녹음 구간이 올바르지 않습니다.');let ranges=[[start,end]];
  if(completion&&completion.mode!=='full'&&reusable){
    const old=previous.document,kept=old.cues.filter(c=>c.end<=start||c.start>=end),music_analysis={};
    for(const c of kept)if(old.metadata?.music_analysis?.[c.id])music_analysis[c.id]=old.metadata.music_analysis[c.id];
    const added=doc.cues.map((c,i)=>{const id=`clip-${completion.captureId.slice(0,16)}-${i}`;if(doc.metadata.music_analysis?.[c.id])music_analysis[id]=doc.metadata.music_analysis[c.id];return {...c,id};});
    doc=validateDocument({...doc,duration:Math.max(old.duration,doc.duration),cues:[...kept,...added],metadata:{...doc.metadata,music_analysis},warnings:[...new Set([...old.warnings,...doc.warnings])].slice(0,100)});ranges=[...(previous.ranges||[[old.metadata?.analyzed_start||0,old.duration]]),...ranges].slice(-100);
  }
  if(completion?.mode==='full'&&doc.metadata.progressive===true)ranges=doc.metadata.analyzed_ranges;
  const entry={document:doc,ranges,savedAt:Date.now(),ready:true,displayVersion:2,origin:completion?'analysis':'import'};
  const pending=await cacheUpdate(doc.video_id,entry);
  if(epoch!==operationEpoch)return null;
  if(completion){const tab=await chrome.tabs.get(tabId).catch(()=>null);if(!tab||youtubeId(tab.url)!==doc.video_id)return null;}
  if(epoch!==operationEpoch)return null;
  const update=pending.update;if(completion)update.operation={...latest,phase:'done',progress:1,message:`${doc.cues.length}개 자막을 영상에 적용했습니다.`,updatedAt:Date.now()};
  // Publish only the validated final document and done state, in one write.
  await commit(pending);if(update.operation)await notify(tabId,{type:'OPERATION_UPDATED',operation:update.operation});await notify(tabId,{type:'DOCUMENT_UPDATED',videoId:doc.video_id});if(completion)await notify(tabId,{type:'CAPTURE_CLEAR'});return doc;
});}
// One finished minute of a streaming whole-video analysis. The operation keeps running.
async function saveProgress(input,epoch=operationEpoch){return write(async()=>{
  if(epoch!==operationEpoch)return null;
  const latest=await state();if(latest.mode!=='full'||latest.phase!=='running')return null;
  const doc=validateDocument(input),meta=doc.metadata;
  if(doc.video_id!==latest.videoId||meta.analysis_scope!=='full-video'||meta.progressive!==true||meta.partial!==true||meta.audio_analyzed!==true||!Array.isArray(meta.analyzed_ranges)||Math.abs(doc.duration-latest.expectedDuration)>Math.max(2,latest.expectedDuration*.01))throw new Error('분석한 구간의 자막 형식이 올바르지 않습니다.');
  const pending=await cacheUpdate(doc.video_id,{document:doc,ranges:meta.analyzed_ranges,savedAt:Date.now(),ready:true,displayVersion:2,origin:'analysis'});
  if(epoch!==operationEpoch)return null;
  await commit(pending);await notify(latest.tabId,{type:'DOCUMENT_UPDATED',videoId:doc.video_id});return doc;
});}
// The user's Anthropic key goes only to the offscreen analysis that corrects with it.
async function storedCorrection(){const {aiCorrection}=await chrome.storage.local.get('aiCorrection');return normalizeCorrection(aiCorrection);}
// The OnSori server corrects with the operator's provider key (DeepInfra) when it offers it,
// and names the provider and model it uses.
async function correctionServer(fresh=false){const [availability,{cloudTest}]=await Promise.all([cloudAvailability(fresh).catch(()=>({})),chrome.storage.local.get('cloudTest')]);return {corrections:availability.corrections===true,synthetic:availability.correctionsSynthetic===true,allowSynthetic:cloudTest?.allowSynthetic===true,provider:availability.correctionProvider||null,model:availability.correctionModel||null};}
async function correctionSettings({fresh=false}={}){const [stored,bridge,server]=await Promise.all([storedCorrection(),bridgeAvailability(fresh),correctionServer(fresh)]);return {...effectiveCorrection(stored,bridge,server),bridge,server};}
async function correctionForAnalysis(){const value=await correctionSettings({fresh:true});if(!value.enabled)return null;return value.provider==='api'?{enabled:true,apiKey:value.apiKey,model:value.model}:{enabled:true,provider:value.provider,model:value.provider==='cloud'&&value.server?.model||value.model};}
// Caption text only, with this install's own key; the operator's API key never leaves the server.
async function cloudCorrect(payload){
  const post=async renew=>fetch(`${CLOUD.origin}/v1/corrections`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${await cloudKey(renew)}`},body:JSON.stringify(payload),credentials:'omit',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(90000)});
  let response;
  try{response=await post(false);if(response.status===401)response=await post(true);}
  catch(e){return {ok:false,code:'cloud_failed',message:/열쇠/.test(e?.message||'')?e.message:'온소리 서버에 연결하지 못해 이 구간은 원문을 표시합니다.'};}
  let body=null;try{body=await response.json();}catch{}
  if(response.ok)return {ok:true,corrections:Array.isArray(body?.corrections)?body.corrections:[],model:typeof body?.model==='string'?body.model:null,usage:body?.usage||null};
  const detail=String(body?.detail||`http_${response.status}`);
  if(/daily_correction_limit/.test(detail))return {ok:false,code:'cloud_limit',message:'오늘 쓸 수 있는 자막 보정량을 다 써서 원문을 표시합니다.'};
  if(response.status===503)return {ok:false,code:'cloud_unavailable',message:'온소리 서버의 자막 보정을 지금 쓸 수 없어 원문을 표시합니다.'};
  return {ok:false,code:'cloud_failed',message:`온소리 서버 보정에 실패해 이 구간은 원문을 표시합니다(${detail.slice(0,60)}).`};
}
const correctionState=value=>{const cloud=value.provider==='cloud';return {enabled:value.enabled,provider:value.provider,auto:value.auto,ready:value.ready,hasKey:Boolean(value.apiKey),model:cloud&&value.server?.model||value.model,label:cloud?serverCorrectionLabel(value.server?.provider,value.server?.model):AI_CORRECTION.label,bridge:{available:value.bridge?.available===true,version:value.bridge?.version||null,subscription:value.bridge?.subscription||null,code:value.bridge?.code||null},server:{available:value.server?.corrections===true,provider:value.server?.provider||null,model:value.server?.model||null}};};
// The Claude Code CLI signed in on this PC, reached through the native bridge (native-host/).
// Nothing to set up in Chrome: whenever the bridge answers and Claude Code is signed in,
// correction uses it. The answer is cached briefly (panels refresh often; a probe starts
// claude.exe twice) and re-checked before each analysis.
let bridgeRefresh=null;
async function probeBridge(){
  const status=await nativeRequest({type:'status'});
  const value=status?.ok?{available:status.loggedIn===true,version:status.version||null,subscription:status.subscription||null,code:status.loggedIn===true?null:'cli_auth'}:{available:false,code:status?.code||'bridge_error'};
  await chrome.storage.session.set({bridgeStatus:{at:Date.now(),value}});return value;
}
async function bridgeAvailability(fresh=false){
  const {bridgeStatus:cached}=await chrome.storage.session.get('bridgeStatus');
  if(cached&&Date.now()-cached.at<(cached.value.available?300000:30000))return cached.value;
  if(!bridgeRefresh)bridgeRefresh=probeBridge().finally(()=>bridgeRefresh=null);
  return cached&&!fresh?cached.value:bridgeRefresh;
}
async function nativeRequest(message){
  if(typeof chrome.runtime.sendNativeMessage!=='function')return {ok:false,code:'no_permission',message:'Claude Code 연결 권한이 없습니다. 확장 프로그램을 다시 불러와 주세요.'};
  try{return await chrome.runtime.sendNativeMessage(BRIDGE_HOST,message)||{ok:false,code:'bridge_error',message:'Claude Code 연결 프로그램이 응답하지 않았습니다.'};}
  catch(e){
    const text=String(e?.message||e);
    if(/not found/i.test(text))return {ok:false,code:'bridge_missing',message:'Claude Code 연결 프로그램이 설치되지 않았습니다. AI 보정 설정 화면의 안내대로 설치해 주세요.'};
    if(/forbidden/i.test(text))return {ok:false,code:'bridge_forbidden',message:'이 확장 ID가 Claude Code 연결 프로그램에 등록되지 않았습니다. 설정 화면에 보이는 확장 ID로 다시 설치해 주세요.'};
    return {ok:false,code:'bridge_error',message:`Claude Code 연결 프로그램 오류: ${text.slice(0,160)}`};
  }
}
const settingsPage=sender=>{try{const u=new URL(sender.url),own=new URL(chrome.runtime.getURL('ai-settings.html'));return sender.id===chrome.runtime.id&&u.origin===own.origin&&u.pathname==='/ai-settings.html';}catch{return false;}};
async function ensureOffscreen(){const contexts=await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT'],documentUrls:[chrome.runtime.getURL('offscreen.html')]});if(contexts.length)return;if(!creatingOffscreen)creatingOffscreen=chrome.offscreen.createDocument({url:'offscreen.html',reasons:['USER_MEDIA','BLOBS','WORKERS'],justification:'영상 전체 오디오를 기기 안에서 분석하며, 사용자가 선택한 경우에만 탭 오디오를 녹음합니다.'}).finally(()=>creatingOffscreen=null);await creatingOffscreen;}
const offscreen=payload=>chrome.runtime.sendMessage({target:'offscreen',...payload});
// Public availability (no key) cached for a minute; an unreachable server is simply unavailable.
let availabilityRefresh=null;
async function cloudAvailability(fresh=false){
  const {cloudAvailability:cached}=await chrome.storage.session.get('cloudAvailability');if(cached&&Date.now()-cached.at<60000)return cached.value;
  // Panels show the last answer at once; starting an analysis waits for a fresh one.
  if(!availabilityRefresh)availabilityRefresh=fetchAvailability().finally(()=>availabilityRefresh=null);
  return cached&&!fresh?cached.value:availabilityRefresh;
}
async function fetchAvailability(){
  let value={available:false,synthetic:false,corrections:false,correctionsSynthetic:false,correctionProvider:null,correctionModel:null};
  try{const r=await fetch(`${CLOUD.origin}/v1/availability`,{credentials:'omit',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(5000)});if(r.ok){const j=await r.json();value={available:j.available===true,synthetic:j.synthetic===true,dailyMinutes:Number.isFinite(j.install_daily_audio_minutes)?j.install_daily_audio_minutes:null,corrections:j.corrections===true,correctionsSynthetic:j.corrections_synthetic===true,correctionProvider:['deepinfra','anthropic','mock'].includes(j.correction_provider)?j.correction_provider:null,correctionModel:typeof j.correction_model==='string'&&MODEL_ID_PATTERN.test(j.correction_model)?j.correction_model:null};}}catch{}
  await chrome.storage.session.set({cloudAvailability:{at:Date.now(),value}});return value;
}
// Synthetic (mock) servers are offered only to an isolated QA profile.
async function cloudState(fresh=false){const [{cloudConsent,cloudTest},availability]=await Promise.all([chrome.storage.local.get(['cloudConsent','cloudTest']),cloudAvailability(fresh)]);const allowSynthetic=cloudTest?.allowSynthetic===true;return {offered:availability.available&&(!availability.synthetic||allowSynthetic),consent:cloudConsent?.version===CLOUD.consentVersion?cloudConsent.choice:null,dailyMinutes:availability.dailyMinutes,allowSynthetic};}
// One random key per install, issued by the server on first cloud use; never the operator token.
async function cloudKey(renew){
  const {cloudInstall}=await chrome.storage.local.get('cloudInstall');if(cloudInstall?.key&&!renew)return cloudInstall.key;
  const r=await fetch(`${CLOUD.origin}/v1/installs`,{method:'POST',credentials:'omit',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(10000)});
  if(!r.ok)throw new Error(r.status===429?'오늘 이 주소에서 받을 수 있는 클라우드 열쇠 수를 넘었습니다.':'클라우드 사용 열쇠를 받지 못했습니다.');
  const {install_key:key}=await r.json();if(!/^osi_[A-Za-z0-9_-]{43}$/.test(key||''))throw new Error('클라우드 사용 열쇠 형식이 올바르지 않습니다.');
  await chrome.storage.local.set({cloudInstall:{key,issuedAt:Date.now()}});return key;
}
async function ensureIdle(){if(busyPhases.includes((await state()).phase))throw new Error('진행 중인 분석을 먼저 취소해 주세요.');}
async function startCapture(inputOptions,sender={},automatic=false){
  const requestEpoch=operationEpoch;await ensureIdle();const tab=await requestTab(sender),id=youtubeId(tab.url),{localConsent}=await chrome.storage.local.get('localConsent');
  if(localConsent?.enabled!==true)throw new Error('도구 모음의 온소리 아이콘을 눌러 기기 내 분석을 먼저 사용 설정해 주세요.');
  if(toolbarSender(sender))await grant(tab);
  if(!await hasGrant(tab)){await setState({phase:'waiting_permission',tabId:tab.id,videoId:id,message:'현재 영상의 녹음 권한이 필요합니다. 도구 모음의 온소리 아이콘을 직접 눌러 주세요.'});return {ok:true,waiting:true};}
  if(requestEpoch!==operationEpoch)return {ok:true,cancelled:true};
  const epoch=++operationEpoch,captureId=crypto.randomUUID(),options=analysisOptions(inputOptions),base={automatic,capture:true,captureId,tabId:tab.id,videoId:id,progress:0};
  await chrome.storage.local.set({analysisOptions:options});await setState({...base,phase:'preparing',message:'기기 내 분석용 탭 오디오를 연결합니다.'},epoch);
  try{
    const initial=await notify(tab.id,{type:'VIDEO_STATE'});if(!initial||initial.videoId!==id)throw new Error('YouTube 페이지를 새로고침한 뒤 다시 시도해 주세요.');if(initial.ad)throw new Error('광고가 끝난 뒤 시작해 주세요.');
    if(!Number.isFinite(initial.duration))throw new Error('라이브 영상은 구간 녹음을 지원하지 않습니다. 일반 영상을 선택해 주세요.');
    if(automatic&&(initial.paused||initial.rate!==1)){await setState({...base,phase:'idle',message:'1배속으로 재생하면 분석을 시작합니다.'},epoch);return {ok:true,skipped:true};}
    if(epoch!==operationEpoch)return {ok:true,cancelled:true};await ensureOffscreen();if(epoch!==operationEpoch)return {ok:true,cancelled:true};
    const streamId=await chrome.tabCapture.getMediaStreamId({targetTabId:tab.id});if(epoch!==operationEpoch)return {ok:true,cancelled:true};
    const prepared=await offscreen({type:'CAPTURE_PREPARE',captureId,streamId});if(!prepared?.ok)throw new Error(prepared?.error||'탭 오디오를 연결할 수 없습니다.');
    if(epoch!==operationEpoch){await offscreen({type:'CAPTURE_DISCARD',captureId});return {ok:true,cancelled:true};}
    const snap=await notify(tab.id,{type:'PREPARE_CAPTURE',videoId:id});if(epoch!==operationEpoch){await offscreen({type:'CAPTURE_DISCARD',captureId});return {ok:true,cancelled:true};}
    if(snap?.error)throw new Error(snap.error);if(!snap||snap.videoId!==id||snap.paused||snap.rate!==1||snap.ad)throw new Error('영상을 1배속으로 재생한 뒤 다시 시도해 주세요.');
    const op={...base,phase:'capturing',title:String(snap.title||'').slice(0,300),startTime:snap.time,startedAt:Date.now(),message:'최대 60초 녹음 후 이 기기에서 분석합니다. 창을 닫아도 계속됩니다.'};
    if(!await setState(op,epoch))return {ok:true,cancelled:true};await notify(tab.id,{type:'CAPTURE_ACTIVE',active:true,captureFrames:options.capture_frames});
    if(epoch!==operationEpoch){await offscreen({type:'CAPTURE_DISCARD',captureId});await notify(tab.id,{type:'CAPTURE_ACTIVE',active:false});return {ok:true,cancelled:true};}
    const result=await offscreen({type:'CAPTURE_RECORD',captureId,videoId:id,title:op.title,startTime:snap.time,snapshotAt:snap.sampledAt,options,correction:await correctionForAnalysis()});if(!result?.ok)throw new Error(result?.error||'녹음을 시작하지 못했습니다.');
    await setState({...op,startedAt:result.startedAt,startTime:result.startTime},epoch);return {ok:true};
  }catch(e){try{await offscreen({type:'CAPTURE_DISCARD',captureId});}catch{}await notify(tab.id,{type:'CAPTURE_ACTIVE',active:false});await notify(tab.id,{type:'CAPTURE_CLEAR'});if(epoch!==operationEpoch)return {ok:true,cancelled:true};
    const permission=/Extension has not been invoked|activeTab permission/i.test(e?.message||'');
    if(permission){await chrome.storage.session.set({toolbarGrant:null});await rememberAuto(`${tab.id}:${id}`,{permissionRequired:true});}
    await setState({...base,phase:permission?'waiting_permission':'error',message:messageError(e)},epoch);if(permission)return {ok:true,waiting:true};throw e;}
}
async function stopCapture(reason='녹음 구간을 기기에서 분석합니다.'){
  const epoch=operationEpoch,op=await state();if(op.phase!=='capturing')return;await setState({...op,phase:'running',progress:0,message:reason},epoch);await notify(op.tabId,{type:'CAPTURE_ACTIVE',active:false});
  const result=await offscreen({type:'CAPTURE_STOP',captureId:op.captureId});if(!result?.ok)await setState({...op,phase:'error',message:result?.error||'녹음을 마치지 못했습니다.'},epoch);
}
async function cancel(message='녹음과 분석을 취소했습니다. 자막 만들기를 누르면 다시 시작합니다.',{byUser=true}={}){
  const epoch=++operationEpoch,op=await state();if(op.tabId&&op.videoId)await rememberAuto(`${op.tabId}:${op.videoId}`,byUser?{cancelled:true,interrupted:false}:{interrupted:true});await setState({...op,phase:'cancelled',message},epoch);
  if(op.tabId){await notify(op.tabId,{type:'CANCEL_AUDIO_LOOKUP',captureId:op.captureId});await notify(op.tabId,{type:'CAPTURE_ACTIVE',active:false});await notify(op.tabId,{type:'CAPTURE_CLEAR'});}if(op.captureId)try{await offscreen({type:'CAPTURE_DISCARD',captureId:op.captureId});}catch{}
}
async function rememberAuto(key,patch){const {autoHistory={}}=await chrome.storage.local.get('autoHistory');autoHistory[key]={...autoHistory[key],...patch,updatedAt:Date.now()};await chrome.storage.local.set({autoHistory:Object.fromEntries(Object.entries(autoHistory).sort((a,b)=>b[1].updatedAt-a[1].updatedAt).slice(0,48))});return autoHistory[key];}
async function startFull(inputOptions,sender={},automatic=false){
  const requestEpoch=operationEpoch;await ensureIdle();const tab=await requestTab(sender),id=youtubeId(tab.url),{localConsent}=await chrome.storage.local.get('localConsent');
  if(localConsent?.enabled!==true)throw new Error('기기 내 분석을 먼저 사용 설정해 주세요.');
  if(requestEpoch!==operationEpoch)return {ok:true,cancelled:true};
  const options=analysisOptions(inputOptions),saved=await readEntry(id),savedMeta=saved?.document?.metadata;
  // Minutes analyzed earlier (before a reload, a navigation or a cancel) are kept; only the rest is analyzed.
  const resume=progressiveEntry(saved)&&saved.ready&&savedMeta.partial===true&&savedMeta.audio_analyzed===true&&(savedMeta.speech_language||'ko')===options.language?saved.document:null;
  if(requestEpoch!==operationEpoch)return {ok:true,cancelled:true};
  const epoch=++operationEpoch,captureId=crypto.randomUUID(),base={automatic,capture:false,mode:'full',captureId,tabId:tab.id,videoId:id,startTime:0,progress:0,resume:Boolean(resume)};
  await rememberAuto(`${tab.id}:${id}`,{fullAttempted:true,cancelled:false,interrupted:false,failed:false});
  await chrome.storage.local.set({analysisOptions:options});await setState({...base,phase:'preparing',message:resume?'분석해 둔 구간에 이어서 남은 구간을 분석합니다.':'영상 전체 오디오를 확인합니다.'},epoch);
  try{
    const initial=await notify(tab.id,{type:'VIDEO_STATE'});if(initial?.ad)throw new Error('광고가 끝난 뒤 전체 분석을 시작해 주세요.');
    const data=await notify(tab.id,{type:'GET_FULL_SOURCE',videoId:id});
    if(epoch!==operationEpoch)return {ok:true,cancelled:true};
    const source=selectFullSource(data,id,options.language,{allowLookup:true});await ensureOffscreen();
    if(epoch!==operationEpoch)return {ok:true,cancelled:true};
    const op={...base,title:source.title,expectedDuration:source.duration,phase:'running',message:'전체 오디오를 가져옵니다. 영상은 재생하지 않아도 됩니다.'};
    if(!await setState(op,epoch))return {ok:true,cancelled:true};
    const cloud=await cloudState(true).catch(()=>({offered:false}));
    const result=await offscreen({type:'FULL_ANALYZE',captureId,source,options,cloud:{enabled:cloud.offered&&cloud.consent==='granted',allowSynthetic:cloud.allowSynthetic===true},correction:await correctionForAnalysis(),resume});
    if(epoch!==operationEpoch){await offscreen({type:'CAPTURE_DISCARD',captureId});return {ok:true,cancelled:true};}
    if(!result?.ok)throw new Error(result?.error||'전체 분석을 시작하지 못했습니다.');return {ok:true};
  }catch(e){if(epoch!==operationEpoch)return {ok:true,cancelled:true};await rememberAuto(`${tab.id}:${id}`,{failed:true});await setState({...base,phase:'error',message:messageError(e)},epoch);throw e;}
}
async function autoStart(message,sender){
  const data=await chrome.storage.local.get(['settings','analysisOptions','autoHistory','localConsent']),settings=normalizeSettings(data.settings),op=await state();
  if(data.localConsent?.enabled!==true||!settings.enabled||!settings.autoAnalyze||busyPhases.includes(op.phase))return {ok:true,skipped:true};
  const tab=await requestTab(sender),focused=await activeTab().catch(()=>null);if(!focused||tab.id!==focused.id)return {ok:true,skipped:true};
  const id=youtubeId(tab.url),key=`${tab.id}:${id}`,snap=await notify(tab.id,{type:'VIDEO_STATE'}),entry=data.autoHistory?.[key]||{};
  if(!snap||snap.videoId!==id||snap.ad||!Number.isFinite(snap.duration))return {ok:true,skipped:true};
  const doc=readyDocument(await readEntry(id),op,id),partial=doc?.metadata.progressive===true&&doc.metadata.partial===true;
  if(doc?.metadata.analysis_scope==='full-video'&&!partial)return {ok:true,cached:true};
  // A user cancel or a failure stops automatic analysis; a reload or navigation only pauses it.
  if(entry.cancelled||entry.failed||(entry.fullAttempted&&!partial&&!entry.interrupted))return {ok:true,skipped:true};
  return startFull(data.analysisOptions,{tab},true);
}
const consentSender=sender=>{if(sender.id===chrome.runtime.id&&sender.frameId===0&&sender.tab&&youtubeId(sender.url))return true;try{const u=new URL(sender.url);return u.origin===new URL(chrome.runtime.getURL('popup.html')).origin&&u.protocol==='chrome-extension:'&&u.host===new URL(chrome.runtime.getURL('popup.html')).host&&u.pathname==='/popup.html';}catch{return false;}};
async function handle(message,sender){const handleEpoch=operationEpoch;switch(message.type){
  case 'GET_STATE':{const tab=await requestTab(sender).catch(()=>null),data=await chrome.storage.local.get(['settings','analysisOptions','localConsent']),id=tab?youtubeId(tab.url):null,operation=await state(),entry=await readEntry(id),document=readyDocument(entry,operation,id);return {ok:true,operation,settings:normalizeSettings(data.settings),analysisOptions:analysisOptions(data.analysisOptions),localEnabled:data.localConsent?.enabled===true,cloud:await cloudState().catch(()=>({offered:false,consent:null})),correction:correctionState(await correctionSettings()),videoId:id,tabId:tab?.id||null,title:tab?.title||'',document,hasStoredDocument:Boolean(entry),awaitingAnalysis:Boolean(entry&&!document)};}
  case 'GET_CORRECTION':{if(!settingsPage(sender))throw new Error('AI 보정 설정 화면에서 열어 주세요.');const value=await correctionSettings();return {ok:true,...correctionState(value),keyHint:apiKeyHint(value.apiKey),extensionId:chrome.runtime.id};}
  case 'SET_CORRECTION_PROVIDER':{
    if(!settingsPage(sender))throw new Error('AI 보정 설정 화면에서 선택해 주세요.');
    if(!PROVIDERS.includes(message.provider))throw new Error('보정 방식이 올바르지 않습니다.');
    const stored=await storedCorrection();await chrome.storage.local.set({aiCorrection:normalizeCorrection({...stored,provider:message.provider,optOut:false,updatedAt:Date.now()})});
    const value=await correctionSettings({fresh:message.provider==='cli'});return {ok:true,...correctionState(value),keyHint:apiKeyHint(value.apiKey),extensionId:chrome.runtime.id};
  }
  case 'CLI_STATUS':{if(!settingsPage(sender))throw new Error('AI 보정 설정 화면에서 확인해 주세요.');const status=await nativeRequest({type:'status'});await chrome.storage.session.set({bridgeStatus:null});return status;}
  case 'CLI_CORRECT':return nativeRequest({type:'correct',payload:message.payload});
  case 'CLOUD_CORRECT':return cloudCorrect(correctionPayload(message.payload));
  // One real two-word request, so a revoked login shows up here rather than during analysis.
  case 'CLI_TEST':{if(!settingsPage(sender))throw new Error('AI 보정 설정 화면에서 확인해 주세요.');return nativeRequest({type:'correct',payload:{title:'연결 확인',context:[],lines:[{id:'t',text:'안녕 하세요 반갑 습니다'}]}});}
  case 'SET_CORRECTION':{
    if(!consentSender(sender)&&!settingsPage(sender))throw new Error('온소리 패널에서 선택해 주세요.');
    const value=await correctionSettings({fresh:message.enabled===true});if(message.enabled===true&&!value.ready)throw new Error('이 PC에서 Claude Code 연결 프로그램을 찾지 못했습니다. AI 보정 설정 화면을 확인해 주세요.');
    const stored=await storedCorrection();await chrome.storage.local.set({aiCorrection:normalizeCorrection({...stored,optOut:message.enabled!==true,updatedAt:Date.now()})});
    return {ok:true,correction:correctionState(await correctionSettings())};
  }
  case 'SET_CORRECTION_KEY':{
    // Only the extension's own settings page may store, replace or delete the key.
    if(!settingsPage(sender))throw new Error('AI 보정 설정 화면에서 API 키를 등록해 주세요.');
    const key=String(message.apiKey??'').trim();if(key&&!API_KEY_PATTERN.test(key))throw new Error('Anthropic API 키는 sk-ant-로 시작합니다. 키를 다시 확인해 주세요.');
    const stored=await storedCorrection();
    await chrome.storage.local.set({aiCorrection:normalizeCorrection(key?{...stored,apiKey:key,provider:'api',optOut:false,updatedAt:Date.now()}:{...stored,apiKey:'',provider:'cli',updatedAt:Date.now()})});
    const value=await correctionSettings();return {ok:true,...correctionState(value),keyHint:apiKeyHint(value.apiKey)};
  }
  case 'OPEN_AI_SETTINGS':await chrome.tabs.create({url:chrome.runtime.getURL('ai-settings.html')});return {ok:true};
  case 'TOOLBAR_OPEN':{if(!toolbarSender(sender))throw new Error('도구 모음에서 온소리 아이콘을 직접 눌러 주세요.');const tab=await activeTab(),key=`${tab.id}:${youtubeId(tab.url)}`,{autoHistory={}}=await chrome.storage.local.get('autoHistory');await grant(tab);if(autoHistory[key]?.permissionRequired)await rememberAuto(key,{permissionRequired:false,windows:[]});return autoStart(message,sender);}
  case 'ENABLE_LOCAL':{if(!consentSender(sender))throw new Error('온소리 패널에서 사용 설정해 주세요.');const tab=await requestTab(sender);await chrome.storage.local.set({localConsent:{enabled:true,version:2,enabledAt:Date.now()},analysisOptions:analysisOptions(message.options)});if(toolbarSender(sender))await grant(tab);return autoStart(message,sender);}
  case 'SET_CLOUD_CONSENT':{if(!consentSender(sender))throw new Error('온소리 패널에서 선택해 주세요.');if(!['granted','declined'].includes(message.choice))throw new Error('클라우드 사용 선택이 올바르지 않습니다.');await chrome.storage.local.set({cloudConsent:{choice:message.choice,version:CLOUD.consentVersion,at:Date.now()}});return {ok:true,cloud:await cloudState()};}
  case 'CLOUD_KEY':return {ok:true,key:await cloudKey(message.renew===true)};
  case 'SET_SETTINGS':{const settings=normalizeSettings(message.settings);await chrome.storage.local.set({settings});const op=await state();if(!settings.autoAnalyze&&op.automatic&&busyPhases.includes(op.phase))await cancel('자동 분석을 꺼서 진행 중인 분석을 취소했습니다. 분석해 둔 구간은 남아 있습니다.');return {ok:true,settings};}
  case 'SET_ANALYSIS_OPTIONS':{const options=analysisOptions(message.options);await chrome.storage.local.set({analysisOptions:options});return {ok:true,options};}
  case 'HEALTH':return {ok:true,health:{status:'ok',message:'AI 모델은 첫 분석 때 내려받아 Chrome에 보관합니다. 오디오와 선택한 화면은 기기 안에서 처리합니다.'}};
  case 'ANALYZE_URL':return startFull(message.options,sender);
  case 'AUTO_START':return autoStart(message,sender);
  case 'START_CAPTURE':{const tab=await requestTab(sender);await rememberAuto(`${tab.id}:${youtubeId(tab.url)}`,{cancelled:false,fullAttempted:true});return startCapture(message.options,sender);}
  case 'STOP_CAPTURE':await stopCapture();return {ok:true};
  case 'CANCEL':await cancel(undefined,{byUser:true});return {ok:true};
  case 'REPLAY_CAPTURE':{const op=await state(),tab=await requestTab(sender);if(op.phase!=='done'||!Number.isFinite(op.startTime)||tab.id!==op.tabId||youtubeId(tab.url)!==op.videoId)throw new Error('분석이 완료된 같은 영상에서 다시 보기 해 주세요.');const result=await notify(op.tabId,{type:'VIDEO_SEEK',videoId:op.videoId,time:op.startTime});if(!result?.ok)throw new Error(result?.error||'YouTube 페이지를 새로고침해 주세요.');return {ok:true};}
  case 'VIDEO_NAVIGATED':{const op=await state();if(sender.tab?.id===op.tabId&&message.videoId!==op.videoId&&busyPhases.includes(op.phase))await cancel('영상이 바뀌어 분석을 멈췄습니다. 분석해 둔 구간은 저장했고, 이 영상으로 돌아오면 이어서 분석합니다.',{byUser:false});return {ok:true};}
  case 'CAPTURE_INTERRUPTED':{const op=await state();if(sender.tab?.id===op.tabId)await stopCapture(message.reason);return {ok:true};}
  case 'CAPTURE_LEVEL':{const op=await state();if(op.phase==='capturing')await setState({...op,level:{rms:message.rms,peak:message.peak,elapsed:message.elapsed,bytes:message.bytes,silentSeconds:message.silentSeconds}},handleEpoch);return {ok:true};}
  case 'FULL_AUDIO_LOOKUP':{
    const op=await state();if(op.mode!=='full'||op.phase!=='running')throw new Error('전체 분석 중인 요청이 아닙니다.');
    const tab=await chrome.tabs.get(op.tabId);if(youtubeId(tab.url)!==op.videoId)throw new Error('영상이 변경되어 조회를 중지했습니다.');
    const result=await notify(op.tabId,{type:'LOOKUP_FULL_AUDIO',captureId:op.captureId,source:{videoId:op.videoId,duration:op.expectedDuration},language:message.language});
    if(handleEpoch!==operationEpoch)return {ok:false,error:'오디오 조회를 취소했습니다.'};
    if(!result?.ok)throw new Error(result?.error||'영상 페이지의 오디오 조회 연결이 끝났습니다. 페이지를 새로고침해 주세요.');
    const raw=result.source,source=selectFullSource({...raw,formats:[{url:raw?.url,mimeType:raw?.mimeType,contentLength:raw?.bytes}],tracks:raw?.track?[{url:raw.track.url,kind:raw.track.kind}]:[]},op.videoId);
    if(Math.abs(source.duration-op.expectedDuration)>Math.max(2,op.expectedDuration*.01))throw new Error('조회한 오디오 길이가 영상과 다릅니다.');
    return {ok:true,source:{...source,transport:'youtube-page-visionos'}};
  }
  case 'PLAYBACK_POSITION':{const op=await state(),snap=await notify(op.tabId,{type:'VIDEO_STATE'});return {ok:true,time:snap?.videoId===op.videoId&&!snap.ad&&Number.isFinite(snap.time)?snap.time:null};}
  case 'ANALYSIS_CHUNK':{const epoch=operationEpoch;await saveProgress(message.document,epoch);return {ok:true};}
  case 'CAPTURE_REFERENCES':{const op=await state(),evidence=await notify(op.tabId,{type:'NATIVE_CAPTIONS'});return {ok:true,references:Array.isArray(evidence?.references)?evidence.references.slice(0,2000):[],frames:Array.isArray(evidence?.frames)?evidence.frames.slice(0,241):[]};}
  case 'CAPTURE_LIMIT':await stopCapture('60초 녹음을 마쳤습니다. 기기에서 분석합니다.');return {ok:true};
  case 'CAPTURE_ANALYZING':case 'ANALYSIS_PROGRESS':{const epoch=operationEpoch,op=await state();if(['capturing','running','uploading'].includes(op.phase)){await setState({...op,phase:'running',progress:Math.max(0,Math.min(.999,Number(message.progress)||0)),message:String(message.message||'기기에서 소리를 분석합니다.').slice(0,1000)},epoch);if(message.type==='CAPTURE_ANALYZING')await notify(op.tabId,{type:'CAPTURE_ACTIVE',active:false});}return {ok:true};}
  case 'ANALYSIS_COMPLETE':{const epoch=operationEpoch,op=await state();await saveDocument(message.document,op.tabId,{completion:op,epoch});return {ok:true};}
  case 'CAPTURE_ERROR':{const op=await state();if(busyPhases.includes(op.phase)){if(op.tabId&&op.videoId)await rememberAuto(`${op.tabId}:${op.videoId}`,{failed:true,interrupted:false});await setState({...op,phase:'error',message:String(message.error||'기기 내 분석에 실패했습니다. 다시 시도해 주세요.').slice(0,1000)},handleEpoch);await notify(op.tabId,{type:'CAPTURE_ACTIVE',active:false});await notify(op.tabId,{type:'CAPTURE_CLEAR'});}return {ok:true};}
  case 'IMPORT':{await ensureIdle();const tab=await requestTab(sender),doc=validateDocument(message.document);if(doc.video_id!==youtubeId(tab.url))throw new Error('JSON의 영상 ID와 현재 영상이 다릅니다.');await saveDocument(doc,tab.id);return {ok:true};}
  case 'REMOVE_DOCUMENT':{await ensureIdle();const tab=await requestTab(sender),id=youtubeId(tab.url);await write(async()=>{const {captionIndex={}}=await chrome.storage.local.get('captionIndex');delete captionIndex[id];await chrome.storage.local.remove(captionKey(id));await chrome.storage.local.set({captionIndex});});await notify(tab.id,{type:'DOCUMENT_UPDATED',videoId:id});return {ok:true};}
  case 'OPEN_HELP':await chrome.tabs.create({url:chrome.runtime.getURL('help.html')});return {ok:true};
  default:return {ok:false,error:'알 수 없는 요청입니다.'};
}}
async function dispatch(message,sender){
  if(captureMessages.includes(message.type)){if(sender.url!==chrome.runtime.getURL('offscreen.html'))return {ok:false,error:'분석 문서에서 온 요청이 아닙니다.'};const op=await state();if(!message.captureId||message.captureId!==op.captureId||!busyPhases.includes(op.phase))return {ok:true,ignored:true};}
  if(sender.tab&&['STOP_CAPTURE','CANCEL'].includes(message.type)){const op=await state();if(sender.tab.id!==op.tabId||youtubeId(sender.tab.url)!==op.videoId)return {ok:false,error:'분석 중인 같은 영상에서 조작해 주세요.'};}
  return handle(message,sender);
}
chrome.runtime.onMessage.addListener((message,sender,sendResponse)=>{
  if(message.target==='offscreen')return;
  // Cancellation/navigation must abort pending getUserMedia and model work promptly.
  // A Claude Code request can take tens of seconds; it must not hold up progress and saves.
  if(['GET_STATE','HEALTH','CANCEL','VIDEO_NAVIGATED','GET_CORRECTION','CLI_STATUS','CLI_TEST','CLI_CORRECT','CLOUD_CORRECT'].includes(message.type)){migrated.then(()=>dispatch(message,sender)).then(sendResponse,e=>sendResponse({ok:false,error:messageError(e)}));return true;}
  const task=mutation.then(()=>startup).then(()=>dispatch(message,sender));mutation=task.catch(()=>{});task.then(sendResponse,e=>sendResponse({ok:false,error:messageError(e)}));return true;
});
// Recover an offscreen analysis after service-worker suspension; never start capture here.
const startupEpoch=operationEpoch;
const startup=migrated.then(()=>chrome.storage.local.get(['settings','operation'])).then(async data=>{
  await chrome.storage.local.set({settings:normalizeSettings(data.settings)});if(!busyPhases.includes(data.operation?.phase))return;
  const session=await offscreen({type:'GET_SESSION'}).catch(()=>null);if(session?.captureId===data.operation.captureId&&!session.discarded&&!session.failed&&(session.recording||session.analyzing||session.preparing))return;
  await setState({...data.operation,phase:'error',message:'이전 분석 연결이 끝났습니다. 현재 구간에서 다시 시작해 주세요.'},startupEpoch);
});
chrome.tabs.onUpdated.addListener((tabId,change)=>{if(!change.url&&change.status!=='loading')return;void (async()=>{const {toolbarGrant}=await chrome.storage.session.get('toolbarGrant');if(toolbarGrant?.tabId===tabId&&(change.status==='loading'||youtubeId(change.url)!==toolbarGrant.videoId))await chrome.storage.session.set({toolbarGrant:null});const op=await state();if(op.tabId!==tabId||!busyPhases.includes(op.phase))return;
  const sameVideo=change.url?youtubeId(change.url)===op.videoId:change.status==='loading';
  // The offscreen analysis does not depend on the page once it runs: a reload keeps it going
  // and the reloaded page shows every minute saved so far.
  if(op.mode==='full'&&op.phase==='running'&&sameVideo)return;
  if(change.status==='loading'||youtubeId(change.url)!==op.videoId)await cancel(op.mode==='full'?'페이지가 바뀌어 분석을 멈췄습니다. 분석해 둔 구간은 저장했고, 이 영상을 다시 열면 이어서 분석합니다.':'페이지가 바뀌어 녹음과 분석을 취소했습니다.',{byUser:false});})();});
chrome.tabs.onRemoved.addListener(tabId=>{void (async()=>{const op=await state();if(op.tabId===tabId&&busyPhases.includes(op.phase))await cancel('영상 탭이 닫혀 녹음과 분석을 취소했습니다.',{byUser:false});})();});
