import {normalizeSettings,parseDocument,subtitleFile} from './core.js';
import {CAPTION_FONTS,FONT_GROUPS,CAPTION_THEMES,CAPTION_CSS,STYLE_DEFAULTS,FONT_NAME,matchTheme,themeSettings,applyCaptionStyle,captionStyleVars,ensureCaptionFont,fontInfo,effectiveWeight} from './caption-style.js';
// YouTube sees shadow-DOM key events as coming from our host element, not an input, so a
// focused control's own keys would also seek, play or change volume. Keep only those keys
// inside OnSori; every other key, and any key pressed outside OnSori, still reaches YouTube.
const RANGE_KEYS=new Set(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown']),ACTIVATE_KEYS=new Set([' ','Enter']);
export function controlOwnsKey(target,key){
  const tag=target?.tagName,type=String(target?.type||'').toLowerCase();
  if(tag==='SELECT'||tag==='TEXTAREA'||target?.isContentEditable)return true;
  if(tag==='INPUT')return type==='range'?RANGE_KEYS.has(key):['checkbox','radio','button','submit','reset','file'].includes(type)?ACTIVATE_KEYS.has(key):true;
  return (tag==='BUTTON'||tag==='SUMMARY')&&ACTIVATE_KEYS.has(key);
}
export function keepControlKeys(root){for(const type of ['keydown','keypress','keyup'])root.addEventListener(type,event=>{if(controlOwnsKey(event.target,event.key))event.stopPropagation();});}
export function mountControls(root,{embedded=false,onCollapse=()=>{}}={}) {
const $=id=>root.getElementById(id),fields=['autoAnalyze','enabled','showSpeech','showSound','showMusic','infoLevel','effectStrength','baseSize','offset','positionX','positionY','fontWeight','textColor','edgeStyle','edgeColor','bgColor','bgOpacity','bgShape','bgRadius','kindAccent'];let current=null,operation={phase:'idle'},validTab=false,optionsLoaded=false,localEnabled=false,currentVideoId=null,currentTabId=null,pending=false,refreshSequence=0;

if(embedded){
  $('collapsePanel').hidden=false;
  // The page may see the open shadow DOM, but cannot synthesize user actions.
  for(const type of ['click','change','input'])root.addEventListener(type,event=>{
    if(!event.isTrusted&&!(type==='click'&&event.target===$('importFile'))){event.preventDefault();event.stopImmediatePropagation();}
  },true);
  keepControlKeys(root);
  $('collapsePanel').addEventListener('click',onCollapse);
}
async function send(payload){const r=await chrome.runtime.sendMessage(payload);if(!r?.ok)throw new Error(r?.error||'확장 프로그램에 연결되지 않았습니다.');return r;}
function feedback(text,error=true){$('feedback').textContent=text;$('feedback').dataset.tone=error?'error':'ok';}
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
async function refresh(){const sequence=++refreshSequence;try{const data=await send({type:'GET_STATE'});if(sequence!==refreshSequence)return;validTab=Boolean(data.videoId);currentVideoId=data.videoId;currentTabId=data.tabId;current=data.document;localEnabled=data.localEnabled===true;$('setupHelp').hidden=localEnabled;$('analysisControls').hidden=!localEnabled;$('videoTitle').textContent=validTab?data.title.replace(/ - YouTube$/,''):'YouTube 영상 페이지에서 사용해 주세요.';$('documentStatus').textContent=current?`${current.cues.length}개 자막 · 영상에 연결됨`:data.awaitingAnalysis?'분석 완료 후 자막 표시':'이 영상의 자막 없음';$('export').disabled=!current;$('remove').disabled=!data.hasStoredDocument;$('importButton').disabled=!validTab;for(const id of fields){const el=$(id);if((root.activeElement||document.activeElement)===el)continue;if(el.type==='checkbox')el.checked=data.settings[id];else el.value=data.settings[id];}showFont(data.settings.fontFamily);if(!optionsLoaded){$('language').value=data.analysisOptions.language;$('musicDetail').checked=data.analysisOptions.music_detail;$('captureFrames').checked=data.analysisOptions.capture_frames;optionsLoaded=true;}strengthLabel();positionPreview();renderDesign();renderOperation(data.operation);}catch(e){feedback(e.message);}}
function strengthLabel(){$('strengthValue').textContent=({'0':'고정','0.5':'부드럽게','1':'강하게'})[$('effectStrength').value];}
function analysisOptions(){return {language:$('language').value,music_detail:$('musicDetail').checked,capture_frames:$('captureFrames').checked};}
async function action(type){feedback('');pending=true;renderOperation(operation);try{await send({type,options:analysisOptions()});}catch(e){feedback(e.message);}finally{pending=false;await refresh();}}
function fieldSettings(){const settings={typographyVersion:2,fontFamily:chosenFont()};for(const key of fields){const el=$(key);settings[key]=el.type==='checkbox'?el.checked:el.value;}return normalizeSettings(settings);}
async function saveSettings(){const settings=fieldSettings();try{await send({type:'SET_SETTINGS',settings});shownFont=settings.fontFamily;strengthLabel();positionPreview();renderDesign();}catch(e){feedback(e.message);}}
for(const id of fields)$(id).addEventListener('change',saveSettings);
// Caption design: the preview uses the overlay's own CSS, and the font loads into this document.
const doc=root.ownerDocument||root,captionStyle=doc.createElement('style');captionStyle.textContent=CAPTION_CSS;(root.head||root).append(captionStyle);
const CUSTOM='__custom',themeIds=Object.keys(CAPTION_THEMES);let fontSequence=0,shownFont=null,statusFont=null;
$('fontFamily').innerHTML='<option value="">시스템 기본 · 내려받지 않음</option>'+Object.entries(FONT_GROUPS).map(([group,label])=>`<optgroup label="${label}">${CAPTION_FONTS.filter(f=>f.group===group).map(f=>`<option value="${f.family}">${f.family}</option>`).join('')}</optgroup>`).join('')+`<option value="${CUSTOM}">다른 Google Fonts 이름 직접 입력…</option>`;
for(const id of themeIds){const button=$('theme-'+id),vars=captionStyleVars({...STYLE_DEFAULTS,...themeSettings(id)});for(const [name,value] of Object.entries(vars))button.style.setProperty(name,value);button.addEventListener('click',()=>{for(const [key,value] of Object.entries(themeSettings(id)))$(key).value=String(value);saveSettings();});}
// Until a typed name is applied, other edits keep the saved family.
function chosenFont(){const value=$('fontFamily').value,name=$('customFont').value.trim().replace(/\s+/g,' ');return value!==CUSTOM?value:FONT_NAME.test(name)?name:shownFont||'';}
function showFont(family){if(family===shownFont)return;shownFont=family;const custom=Boolean(family)&&!fontInfo(family);$('fontFamily').value=custom?CUSTOM:family;$('customFontRow').hidden=!custom;if(custom&&(root.activeElement||document.activeElement)!==$('customFont'))$('customFont').value=family;}
function renderDesign(){
  const settings=fieldSettings(),theme=matchTheme(settings);applyCaptionStyle($('previewCaptions'),settings);
  for(const id of themeIds)$('theme-'+id).setAttribute('aria-pressed',String(id===theme));
  $('themeState').textContent=theme?`${CAPTION_THEMES[theme].label} 테마 사용 중`:'직접 바꾼 디자인 · 테마를 누르면 그 테마 값으로 돌아갑니다';
  $('bgOpacityValue').textContent=`${settings.bgOpacity}%`;$('bgRadiusValue').textContent=`${settings.bgRadius}px`;
  const sequence=++fontSequence,status=$('fontStatus'),info=fontInfo(settings.fontFamily),weight=effectiveWeight(settings);
  if(settings.fontFamily!==statusFont){statusFont=settings.fontFamily;status.dataset.error='false';status.textContent=settings.fontFamily?`${settings.fontFamily} 불러오는 중…`:'';}
  ensureCaptionFont(doc,settings).then(result=>{
    if(sequence!==fontSequence||result.system)return;
    status.dataset.error=String(!result.ok);
    status.textContent=!result.ok?`Google Fonts에서 '${settings.fontFamily}' 글꼴을 불러오지 못해 시스템 글꼴로 표시합니다. 인터넷 연결과 이름의 대소문자·띄어쓰기를 확인해 주세요.`:info&&weight!==settings.fontWeight?`${settings.fontFamily} 적용 · 이 글꼴은 ${info.weights.join('·')} 굵기만 있어 ${weight}으로 표시합니다.`:`${settings.fontFamily} 적용됨`;
  });
}
// Arrow keys and type-ahead change the select once per step; download only where the user stops.
let fontTimer=0;$('fontFamily').addEventListener('change',()=>{clearTimeout(fontTimer);if($('fontFamily').value===CUSTOM){$('customFontRow').hidden=false;$('customFont').focus?.();return;}$('customFontRow').hidden=true;fontTimer=setTimeout(saveSettings,450);});
async function applyCustomFont(){const name=$('customFont').value.trim().replace(/\s+/g,' ');if(!FONT_NAME.test(name)){feedback('Google Fonts 글꼴 이름은 영문·숫자·띄어쓰기로 60자 이내입니다. 예: Roboto Slab');return;}feedback('');$('customFont').value=name;await saveSettings();}
$('applyFont').addEventListener('click',applyCustomFont);$('customFont').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();applyCustomFont();}});
for(const id of ['textColor','edgeColor','bgColor'])$(id).addEventListener('input',renderDesign);
for(const id of ['bgOpacity','bgRadius'])$(id).addEventListener('input',()=>{renderDesign();saveSettings();});
$('previewScene').addEventListener('click',()=>{const bright=$('stylePreview').dataset.scene!=='bright';$('stylePreview').dataset.scene=bright?'bright':'dark';$('previewScene').setAttribute('aria-pressed',String(bright));$('previewScene').textContent=bright?'어두운 장면으로 보기':'밝은 장면으로 보기';});
$('resetDesign').addEventListener('click',()=>{for(const [key,value] of Object.entries(STYLE_DEFAULTS))if(key!=='fontFamily')$(key).value=String(value);$('fontFamily').value='';$('customFontRow').hidden=true;saveSettings();});
for(const id of ['positionX','positionY'])$(id).addEventListener('input',()=>{positionPreview();saveSettings();});
function positionPreview(){for(const id of ['positionX','positionY'])$(id+'Value').textContent=$(id).value+'%';$('positionSample').style.left=`clamp(58px, ${$('positionX').value}%, calc(100% - 58px))`;$('positionSample').style.top=`clamp(17px, ${$('positionY').value}%, calc(100% - 17px))`;}
$('resetPosition').addEventListener('click',()=>{$('positionX').value=50;$('positionY').value=88;positionPreview();saveSettings();});
$('effectStrength').addEventListener('input',strengthLabel);$('studio').addEventListener('click',()=>action('OPEN_HELP'));$('enableLocal').addEventListener('click',()=>action('ENABLE_LOCAL'));$('capture').addEventListener('click',()=>action('ANALYZE_URL'));$('record').addEventListener('click',()=>action('START_CAPTURE'));$('stop').addEventListener('click',()=>action('STOP_CAPTURE'));$('cancel').addEventListener('click',()=>action('CANCEL'));$('remove').addEventListener('click',()=>action('REMOVE_DOCUMENT'));
$('replay').addEventListener('click',()=>action('REPLAY_CAPTURE'));
$('importButton').addEventListener('click',()=>$('importFile').click());$('importFile').addEventListener('change',async event=>{const file=event.target.files[0];if(!file)return;try{if(file.size>10*1024*1024)throw new Error('JSON 파일은 10MB 이하만 선택해 주세요.');const doc=parseDocument(await file.text());await send({type:'IMPORT',document:doc});feedback('현재 영상에 자막을 적용했습니다.',false);await refresh();}catch(e){feedback(e.message);}event.target.value='';});
$('export').addEventListener('click',()=>{if(!current)return;const blob=new Blob([subtitleFile(current,'json')],{type:'application/json;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`onsori-${current.video_id}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
const onStorage=(changes,area)=>{if(area!=='local')return;if(changes.operation)renderOperation(changes.operation.newValue||{phase:'idle'});if(changes.analysisOptions)optionsLoaded=false;if(changes.captionCache||changes.settings||changes.operation||changes.localConsent||changes.analysisOptions)refresh();};chrome.storage.onChanged.addListener(onStorage);const clock=setInterval(()=>{if(operation.phase==='capturing')renderOperation(operation);},1000);refresh();if(!embedded)send({type:'TOOLBAR_OPEN'}).then(()=>refresh()).catch(e=>feedback(e.message));

for(const id of ['language','musicDetail','captureFrames'])$(id).addEventListener('change',()=>send({type:'SET_ANALYSIS_OPTIONS',options:analysisOptions()}).catch(e=>feedback(e.message)));

return {refresh,destroy(){clearInterval(clock);chrome.storage.onChanged.removeListener(onStorage);}};
}
