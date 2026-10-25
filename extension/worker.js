import {DEFAULT_SETTINGS,normalizeSettings,validateDocument,youtubeId,readyDocument} from './core.js';
const API='http://127.0.0.1:8765',HEADERS={'X-OnSori-Client':'onsori-local-v1'};
let pollTimer,creatingOffscreen,mutation=Promise.resolve(),operationEpoch=0;
const messageError=e=>{const text=e?.message||String(e);return /Extension has not been invoked|activeTab permission/i.test(text)?'YouTube 영상에서 Chrome 도구 모음의 온소리 아이콘을 직접 클릭한 뒤 구간 녹음을 시작해 주세요.':text;};
async function api(path,options={}){let response;try{response=await fetch(API+path,{...options,headers:{...HEADERS,...options.headers},signal:AbortSignal.timeout(15000)});}catch{throw new Error('분석 서버가 꺼져 있습니다. 온소리 폴더의 Start-OnSori.cmd를 실행한 뒤 다시 시도해 주세요.');}if(!response.ok){let body;try{body=await response.json();}catch{}throw new Error(body?.detail||body?.error||`분석 요청 오류 (${response.status})`);}return response.json();}
async function state(){return (await chrome.storage.local.get('operation')).operation||{phase:'idle',message:'분석할 YouTube 영상을 선택해 주세요.'};}
async function setState(value){const operation={...value,updatedAt:Date.now()};const update={operation};
  // Invalidate playback before recording/requesting, atomically with progress.
  // Keep prior data internally for successful range merges, never as a fallback.
  if(operation.videoId&&['requesting','preparing'].includes(operation.phase)){
    const {captionCache={}}=await chrome.storage.local.get('captionCache');
    if(captionCache[operation.videoId])update.captionCache={...captionCache,[operation.videoId]:{...captionCache[operation.videoId],ready:false}};
  }
  await chrome.storage.local.set(update);if(operation.tabId)await notify(operation.tabId,{type:'OPERATION_UPDATED',operation});}
function analysisOptions(value={}){return {language:['ko','auto','en'].includes(value.language)?value.language:'ko',whisper_model:'base',event_detection:true,audio_captioning:value.audio_captioning===true};}
async function notify(tabId,payload){try{return await chrome.tabs.sendMessage(tabId,payload);}catch{return null;}}
async function activeTab(){const tabs=await chrome.tabs.query({active:true,currentWindow:true});const tab=tabs[0];if(!tab?.id||!youtubeId(tab.url))throw new Error('YouTube 영상의 재생 페이지에서 열어 주세요. 설치 직후라면 페이지를 새로고침해 주세요.');return tab;}
// Embedded panels belong to their containing tab, even when another tab has focus.
async function requestTab(sender={}){if(!sender.tab)return activeTab();const tab=await chrome.tabs.get(sender.tab.id);if(!tab?.id||!youtubeId(tab.url))throw new Error('YouTube 영상의 재생 페이지에서 사용해 주세요.');return tab;}
async function saveDocument(input,tabId,{merge=false,start=0,end=0,origin='analysis',completion=null,epoch=operationEpoch}={}){
  let doc=validateDocument(input);if(!doc.video_id)throw new Error('이 자막에는 YouTube 영상 ID가 없습니다. 스튜디오에서 영상 ID를 지정한 뒤 가져와 주세요.');
  const data=await chrome.storage.local.get('captionCache'),cache=data.captionCache||{};
  const previous=cache[doc.video_id];const reusable=previous?.displayVersion===2&&previous.document.metadata?.audio_analyzed!==false&&previous.document.metadata?.partial!==true;
  if(merge&&reusable){const old=cache[doc.video_id].document;const kept=old.cues.filter(c=>c.end<=start||c.start>=end);doc=validateDocument({...doc,duration:Math.max(old.duration,doc.duration),cues:[...kept,...doc.cues.map((c,i)=>({...c,id:`clip-${Date.now()}-${i}-${c.id.slice(0,60)}`}))],warnings:[...new Set([...old.warnings,...doc.warnings])].slice(0,100)});}
  const oldCache=cache[doc.video_id],oldRanges=!reusable?[]:(oldCache?.ranges||(oldCache?[[oldCache.document.metadata?.analyzed_start||0,oldCache.document.duration]]:[]));
  const ranges=merge?[...oldRanges,[start,end]]:[[doc.metadata?.analyzed_start||0,doc.duration]];
  cache[doc.video_id]={document:doc,ranges:ranges.slice(-100),savedAt:Date.now(),ready:true,displayVersion:2,origin};
  let entries=Object.entries(cache).sort((a,b)=>b[1].savedAt-a[1].savedAt).slice(0,8);
  while(entries.length>1&&JSON.stringify(Object.fromEntries(entries)).length>3_000_000)entries.pop();
  if(JSON.stringify(Object.fromEntries(entries)).length>4_000_000)throw new Error('자막 파일이 확장 프로그램 보관 한도를 넘습니다. 자막을 구간별로 나누어 주세요.');
  const update={captionCache:Object.fromEntries(entries)};
  if(completion){
    const latest=await state();
    if(epoch!==operationEpoch||latest.jobId!==completion.jobId||!['queued','running'].includes(latest.phase))return null;
    update.operation={...completion,phase:'done',progress:1,message:`${doc.cues.length}개 자막을 영상에 적용했습니다.`,jobId:null,updatedAt:Date.now()};
  }
  await chrome.storage.local.set(update);
  if(update.operation&&tabId)await notify(tabId,{type:'OPERATION_UPDATED',operation:update.operation});
  if(tabId)await notify(tabId,{type:'DOCUMENT_UPDATED',videoId:doc.video_id});return doc;
}
function schedulePoll(){clearTimeout(pollTimer);pollTimer=setTimeout(poll,1700);}
async function poll(){const epoch=operationEpoch,op=await state();if(!op.jobId||!['queued','running'].includes(op.phase))return;try{
  const job=await api(`/api/jobs/${encodeURIComponent(op.jobId)}`);
  const latest=await state();if(latest.jobId!==op.jobId||latest.phase==='cancelled')return;
  if(job.status==='done'){
    if(!job.result)throw new Error('분석 서버에서 자막 결과를 받지 못했습니다.');
    if(job.result.metadata?.partial===true||job.result.metadata?.audio_analyzed===false)throw new Error('소리 분석이 끝나지 않아 자막을 표시하지 않습니다. 탭 녹음으로 이어서 분석합니다.');
    await saveDocument(job.result,op.tabId,{merge:op.capture===true,start:op.startTime,end:job.result.duration,completion:op,epoch});
  }else if(['error','cancelled'].includes(job.status)){await setState({...op,phase:job.status,jobId:null,message:job.error||job.message||'분석이 중단되었습니다.'});}
  else{await setState({...op,phase:job.status,progress:job.progress||0,message:job.message||'소리를 분석하고 있습니다.'});schedulePoll();}
}catch(e){const latest=await state();if(epoch!==operationEpoch||latest.jobId!==op.jobId)return;await setState({...op,phase:'error',jobId:null,message:messageError(e)});}}
async function ensureOffscreen(){const existing=await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT'],documentUrls:[chrome.runtime.getURL('offscreen.html')]});if(existing.length)return;if(!creatingOffscreen){creatingOffscreen=chrome.offscreen.createDocument({url:'offscreen.html',reasons:['USER_MEDIA'],justification:'사용자가 요청한 현재 YouTube 탭의 최대 60초 오디오를 녹음하고 원래 재생음을 유지합니다.'}).finally(()=>creatingOffscreen=null);}await creatingOffscreen;}
async function offscreen(payload){return chrome.runtime.sendMessage({target:'offscreen',...payload});}
async function ensureIdle(){const op=await state();if(['requesting','preparing','capturing','uploading','queued','running'].includes(op.phase))throw new Error('진행 중인 분석을 먼저 중단해 주세요.');}
async function startCapture(inputOptions,sender,automatic=false){await ensureIdle();const epoch=++operationEpoch,captureId=crypto.randomUUID();const options=analysisOptions(inputOptions);await chrome.storage.local.set({analysisOptions:options});const tab=await requestTab(sender);const id=youtubeId(tab.url);const base={automatic,capture:true,captureId,tabId:tab.id,videoId:id,progress:0};await setState({...base,phase:'preparing',message:'탭 오디오를 연결한 뒤 영상을 1배속으로 재생합니다.'});try{
  const initial=await notify(tab.id,{type:'VIDEO_STATE'});if(!initial||initial.videoId!==id)throw new Error('영상에 연결되지 않았습니다. YouTube 페이지를 새로고침해 주세요.');
  if(automatic&&(initial.paused||initial.rate!==1))throw new Error('자동 녹음은 영상이 1배속으로 재생될 때 시작됩니다.');
  if(initial.ad)throw new Error('광고가 끝난 뒤 자막 만들기를 눌러 주세요. 광고 오디오는 녹음하지 않습니다.');
  await api('/api/health');if(epoch!==operationEpoch)return {ok:true,cancelled:true};await ensureOffscreen();
  if(epoch!==operationEpoch)return {ok:true,cancelled:true};
  const streamId=await chrome.tabCapture.getMediaStreamId({targetTabId:tab.id});
  if(epoch!==operationEpoch)return {ok:true,cancelled:true};
  const prepared=await offscreen({type:'CAPTURE_PREPARE',captureId,streamId});if(!prepared?.ok)throw new Error(prepared?.error||'탭 오디오를 연결할 수 없습니다.');
  if(epoch!==operationEpoch){await offscreen({type:'CAPTURE_DISCARD',captureId});return {ok:true,cancelled:true};}
  const snap=await notify(tab.id,{type:'PREPARE_CAPTURE',videoId:id});if(epoch!==operationEpoch){await offscreen({type:'CAPTURE_DISCARD',captureId});return {ok:true,cancelled:true};}if(snap?.error)throw new Error(snap.error);if(!snap||snap.videoId!==id||snap.paused||snap.rate!==1||snap.ad)throw new Error('영상을 재생할 수 없습니다. 영상의 재생 버튼을 누른 뒤 다시 시도해 주세요.');
  const op={...base,phase:'capturing',title:snap.title.slice(0,300),startTime:snap.time,startedAt:Date.now(),message:'최대 60초 녹음 후 분석합니다. 이 창을 닫아도 영상에서 진행 상태를 볼 수 있습니다.'};await setState(op);
  await notify(tab.id,{type:'CAPTURE_ACTIVE',active:true});
  if(epoch!==operationEpoch){await offscreen({type:'CAPTURE_DISCARD',captureId});await notify(tab.id,{type:'CAPTURE_ACTIVE',active:false});return {ok:true,cancelled:true};}
  const result=await offscreen({type:'CAPTURE_RECORD',captureId,videoId:id,title:op.title,startTime:snap.time,snapshotAt:snap.sampledAt,options});if(!result?.ok)throw new Error(result?.error||'녹음을 시작하지 못했습니다.');
  if(epoch!==operationEpoch){await offscreen({type:'CAPTURE_DISCARD',captureId});return {ok:true,cancelled:true};}
  await setState({...op,startedAt:result.startedAt,startTime:result.startTime});
  return {ok:true};
}catch(e){try{await offscreen({type:'CAPTURE_DISCARD',captureId});}catch{}await notify(tab.id,{type:'CAPTURE_ACTIVE',active:false});if(epoch!==operationEpoch)return {ok:true,cancelled:true};await setState({...base,phase:'error',message:messageError(e)});throw e;}}
async function stopCapture(reason='요청한 구간 녹음이 끝났습니다.'){const op=await state();if(op.phase!=='capturing')return;await setState({...op,phase:'uploading',message:`${reason} 녹음 구간을 분석 서버로 보냅니다.`});await notify(op.tabId,{type:'CAPTURE_ACTIVE',active:false});const result=await offscreen({type:'CAPTURE_STOP',captureId:op.captureId});if(!result?.ok&&(await state()).phase==='uploading'){await setState({...op,phase:'error',message:result?.error||'녹음을 종료할 수 없습니다.'});}}
async function cancel(){operationEpoch++;const op=await state();if(op.tabId&&op.videoId)await rememberAuto(`${op.tabId}:${op.videoId}`,{cancelled:true});clearTimeout(pollTimer);await setState({...op,phase:'cancelled',message:'녹음과 분석을 취소했습니다. 다시 자막 만들기를 누르면 새로 시작합니다.',jobId:null});if(op.tabId)await notify(op.tabId,{type:'CAPTURE_ACTIVE',active:false});if(['capturing','uploading','preparing'].includes(op.phase)){try{await offscreen({type:'CAPTURE_DISCARD',captureId:op.captureId});}catch{}}if(op.jobId){try{await api(`/api/jobs/${encodeURIComponent(op.jobId)}`,{method:'DELETE'});}catch{}}}
async function startUrl(inputOptions,sender,automatic=false){await ensureIdle();const epoch=++operationEpoch;const options=analysisOptions(inputOptions);await chrome.storage.local.set({analysisOptions:options});const tab=await requestTab(sender);const id=youtubeId(tab.url);await setState({automatic,phase:'requesting',tabId:tab.id,videoId:id,message:'영상 분석을 요청하고 있습니다.',progress:0});try{const job=await api('/api/jobs/youtube',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:tab.url,...options})});if(epoch!==operationEpoch){try{await api(`/api/jobs/${encodeURIComponent(job.id)}`,{method:'DELETE'});}catch{}return {ok:true,cancelled:true};}await setState({automatic,phase:job.status,jobId:job.id,tabId:tab.id,videoId:id,progress:job.progress||0,message:job.message||'분석 대기 중입니다.'});schedulePoll();return {ok:true};}catch(e){if(epoch!==operationEpoch)return {ok:true,cancelled:true};await setState({automatic,phase:'error',tabId:tab.id,videoId:id,message:messageError(e)});throw e;}}


const busyPhases=['requesting','preparing','capturing','uploading','queued','running'];
async function rememberAuto(key,patch){
  const data=await chrome.storage.local.get('autoHistory'),history=data.autoHistory||{};
  history[key]={...history[key],...patch,updatedAt:Date.now()};
  await chrome.storage.local.set({autoHistory:Object.fromEntries(Object.entries(history).sort((a,b)=>b[1].updatedAt-a[1].updatedAt).slice(0,48))});
  return history[key];
}
async function autoStart(message,sender){
  const epoch=operationEpoch;
  const data=await chrome.storage.local.get(['settings','analysisOptions','captionCache','autoHistory']);
  const settings=normalizeSettings(data.settings),op=await state();
  if(!settings.enabled||!settings.autoAnalyze||busyPhases.includes(op.phase))return {ok:true,skipped:true};
  const tab=await requestTab(sender),focused=await activeTab();
  if(tab.id!==focused.id)return {ok:true,skipped:true};
  const id=youtubeId(tab.url),key=`${tab.id}:${id}`,snap=await notify(tab.id,{type:'VIDEO_STATE'});
  if(op.phase==='cancelled'&&op.tabId===tab.id&&op.videoId===id)return {ok:true,skipped:true};
  let entry=data.autoHistory?.[key]||{};
  const invoked=message.invoked===true&&!sender.tab&&sender.url?.startsWith(chrome.runtime.getURL('popup.html'));
  if(invoked&&entry.permissionRequired)entry=await rememberAuto(key,{permissionRequired:false,windows:[]});
  if(!snap||snap.videoId!==id||snap.ad||snap.paused||snap.ended||!Number.isFinite(snap.duration)||snap.duration>1200||snap.duration-snap.time<2)return {ok:true,skipped:true};
  const cached=data.captionCache?.[id],meta=cached?.document?.metadata;
  const ranges=cached?.ranges||[[meta?.analyzed_start||0,cached?.document?.duration||0]];
  if(readyDocument(cached,op,id)&&meta?.audio_analyzed!==false&&ranges.some(([start,end])=>snap.time>=start&&snap.time<end-.15))return {ok:true,cached:true};
  // Opening the toolbar popup is the browser's user invocation; only it can
  // retry a permission failure. Content scripts cannot synthesize this grant.
  if(entry.cancelled||entry.retryAfter>Date.now()||(entry.permissionRequired&&!invoked))return {ok:true,skipped:true};
  if(cached&&cached.displayVersion!==2&&entry.legacyResetVersion!==2)entry=await rememberAuto(key,{legacyReset:true,legacyResetVersion:2,urlAttempted:false,windows:[]});
  try{await api('/api/health');}catch(e){if(epoch!==operationEpoch)return {ok:true,cancelled:true};await rememberAuto(key,{retryAfter:Date.now()+30000});if(epoch!==operationEpoch)return {ok:true,cancelled:true};await setState({phase:'waiting_server',tabId:tab.id,videoId:id,message:messageError(e)});return {ok:true,waiting:true};}
  if(epoch!==operationEpoch)return {ok:true,cancelled:true};
  if(!entry.urlAttempted){
    entry=await rememberAuto(key,{urlAttempted:true});
    if(epoch!==operationEpoch)return {ok:true,cancelled:true};
    try{return await startUrl(data.analysisOptions,{tab},true);}catch{ /* Try captured audio on the next playback tick. */ return {ok:true,fallback:true};}
  }
  if(snap.rate!==1)return {ok:true,skipped:true};
  const window=Math.floor(snap.time/60),windows=entry.windows||[];
  if(windows.includes(window)&&!invoked)return {ok:true,skipped:true};
  await rememberAuto(key,{windows:[...new Set([...windows,window])].slice(-21),permissionRequired:false});
  if(epoch!==operationEpoch)return {ok:true,cancelled:true};
  try{return await startCapture(data.analysisOptions,{tab},true);}catch(e){
    if(/Extension has not been invoked|activeTab permission/i.test(e.message||'')){
      await rememberAuto(key,{permissionRequired:true});
      await setState({phase:'waiting_permission',tabId:tab.id,videoId:id,message:'탭 녹음을 연결하려면 도구 모음의 온소리 아이콘을 한 번 눌러 주세요. 영상 재생 중이면 자동으로 이어집니다.'});
    }
    return {ok:true,waiting:true};
  }
}

async function handle(message,sender){switch(message.type){
  case 'GET_STATE':{const tab=await requestTab(sender).catch(()=>null);const data=await chrome.storage.local.get(['settings','captionCache','analysisOptions']);const id=tab?youtubeId(tab.url):null,operation=await state(),entry=id?data.captionCache?.[id]:null,document=readyDocument(entry,operation,id);return {ok:true,operation,settings:normalizeSettings(data.settings),analysisOptions:analysisOptions(data.analysisOptions),videoId:id,tabId:tab?.id||null,title:tab?.title||'',document,hasStoredDocument:Boolean(entry),awaitingAnalysis:Boolean(entry&&!document)};}
  case 'SET_SETTINGS':{const settings=normalizeSettings(message.settings);await chrome.storage.local.set({settings});return {ok:true,settings};}
  case 'HEALTH':return {ok:true,health:await api('/api/health')};
  case 'ANALYZE_URL':return startUrl(message.options,sender);
  case 'AUTO_START':return autoStart(message,sender);
  case 'START_CAPTURE':return startCapture(message.options,sender);
  case 'STOP_CAPTURE':await stopCapture();return {ok:true};
  case 'CANCEL':await cancel();return {ok:true};
  case 'REPLAY_CAPTURE':{const op=await state();if(op.phase!=='done'||!op.capture||!Number.isFinite(op.startTime))throw new Error('완료된 녹음 구간이 없습니다.');const tab=await requestTab(sender);if(tab.id!==op.tabId||youtubeId(tab.url)!==op.videoId)throw new Error('분석한 YouTube 영상 탭에서 다시 보기를 눌러 주세요.');const result=await notify(op.tabId,{type:'VIDEO_SEEK',videoId:op.videoId,time:op.startTime});if(!result?.ok)throw new Error(result?.error||'영상에 연결되지 않았습니다. 페이지를 새로고침해 주세요.');return {ok:true};}
  case 'CAPTURE_INTERRUPTED':{const op=await state();if(sender.tab?.id===op.tabId)await stopCapture(message.reason||'영상 재생 상태가 바뀌었습니다.');return {ok:true};}
  case 'CAPTURE_LEVEL':{const op=await state();if(op.phase==='capturing')await setState({...op,level:{rms:message.rms,peak:message.peak,elapsed:message.elapsed,bytes:message.bytes,silentSeconds:message.silentSeconds}});return {ok:true};}
  case 'CAPTURE_REFERENCES':{const op=await state();const evidence=await notify(op.tabId,{type:'NATIVE_CAPTIONS'});return {ok:true,references:Array.isArray(evidence?.references)?evidence.references.slice(0,2000):[],frames:Array.isArray(evidence?.frames)?evidence.frames.slice(0,241):[]};}
  case 'CAPTURE_LIMIT':await stopCapture('60초 녹음이 완료되었습니다.');return {ok:true};
  case 'CAPTURE_UPLOADING':{const op=await state();if(op.phase==='capturing'){await setState({...op,phase:'uploading',message:'녹음한 구간을 분석 서버에 보내고 있습니다.'});await notify(op.tabId,{type:'CAPTURE_ACTIVE',active:false});}return {ok:true};}
  case 'CAPTURE_JOB':{const op=await state();if(!['uploading','capturing'].includes(op.phase)){try{await api(`/api/jobs/${encodeURIComponent(message.job.id)}`,{method:'DELETE'});}catch{}return {ok:true};}await setState({...op,phase:message.job.status,jobId:message.job.id,progress:message.job.progress||0,message:message.job.message||'녹음 구간을 분석하고 있습니다.'});schedulePoll();return {ok:true};}
  case 'CAPTURE_ERROR':{const op=await state();if(['capturing','preparing','uploading'].includes(op.phase)){await setState({...op,phase:'error',jobId:null,message:message.error});if(op.tabId)await notify(op.tabId,{type:'CAPTURE_ACTIVE',active:false});}return {ok:true};}
  case 'IMPORT':{await ensureIdle();const tab=await requestTab(sender);const doc=validateDocument(message.document);if(doc.video_id!==youtubeId(tab.url))throw new Error('자막의 영상 ID와 현재 YouTube 영상이 다릅니다. 해당 영상에서 다시 가져와 주세요.');await saveDocument(doc,tab.id,{origin:'import'});return {ok:true};}
  case 'REMOVE_DOCUMENT':{const tab=await requestTab(sender),id=youtubeId(tab.url);const data=await chrome.storage.local.get('captionCache'),cache=data.captionCache||{};delete cache[id];await chrome.storage.local.set({captionCache:cache});await notify(tab.id,{type:'DOCUMENT_UPDATED',videoId:id});return {ok:true};}
  case 'OPEN_STUDIO':await chrome.tabs.create({url:API});return {ok:true};
  default:return {ok:false,error:'알 수 없는 요청입니다.'};}}
async function dispatch(message,sender){
  if(['CAPTURE_REFERENCES','CAPTURE_LEVEL','CAPTURE_LIMIT','CAPTURE_UPLOADING','CAPTURE_JOB','CAPTURE_ERROR'].includes(message.type)){
    if(sender.url!==chrome.runtime.getURL('offscreen.html'))return {ok:false,error:'녹음 문서에서 온 요청이 아닙니다.'};
    const op=await state();if(!message.captureId||message.captureId!==op.captureId){if(message.type==='CAPTURE_JOB'&&message.job?.id){try{await api(`/api/jobs/${encodeURIComponent(message.job.id)}`,{method:'DELETE'});}catch{}}return {ok:true,ignored:true};}
  }
  if(sender.tab&&['STOP_CAPTURE','CANCEL'].includes(message.type)){const op=await state();if(sender.tab.id!==op.tabId||youtubeId(sender.tab.url)!==op.videoId)return {ok:false,error:'현재 녹음 중인 영상에서만 조작할 수 있습니다.'};}
  return handle(message,sender);
}
chrome.runtime.onMessage.addListener((message,sender,sendResponse)=>{
  if(message.target==='offscreen')return;
  if(['GET_STATE','HEALTH','CANCEL'].includes(message.type)){dispatch(message,sender).then(sendResponse,e=>sendResponse({ok:false,error:messageError(e)}));return true;}
  // All mutations serialize to prevent double clicks starting competing jobs.
  const task=mutation.then(()=>dispatch(message,sender));mutation=task.catch(()=>{});task.then(sendResponse,e=>sendResponse({ok:false,error:messageError(e)}));return true;
});
chrome.storage.local.get(['settings','operation']).then(async data=>{await chrome.storage.local.set({settings:normalizeSettings(data.settings)});if(['queued','running'].includes(data.operation?.phase))schedulePoll();else if(['requesting','preparing'].includes(data.operation?.phase))await setState({...data.operation,phase:'error',message:'연결이 끊어졌습니다. 분석을 다시 시작해 주세요.'});});
chrome.tabs.onUpdated.addListener(async(tabId,change)=>{if(!change.url&&change.status!=='loading')return;const task=mutation.then(async()=>{const op=await state();if(op.tabId===tabId&&op.phase==='capturing'&&(change.status==='loading'||youtubeId(change.url)!==op.videoId))await stopCapture('영상 페이지가 새로고침되거나 변경되었습니다.');});mutation=task.catch(()=>{});await task;});
chrome.tabs.onRemoved.addListener(async tabId=>{const op=await state();if(op.tabId===tabId&&['capturing','preparing'].includes(op.phase))await cancel();});
