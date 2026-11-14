// Optional typo correction of recognized speech: Claude Haiku through the user's own Anthropic API
// key or the Claude Code CLI signed in on this PC, or the model the OnSori server names (DeepInfra).
// Only recognized caption TEXT leaves the device; audio never does.
// The SDK is bundled in vendor/anthropic (no remote code) and loaded only when used.
import {matchingBlocks,normalized,similarity} from './browser-engine-signal.js';
import {AI_CORRECTION,API_KEY_PATTERN,CORRECTION_SYSTEM,CORRECTION_SCHEMA,MODEL_ID_PATTERN,correctionPayload,correctionSourceTag} from './ai-config.js';
export {AI_CORRECTION,API_KEY_PATTERN,apiKeyHint} from './ai-config.js';

const SYSTEM=CORRECTION_SYSTEM,SCHEMA=CORRECTION_SCHEMA;

export class CorrectionError extends Error{constructor(code,message){super(message);this.name='CorrectionError';this.code=code;}}
// Codes after which every later request would fail the same way: stop correcting this analysis.
export const FATAL_CORRECTION_CODES=Object.freeze(['invalid_key','forbidden','model_unavailable','bad_request','no_key','bridge_missing','bridge_forbidden','no_permission','cli_missing','cli_auth','cloud_limit','cloud_unavailable']);

let sdk=null;
export function loadSdk(){sdk??=import('./vendor/anthropic/anthropic-sdk.mjs');return sdk;}
export async function createCorrectionClient(apiKey){
  if(!API_KEY_PATTERN.test(apiKey||''))throw new CorrectionError('no_key','AI 자막 보정용 Anthropic API 키를 등록해 주세요.');
  const {Anthropic}=await loadSdk();
  // The key belongs to the user and is used only from extension pages, never the YouTube page.
  return new Anthropic({apiKey,dangerouslyAllowBrowser:true,maxRetries:2,timeout:AI_CORRECTION.timeoutMs});
}

// Map SDK errors by their typed classes; the message text is only shown to the user.
export async function correctionError(error){
  if(error instanceof CorrectionError||error?.name==='AbortError')return error;
  const errors=await loadSdk().catch(()=>null);
  const is=name=>Boolean(errors?.[name]&&error instanceof errors[name]);
  if(is('APIUserAbortError'))return new DOMException('분석을 취소했습니다.','AbortError');
  if(is('AuthenticationError'))return new CorrectionError('invalid_key','Anthropic API 키가 올바르지 않거나 만료되었습니다.');
  if(is('PermissionDeniedError'))return new CorrectionError('forbidden','이 Anthropic API 키로는 Claude Haiku를 사용할 수 없습니다.');
  if(is('NotFoundError'))return new CorrectionError('model_unavailable','이 계정에서 Claude Haiku 모델을 찾을 수 없습니다.');
  if(is('RateLimitError'))return new CorrectionError('rate_limited','Anthropic API 사용 한도에 걸렸습니다. 잠시 뒤 다시 보정합니다.');
  if(is('BadRequestError'))return new CorrectionError('bad_request',`Anthropic API가 요청을 거절했습니다: ${String(error.message||'').slice(0,160)}`);
  if(is('APIConnectionError'))return new CorrectionError('network','Anthropic API에 연결하지 못했습니다.');
  if(is('APIError'))return new CorrectionError('server',`Anthropic API 오류입니다 (${error.status||'응답 없음'}).`);
  return new CorrectionError('unknown',String(error?.message||error||'AI 자막 보정에 실패했습니다.').slice(0,200));
}

// A key check that generates no tokens: the model lookup needs a valid key and model access.
export async function verifyCorrectionKey(apiKey,{client,model=AI_CORRECTION.model}={}){
  try{client??=await createCorrectionClient(apiKey);const info=await client.models.retrieve(model);return {ok:true,model:info?.id||model,name:info?.display_name||AI_CORRECTION.label};}
  catch(error){throw await correctionError(error);}
}

// Speech recognized on this device or by the OnSori cloud, not yet corrected by any reference.
export function correctionTargets(doc){
  return doc.cues.filter(c=>c.kind==='speech'&&!c.speech_correction&&!c.ai_correction&&/whisper|onsori-cloud-speech/.test(c.source||''));
}

// Guard against invented wording. A text-only check cannot tell a right sound-alike fix from a wrong
// one, so it only refuses a fix that brings in or drops more than three syllables found nowhere in the
// other line (적은 것과 -> 아까 말씀드린 것과, 2026-11-14). Fixing a misheard word passes whatever its
// length (적은 것과 -> 저것과, 윗돌이 -> 웃도리, 일이 가볍어 -> 이리 가벼워).
export function acceptCorrection(original,candidate){
  const before=String(original??'').trim(),text=String(candidate??'').replace(/\s+/g,' ').trim();
  if(!text||text.length>2000||text===before||/[♪♬\[\]<>]/.test(text))return null;
  const a=normalized(before),b=normalized(text);if(!a.length||!b.length)return null;
  if(a===b)return text;
  const kept=matchingBlocks(a,b).reduce((n,x)=>n+x[2],0);
  if(a.length-kept>3||b.length-kept>3)return null;
  const letters=similarity(a,b),jamo=similarity(a.normalize('NFD'),b.normalize('NFD'));
  return jamo>=.6||letters>=.5?text:null;
}

export async function requestCorrections({lines,context=[],title='',client,model=AI_CORRECTION.model,signal}){
  const payload=correctionPayload({title:String(title||''),context:context.map(String),lines:lines.map(l=>({id:l.id,text:l.text}))});
  let response;
  try{
    response=await client.messages.create({
      model,max_tokens:16000,system:SYSTEM,
      output_config:{effort:'low',format:{type:'json_schema',schema:SCHEMA}},
      messages:[{role:'user',content:JSON.stringify(payload)}],
    },{signal});
  }catch(error){throw await correctionError(error);}
  if(response?.stop_reason==='refusal')throw new CorrectionError('refusal','Claude가 이 구간의 보정을 거절해 인식 원문을 유지합니다.');
  if(response?.stop_reason==='max_tokens')throw new CorrectionError('truncated','보정 응답이 길이 한도를 넘어 인식 원문을 유지합니다.');
  const text=(response?.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('');
  let parsed;try{parsed=JSON.parse(text);}catch{throw new CorrectionError('invalid_output','보정 응답을 읽지 못해 인식 원문을 유지합니다.');}
  return {corrections:Array.isArray(parsed?.corrections)?parsed.corrections:[],usage:response.usage||null,model:MODEL_ID_PATTERN.test(response?.model||'')?response.model:null};
}

// The same request through the Claude Code CLI signed in on this PC: the analysis document
// hands the caption payload to the worker, which relays it to the local native bridge.
// The bridge answers with corrections only, shaped here like a Messages API response.
export function createCliClient(relay,type='CLI_CORRECT'){
  return {messages:{async create(body,{signal}={}){
    if(signal?.aborted)throw new DOMException('분석을 취소했습니다.','AbortError');
    const reply=await relay({type,payload:JSON.parse(body.messages[0].content)});
    if(signal?.aborted)throw new DOMException('분석을 취소했습니다.','AbortError');
    if(!reply?.ok)throw new CorrectionError(reply?.code||'cli_failed',reply?.message||reply?.error||'Claude Code로 보정하지 못했습니다.');
    return {stop_reason:'end_turn',model:reply.model||null,usage:reply.usage||null,content:[{type:'text',text:JSON.stringify({corrections:Array.isArray(reply.corrections)?reply.corrections:[]})}]};
  }}};
}

// Corrects the recognized speech of one document in place and records what changed.
// The original text stays in cue.ai_correction; a failed request leaves cues untouched.
export async function correctDocumentSpeech(doc,{apiKey,model=AI_CORRECTION.model,client,context=[],signal}={}){
  const targets=correctionTargets(doc),record={model,status:'done',checked:targets.length,corrected:0,rejected:0,input_tokens:0,output_tokens:0};
  if(targets.length){
    client??=await createCorrectionClient(apiKey);
    const byId=new Map(targets.map(c=>[c.id,c]));let previous=[...context];
    for(let i=0;i<targets.length;i+=AI_CORRECTION.maxLines){
      const batch=targets.slice(i,i+AI_CORRECTION.maxLines),{corrections,usage,model:answered}=await requestCorrections({lines:batch,context:previous,title:doc.title,client,model,signal}),used=answered||model;if(answered)record.model=answered;
      record.input_tokens+=usage?.input_tokens||0;record.output_tokens+=usage?.output_tokens||0;
      for(const item of corrections){
        const cue=byId.get(item?.id);if(!cue||cue.ai_correction)continue;
        // A line returned as it was is no change, not a rejected rewrite.
        if(String(item.text??'').replace(/\s+/g,' ').trim()===String(cue.text??'').trim())continue;
        const text=acceptCorrection(cue.text,item.text);if(!text){record.rejected++;continue;}
        cue.ai_correction={original_text:cue.text,model:used};cue.text=text;cue.source=`${cue.source}+${correctionSourceTag(used)}`;record.corrected++;
      }
      previous=[...previous,...batch.map(c=>c.text)].slice(-AI_CORRECTION.contextLines);
    }
  }
  doc.metadata.ai_correction=mergeCorrectionRecords(doc.metadata.ai_correction,record);
  return doc;
}

export function mergeCorrectionRecords(a,b){
  if(!a)return b;if(!b)return a;
  const sum=key=>(a[key]||0)+(b[key]||0);
  return {model:b.model||a.model,status:a.status===b.status?b.status:'partial',checked:sum('checked'),corrected:sum('corrected'),rejected:sum('rejected'),input_tokens:sum('input_tokens'),output_tokens:sum('output_tokens'),...(b.error||a.error?{error:b.error||a.error}:{})};
}
