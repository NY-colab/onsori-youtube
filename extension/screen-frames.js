// Read pixels from the video itself, never the page, comments or our overlay.
export function createFrameCollector(makeCanvas=()=>document.createElement('canvas')){
  let frames=[],videoId=null,last=-Infinity,unavailable=false;
  return {
    reset(id){frames=[];videoId=id;last=-Infinity;unavailable=false;},
    observe(video,snap){
      // At most 121 x 350 KB keeps the complete runtime message below Chrome's
      // 64 MiB limit and matches the OCR engine's two observations per second.
      if(unavailable||frames.length>=121||!video||!snap||snap.videoId!==videoId||snap.ad||snap.paused||!Number.isFinite(snap.time)||snap.time<0||snap.time-last<.48||!video.videoWidth||!video.videoHeight)return;
      last=snap.time;
      try{
        const canvas=makeCanvas(),scale=Math.min(1,1280/video.videoWidth),top=Math.floor(video.videoHeight*.60);
        canvas.width=Math.round(video.videoWidth*scale);canvas.height=Math.round((video.videoHeight-top)*scale);
        canvas.getContext('2d').drawImage(video,0,top,video.videoWidth,video.videoHeight-top,0,0,canvas.width,canvas.height);
        const jpeg=canvas.toDataURL('image/jpeg',.85);
        if(jpeg.length<=350000)frames.push({video_id:videoId,time:snap.time,jpeg});
      }catch{unavailable=true;} // CORS/DRM is not bypassed; audio/native references still work.
    },
    snapshot(){return frames.map(f=>({...f}));},
    status(){return unavailable?'unavailable':frames.length?'captured':'empty';}
  };
}
