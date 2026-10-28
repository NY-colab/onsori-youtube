import {normalizeSettings,parseDocument,subtitleFile} from './core.js';
const $=id=>document.getElementById(id),fields=['autoAnalyze','enabled','showSpeech','showSound','showMusic','infoLevel','effectStrength','baseSize','offset','positionX','positionY'];let current=null,operation={phase:'idle'},validTab=false,optionsLoaded=false,localEnabled=false,currentVideoId=null,currentTabId=null,pending=false,refreshSequence=0;
const embedded=new URLSearchParams(location.search).get('view')==='panel'&&window.parent!==window;
if(embedded){
  document.documentElement.dataset.view='panel';
  $('collapsePanel').hidden=false;
  // Chrome strips the referrer on web-accessible extension frames.
  const parentOrigin=new URLSearchParams(location.search).get('parent');
  if(['https://www.youtube.com','https://m.youtube.com'].includes(parentOrigin)){
    const post=payload=>window.parent.postMessage(payload,parentOrigin);
    let sizeFrame=0;
    new ResizeObserver(()=>{cancelAnimationFrame(sizeFrame);sizeFrame=requestAnimationFrame(()=>post({type:'ONSORI_PANEL_SIZE',height:document.body.getBoundingClientRect().height+2}));}).observe(document.body);
    $('collapsePanel').addEventListener('click',()=>post({type:'ONSORI_PANEL_COLLAPSE'}));
    window.addEventListener('message',event=>{if(event.source===window.parent&&event.origin===parentOrigin&&event.data?.type==='ONSORI_PANEL_CONTEXT')refresh();});
  }
}
async function send(payload){const r=await chrome.runtime.sendMessage(payload);if(!r?.ok)throw new Error(r?.error||'확장 프로그램에 연결되지 않았습니다.');return r;}
function feedback(text,error=true){$('feedback').textContent=text;$('feedback').style.color=error?'#ffb3b7':'#a2efcd';}
function renderOperation(op){
  operation=op;
  const busy=['requesting','preparing','capturing','uploading','queued','running'].includes(op.phase);
  const own=(!op.videoId||op.videoId===currentVideoId)&&(!op.tabId||op.tabId===currentTabId),recording=op.phase==='capturing'&&own;
  $('operationPanel').hidden=op.phase==='idle'||(!busy&&!own);
  $('operationPanel').dataset.error=String(op.phase==='error');
  $('operationMessage').textContent=own?op.message||'':'다른 YouTube 탭에서 분석 중입니다. 해당 탭에서 진행 상태를 확인하거나 완료 후 다시 시작해 주세요.';
  $('phaseLabel').textContent=!own?'다른 영상 분석 중':({waiting_permission:'녹음 연결',requesting:'분석 요청',preparing:op.mode==='full'?'영상 전체 분석 준비':'녹음 준비',capturing:'탭 오디오 녹음 중',uploading:'기기 내 분석 준비',queued:'분석 대기',running:'소리 분석 중',done:'자막 적용 완료',error:'확인이 필요합니다',cancelled:'분석 취소'})[op.phase]||'분석 상태';
  $('progress').value=op.progress||0;$('progress').hidden=!busy||recording||!own;
  $('stop').hidden=!recording;$('cancel').hidden=!busy||!own;$('replay').hidden=op.phase!=='done'||!(op.capture||op.mode==='full')||!own;
  $('capture').disabled=busy||pending||!validTab||!localEnabled;$('record').disabled=busy||pending||!validTab||!localEnabled;$('enableLocal').disabled=busy||pending||!validTab;
  $('captureClock').textContent=recording?`${Math.max(0,Math.min(60,Math.floor((Date.now()-(op.startedAt||Date.now()))/1000)))} / 60초`:'';
  const silent=op.level?.silentSeconds>=5;$('audioSignal').hidden=!recording;$('audioSignal').dataset.silent=String(silent);
  $('audioSignal').textContent=silent?'소리 입력이 작거나 없습니다. 영상·탭 음소거를 확인하세요.':op.level?.bytes>0?`소리 수신 중 · ${Math.round(op.level.bytes/1024)} KB`:'탭 오디오 신호 확인 중';
  $('audioMeter').hidden=!recording;$('audioMeter').value=Math.min(1,Math.sqrt(op.level?.rms||0)*3);
}
async function refresh(){const sequence=++refreshSequence;try{const data=await send({type:'GET_STATE'});if(sequence!==refreshSequence)return;validTab=Boolean(data.videoId);currentVideoId=data.videoId;currentTabId=data.tabId;current=data.document;localEnabled=data.localEnabled===true;$('setupHelp').hidden=localEnabled;$('analysisControls').hidden=!localEnabled;$('videoTitle').textContent=validTab?data.title.replace(/ - YouTube$/,''):'YouTube 영상 페이지에서 사용해 주세요.';$('documentStatus').textContent=current?`${current.cues.length}개 자막 · 영상에 연결됨`:data.awaitingAnalysis?'분석 완료 후 자막 표시':'이 영상의 자막 없음';$('export').disabled=!current;$('remove').disabled=!data.hasStoredDocument;$('importButton').disabled=!validTab;for(const id of fields){const el=$(id);if(document.activeElement===el)continue;if(el.type==='checkbox')el.checked=data.settings[id];else el.value=data.settings[id];}if(!optionsLoaded){$('language').value=data.analysisOptions.language;$('musicDetail').checked=data.analysisOptions.music_detail;$('captureFrames').checked=data.analysisOptions.capture_frames;optionsLoaded=true;}strengthLabel();positionPreview();renderOperation(data.operation);}catch(e){feedback(e.message);}}
function strengthLabel(){$('strengthValue').textContent=({'0':'고정','0.5':'부드럽게','1':'강하게'})[$('effectStrength').value];}
function analysisOptions(){return {language:$('language').value,music_detail:$('musicDetail').checked,capture_frames:$('captureFrames').checked};}
async function action(type){feedback('');pending=true;renderOperation(operation);try{await send({type,options:analysisOptions()});}catch(e){feedback(e.message);}finally{pending=false;await refresh();}}
async function saveSettings(){const settings={typographyVersion:2};for(const key of fields){const el=$(key);settings[key]=el.type==='checkbox'?el.checked:el.value;}try{await send({type:'SET_SETTINGS',settings:normalizeSettings(settings)});strengthLabel();positionPreview();}catch(e){feedback(e.message);}}
for(const id of fields)$(id).addEventListener('change',saveSettings);
for(const id of ['positionX','positionY'])$(id).addEventListener('input',()=>{positionPreview();saveSettings();});
function positionPreview(){for(const id of ['positionX','positionY'])$(id+'Value').textContent=$(id).value+'%';$('positionSample').style.left=`clamp(58px, ${$('positionX').value}%, calc(100% - 58px))`;$('positionSample').style.top=`clamp(17px, ${$('positionY').value}%, calc(100% - 17px))`;}
$('resetPosition').addEventListener('click',()=>{$('positionX').value=50;$('positionY').value=88;positionPreview();saveSettings();});
$('effectStrength').addEventListener('input',strengthLabel);$('studio').addEventListener('click',()=>action('OPEN_HELP'));$('enableLocal').addEventListener('click',()=>action('ENABLE_LOCAL'));$('capture').addEventListener('click',()=>action('ANALYZE_URL'));$('record').addEventListener('click',()=>action('START_CAPTURE'));$('stop').addEventListener('click',()=>action('STOP_CAPTURE'));$('cancel').addEventListener('click',()=>action('CANCEL'));$('remove').addEventListener('click',()=>action('REMOVE_DOCUMENT'));
$('replay').addEventListener('click',()=>action('REPLAY_CAPTURE'));
$('importButton').addEventListener('click',()=>$('importFile').click());$('importFile').addEventListener('change',async event=>{const file=event.target.files[0];if(!file)return;try{if(file.size>10*1024*1024)throw new Error('JSON 파일은 10MB 이하만 선택해 주세요.');const doc=parseDocument(await file.text());await send({type:'IMPORT',document:doc});feedback('현재 영상에 자막을 적용했습니다.',false);await refresh();}catch(e){feedback(e.message);}event.target.value='';});
$('export').addEventListener('click',()=>{if(!current)return;const blob=new Blob([subtitleFile(current,'json')],{type:'application/json;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`onsori-${current.video_id}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
chrome.storage.onChanged.addListener((changes,area)=>{if(area!=='local')return;if(changes.operation)renderOperation(changes.operation.newValue||{phase:'idle'});if(changes.analysisOptions)optionsLoaded=false;if(changes.captionCache||changes.settings||changes.operation||changes.localConsent||changes.analysisOptions)refresh();});setInterval(()=>{if(operation.phase==='capturing')renderOperation(operation);},1000);refresh();if(!embedded)send({type:'TOOLBAR_OPEN'}).then(()=>refresh()).catch(e=>feedback(e.message));

for(const id of ['language','musicDetail','captureFrames'])$(id).addEventListener('change',()=>send({type:'SET_ANALYSIS_OPTIONS',options:analysisOptions()}).catch(e=>feedback(e.message)));
