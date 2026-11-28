import {retryNetwork,NETWORK_RETRY_DELAYS} from './network-retry.js';
export const FULL_LIMITS=Object.freeze({seconds:1200,bytes:100*1024*1024});
export function mediaUrl(value){
  try{const u=new URL(value);if(u.protocol==='https:'&&u.hostname.endsWith('.googlevideo.com')&&!u.username&&!u.password&&(!u.port||u.port==='443')&&u.pathname==='/videoplayback')return u.href;}catch{}return null;
}
export function captionUrl(value,videoId){
  try{const u=new URL(value);if(u.protocol==='https:'&&['www.youtube.com','m.youtube.com'].includes(u.hostname)&&u.pathname==='/api/timedtext'&&u.searchParams.get('v')===videoId&&!u.username&&!u.password&&!u.port){u.searchParams.set('fmt','json3');return u.href;}}catch{}return null;
}
export function selectFullSource(data,videoId,language='ko',{allowLookup=false}={}){
  if(!data||data.videoId!==videoId)throw new Error('영상 정보를 읽지 못했습니다. YouTube 페이지를 새로고침해 주세요.');
  const duration=Number(data.duration);
  if(data.live||!Number.isFinite(duration)||duration<.2)throw new Error('실시간 방송은 전체 분석할 수 없습니다. 일반 영상을 선택해 주세요.');
  if(duration>FULL_LIMITS.seconds)throw new Error('기기 메모리 보호를 위해 전체 분석은 20분 이하 영상을 지원합니다. 다른 방법에서 필요한 구간을 녹음할 수 있습니다.');
  const formats=(Array.isArray(data.formats)?data.formats:[]).filter(f=>!f.drm&&mediaUrl(f.url)&&/^audio\/(mp4|webm)(;|$)/.test(f.mimeType||'')&&(!f.audioTrack||f.audioTrack.audioIsDefault!==false)&&!(Number(f.contentLength)>FULL_LIMITS.bytes)).sort((a,b)=>Number(b.audioTrack?.audioIsDefault===true)-Number(a.audioTrack?.audioIsDefault===true)||Number(b.mimeType.startsWith('audio/mp4'))-Number(a.mimeType.startsWith('audio/mp4'))||(Number(a.bitrate)||128000)-(Number(b.bitrate)||128000));
  if(!formats.length&&!allowLookup)throw new Error('이 영상에서 분석 가능한 전체 오디오 주소를 찾지 못했습니다.');
  const tracks=(Array.isArray(data.tracks)?data.tracks:[]).filter(t=>captionUrl(t.url,videoId)).sort((a,b)=>Number(b.language===language)-Number(a.language===language)||Number(a.kind==='asr')-Number(b.kind==='asr'));
  return {videoId,title:String(data.title||'').slice(0,300),duration,url:mediaUrl(formats[0]?.url),mimeType:formats[0]?.mimeType,bytes:Number(formats[0]?.contentLength)||null,video:selectScreenVideo(data.formats),track:pickTrack(data.captionRequest,tracks,videoId,language),...(typeof data.captionStatus==='string'?{captionStatus:data.captionStatus.slice(0,40)}:{})};
}
// A small video-only stream for reading burned-in subtitles: the lowest picture of at least
// 360 lines (else at least 240), H.264 before VP9, never DRM, within the download limit.
export function selectScreenVideo(formats){
  const usable=(Array.isArray(formats)?formats:[]).filter(f=>!f.drm&&mediaUrl(f.url)&&/^video\/(mp4|webm)(;|$)/.test(f.mimeType||'')&&Number(f.height)>=240&&!(Number(f.contentLength)>FULL_LIMITS.bytes));
  const rank=f=>[Number(f.height)>=360?0:1,Number(f.height)>=360?Number(f.height):-Number(f.height),/avc1/.test(f.mimeType)?0:1,Number(f.bitrate)||0];
  const best=usable.sort((a,b)=>{const x=rank(a),y=rank(b);for(let i=0;i<x.length;i++)if(x[i]!==y[i])return x[i]-y[i];return 0;})[0];
  return best?{url:mediaUrl(best.url),mimeType:best.mimeType,bytes:Number(best.contentLength)||null,height:Number(best.height)}:null;
}
// The player's own caption request carries its pot value and is the only address that
// returns text; a bare track address answers with an empty body.
function pickTrack(request,tracks,videoId,language){
  const url=captionUrl(request?.url,videoId);
  if(url&&new URL(url).searchParams.get('pot')&&(language==='auto'||request.language===language))return {url,kind:request.kind==='asr'?'asr':'standard',language:String(request.language||'').slice(0,20),attested:true};
  return tracks[0]?{url:captionUrl(tracks[0].url,videoId),kind:tracks[0].kind}:null;
}
// Network drops are retried (network-retry.js); HTTP errors, size limits and cancellation are not.
// `what` names what was being received, with its object particle, for the final message.
export async function boundedDownload(url,{signal,maxBytes=FULL_LIMITS.bytes,onProgress,fetcher=fetch,request={},what='영상 소리를',retryDelays=NETWORK_RETRY_DELAYS,sleep}={}){
  try{
    return await retryNetwork(()=>downloadOnce(url,{signal,maxBytes,onProgress,fetcher,request}),{signal,delays:retryDelays,sleep,
      giveUp:()=>new Error(`인터넷 연결이 끊겨 YouTube에서 ${what} 받지 못했습니다. 연결을 확인하고 다시 시도해 주세요.`)});
  }catch(e){
    if(e?.name==='TimeoutError')throw new Error(`YouTube 응답이 늦어 ${what} 받지 못했습니다. 잠시 뒤 다시 시도해 주세요.`);
    throw e;
  }
}
async function downloadOnce(url,{signal,maxBytes,onProgress,fetcher,request}){
  const response=await fetcher(url,{...request,signal,credentials:'omit',redirect:'error',cache:'no-store'});
  if(!response.ok)throw new Error(`오디오를 받을 수 없습니다 (${response.status}). 영상 주소를 다시 확인하거나 다른 방법의 탭 녹음을 이용해 주세요.`);
  const size=Number(response.headers.get('content-length'))||0;if(size>maxBytes){await response.body?.cancel();throw new Error('전체 오디오가 100MB 한도를 넘습니다.');}
  const reader=response.body?.getReader();if(!reader)throw new Error('오디오 응답을 읽을 수 없습니다.');
  const parts=[];let bytes=0;
  try{while(true){if(signal?.aborted)throw new DOMException('취소됨','AbortError');const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>maxBytes)throw new Error('전체 오디오가 허용 크기를 넘습니다.');parts.push(value);onProgress?.(bytes,size);}}catch(e){await reader.cancel().catch(()=>{});throw e;}finally{reader.releaseLock();}
  if(!bytes)throw new Error('빈 오디오 응답입니다.');return new Blob(parts,{type:response.headers.get('content-type')||'application/octet-stream'});
}
export function parseCaptionReferences(json,videoId,duration){
  return (Array.isArray(json?.events)?json.events:[]).slice(0,10000).flatMap(e=>{
    const start=Number(e.tStartMs)/1000,end=Math.min(duration,start+Number(e.dDurationMs)/1000),text=(e.segs||[]).map(s=>String(s.utf8||'')).join('').replace(/\s+/g,' ').trim();
    return Number.isFinite(start)&&Number.isFinite(end)&&start>=0&&end>start&&end-start<=15&&text.length>=4&&text.length<=500?[{video_id:videoId,start,end,text,source:'youtube-native-caption'}]:[];
  }).slice(0,2000);
}
// json3 caption track -> timed words. Auto captions put each word in its own segment
// with an offset; a manual track has whole lines. Bracketed sound tags ([음악]) are kept
// apart and never become speech.
export function captionWords(json,duration=Infinity){
  const words=[],tags=[];
  for(const e of (Array.isArray(json?.events)?json.events:[]).slice(0,20000)){
    const base=Number(e.tStartMs),span=Number(e.dDurationMs);if(!Number.isFinite(base)||!Array.isArray(e.segs))continue;
    const eventEnd=Math.min(duration,(base+(Number.isFinite(span)?span:0))/1000);
    for(const seg of e.segs){
      let text=String(seg?.utf8||'').replace(/\s+/g,' ').trim(),turn=false;if(!text)continue;
      if(text.startsWith('>>')){turn=true;text=text.slice(2).trim();}if(!text)continue;
      const start=(base+(Number(seg.tOffsetMs)||0))/1000;if(!Number.isFinite(start)||start<0||start>=duration)continue;
      if(/^\[[^\]]{1,30}\]$/.test(text)){tags.push({start,end:Math.max(start+.3,eventEnd),text});continue;}
      // Lone Latin letters ("Ja.", "H") are auto-caption noise in Korean tracks.
      if(/^[A-Za-z]{1,3}\.?$/.test(text))continue;
      words.push({start,eventEnd:Math.max(start+.1,eventEnd),text:text.slice(0,200),turn});
    }
  }
  words.sort((a,b)=>a.start-b.start);
  return {words:words.slice(0,20000),tags:tags.slice(0,2000)};
}
// Timed words -> caption lines: a line ends after . ? !, before a ">>" speaker mark,
// or at a pause over 1.6 s. Same rule as the 2026-11-14 measurement (CER 0.136 vs 0.157 for Whisper).
export function captionLines(words,{maxSeconds=12,maxLetters=80}={}){
  const lines=[];let cur=null;
  words.forEach((w,i)=>{
    const next=words[i+1];
    if(cur&&w.turn){lines.push(cur);cur=null;}
    cur??={start:w.start,words:[]};cur.words.push(w);
    const gap=next?next.start-w.start:Infinity,letters=cur.words.reduce((n,x)=>n+x.text.length,0);
    if(/[.?!]$/.test(w.text)||!next||next.turn||gap>1.6||next.start-cur.start>maxSeconds||letters>=maxLetters){
      cur.end=Math.min(w.eventEnd,next&&gap<=1.6?next.start:w.start+.4+.09*w.text.length);lines.push(cur);cur=null;
    }
  });
  if(cur){cur.end=cur.words.at(-1).start+.6;lines.push(cur);}
  return lines.map(l=>({start:Math.round(l.start*1000)/1000,end:Math.round(Math.max(l.end,l.start+.3)*1000)/1000,text:l.words.map(w=>w.text).join(' '),words:l.words.map(w=>({start:Math.round(w.start*1000)/1000,text:w.text}))}));
}
