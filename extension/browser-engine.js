import {validateDocument} from './core.js';
import {MODEL_CONFIG} from './model-config.js';
import {assembleDocument,applyReferences,stableOcrReferences,selectOcrFrames} from './browser-engine-signal.js';

const abortError=()=>new DOMException('분석을 취소했습니다.','AbortError');
function check(signal){if(signal?.aborted)throw abortError();}
function abortable(promise,signal){if(!signal)return promise;return new Promise((resolve,reject)=>{const abort=()=>reject(abortError());promise.then(value=>{signal.removeEventListener('abort',abort);resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});if(signal.aborted){abort();return;}signal.addEventListener('abort',abort,{once:true});});}
export async function browserEngineAvailability(){
  const required=['vendor/transformers/transformers.min.js','vendor/transformers/ort-wasm-simd-threaded.jsep.wasm','vendor/tesseract/tesseract.esm.min.js','vendor/tesseract/worker.min.js'];
  const available=await Promise.all(required.map(async path=>{try{return (await fetch(new URL(path,import.meta.url))).ok;}catch{return false;}}));
  return {available:available.every(Boolean),engine:'browser-wasm',models:MODEL_CONFIG,message:available.every(Boolean)?'설치 프로그램 없이 브라우저 안에서 분석합니다. 첫 실행은 AI 모델을 내려받습니다.':'브라우저 AI 파일이 없습니다. 빌드된 확장프로그램을 설치해 주세요.'};
}

async function decode(blob,signal,maxSeconds=MODEL_CONFIG.maxSeconds){
  check(signal);
  if(!(blob instanceof Blob)||!blob.size||blob.size>MODEL_CONFIG.maxBytes)throw new Error('0~100MB 사이의 오디오 파일이 필요합니다.');
  const Audio=globalThis.AudioContext||globalThis.webkitAudioContext;
  if(!Audio)throw new Error('이 브라우저는 오디오 디코딩을 지원하지 않습니다.');
  const context=new Audio({sampleRate:16000});
  try{
    const audio=await context.decodeAudioData(await blob.arrayBuffer());check(signal);
    if(audio.duration<.2||audio.duration>maxSeconds+.5)throw new Error(`이 분석은 최대 ${Math.round(maxSeconds/60)}분 오디오를 지원합니다.`);
    let mono=new Float32Array(audio.length);
    for(let ch=0;ch<audio.numberOfChannels;ch++){const channel=audio.getChannelData(ch);for(let i=0;i<mono.length;i++)mono[i]+=channel[i]/audio.numberOfChannels;}
    if(audio.sampleRate!==16000){
      const Offline=globalThis.OfflineAudioContext;if(!Offline)throw new Error('16kHz 변환을 지원하지 않습니다.');
      const render=new Offline(1,Math.round(audio.duration*16000),16000),buffer=render.createBuffer(1,mono.length,audio.sampleRate);buffer.copyToChannel(mono,0);
      const source=render.createBufferSource();source.buffer=buffer;source.connect(render.destination);source.start();mono=(await render.startRendering()).getChannelData(0).slice();
    }
    for(let i=0;i<mono.length;i++)mono[i]=Number.isFinite(mono[i])?Math.max(-1,Math.min(1,mono[i])):0;
    check(signal);return mono;
  }finally{await context.close();}
}
async function infer(pcm,options,onProgress,signal){
  check(signal);
  const worker=new Worker(new URL('./browser-inference-worker.js',import.meta.url),{type:'module'});
  return new Promise((resolve,reject)=>{
    const finish=(fn,value)=>{signal?.removeEventListener('abort',abort);worker.terminate();fn(value);};
    const abort=()=>finish(reject,abortError());signal?.addEventListener('abort',abort,{once:true});
    worker.onerror=event=>finish(reject,new Error(event.message||'브라우저 AI 작업자를 시작할 수 없습니다.'));
    worker.onmessage=({data})=>{
      if(data.type==='progress')onProgress?.({progress:data.progress,message:data.message});
      else if(data.type==='result')finish(resolve,data);
      else if(data.type==='error')finish(reject,new Error(data.message));
    };
    // Transfer a copy: preserve waveform for shared-reference RMS after inference.
    const copy=pcm.slice();worker.postMessage({type:'analyze',pcm:copy.buffer,language:options.language||'ko',events:options.event_detection!==false},[copy.buffer]);
    if(signal?.aborted)abort();
  });
}

async function screenReferences(frames,doc,onProgress,signal){
  const selected=selectOcrFrames(frames,doc,MODEL_CONFIG.ocr);
  if(!selected.length)return {references:[],status:'no-relevant-frames',processed:0};
  const {default:Tesseract}=await import('./vendor/tesseract/tesseract.esm.min.js');check(signal);
  let worker,nativeWorker;
  const abort=()=>{nativeWorker?.terminate();try{worker?.terminate()?.catch?.(()=>{});}catch{}};signal?.addEventListener('abort',abort,{once:true});
  try{
    onProgress?.({progress:.73,message:'화면 자막 확인용 한국어 OCR 모델 준비 중'});
    worker=await abortable(Tesseract.createWorker(MODEL_CONFIG.ocr.languages,1,{
      workerPath:new URL('./vendor/tesseract/worker.min.js',import.meta.url).href,
      corePath:new URL('./vendor/tesseract/',import.meta.url).href,
      langPath:MODEL_CONFIG.ocr.dataPath,workerBlobURL:false,gzip:false,
      cacheMethod:'write',errorHandler:()=>{},
      onWorkerCreated:w=>{nativeWorker=w;if(signal?.aborted)w.terminate();},
    }),signal);
    check(signal);await abortable(worker.setParameters({tessedit_pageseg_mode:6,preserve_interword_spaces:'1',user_defined_dpi:'150'}),signal);
    const observations=[];
    for(let i=0;i<selected.length;i++){
      check(signal);
      const frame=selected[i],prepared=await prepareSubtitleFrame(frame.jpeg),result=await abortable(worker.recognize(prepared,{}, {text:true,blocks:true}),signal);
      const blocks=result.data.blocks||[],lines=blocks.flatMap(b=>(b.paragraphs||[]).flatMap(p=>p.lines||[]));
      // Separate distant background glyphs from the central subtitle group.
      // The aggregate confidence is reported as-is on the Tesseract 0..100
      // scale; it is not interchangeable with PaddleOCR probabilities.
      const accepted=lines.flatMap(subtitleWordGroups).filter(l=>l.confidence>=MODEL_CONFIG.ocr.minConfidence);
      const text=accepted.map(l=>l.text.trim()).join(' ');
      if(text)observations.push({time:frame.time,text,confidence:Math.min(...accepted.map(l=>l.confidence))});
      onProgress?.({progress:.75+.22*(i+1)/selected.length,message:`화면 자막 확인 ${i+1}/${selected.length}`});
    }
    return {references:stableOcrReferences(observations,doc.video_id),status:'done',processed:selected.length,observations:observations.length};
  }finally{signal?.removeEventListener('abort',abort);try{await worker?.terminate();}catch{}}
}

export async function prepareSubtitleFrame(jpeg){
  const bytes=Uint8Array.from(atob(jpeg.split(',')[1]),c=>c.charCodeAt(0));
  const image=await createImageBitmap(new Blob([bytes],{type:'image/jpeg'}));
  try{
    if(image.width>1280||image.height>1280)throw new Error('화면 자막 이미지가 허용 크기를 넘었습니다.');
    const scale=Math.min(3,1920/image.width),canvas=new OffscreenCanvas(Math.round(image.width*scale),Math.round(image.height*scale)),ctx=canvas.getContext('2d',{willReadFrequently:true});
    ctx.drawImage(image,0,0,canvas.width,canvas.height);
    const data=ctx.getImageData(0,0,canvas.width,canvas.height);
    // Standard white, dark-outlined video subtitles. Preserve the unmodified
    // frame at the capture boundary; this derived bitmap is OCR input only.
    for(let i=0;i<data.data.length;i+=4){const r=data.data[i],g=data.data[i+1],b=data.data[i+2],v=Math.min(r,g,b)>175&&Math.max(r,g,b)-Math.min(r,g,b)<65?0:255;data.data[i]=data.data[i+1]=data.data[i+2]=v;}
    ctx.putImageData(data,0,0);return canvas.convertToBlob({type:'image/png'});
  }finally{image.close();}
}
export function subtitleWordGroups(line){
  const words=(line.words||[]).filter(w=>w.text?.trim()&&w.bbox&&(!/^[|^~\\/]+$/.test(w.text.trim()))),groups=[];
  for(const word of words){const previous=groups.at(-1),height=Math.max(1,word.bbox.y1-word.bbox.y0);if(!previous||word.bbox.x0-previous.at(-1).bbox.x1>height*2)groups.push([word]);else previous.push(word);}
  const raw=String(line.text||''),positions=[];let compact='';for(let i=0;i<raw.length;i++)if(!/\s/u.test(raw[i])){positions.push(i);compact+=raw[i];}
  return groups.map(group=>{
    const target=group.map(w=>w.text.trim()).join('').replace(/\s/gu,''),at=compact.indexOf(target);
    const text=at>=0?raw.slice(positions[at],positions[at+target.length-1]+1):group.map(w=>w.text.trim()).join(' ');
    return {text,confidence:group.reduce((sum,w)=>sum+w.confidence*Array.from(w.text.trim()).length,0)/group.reduce((sum,w)=>sum+Array.from(w.text.trim()).length,0)};
  }).filter(l=>l.text.replace(/[^\p{L}\p{N}]/gu,'').length>=4);
}

export async function analyzeRecording({blob,videoId=null,title='브라우저 녹음',startTime=0,options={},references=[],frames=[],scope='clip',expectedDuration,onProgress,signal}={}){
  check(signal);
  if(typeof startTime!=='number'||!Number.isFinite(startTime)||startTime<0||startTime>86340)throw new Error('녹음 시작 시각이 올바르지 않습니다.');
  onProgress?.({progress:.02,message:'브라우저에서 오디오 읽는 중'});
  const full=scope==='full-video';
  const pcm=await decode(blob,signal,full?MODEL_CONFIG.maxFullSeconds:MODEL_CONFIG.maxSeconds);
  if(full&&(!Number.isFinite(expectedDuration)||Math.abs(pcm.length/16000-expectedDuration)>Math.max(2,expectedDuration*.01)))throw new Error('전체 오디오의 길이가 영상과 맞지 않아 결과를 적용하지 않았습니다.');
  const result=await infer(pcm,options,onProgress,signal);check(signal);
  const doc=assembleDocument({pcm,asr:result.asr,windows:result.windows,videoId,title,startTime,options});
  doc.metadata.analysis_scope=full?'full-video':'clip';
  if(options.use_caption_references!==false){
    applyReferences(doc,references,'native');
    try{
      const ocr=await screenReferences(frames,doc,onProgress,signal);check(signal);
      applyReferences(doc,ocr.references,'screen');doc.metadata.screen_correction={...doc.metadata.screen_correction,status:ocr.status,processed_frames:ocr.processed,observations:ocr.observations||0,model:'Tesseract tessdata_fast kor+eng',revision:MODEL_CONFIG.ocr.revision};
      if(!ocr.processed&&options.capture_frames!==false)doc.warnings.push('화면 자막 교정에 사용할 영상 프레임이 없습니다. 음성 인식 결과는 검토가 필요합니다.');
    }catch(error){check(signal);doc.warnings.push(`화면 자막 확인을 완료하지 못했습니다: ${error.message}`);doc.metadata.screen_correction={status:'unavailable',error:String(error.message).slice(0,500)};}
  }
  check(signal);onProgress?.({progress:1,message:'브라우저 분석 완료'});return validateDocument(doc);
}
