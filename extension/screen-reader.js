// Reads burned-in subtitles from a downloaded video-only stream in the offscreen document.
// Frames are sampled every 0.5 s, only the bottom band is read, and OCR runs only when the
// white-text pixels of that band changed. Nothing is uploaded: frames stay on this device.
import {MODEL_CONFIG} from './model-config.js';
import {SCREEN_OCR,subtitleText,screenLines,looksSubtitled} from './screen-lines.js';
import {subtitleWordGroups} from './browser-engine.js';

const abortError=()=>new DOMException('분석을 취소했습니다.','AbortError');
const check=signal=>{if(signal?.aborted)throw abortError();};

function waitFor(target,event,signal,ms=10000){
  return new Promise((resolve,reject)=>{
    const done=ok=>()=>{clearTimeout(timer);target.removeEventListener(event,onOk);target.removeEventListener('error',onError);signal?.removeEventListener('abort',onAbort);ok();};
    const onOk=done(resolve),onError=done(()=>reject(new Error('화면 자막을 읽을 영상을 열지 못했습니다.'))),onAbort=done(()=>reject(abortError()));
    const timer=setTimeout(done(()=>reject(new Error('영상 화면을 여는 데 시간이 너무 걸립니다.'))),ms);
    target.addEventListener(event,onOk,{once:true});target.addEventListener('error',onError,{once:true});signal?.addEventListener('abort',onAbort,{once:true});
  });
}

export async function createScreenReader(blob,{duration,signal,config=SCREEN_OCR,onProgress}={}){
  check(signal);
  const url=URL.createObjectURL(blob),video=document.createElement('video');
  video.muted=true;video.preload='auto';video.playsInline=true;video.src=url;
  let worker=null,nativeWorker=null;
  const close=async()=>{try{await worker?.terminate();}catch{}nativeWorker?.terminate?.();video.removeAttribute('src');video.load();URL.revokeObjectURL(url);};
  try{
    await waitFor(video,'loadeddata',signal,20000);
    if(!video.videoWidth||!video.videoHeight)throw new Error('영상 화면 크기를 읽지 못했습니다.');
    const {default:Tesseract}=await import('./vendor/tesseract/tesseract.esm.min.js');check(signal);
    onProgress?.('화면 자막을 읽을 한국어 OCR 모델 준비 중');
    worker=await Tesseract.createWorker(MODEL_CONFIG.ocr.languages,1,{
      workerPath:new URL('./vendor/tesseract/worker.min.js',import.meta.url).href,
      corePath:new URL('./vendor/tesseract/',import.meta.url).href,
      langPath:MODEL_CONFIG.ocr.dataPath,workerBlobURL:false,gzip:false,cacheMethod:'write',errorHandler:()=>{},
      onWorkerCreated:w=>{nativeWorker=w;}});
    check(signal);
    await worker.setParameters({tessedit_pageseg_mode:6,preserve_interword_spaces:'1',user_defined_dpi:'150'});
  }catch(e){await close();throw e;}

  const top=Math.floor(video.videoHeight*(1-config.band)),bandHeight=video.videoHeight-top,left=Math.floor(video.videoWidth*(1-config.width)/2),bandWidth=video.videoWidth-2*left;
  const scale=Math.min(config.scale,1280/bandWidth);
  const canvas=new OffscreenCanvas(Math.round(bandWidth*scale),Math.round(bandHeight*scale)),ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.imageSmoothingQuality='high';
  const cache=new Map(),stats={frames:0,ocr:0,reused:0,empty:0,frameMs:0,ocrMs:0};let previous=null;
  const seek=async time=>{if(Math.abs(video.currentTime-time)<.01&&video.readyState>=2)return;const ready=waitFor(video,'seeked',signal);video.currentTime=time;await ready;};
  // Every seek decodes from the previous keyframe, so a range is read by playing forward (muted,
  // 4x) and pausing once playback reaches each sample time. The hidden offscreen page has no frame
  // callbacks, so the position is polled. If playback stalls, the reader goes back to seeking.
  let playable=true;
  const advance=async time=>{
    if(video.currentTime>=time-.02||video.ended)return;
    if(!playable)return seek(time);
    video.playbackRate=4;
    try{await video.play();}catch{playable=false;return seek(time);}
    const started=performance.now(),from=video.currentTime;
    try{
      while(video.currentTime<time-.02&&!video.ended){
        check(signal);
        if(performance.now()-started>3000+(time-from)*1000&&video.currentTime<=from+.01){playable=false;break;}
        await new Promise(r=>setTimeout(r,8));
      }
    }finally{video.pause();}
    if(!playable)return seek(time);
  };
  // White, low-saturation pixels (standard dark-outlined subtitles) become black text on white.
  const frameAt=async (time,playing=false)=>{
    if(playing)await advance(time);else await seek(time);
    ctx.drawImage(video,left,top,bandWidth,bandHeight,0,0,canvas.width,canvas.height);
    const W=canvas.width,H=canvas.height,image=ctx.getImageData(0,0,W,H),d=image.data,gridW=160,gridH=40,grid=new Uint8Array(gridW*gridH);
    let ink=0,x0=W,x1=-1,y0=H,y1=-1;
    for(let y=0;y<H;y++)for(let x=0;x<W;x++){
      const i=(y*W+x)*4,r=d[i],g=d[i+1],b=d[i+2],text=Math.min(r,g,b)>175&&Math.max(r,g,b)-Math.min(r,g,b)<65;
      d[i]=d[i+1]=d[i+2]=text?0:255;
      if(text){ink++;grid[Math.floor(y*gridH/H)*gridW+Math.floor(x*gridW/W)]=1;if(x<x0)x0=x;if(x>x1)x1=x;if(y<y0)y0=y;if(y>y1)y1=y;}
    }
    ctx.putImageData(image,0,0);
    // Only the box around the text goes to OCR: smaller images are read much faster.
    const m=24,box={x:Math.max(0,x0-m),y:Math.max(0,y0-m),w:Math.min(W,x1+m+1)-Math.max(0,x0-m),h:Math.min(H,y1+m+1)-Math.max(0,y0-m)};
    return {ink,grid,box,pixels:d,width:W};
  };
  const observe=async (time,playing=false)=>{
    const key=Math.round(time*1000);if(cache.has(key))return cache.get(key);
    check(signal);
    const t0=performance.now(),frame=await frameAt(time,playing);let row;stats.frames++;stats.frameMs+=performance.now()-t0;
    if(frame.ink<250||frame.box.w<40||frame.box.h<16){row={time,text:'',confidence:0};stats.empty++;}
    else if(previous?.row.text&&sameInk(frame.grid,previous.grid)){row={...previous.row,time};stats.reused++;}
    else{const t1=performance.now();stats.ocr++;
      const result=await worker.recognize(grayImage(frame),{},{text:true,blocks:true});
      const lines=(result.data.blocks||[]).flatMap(b=>(b.paragraphs||[]).flatMap(p=>p.lines||[]));
      row={time,...subtitleText(lines.flatMap(subtitleWordGroups),config)};stats.ocrMs+=performance.now()-t1;
    }
    previous={grid:frame.grid,row};cache.set(key,row);return row;
  };
  // The text box as a binary PGM image. Canvas encoders wait for rendering, which is paused in the
  // hidden offscreen page (about 1 s per frame, 2026-11-24); Tesseract reads PNM directly.
  const grayImage=({pixels,width,box})=>{
    const header=new TextEncoder().encode(`P5
${box.w} ${box.h}
255
`),out=new Uint8Array(header.length+box.w*box.h);out.set(header);
    let o=header.length;for(let y=box.y;y<box.y+box.h;y++)for(let x=box.x;x<box.x+box.w;x++)out[o++]=pixels[(y*width+x)*4];
    return new Blob([out],{type:'image/x-portable-graymap'});
  };
  // Same subtitle: the cells holding white text barely moved (changed cells / cells with text).
  const sameInk=(a,b)=>{let diff=0,union=0;for(let i=0;i<a.length;i++){if(a[i]||b[i])union++;if(a[i]!==b[i])diff++;}return union>0&&diff/union<.12;};
  const sampleTimes=(from,to)=>{const times=[];for(let t=Math.ceil((from-config.step/2)/config.step)*config.step+config.step/2;t<to&&t<duration;t+=config.step)if(t>=0)times.push(Math.round(t*1000)/1000);return times;};
  return {
    // A few frames spread over the whole video decide whether its dialogue is burned in.
    async probe(){
      const count=Math.min(config.probeFrames,Math.max(1,Math.floor(duration/config.step))),rows=[];
      for(let i=0;i<count;i++){const t=duration*(i+.5)/count;rows.push(await observe(Math.round(t*1000)/1000));previous=null;onProgress?.(`화면 자막이 있는 영상인지 확인 중 ${i+1}/${count}`);}
      return {subtitled:looksSubtitled(rows,config),frames:rows.length,shown:rows.filter(r=>r.text).length,height:video.videoHeight,stats};
    },
    // Subtitle lines whose middle falls in [from,to); frames a little outside are read too, so a
    // line crossing the boundary keeps its full time.
    async read(from,to,report){
      const times=sampleTimes(Math.max(0,from-6),Math.min(duration,to+6)),rows=[];previous=null;
      const first=times.findIndex(t=>!cache.has(Math.round(t*1000)));
      if(first>=0)await seek(Math.max(0,times[first]-config.step));
      for(let i=0;i<times.length;i++){rows.push(await observe(times[i],true));report?.((i+1)/times.length);}
      return screenLines(rows,config).filter(l=>{const mid=(l.start+l.end)/2;return mid>=from&&(mid<to||to>=duration-.01);});
    },
    close,
  };
}
