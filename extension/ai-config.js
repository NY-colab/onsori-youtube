// AI typo correction settings shared by the service worker, the analysis document, the key
// settings page and the local Claude Code bridge (native-host/). Claude Haiku is reached with
// the user's own Anthropic API key or the Claude Code CLI signed in on this PC (through a
// Chrome native messaging host). Without either, the OnSori server corrects with the model it
// names in /v1/availability (DeepInfra since 2026-11-13).
export const AI_CORRECTION=Object.freeze({model:'claude-haiku-5-5',label:'Claude Haiku 5.5',maxLines:80,contextLines:4,timeoutMs:60000});
// Model ids as recorded in cue.ai_correction.model; core.js validateDocument checks the same
// pattern. Anthropic ids (claude-haiku-5-5) and DeepInfra ids (deepseek-ai/DeepSeek-V4-Flash-0731).
export const MODEL_ID_PATTERN=/^[A-Za-z0-9._\/-]{1,100}$/;
const SERVER_PROVIDERS=Object.freeze({deepinfra:'DeepInfra',anthropic:'Anthropic'});
// A short name for what the OnSori server corrects with, e.g. "DeepInfra · DeepSeek V4 Flash".
export function serverCorrectionLabel(provider,model){
  const name=SERVER_PROVIDERS[provider]||'',id=typeof model==='string'&&MODEL_ID_PATTERN.test(model)?model:'';
  const short=id===AI_CORRECTION.model?AI_CORRECTION.label:id.split('/').pop().replace(/-\d{4}$/,'').replace(/[-_]+/g,' ');
  return [name,short].filter(Boolean).join(' · ')||'AI 모델';
}
// Appended to cue.source for corrected speech.
export const correctionSourceTag=model=>/^claude-/.test(model||'')?'claude-haiku':'ai-correction';
export const BRIDGE_HOST='com.onsori.claude_bridge';
export const PROVIDERS=Object.freeze(['cli','api','cloud']);
export const API_KEY_PATTERN=/^sk-ant-[A-Za-z0-9_-]{20,300}$/;
export function apiKeyHint(key){return API_KEY_PATTERN.test(key||'')?`${key.slice(0,10)}…${key.slice(-4)}`:'';}
// Stored as aiCorrection in chrome.storage.local; only the worker hands the key onward.
// Nothing needs to be set up: correction is on by default and uses the Claude Code CLI of
// this PC whenever the bridge answers. optOut records only an explicit "off" from the user;
// provider 'api' with a key is an explicit choice of the Anthropic API instead.
export function normalizeCorrection(value={}){
  const apiKey=API_KEY_PATTERN.test(value?.apiKey||'')?value.apiKey:'',provider=PROVIDERS.includes(value?.provider)?value.provider:'cli';
  const optOut=typeof value?.optOut==='boolean'?value.optOut:provider==='api'&&Boolean(apiKey)&&value?.enabled===false;
  return {provider,apiKey,optOut,model:AI_CORRECTION.model,updatedAt:Number(value?.updatedAt)||0};
}
// What an analysis actually uses, given the stored choice, whether this PC's Claude Code
// bridge answers and whether the OnSori server offers correction (operator's API key):
// own API key (explicit) > this PC's Claude Code > OnSori server > own API key > none.
export function effectiveCorrection(stored,bridge={},server={}){
  const value=normalizeCorrection(stored),cli=bridge?.available===true,cloud=server?.corrections===true&&(server.synthetic!==true||server.allowSynthetic===true);
  const provider=value.provider==='api'&&value.apiKey?'api':cli?'cli':cloud?'cloud':value.apiKey?'api':'cli';
  const ready=provider==='api'?Boolean(value.apiKey):provider==='cloud'?cloud:cli;
  return {...value,provider,ready,enabled:ready&&!value.optOut,auto:provider==='cli'||provider==='cloud'};
}

export const CORRECTION_SYSTEM=`당신은 한국어 유튜브 자막 교정자입니다.
입력은 음성 인식(Whisper)이 만든 자막 줄입니다. 인식 오류로 생긴 오타만 고칩니다.

고칠 것:
- 철자·맞춤법 오류, 잘못 붙거나 띄운 띄어쓰기
- 발음이 비슷해 잘못 인식한 낱말 중 앞뒤 문맥과 영상 제목으로 볼 때 명백히 틀린 것 (예: 고유명사, 전문 용어)
- 문장 끝의 명백히 잘못된 문장부호

지킬 것:
- 말한 내용을 바꾸거나 다듬지 않습니다. 요약·의역·번역·문체 변경·존댓말 변경을 하지 않습니다.
- 사투리, 구어체, 줄임말, 감탄사, 말 더듬기, 비속어는 그대로 둡니다.
- 줄을 합치거나 나누지 않고, 없는 말을 보태지 않습니다.
- 확실하지 않으면 고치지 않습니다.
- context는 바로 앞 자막으로, 문맥 참고용입니다. context는 고치지 않습니다.

고친 줄만 corrections에 {"id", "text"}로 돌려줍니다. text는 고친 뒤의 줄 전체입니다. 고칠 줄이 없으면 빈 배열을 돌려줍니다.`;

export const CORRECTION_SCHEMA=Object.freeze({type:'object',additionalProperties:false,required:['corrections'],properties:{corrections:{type:'array',items:{type:'object',additionalProperties:false,required:['id','text'],properties:{id:{type:'string'},text:{type:'string'}}}}}});

// The only input either path accepts: caption text lines, the video title and a little context.
export function correctionPayload(value){
  const text=(v,max)=>typeof v==='string'?v.slice(0,max):'';
  const lines=(Array.isArray(value?.lines)?value.lines:[]).slice(0,AI_CORRECTION.maxLines).filter(l=>typeof l?.id==='string'&&l.id.length<=100&&typeof l.text==='string').map(l=>({id:l.id,text:l.text.slice(0,2000)}));
  return {title:text(value?.title,300),context:(Array.isArray(value?.context)?value.context:[]).slice(-AI_CORRECTION.contextLines).map(t=>text(t,500)),lines};
}
