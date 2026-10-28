// MAIN world bridge: read only the current player's published response.
// No player-code execution, signature deciphering, or credential extraction.
(()=>{
  const currentId=()=>new URL(location.href).searchParams.get('v')||location.pathname.match(/^\/shorts\/([\w-]{11})/)?.[1];
  window.addEventListener('message',event=>{
    const m=event.data;if(event.source!==window||event.origin!==location.origin||m?.type!=='ONSORI_SOURCE_REQUEST'||typeof m.nonce!=='string'||m.nonce.length>80||m.videoId!==currentId())return;
    let response;try{response=document.querySelector('#movie_player')?.getPlayerResponse?.();}catch{}
    if(response?.videoDetails?.videoId!==m.videoId)response=window.ytInitialPlayerResponse;
    const details=response?.videoDetails;
    const data=details?.videoId===m.videoId?{
      videoId:details.videoId,title:String(details.title||'').slice(0,300),duration:Number(details.lengthSeconds),live:details.isLiveContent===true,
      formats:[...(response.streamingData?.adaptiveFormats||[]),...(response.streamingData?.formats||[])].slice(0,100).map(f=>({url:f.url,mimeType:f.mimeType,bitrate:f.bitrate,contentLength:f.contentLength,audioTrack:f.audioTrack,drm:Boolean(f.drmFamilies?.length)})),
      tracks:(response.captions?.playerCaptionsTracklistRenderer?.captionTracks||[]).slice(0,30).map(t=>({url:t.baseUrl,language:t.languageCode,kind:t.kind})),
    }:null;
    window.postMessage({type:'ONSORI_SOURCE_RESPONSE',nonce:m.nonce,videoId:m.videoId,data},location.origin);
  });
})();
