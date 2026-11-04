import {CLOUD} from './cloud-config.js';
import {MODEL_CONFIG} from './model-config.js';

const SR=MODEL_CONFIG.sampleRate;
const abortError=()=>new DOMException('분석을 취소했습니다.','AbortError');

// Reasons shown to the user before the device takes over speech analysis.
const REASONS={
  install_daily_limit:'오늘 클라우드 사용량을 다 썼습니다.',
  daily_audio_limit:'오늘 클라우드 서버 전체 사용량을 다 썼습니다.',
  provider_disabled:'클라우드 대사 분석이 꺼져 있습니다.',
  queue_full:'클라우드 서버가 바쁩니다.',
  upload_too_large:'클라우드로 보낼 수 있는 길이를 넘었습니다.',
};
export class CloudSpeechError extends Error{constructor(code,message){super(message);this.name='CloudSpeechError';this.code=code;}}
const fail=(code,fallback='클라우드 대사 분석을 완료하지 못했습니다.')=>new CloudSpeechError(code,REASONS[code]||fallback);

// 16 kHz mono PCM16 WAV: the only format the gateway accepts.
export function encodeWav(pcm){
  const bytes=new ArrayBuffer(44+pcm.length*2),view=new DataView(bytes),text=(at,value)=>{for(let i=0;i<value.length;i++)view.setUint8(at+i,value.charCodeAt(i));};
  text(0,'RIFF');view.setUint32(4,36+pcm.length*2,true);text(8,'WAVE');text(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);
  view.setUint32(24,SR,true);view.setUint32(28,SR*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);text(36,'data');view.setUint32(40,pcm.length*2,true);
  for(let i=0;i<pcm.length;i++){const v=Math.max(-1,Math.min(1,pcm[i]));view.setInt16(44+i*2,v<0?v*32768:v*32767,true);}
  return bytes;
}

// A finished cloud job becomes Whisper-shaped chunks, so the device applies the
// same speech filter, timing bounds and loudness styling as local recognition.
export function cloudChunks(job,duration,{allowSynthetic=false}={}){
  if(job?.status!=='done')throw fail('job_not_done');
  const doc=job.result,meta=doc?.metadata||{};
  if(!doc||!Array.isArray(doc.cues)||meta.analysis_scope!=='speech-only')throw fail('invalid_result');
  if(meta.synthetic===true&&!allowSynthetic)throw fail('synthetic_result','클라우드 서버가 시험용 결과만 돌려주고 있습니다.');
  const chunks=[];
  for(const cue of doc.cues){
    const start=Number(cue?.start),end=Number(cue?.end),text=String(cue?.text??'').trim();
    if(cue?.kind!=='speech'||!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start||end>duration+.05||!text||text.length>2000)throw fail('invalid_result');
    chunks.push({text,timestamp:[start,Math.min(end,duration)]});
  }
  return {text:chunks.map(c=>c.text).join(' '),chunks,diagnostics:{method:'OnSori cloud speech-only job; device keeps music, effects, timing bounds and loudness',provider_model:meta.model??null,synthetic:meta.synthetic===true,job_id:job.id,rejected:[]}};
}

function wait(seconds,signal){return new Promise((resolve,reject)=>{const timer=setTimeout(resolve,seconds*1000);signal?.addEventListener('abort',()=>{clearTimeout(timer);reject(abortError());},{once:true});});}

export async function transcribeInCloud(pcm,{videoId=null,title='',cloud,signal,onProgress,fetchImpl=fetch,sleep=wait}){
  const duration=pcm.length/SR,origin=CLOUD.origin,idempotency=crypto.randomUUID();
  const request=async(path,init={},token)=>{
    try{return await fetchImpl(origin+path,{...init,headers:{...(init.headers||{}),...(token?{Authorization:`Bearer ${token}`}:{})},credentials:'omit',cache:'no-store',redirect:'error',signal});}
    catch(e){if(signal?.aborted)throw abortError();throw fail('network','클라우드 서버에 연결하지 못했습니다.');}
  };
  const detail=async response=>{try{return (await response.json())?.detail;}catch{return null;}};
  const form=()=>{const body=new FormData();body.set('file',new Blob([encodeWav(pcm)],{type:'audio/wav'}),'audio.wav');body.set('consent','true');body.set('language','ko');body.set('title',String(title).slice(0,300));if(videoId)body.set('video_id',videoId);return body;};
  onProgress?.({message:'대사 분석용 소리를 클라우드로 보내는 중'});
  let token=await cloud.key(false);if(!token)throw fail('no_key','클라우드 사용 열쇠를 받지 못했습니다.');
  let response=await request('/v1/jobs',{method:'POST',body:form(),headers:{'Idempotency-Key':idempotency}},token);
  // A server data reset invalidates keys: get a new one once and retry the same upload.
  if(response.status===401){token=await cloud.key(true);if(!token)throw fail('no_key','클라우드 사용 열쇠를 받지 못했습니다.');response=await request('/v1/jobs',{method:'POST',body:form(),headers:{'Idempotency-Key':idempotency}},token);}
  if(!response.ok)throw fail(await detail(response)||`http_${response.status}`);
  let job=await response.json();
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(job?.id||''))throw fail('invalid_result');
  const cancel=()=>{fetchImpl(`${origin}/v1/jobs/${job.id}`,{method:'DELETE',headers:{Authorization:`Bearer ${token}`},credentials:'omit',keepalive:true}).catch(()=>{});};
  signal?.addEventListener('abort',cancel,{once:true});
  try{
    const started=Date.now();
    while(!['done','error','cancelled'].includes(job.status)){
      if(Date.now()-started>CLOUD.maxWaitSeconds*1000){cancel();throw fail('timeout','클라우드 분석이 너무 오래 걸립니다.');}
      onProgress?.({message:'클라우드에서 대사를 분석하는 중'});
      await sleep(CLOUD.pollSeconds,signal);
      const poll=await request(`/v1/jobs/${job.id}`,{},token);
      if(!poll.ok)throw fail(await detail(poll)||`http_${poll.status}`);
      job=await poll.json();
    }
    if(job.status!=='done')throw fail(job.error||job.status);
    return cloudChunks(job,duration,{allowSynthetic:cloud.allowSynthetic===true});
  }finally{signal?.removeEventListener('abort',cancel);}
}
