// Extension page for AI typo correction. The Anthropic key is typed only here (never in the
// YouTube page panel); the Claude Code connection is granted and checked only here. The OnSori
// server path needs no setup and shows the provider and model the server names.
import {verifyCorrectionKey,API_KEY_PATTERN} from './ai-correction.js';
const $=id=>document.getElementById(id);
async function raw(payload){return chrome.runtime.sendMessage(payload);}
async function send(payload){const response=await raw(payload);if(!response?.ok)throw new Error(response?.error||response?.message||'확장 프로그램에 연결되지 않았습니다. 확장 프로그램을 새로고침해 주세요.');return response;}
function say(id,text,error=false){$(id).textContent=text;$(id).dataset.tone=error?'error':'ok';}
const feedback=(text,error)=>say('feedback',text,error),cliFeedback=(text,error)=>say('cliFeedback',text,error);
let current={};
function render(state){
  current=state;const cli=state.provider==='cli',api=state.provider==='api'&&(state.hasKey||state.chosen==='api');
  $('keyState').textContent=state.provider==='cloud'?`온소리 서버로 자동 보정(${state.label}) · ${state.enabled?'켜짐':'꺼짐'}`:cli?(state.ready?`이 PC의 Claude Code로 자동 보정 · ${state.enabled?'켜짐':'꺼짐'}`:'이 PC에서 Claude Code 연결 프로그램을 찾지 못했습니다.'):state.hasKey?`등록된 키 · ${state.keyHint}${state.enabled?' · 보정 켜짐':' · 보정 꺼짐'}`:'연결 방식을 고르고 설정해 주세요.';
  $('enabled').checked=state.enabled===true;$('enabled').disabled=!state.ready;
  $('providerCli').checked=cli;$('providerApi').checked=api;$('cliCard').hidden=!cli;$('keyForm').hidden=!api;
  $('remove').hidden=!state.hasKey;$('extensionId').textContent=state.extensionId||'';
  $('model').textContent=state.model?`${state.label} (${state.model})`:state.label;$('save').textContent=state.hasKey?'새 키로 바꾸고 연결 확인':'저장하고 연결 확인';
}
async function load(){try{render({...await send({type:'GET_CORRECTION'}),chosen:current.chosen});}catch(e){feedback(e.message,true);}}
function busy(value){for(const id of ['save','remove','apiKey','cliCheck'])$(id).disabled=value;}

// Claude Code: status (installed, signed in), then one tiny real request, since a revoked
// login still reports "logged in".
async function checkCli(){
  busy(true);$('cliInstall').hidden=true;$('cliState').textContent='이 PC의 Claude Code를 확인하고 있습니다…';cliFeedback('');
  try{
    const status=await raw({type:'CLI_STATUS'});
    if(!status?.ok){$('cliInstall').hidden=!['bridge_missing','bridge_forbidden','no_permission'].includes(status?.code);$('cliState').textContent='연결되지 않았습니다.';cliFeedback(status?.message||status?.error||'Claude Code 연결 프로그램에 연결하지 못했습니다.',true);return;}
    const who=[status.version,status.subscription?`claude.ai ${status.subscription} 구독`:status.authMethod].filter(Boolean).join(' · ');
    if(!status.loggedIn){$('cliState').textContent=`Claude Code 확인 · ${who}`;cliFeedback('Claude Code에 로그인되어 있지 않습니다. 터미널에서 claude auth login을 실행해 주세요.',true);return;}
    $('cliState').textContent=`Claude Code 확인 · ${who} · 시험 보정 중…`;
    const test=await raw({type:'CLI_TEST'});
    if(!test?.ok){$('cliState').textContent=`Claude Code 확인 · ${who}`;cliFeedback(test?.message||test?.error||'시험 보정에 실패했습니다.',true);return;}
    $('cliState').textContent=`연결됨 · ${who}${test.model?` · ${test.model}`:''}`;
    cliFeedback(`시험 보정에 성공했습니다.${test.corrections?.[0]?` ‘안녕 하세요 반갑 습니다’ → ‘${test.corrections[0].text}’`:''} 이후 분석하는 대사부터 보정합니다.`);
  }catch(e){cliFeedback(e.message,true);}finally{busy(false);}
}
$('providerCli').addEventListener('change',async()=>{
  try{render({...await send({type:'SET_CORRECTION_PROVIDER',provider:'cli'}),chosen:'cli'});await checkCli();}catch(e){cliFeedback(e.message,true);await load();}
});
$('providerApi').addEventListener('change',async()=>{current.chosen='api';try{render({...await send({type:'SET_CORRECTION_PROVIDER',provider:'api'}),chosen:'api'});feedback(current.hasKey?'Anthropic API 키로 보정합니다.':'API 키를 등록하면 보정을 켤 수 있습니다.');}catch(e){feedback(e.message,true);await load();}});
$('cliCheck').addEventListener('click',checkCli);
$('copyId').addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('extensionId').textContent);cliFeedback('확장 ID를 복사했습니다.');}catch{cliFeedback('ID를 직접 선택해 복사해 주세요.',true);}});
$('keyForm').addEventListener('submit',async event=>{
  event.preventDefault();const key=$('apiKey').value.trim();
  if(!API_KEY_PATTERN.test(key)){feedback('Anthropic API 키는 sk-ant-로 시작합니다. 키를 다시 확인해 주세요.',true);return;}
  busy(true);feedback('키와 Claude Haiku 사용 권한을 확인하고 있습니다…');
  try{
    let note='';
    try{const info=await verifyCorrectionKey(key);note=`${info.name} 연결을 확인했습니다.`;}
    catch(error){
      // A wrong key or a key without model access is never stored; a temporary network or
      // server problem does not block saving, and analysis keeps the raw text if it persists.
      if(['invalid_key','forbidden','model_unavailable','no_key'].includes(error.code))throw error;
      note=`지금은 연결을 확인하지 못했습니다(${error.message}). 키는 저장했고, 보정할 때 다시 연결합니다.`;
    }
    await send({type:'SET_CORRECTION_KEY',apiKey:key,enable:true});$('apiKey').value='';
    await load();feedback(`${note} 이후 분석하는 대사부터 보정합니다.`);
  }catch(e){feedback(e.message,true);}finally{busy(false);}
});
$('remove').addEventListener('click',async()=>{busy(true);try{await send({type:'SET_CORRECTION_KEY',apiKey:''});await load();feedback('API 키를 지웠습니다.');}catch(e){feedback(e.message,true);}finally{busy(false);}});
$('enabled').addEventListener('change',async event=>{try{await send({type:'SET_CORRECTION',enabled:event.target.checked});await load();say(current.provider==='cli'?'cliFeedback':'feedback',event.target.checked?'AI 자막 보정을 켰습니다.':'AI 자막 보정을 껐습니다.');}catch(e){feedback(e.message,true);await load();}});
chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local'&&changes.aiCorrection)load();});
load();
