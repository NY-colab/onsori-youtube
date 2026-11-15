import {CLOUD} from './cloud-config.js';
import {MODEL_CONFIG} from './model-config.js';
import {encodeWav} from './cloud-speech.js';

const SR=MODEL_CONFIG.sampleRate;
export const SOUND_PIECE_SECONDS=30;
const abortError=()=>new DOMException('분석을 취소했습니다.','AbortError');
// Codes after which no further minute is sent: the operator's Gemini budget is spent, the
// daily share is used up, or the server cannot use its key. Other failures affect one minute only.
export const SOUND_STOP_CODES=['sound_quota','daily_sound_limit','install_daily_sound_limit','sounds_disabled','sound_provider_auth','sound_model_unavailable','explicit_consent_required','no_key'];
const REASONS={
  sound_quota:'Gemini 사용 한도에 닿았습니다.',
  daily_sound_limit:'오늘 서버의 음악·효과음 분석 사용량을 다 썼습니다.',
  install_daily_sound_limit:'오늘 쓸 수 있는 음악·효과음 분석 사용량을 다 썼습니다.',
  sounds_disabled:'서버의 음악·효과음 분석이 꺼져 있습니다.',
};
export class CloudSoundError extends Error{constructor(code,message){super(message);this.name='CloudSoundError';this.code=code;}}
const fail=(code,fallback='서버의 음악·효과음 분석을 완료하지 못했습니다.')=>new CloudSoundError(code,REASONS[code]||fallback);

// Pieces of at most 30 s (the length measured on 2026-11-15) covering [start,end) of pcm (seconds).
export function soundPieces(start,end,size=SOUND_PIECE_SECONDS){
  const pieces=[],count=Math.max(1,Math.ceil((end-start)/size-1e-6)),step=(end-start)/count;
  for(let i=0;i<count;i++)pieces.push([start+i*step,i===count-1?end:start+(i+1)*step]);
  return pieces;
}

// One piece -> music/sound events in the piece's own time (0 = piece start).
async function describePiece(pcm,{cloud,signal,fetchImpl}){
  const request=async token=>{
    try{return await fetchImpl(`${CLOUD.origin}/v1/sounds`,{method:'POST',body:new Blob([encodeWav(pcm)],{type:'audio/wav'}),headers:{Authorization:`Bearer ${token}`,'Content-Type':'audio/wav','X-OnSori-Consent':'sounds'},credentials:'omit',cache:'no-store',redirect:'error',signal});}
    catch(e){if(signal?.aborted)throw abortError();throw fail('network','온소리 서버에 연결하지 못했습니다.');}
  };
  let token=await cloud.key(false);if(!token)throw fail('no_key','클라우드 사용 열쇠를 받지 못했습니다.');
  let response=await request(token);
  if(response.status===401){token=await cloud.key(true);if(!token)throw fail('no_key','클라우드 사용 열쇠를 받지 못했습니다.');response=await request(token);}
  let body=null;try{body=await response.json();}catch{}
  if(!response.ok)throw fail(typeof body?.detail==='string'?body.detail:`http_${response.status}`);
  if(body?.synthetic===true&&cloud.allowSynthetic!==true)throw fail('synthetic_result','서버가 시험용 결과만 돌려주고 있습니다.');
  const duration=pcm.length/SR,events=Array.isArray(body?.events)?body.events:null;if(!events)throw fail('invalid_result');
  return {model:typeof body.model==='string'?body.model.slice(0,100):null,events:events.flatMap(e=>{
    const start=Number(e?.start),end=Number(e?.end),text=String(e?.text??'').replace(/\s+/g,' ').trim().slice(0,80);
    return ['music','sound'].includes(e?.kind)&&Number.isFinite(start)&&Number.isFinite(end)&&start>=0&&end>start&&start<duration&&text?[{start,end:Math.min(end,duration),kind:e.kind,text}]:[];
  })};
}

// [from,to) of pcm (whose first sample is at absolute time `offset`) -> absolute-time events.
// Pieces are sent in parallel; any failure rejects with a CloudSoundError.
export async function describeSoundsInCloud(pcm,{from,to,offset=0,cloud,signal,fetchImpl=fetch}){
  const pieces=soundPieces(from,to);
  const results=await Promise.all(pieces.map(([a,b])=>describePiece(pcm.subarray(Math.round((a-offset)*SR),Math.round((b-offset)*SR)),{cloud,signal,fetchImpl}).then(r=>({...r,at:a}))));
  return {model:results.find(r=>r.model)?.model||null,events:results.flatMap(r=>r.events.map(e=>({...e,start:Math.round((e.start+r.at)*1000)/1000,end:Math.round((e.end+r.at)*1000)/1000})))};
}
