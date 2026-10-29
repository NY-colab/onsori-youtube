import {selectFullSource} from './full-source.js';
import {normalizeSettings,validateDocument,youtubeId,readyDocument} from './core.js';
const busyPhases=['requesting','preparing','capturing','uploading','queued','running'];
const captureMessages=['FULL_AUDIO_LOOKUP','CAPTURE_REFERENCES','CAPTURE_LEVEL','CAPTURE_LIMIT','CAPTURE_ANALYZING','ANALYSIS_PROGRESS','ANALYSIS_COMPLETE','CAPTURE_ERROR'];
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
async function setState(value,epoch=operationEpoch){return write(async()=>{
  if(epoch!==operationEpoch)return false;
  const operation={...value,updatedAt:Date.now()},update={operation};
  if(operation.videoId&&['requesting','preparing','cancelled','error'].includes(operation.phase)){
    const {captionCache={}}=await chrome.storage.local.get('captionCache');if(epoch!==operationEpoch)return false;
    if(captionCache[operation.videoId])update.captionCache={...captionCache,[operation.videoId]:{...captionCache[operation.videoId],ready:false}};
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
  const {captionCache={}}=await chrome.storage.local.get('captionCache'),previous=captionCache[doc.video_id];
  const reusable=previous?.displayVersion===2&&previous.document?.metadata?.audio_analyzed!==false&&previous.document?.metadata?.partial!==true;
  const start=completion?.startTime||0,end=doc.duration;if(completion&&end<=start)throw new Error('분석 결과의 녹음 구간이 올바르지 않습니다.');let ranges=[[start,end]];
  if(completion&&completion.mode!=='full'&&reusable){
    const old=previous.document,kept=old.cues.filter(c=>c.end<=start||c.start>=end),music_analysis={};
    for(const c of kept)if(old.metadata?.music_analysis?.[c.id])music_analysis[c.id]=old.metadata.music_analysis[c.id];
    const added=doc.cues.map((c,i)=>{const id=`clip-${completion.captureId.slice(0,16)}-${i}`;if(doc.metadata.music_analysis?.[c.id])music_analysis[id]=doc.metadata.music_analysis[c.id];return {...c,id};});
    doc=validateDocument({...doc,duration:Math.max(old.duration,doc.duration),cues:[...kept,...added],metadata:{...doc.metadata,music_analysis},warnings:[...new Set([...old.warnings,...doc.warnings])].slice(0,100)});ranges=[...(previous.ranges||[[old.metadata?.analyzed_start||0,old.duration]]),...ranges].slice(-100);
  }
  const cache={...captionCache,[doc.video_id]:{document:doc,ranges,savedAt:Date.now(),ready:true,displayVersion:2,origin:completion?'analysis':'import'}};
  let entries=Object.entries(cache).sort((a,b)=>b[1].savedAt-a[1].savedAt).slice(0,8);while(entries.length>1&&JSON.stringify(Object.fromEntries(entries)).length>3_000_000)entries.pop();
  if(JSON.stringify(Object.fromEntries(entries)).length>4_000_000)throw new Error('자막 보관 한도를 넘었습니다. 이전 자막을 JSON으로 저장한 뒤 지워 주세요.');
  if(epoch!==operationEpoch)return null;
  if(completion){const tab=await chrome.tabs.get(tabId).catch(()=>null);if(!tab||youtubeId(tab.url)!==doc.video_id)return null;}
  if(epoch!==operationEpoch)return null;
  const update={captionCache:Object.fromEntries(entries)};if(completion)update.operation={...latest,phase:'done',progress:1,message:`${doc.cues.length}개 자막을 영상에 적용했습니다.`,updatedAt:Date.now()};
  // Publish only the validated final document and done state, in one write.
  await chrome.storage.local.set(update);if(update.operation)await notify(tabId,{type:'OPERATION_UPDATED',operation:update.operation});await notify(tabId,{type:'DOCUMENT_UPDATED',videoId:doc.video_id});if(completion)await notify(tabId,{type:'CAPTURE_CLEAR'});return doc;
});}
async function ensureOffscreen(){const contexts=await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT'],documentUrls:[chrome.runtime.getURL('offscreen.html')]});if(contexts.length)return;if(!creatingOffscreen)creatingOffscreen=chrome.offscreen.createDocument({url:'offscreen.html',reasons:['USER_MEDIA','BLOBS','WORKERS'],justification:'영상 전체 오디오를 기기 안에서 분석하며, 사용자가 선택한 경우에만 탭 오디오를 녹음합니다.'}).finally(()=>creatingOffscreen=null);await creatingOffscreen;}
const offscreen=payload=>chrome.runtime.sendMessage({target:'offscreen',...payload});
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
    const result=await offscreen({type:'CAPTURE_RECORD',captureId,videoId:id,title:op.title,startTime:snap.time,snapshotAt:snap.sampledAt,options});if(!result?.ok)throw new Error(result?.error||'녹음을 시작하지 못했습니다.');
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
async function cancel(message='녹음과 분석을 취소했습니다. 자막 만들기를 누르면 다시 시작합니다.'){
  const epoch=++operationEpoch,op=await state();if(op.tabId&&op.videoId)await rememberAuto(`${op.tabId}:${op.videoId}`,{cancelled:true});await setState({...op,phase:'cancelled',message},epoch);
  if(op.tabId){await notify(op.tabId,{type:'CANCEL_AUDIO_LOOKUP',captureId:op.captureId});await notify(op.tabId,{type:'CAPTURE_ACTIVE',active:false});await notify(op.tabId,{type:'CAPTURE_CLEAR'});}if(op.captureId)try{await offscreen({type:'CAPTURE_DISCARD',captureId:op.captureId});}catch{}
}
async function rememberAuto(key,patch){const {autoHistory={}}=await chrome.storage.local.get('autoHistory');autoHistory[key]={...autoHistory[key],...patch,updatedAt:Date.now()};await chrome.storage.local.set({autoHistory:Object.fromEntries(Object.entries(autoHistory).sort((a,b)=>b[1].updatedAt-a[1].updatedAt).slice(0,48))});return autoHistory[key];}
async function startFull(inputOptions,sender={},automatic=false){
  const requestEpoch=operationEpoch;await ensureIdle();const tab=await requestTab(sender),id=youtubeId(tab.url),{localConsent}=await chrome.storage.local.get('localConsent');
  if(localConsent?.enabled!==true)throw new Error('기기 내 분석을 먼저 사용 설정해 주세요.');
  if(requestEpoch!==operationEpoch)return {ok:true,cancelled:true};
  const epoch=++operationEpoch,captureId=crypto.randomUUID(),options=analysisOptions(inputOptions),base={automatic,capture:false,mode:'full',captureId,tabId:tab.id,videoId:id,startTime:0,progress:0};
  await rememberAuto(`${tab.id}:${id}`,{fullAttempted:true,cancelled:false});
  await chrome.storage.local.set({analysisOptions:options});await setState({...base,phase:'preparing',message:'영상 전체 오디오를 확인합니다.'},epoch);
  try{
    const initial=await notify(tab.id,{type:'VIDEO_STATE'});if(initial?.ad)throw new Error('광고가 끝난 뒤 전체 분석을 시작해 주세요.');
    const data=await notify(tab.id,{type:'GET_FULL_SOURCE',videoId:id});
    if(epoch!==operationEpoch)return {ok:true,cancelled:true};
    const source=selectFullSource(data,id,options.language,{allowLookup:true});await ensureOffscreen();
    if(epoch!==operationEpoch)return {ok:true,cancelled:true};
    const op={...base,title:source.title,expectedDuration:source.duration,phase:'running',message:'전체 오디오를 가져옵니다. 영상은 재생하지 않아도 됩니다.'};
    if(!await setState(op,epoch))return {ok:true,cancelled:true};
    const result=await offscreen({type:'FULL_ANALYZE',captureId,source,options});
    if(epoch!==operationEpoch){await offscreen({type:'CAPTURE_DISCARD',captureId});return {ok:true,cancelled:true};}
    if(!result?.ok)throw new Error(result?.error||'전체 분석을 시작하지 못했습니다.');return {ok:true};
  }catch(e){if(epoch!==operationEpoch)return {ok:true,cancelled:true};await setState({...base,phase:'error',message:messageError(e)},epoch);throw e;}
}
async function autoStart(message,sender){
  const data=await chrome.storage.local.get(['settings','analysisOptions','captionCache','autoHistory','localConsent']),settings=normalizeSettings(data.settings),op=await state();
  if(data.localConsent?.enabled!==true||!settings.enabled||!settings.autoAnalyze||busyPhases.includes(op.phase))return {ok:true,skipped:true};
  const tab=await requestTab(sender),focused=await activeTab().catch(()=>null);if(!focused||tab.id!==focused.id)return {ok:true,skipped:true};
  const id=youtubeId(tab.url),key=`${tab.id}:${id}`,snap=await notify(tab.id,{type:'VIDEO_STATE'}),entry=data.autoHistory?.[key]||{};
  if(!snap||snap.videoId!==id||snap.ad||!Number.isFinite(snap.duration))return {ok:true,skipped:true};
  const doc=readyDocument(data.captionCache?.[id],op,id);if(doc?.metadata.analysis_scope==='full-video')return {ok:true,cached:true};
  if(entry.cancelled||entry.fullAttempted)return {ok:true,skipped:true};
  return startFull(data.analysisOptions,{tab},true);
}
const consentSender=sender=>{if(sender.id===chrome.runtime.id&&sender.frameId===0&&sender.tab&&youtubeId(sender.url))return true;try{const u=new URL(sender.url);return u.origin===new URL(chrome.runtime.getURL('popup.html')).origin&&u.protocol==='chrome-extension:'&&u.host===new URL(chrome.runtime.getURL('popup.html')).host&&u.pathname==='/popup.html';}catch{return false;}};
async function handle(message,sender){const handleEpoch=operationEpoch;switch(message.type){
  case 'GET_STATE':{const tab=await requestTab(sender).catch(()=>null),data=await chrome.storage.local.get(['settings','captionCache','analysisOptions','localConsent']),id=tab?youtubeId(tab.url):null,operation=await state(),entry=data.captionCache?.[id],document=readyDocument(entry,operation,id);return {ok:true,operation,settings:normalizeSettings(data.settings),analysisOptions:analysisOptions(data.analysisOptions),localEnabled:data.localConsent?.enabled===true,videoId:id,tabId:tab?.id||null,title:tab?.title||'',document,hasStoredDocument:Boolean(entry),awaitingAnalysis:Boolean(entry&&!document)};}
  case 'TOOLBAR_OPEN':{if(!toolbarSender(sender))throw new Error('도구 모음에서 온소리 아이콘을 직접 눌러 주세요.');const tab=await activeTab(),key=`${tab.id}:${youtubeId(tab.url)}`,{autoHistory={}}=await chrome.storage.local.get('autoHistory');await grant(tab);if(autoHistory[key]?.permissionRequired)await rememberAuto(key,{permissionRequired:false,windows:[]});return autoStart(message,sender);}
  case 'ENABLE_LOCAL':{if(!consentSender(sender))throw new Error('온소리 패널에서 사용 설정해 주세요.');const tab=await requestTab(sender);await chrome.storage.local.set({localConsent:{enabled:true,version:2,enabledAt:Date.now()},analysisOptions:analysisOptions(message.options)});if(toolbarSender(sender))await grant(tab);return autoStart(message,sender);}
  case 'SET_SETTINGS':{const settings=normalizeSettings(message.settings);await chrome.storage.local.set({settings});const op=await state();if(!settings.autoAnalyze&&op.automatic&&busyPhases.includes(op.phase))await cancel('자동 분석을 꺼서 진행 중인 분석을 취소했습니다.');return {ok:true,settings};}
  case 'SET_ANALYSIS_OPTIONS':{const options=analysisOptions(message.options);await chrome.storage.local.set({analysisOptions:options});return {ok:true,options};}
  case 'HEALTH':return {ok:true,health:{status:'ok',message:'AI 모델은 첫 분석 때 내려받아 Chrome에 보관합니다. 오디오와 선택한 화면은 기기 안에서 처리합니다.'}};
  case 'ANALYZE_URL':return startFull(message.options,sender);
  case 'AUTO_START':return autoStart(message,sender);
  case 'START_CAPTURE':{const tab=await requestTab(sender);await rememberAuto(`${tab.id}:${youtubeId(tab.url)}`,{cancelled:false,fullAttempted:true});return startCapture(message.options,sender);}
  case 'STOP_CAPTURE':await stopCapture();return {ok:true};
  case 'CANCEL':await cancel();return {ok:true};
  case 'REPLAY_CAPTURE':{const op=await state(),tab=await requestTab(sender);if(op.phase!=='done'||!Number.isFinite(op.startTime)||tab.id!==op.tabId||youtubeId(tab.url)!==op.videoId)throw new Error('분석이 완료된 같은 영상에서 다시 보기 해 주세요.');const result=await notify(op.tabId,{type:'VIDEO_SEEK',videoId:op.videoId,time:op.startTime});if(!result?.ok)throw new Error(result?.error||'YouTube 페이지를 새로고침해 주세요.');return {ok:true};}
  case 'VIDEO_NAVIGATED':{const op=await state();if(sender.tab?.id===op.tabId&&message.videoId!==op.videoId&&busyPhases.includes(op.phase))await cancel('영상이 바뀌어 이전 녹음과 분석을 취소했습니다.');return {ok:true};}
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
  case 'CAPTURE_REFERENCES':{const op=await state(),evidence=await notify(op.tabId,{type:'NATIVE_CAPTIONS'});return {ok:true,references:Array.isArray(evidence?.references)?evidence.references.slice(0,2000):[],frames:Array.isArray(evidence?.frames)?evidence.frames.slice(0,241):[]};}
  case 'CAPTURE_LIMIT':await stopCapture('60초 녹음을 마쳤습니다. 기기에서 분석합니다.');return {ok:true};
  case 'CAPTURE_ANALYZING':case 'ANALYSIS_PROGRESS':{const epoch=operationEpoch,op=await state();if(['capturing','running','uploading'].includes(op.phase)){await setState({...op,phase:'running',progress:Math.max(0,Math.min(.999,Number(message.progress)||0)),message:String(message.message||'기기에서 소리를 분석합니다.').slice(0,1000)},epoch);if(message.type==='CAPTURE_ANALYZING')await notify(op.tabId,{type:'CAPTURE_ACTIVE',active:false});}return {ok:true};}
  case 'ANALYSIS_COMPLETE':{const epoch=operationEpoch,op=await state();await saveDocument(message.document,op.tabId,{completion:op,epoch});return {ok:true};}
  case 'CAPTURE_ERROR':{const op=await state();if(busyPhases.includes(op.phase)){await setState({...op,phase:'error',message:String(message.error||'기기 내 분석에 실패했습니다. 다시 시도해 주세요.').slice(0,1000)},handleEpoch);await notify(op.tabId,{type:'CAPTURE_ACTIVE',active:false});await notify(op.tabId,{type:'CAPTURE_CLEAR'});}return {ok:true};}
  case 'IMPORT':{await ensureIdle();const tab=await requestTab(sender),doc=validateDocument(message.document);if(doc.video_id!==youtubeId(tab.url))throw new Error('JSON의 영상 ID와 현재 영상이 다릅니다.');await saveDocument(doc,tab.id);return {ok:true};}
  case 'REMOVE_DOCUMENT':{await ensureIdle();const tab=await requestTab(sender),id=youtubeId(tab.url);await write(async()=>{const {captionCache={}}=await chrome.storage.local.get('captionCache');delete captionCache[id];await chrome.storage.local.set({captionCache});});await notify(tab.id,{type:'DOCUMENT_UPDATED',videoId:id});return {ok:true};}
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
  if(['GET_STATE','HEALTH','CANCEL','VIDEO_NAVIGATED'].includes(message.type)){dispatch(message,sender).then(sendResponse,e=>sendResponse({ok:false,error:messageError(e)}));return true;}
  const task=mutation.then(()=>startup).then(()=>dispatch(message,sender));mutation=task.catch(()=>{});task.then(sendResponse,e=>sendResponse({ok:false,error:messageError(e)}));return true;
});
// Recover an offscreen analysis after service-worker suspension; never start capture here.
const startupEpoch=operationEpoch;
const startup=chrome.storage.local.get(['settings','operation']).then(async data=>{
  await chrome.storage.local.set({settings:normalizeSettings(data.settings)});if(!busyPhases.includes(data.operation?.phase))return;
  const session=await offscreen({type:'GET_SESSION'}).catch(()=>null);if(session?.captureId===data.operation.captureId&&!session.discarded&&!session.failed&&(session.recording||session.analyzing||session.preparing))return;
  await setState({...data.operation,phase:'error',message:'이전 분석 연결이 끝났습니다. 현재 구간에서 다시 시작해 주세요.'},startupEpoch);
});
chrome.tabs.onUpdated.addListener((tabId,change)=>{if(!change.url&&change.status!=='loading')return;void (async()=>{const {toolbarGrant}=await chrome.storage.session.get('toolbarGrant');if(toolbarGrant?.tabId===tabId&&(change.status==='loading'||youtubeId(change.url)!==toolbarGrant.videoId))await chrome.storage.session.set({toolbarGrant:null});const op=await state();if(op.tabId===tabId&&busyPhases.includes(op.phase)&&(change.status==='loading'||youtubeId(change.url)!==op.videoId))await cancel('페이지가 바뀌어 녹음과 분석을 취소했습니다.');})();});
chrome.tabs.onRemoved.addListener(tabId=>{void (async()=>{const op=await state();if(op.tabId===tabId&&busyPhases.includes(op.phase))await cancel('영상 탭이 닫혀 녹음과 분석을 취소했습니다.');})();});
