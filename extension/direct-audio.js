import {selectFullSource,mediaUrl,boundedDownload,FULL_LIMITS} from './full-source.js';

// Client configuration adapted from yt-dlp 2026.10.21 (Unlicense),
// yt_dlp/extractor/youtube/_base.py, INNERTUBE_CLIENTS['visionos'].
// This is a JSON protocol adapter, not a remote player-script executor.
const CLIENT={clientName:'VISIONOS',clientVersion:'1.02',deviceMake:'Apple',deviceModel:'RealityDevice17,1',
  userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  osName:'visionOS',osVersion:'26.5.23O471',hl:'en',timeZone:'UTC',utcOffsetMinutes:0};
const API='https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
function requestSignal(signal,ms=30000){return signal?AbortSignal.any([signal,AbortSignal.timeout(ms)]):AbortSignal.timeout(ms);}

export async function lookupAudio(source,{signal,fetcher=fetch,language='ko',origin='https://www.youtube.com'}={}){
  if(!/^[\w-]{11}$/.test(source?.videoId))throw new Error('영상 ID가 올바르지 않습니다.');
  if(!['https://www.youtube.com','https://m.youtube.com'].includes(origin))throw new Error('YouTube 페이지에서만 오디오를 조회할 수 있습니다.');
  // A fresh anonymous visitor context; no browser cookies or account tokens.
  const watch=await boundedDownload(`${origin}/watch?v=${source.videoId}`,{fetcher,signal:requestSignal(signal),maxBytes:8*1024*1024});
  const html=await watch.text(),visitor=html.match(/"VISITOR_DATA"\s*:\s*"([^"\r\n]{1,2048})"/)?.[1];
  const headers={'Content-Type':'application/json','X-YouTube-Client-Name':'101','X-YouTube-Client-Version':CLIENT.clientVersion};
  if(visitor)headers['X-Goog-Visitor-Id']=visitor;
  const payload=await boundedDownload(API.replace('https://www.youtube.com',origin),{fetcher,signal:requestSignal(signal),maxBytes:4*1024*1024,request:{method:'POST',headers,body:JSON.stringify({
    context:{client:CLIENT},videoId:source.videoId,contentCheckOk:true,racyCheckOk:true,
    playbackContext:{contentPlaybackContext:{html5Preference:'HTML5_PREF_WANTS'}}
  })}});
  const data=JSON.parse(await payload.text());
  if(data.playabilityStatus?.status!=='OK')throw new Error(`YouTube에서 전체 오디오를 제공하지 않았습니다 (${String(data.playabilityStatus?.status||'응답 오류').slice(0,40)}).`);
  const d=data.videoDetails,stream=data.streamingData;
  const resolved=selectFullSource({videoId:d?.videoId,title:d?.title,duration:d?.lengthSeconds,live:d?.isLiveContent===true,
    formats:(stream?.adaptiveFormats||[]).map(f=>({...f,drm:Boolean(f.drmFamilies?.length)})),
    tracks:(data.captions?.playerCaptionsTracklistRenderer?.captionTracks||[]).map(t=>({url:t.baseUrl,language:t.languageCode,kind:t.kind}))
  },source.videoId,language);
  if(Math.abs(resolved.duration-source.duration)>Math.max(2,source.duration*.01))throw new Error('요청한 영상과 오디오 길이가 다릅니다.');
  return {...resolved,track:source.track||resolved.track,transport:'youtube-player-visionos'};
}

export async function downloadAudio(source,{signal,fetcher=fetch,onProgress}={}){
  if(!mediaUrl(source?.url))throw new Error('오디오 주소가 올바르지 않습니다.');
  const size=source.bytes;
  if(!Number.isSafeInteger(size)||size<=0)return boundedDownload(source.url,{fetcher,signal:requestSignal(signal,60000),onProgress});
  if(size>FULL_LIMITS.bytes)throw new Error('전체 오디오가 100MB 한도를 넘습니다.');
  const parts=[];let received=0;
  // Small byte-range requests avoid a single throttled/expired long response.
  // All bytes come from the media file; no playback, seeking or recording.
  for(let start=0;start<size;start+=1048576){
    const end=Math.min(size-1,start+1048575),url=new URL(source.url);url.searchParams.set('range',`${start}-${end}`);
    const part=await boundedDownload(url.href,{fetcher,signal:requestSignal(signal),maxBytes:end-start+1,
      onProgress:n=>onProgress?.(received+n,size)});
    if(part.size!==end-start+1)throw new Error('오디오 일부가 누락되었습니다. 다시 분석해 주세요.');
    parts.push(part);received+=part.size;
  }
  return new Blob(parts,{type:source.mimeType||'audio/mp4'});
}

export async function acquireAudio(source,options={}){
  if(source.url){try{return {source,blob:await downloadAudio(source,options)};}catch(e){if(options.signal?.aborted||e.name==='AbortError')throw e;}}
  options.onLookup?.();
  const resolved=await (options.lookup||lookupAudio)(source,options);
  if(options.signal?.aborted)throw new DOMException('취소됨','AbortError');
  return {source:{...resolved,track:source.track||resolved.track},blob:await downloadAudio(resolved,options)};
}
