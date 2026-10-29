// MAIN world bridge: read only the current player's published response.
// No player-code execution, signature deciphering, or credential extraction.
(()=>{
  const currentId=()=>new URL(location.href).searchParams.get('v')||location.pathname.match(/^\/shorts\/([\w-]{11})/)?.[1];
  window.addEventListener('message',event=>{
    const m=event.data;if(event.source!==window||event.origin!==location.origin||m?.type!=='ONSORI_SOURCE_REQUEST'||typeof m.nonce!=='string'||m.nonce.length>80||m.videoId!==currentId())return;
    let playerResponse;try{playerResponse=document.querySelector('#movie_player')?.getPlayerResponse?.();}catch{}
    // A matching player response can omit streamingData. Keep the matching
    // initial response as a second source, but never mix videos after SPA navigation.
    const responses=[playerResponse,window.ytInitialPlayerResponse].filter(r=>r?.videoDetails?.videoId===m.videoId);
    const response=responses[0];
    const details=response?.videoDetails;
    const data=details?.videoId===m.videoId?{
      videoId:details.videoId,title:String(details.title||'').slice(0,300),duration:Number(details.lengthSeconds),live:details.isLiveContent===true,
      formats:responses.flatMap(r=>[...(r.streamingData?.adaptiveFormats||[]),...(r.streamingData?.formats||[])].slice(0,100)).map(f=>({url:f.url,mimeType:f.mimeType,bitrate:f.bitrate,contentLength:f.contentLength,audioTrack:f.audioTrack,drm:Boolean(f.drmFamilies?.length)})),
      tracks:responses.flatMap(r=>(r.captions?.playerCaptionsTracklistRenderer?.captionTracks||[]).slice(0,30)).map(t=>({url:t.baseUrl,language:t.languageCode,kind:t.kind})),
    }:null;
    window.postMessage({type:'ONSORI_SOURCE_RESPONSE',nonce:m.nonce,videoId:m.videoId,data},location.origin);
  });
})();
