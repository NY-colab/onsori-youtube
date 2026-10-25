// Only the native YouTube caption layer is evidence. Page titles, comments and
// our own overlay must never become speech corrections.
export function nativeCaptionText(player){
  return [...(player?.querySelectorAll('.ytp-caption-window-container .ytp-caption-segment')||[])]
    .map(node=>node.textContent||'').join(' ').replace(/\s+/g,' ').trim().slice(0,500);
}
export function createCaptionCollector(){
  let entries=[],last=null,videoId=null;
  return {
    reset(id){entries=[];last=null;videoId=id;},
    observe(snap,text){
      if(!snap||snap.videoId!==videoId||snap.ad||snap.paused||!Number.isFinite(snap.time)||snap.time<0){last=null;return;}
      text=String(text||'').replace(/\s+/g,' ').trim().slice(0,500);
      if(!text){last=null;return;}
      const time=snap.time;
      if(last&&last.text===text&&time>=last.end-.15&&time-last.end<.65&&time-last.start<14.8){last.end=Math.max(last.end,time+.1);return;}
      // A seek or changed rolling caption starts separate evidence, never a long span.
      last={video_id:videoId,start:time,end:time+.1,text,source:'youtube-native-caption'};
      entries.push(last);if(entries.length>2000)entries.shift();
    },
    snapshot(){return entries.filter(x=>x.end-x.start>=.2).map(x=>({...x}));}
  };
}
