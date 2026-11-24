// MAIN world bridge: read only the current player's published response.
// No signature deciphering or credential extraction. Besides reading the player
// response, the only player call is the public caption option (getOption/setOption).
// Caption text: the player itself requests the caption track (with its own pot
// value) when captions are shown. We only read the address of that request from
// the page's resource timing list; the extension then fetches the same address.
(()=>{
  const currentId=()=>new URL(location.href).searchParams.get('v')||location.pathname.match(/^\/shorts\/([\w-]{11})/)?.[1];
  const captionRequests=new Map();
  const remember=name=>{
    try{const u=new URL(name);if(u.origin!==location.origin||u.pathname!=='/api/timedtext'||!u.searchParams.get('pot'))return;
      const id=u.searchParams.get('v');if(!/^[\w-]{11}$/.test(id||''))return;
      captionRequests.set(id,{url:u.href,language:u.searchParams.get('lang')||'',kind:u.searchParams.get('kind')||''});
      if(captionRequests.size>20)captionRequests.delete(captionRequests.keys().next().value);
    }catch{}
  };
  try{new PerformanceObserver(list=>{for(const e of list.getEntries())remember(e.name);}).observe({type:'resource',buffered:true});}catch{}
  const wait=ms=>new Promise(r=>setTimeout(r,ms));
  const matches=(found,language)=>found&&(language==='auto'||!language||found.language===language);
  // When captions are hidden the player never requests them. Turn the wanted track
  // on through the player's public option, wait for the player's own request, then
  // put the viewer's previous caption choice back.
  async function captionRequest(player,videoId,tracks,language){
    let found=captionRequests.get(videoId);if(matches(found,language))return {found};
    const track=tracks.find(t=>t.language===language)||(language==='auto'?tracks[0]:null);
    if(!track)return {status:'no-track'};
    if(typeof player?.setOption!=='function'||typeof player.getOption!=='function')return {status:'no-player'};
    // The player only asks for captions while the video itself plays (not before the first
    // frame, not during an ad). Analysis can start a moment earlier, so wait for that.
    const playing=()=>{let state=-1;try{state=player.getPlayerState();}catch{}return state!==-1&&state!==5&&!document.querySelector('#movie_player.ad-showing');};
    const poll=async(ms,lang=language)=>{for(let i=0;i<ms/100;i++){await wait(100);const f=captionRequests.get(videoId);if(matches(f,lang))return f;}return null;};
    for(let i=0;i<60&&!playing();i++){await wait(100);found=captionRequests.get(videoId);if(matches(found,language))return {found};}
    if(!playing())return {status:'not-playing'};
    // Right after playback starts the player may not have its pot value yet. Let it make its
    // own request first (captions already on); forcing a track this early yields a request
    // without pot and a caption state read before the player loaded its caption settings.
    found=await poll(4000);if(found)return {found};
    let before=null;try{before=player.getOption('captions','track');}catch{}
    try{
      // Re-selecting a track that is already shown makes the player request it again.
      // A second try covers a pot value that was still being prepared on the first one.
      for(let attempt=0;attempt<2;attempt++){
        if(attempt||before?.languageCode===track.language){player.setOption('captions','track',{});await wait(300);}
        player.setOption('captions','track',{languageCode:track.language});
        found=await poll(attempt?3000:4000,track.language);if(found)return {found};
      }
      return {status:'no-request'};
    }catch{return {status:'player-error'};}
    finally{
      try{
        if(!before?.languageCode)player.setOption('captions','track',{});
        else if(before.languageCode!==track.language||before.kind!==track.kind)player.setOption('captions','track',{languageCode:before.languageCode});
      }catch{}
    }
  }
  window.addEventListener('message',async event=>{
    const m=event.data;if(event.source!==window||event.origin!==location.origin||m?.type!=='ONSORI_SOURCE_REQUEST'||typeof m.nonce!=='string'||m.nonce.length>80||m.videoId!==currentId())return;
    const language=typeof m.language==='string'&&/^(ko|en|auto)$/.test(m.language)?m.language:'ko';
    let player=null,playerResponse;try{player=document.querySelector('#movie_player');playerResponse=player?.getPlayerResponse?.();}catch{}
    // A matching player response can omit streamingData. Keep the matching
    // initial response as a second source, but never mix videos after SPA navigation.
    const responses=[playerResponse,window.ytInitialPlayerResponse].filter(r=>r?.videoDetails?.videoId===m.videoId);
    const response=responses[0];
    const details=response?.videoDetails;
    const data=details?.videoId===m.videoId?{
      videoId:details.videoId,title:String(details.title||'').slice(0,300),duration:Number(details.lengthSeconds),live:details.isLiveContent===true,
      formats:responses.flatMap(r=>[...(r.streamingData?.adaptiveFormats||[]),...(r.streamingData?.formats||[])].slice(0,100)).map(f=>({url:f.url,mimeType:f.mimeType,bitrate:f.bitrate,contentLength:f.contentLength,height:f.height,audioTrack:f.audioTrack,drm:Boolean(f.drmFamilies?.length)})),
      tracks:responses.flatMap(r=>(r.captions?.playerCaptionsTracklistRenderer?.captionTracks||[]).slice(0,30)).map(t=>({url:t.baseUrl,language:t.languageCode,kind:t.kind})),
    }:null;
    if(data&&m.captions===true){
      const {found,status}=await captionRequest(player,m.videoId,data.tracks,language);
      if(found&&m.videoId===currentId())data.captionRequest=found;else data.captionStatus=status||'video-changed';
    }
    window.postMessage({type:'ONSORI_SOURCE_RESPONSE',nonce:m.nonce,videoId:m.videoId,data},location.origin);
  });
})();
