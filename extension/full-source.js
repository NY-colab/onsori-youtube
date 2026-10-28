export const FULL_LIMITS=Object.freeze({seconds:1200,bytes:100*1024*1024});
export function mediaUrl(value){
  try{const u=new URL(value);if(u.protocol==='https:'&&u.hostname.endsWith('.googlevideo.com')&&!u.username&&!u.password&&(!u.port||u.port==='443')&&u.pathname==='/videoplayback')return u.href;}catch{}return null;
}
export function captionUrl(value,videoId){
  try{const u=new URL(value);if(u.protocol==='https:'&&['www.youtube.com','m.youtube.com'].includes(u.hostname)&&u.pathname==='/api/timedtext'&&u.searchParams.get('v')===videoId&&!u.username&&!u.password&&!u.port){u.searchParams.set('fmt','json3');return u.href;}}catch{}return null;
}
export function selectFullSource(data,videoId,language='ko'){
  if(!data||data.videoId!==videoId)throw new Error('영상 정보를 읽지 못했습니다. YouTube 페이지를 새로고침해 주세요.');
  const duration=Number(data.duration);
  if(data.live||!Number.isFinite(duration)||duration<.2)throw new Error('실시간 방송은 전체 분석할 수 없습니다. 일반 영상을 선택해 주세요.');
  if(duration>FULL_LIMITS.seconds)throw new Error('기기 메모리 보호를 위해 전체 분석은 20분 이하 영상을 지원합니다. 다른 방법에서 필요한 구간을 녹음할 수 있습니다.');
  const formats=(Array.isArray(data.formats)?data.formats:[]).filter(f=>!f.drm&&mediaUrl(f.url)&&/^audio\/(mp4|webm)(;|$)/.test(f.mimeType||'')&&(!f.audioTrack||f.audioTrack.audioIsDefault!==false)&&!(Number(f.contentLength)>FULL_LIMITS.bytes)).sort((a,b)=>Number(b.audioTrack?.audioIsDefault===true)-Number(a.audioTrack?.audioIsDefault===true)||Number(b.mimeType.startsWith('audio/mp4'))-Number(a.mimeType.startsWith('audio/mp4'))||(Number(a.bitrate)||128000)-(Number(b.bitrate)||128000));
  if(!formats.length)throw new Error('이 영상은 YouTube가 전체 오디오 주소를 제공하지 않아 직접 분석할 수 없습니다. 다른 방법에서 탭 녹음을 선택해 주세요.');
  const tracks=(Array.isArray(data.tracks)?data.tracks:[]).filter(t=>captionUrl(t.url,videoId)).sort((a,b)=>Number(b.language===language)-Number(a.language===language)||Number(a.kind==='asr')-Number(b.kind==='asr'));
  return {videoId,title:String(data.title||'').slice(0,300),duration,url:mediaUrl(formats[0].url),mimeType:formats[0].mimeType,track:tracks[0]?{url:captionUrl(tracks[0].url,videoId),kind:tracks[0].kind}:null};
}
export async function boundedDownload(url,{signal,maxBytes=FULL_LIMITS.bytes,onProgress,fetcher=fetch}={}){
  const response=await fetcher(url,{signal,credentials:'omit',redirect:'error',cache:'no-store'});
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
