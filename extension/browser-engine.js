import {validateDocument,trimVolumeProfile,clockTime} from './core.js';
import {MODEL_CONFIG} from './model-config.js';
import {assembleDocument,applyReferences,stableOcrReferences,selectOcrFrames,referenceLevel,dbfs,normalized,similarity} from './browser-engine-signal.js';
import {transcribeInCloud} from './cloud-speech.js';
import {correctDocumentSpeech,mergeCorrectionRecords,FATAL_CORRECTION_CODES,AI_CORRECTION} from './ai-correction.js';

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
// One dedicated inference worker. A one-shot analysis closes it after its result; a
// streaming session keeps it, and the models it loaded, for every minute it analyzes.
export function createInferenceSession(){
  let worker=null;
  const close=()=>{worker?.terminate();worker=null;};
  function run(pcm,options,onProgress,signal,extra={}){
    check(signal);
    if(!worker)worker=new Worker(new URL('./browser-inference-worker.js',import.meta.url),{type:'module'});
    const current=worker;
    return new Promise((resolve,reject)=>{
      const finish=(fn,value)=>{signal?.removeEventListener('abort',abort);current.onmessage=null;current.onerror=null;fn(value);};
      const drop=()=>{if(worker===current)close();};
      const abort=()=>{drop();finish(reject,abortError());};signal?.addEventListener('abort',abort,{once:true});
      current.onerror=event=>{drop();finish(reject,new Error(event.message||'브라우저 AI 작업자를 시작할 수 없습니다.'));};
      current.onmessage=({data})=>{
        if(data.type==='progress')onProgress?.({progress:data.progress,message:data.message});
        else if(data.type==='result')finish(resolve,data);
        else if(data.type==='error'){drop();finish(reject,new Error(data.message));}
      };
      // Transfer a copy: preserve waveform for shared-reference RMS after inference.
      const copy=pcm.slice();current.postMessage({type:'analyze',pcm:copy.buffer,language:options.language||'ko',events:options.event_detection!==false,device:options.engine_device==='wasm'?'wasm':'auto',...extra},[copy.buffer]);
      if(signal?.aborted)abort();
    });
  }
  return {run,close};
}
async function infer(pcm,options,onProgress,signal,extra={}){
  const session=createInferenceSession();
  try{return await session.run(pcm,options,onProgress,signal,extra);}finally{session.close();}
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

// Cloud speech (consented full-video analysis): the server transcribes speech while
// this device measures music and effects. Any cloud failure falls back to local
// speech recognition, reusing the sound windows already measured.
async function withCloudSpeech(pcm,{videoId,title,options,cloud,onProgress,signal,run=infer}){
  const remote=transcribeInCloud(pcm,{videoId,title,cloud,signal,onProgress:p=>onProgress?.({...p,progress:.22})}).then(asr=>({asr}),error=>({error}));
  const local=await run(pcm,options,onProgress,signal,{asr:false});
  const speech=await remote;check(signal);
  if(speech.asr)return {...local,asr:speech.asr,runtime:{...local.runtime,speech:'cloud'}};
  if(speech.error?.name==='AbortError')throw speech.error;
  const reason=String(speech.error?.message||'클라우드 대사 분석을 완료하지 못했습니다.').slice(0,200);
  onProgress?.({progress:.45,message:`${reason} 이 기기에서 대사를 분석합니다.`});
  const fallback=await run(pcm,options,onProgress,signal,{windows:local.windows});
  return {...fallback,runtime:{...fallback.runtime,cloud_fallback:reason}};
}

// AI typo correction never blocks captions: a failure keeps the recognized text and says so.
async function correctSpeech(doc,correction,{context=[],signal,onProgress}={}){
  try{onProgress?.('AI로 대사 오타 보정 중');await correctDocumentSpeech(doc,{apiKey:correction.apiKey,client:correction.client,model:correction.model||AI_CORRECTION.model,context,signal});return null;}
  catch(error){
    if(error?.name==='AbortError'||signal?.aborted)throw error.name==='AbortError'?error:abortError();
    doc.metadata.ai_correction=mergeCorrectionRecords(doc.metadata.ai_correction,{model:correction.model||AI_CORRECTION.model,status:'failed',checked:0,corrected:0,rejected:0,error:String(error?.message||error).slice(0,300)});
    return error;
  }
}
const correctionWarning=error=>`AI 자막 보정을 하지 못한 대사는 인식 원문으로 표시합니다: ${String(error?.message||error).slice(0,200)}`;

export async function analyzeRecording({blob,videoId=null,title='브라우저 녹음',startTime=0,options={},references=[],frames=[],scope='clip',expectedDuration,cloud=null,correction=null,onProgress,signal}={}){
  check(signal);
  if(typeof startTime!=='number'||!Number.isFinite(startTime)||startTime<0||startTime>86340)throw new Error('녹음 시작 시각이 올바르지 않습니다.');
  onProgress?.({progress:.02,message:'브라우저에서 오디오 읽는 중'});
  const full=scope==='full-video';
  const pcm=await decode(blob,signal,full?MODEL_CONFIG.maxFullSeconds:MODEL_CONFIG.maxSeconds);
  if(full&&(!Number.isFinite(expectedDuration)||Math.abs(pcm.length/16000-expectedDuration)>Math.max(2,expectedDuration*.01)))throw new Error('전체 오디오의 길이가 영상과 맞지 않아 결과를 적용하지 않았습니다.');
  const result=full&&cloud?.enabled===true?await withCloudSpeech(pcm,{videoId,title,options,cloud,onProgress,signal}):await infer(pcm,options,onProgress,signal);check(signal);
  const doc=assembleDocument({pcm,asr:result.asr,windows:result.windows,runtime:result.runtime,videoId,title,startTime,options});
  doc.metadata.analysis_scope=full?'full-video':'clip';
  if(result.runtime?.speech==='cloud')doc.warnings.push('대사는 온소리 클라우드(외부 AI 업체 DeepInfra)에서 인식했고, 음악·효과음은 이 기기에서 분석했습니다.');
  else if(result.runtime?.cloud_fallback)doc.warnings.push(`${result.runtime.cloud_fallback} 대사는 이 기기에서 분석했습니다.`);
  if(options.use_caption_references!==false){
    applyReferences(doc,references,'native');
    try{
      const ocr=await screenReferences(frames,doc,onProgress,signal);check(signal);
      applyReferences(doc,ocr.references,'screen');doc.metadata.screen_correction={...doc.metadata.screen_correction,status:ocr.status,processed_frames:ocr.processed,observations:ocr.observations||0,model:'Tesseract tessdata_fast kor+eng',revision:MODEL_CONFIG.ocr.revision};
      if(!ocr.processed&&options.capture_frames!==false)doc.warnings.push('화면 자막 교정에 사용할 영상 프레임이 없습니다. 음성 인식 결과는 검토가 필요합니다.');
    }catch(error){check(signal);doc.warnings.push(`화면 자막 확인을 완료하지 못했습니다: ${error.message}`);doc.metadata.screen_correction={status:'unavailable',error:String(error.message).slice(0,500)};}
  }
  if(correction?.enabled===true){const error=await correctSpeech(doc,correction,{signal,onProgress:message=>onProgress?.({progress:.99,message})});if(error)doc.warnings.push(correctionWarning(error));}
  check(signal);onProgress?.({progress:1,message:'브라우저 분석 완료'});return validateDocument(doc);
}

// ---- Streaming whole-video analysis -------------------------------------------------
// The whole audio file is downloaded and decoded first (compressed audio cannot be decoded
// in arbitrary byte ranges), then analyzed one minute at a time. Each finished minute is
// published at once, starting from the playhead, so captions are ready ahead of playback
// like a video buffer. Finished minutes are never analyzed again after an interruption.
const SR=MODEL_CONFIG.sampleRate,round3=x=>Math.round(x*1000)/1000,clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
export const STREAM=Object.freeze({seconds:60,search:8,min:15,pad:1.5});
export function coveredRanges(ranges=[],duration=Infinity){
  const sorted=(Array.isArray(ranges)?ranges:[]).filter(r=>Array.isArray(r)&&Number.isFinite(r[0])&&Number.isFinite(r[1])).map(([a,b])=>[Math.max(0,a),Math.min(duration,b)]).filter(([a,b])=>b>a).sort((x,y)=>x[0]-y[0]);
  const out=[];for(const [a,b] of sorted){const last=out.at(-1);if(last&&a<=last[1]+.05)last[1]=Math.max(last[1],b);else out.push([a,b]);}
  return out.map(([a,b])=>[round3(a),round3(b)]);
}
const coveredSeconds=ranges=>ranges.reduce((sum,[a,b])=>sum+b-a,0);
// The quietest 200 ms near the target minute, so a boundary rarely splits a spoken line.
export function quietestPoint(pcm,from,to,target=(from+to)/2){
  let best=target,cost=Infinity;
  for(let t=from;t<=to+1e-9;t+=.1){const level=dbfs(pcm.subarray(Math.max(0,Math.floor((t-.1)*SR)),Math.floor((t+.1)*SR))),value=level+.05*Math.abs(t-target);if(value<cost){cost=value;best=t;}}
  return round3(best);
}
// Splits every part not yet analyzed into pieces of about one minute (at most 75 s).
export function planChunks(pcm,duration,covered=[],config=STREAM){
  const gaps=[];let at=0;
  for(const [a,b] of coveredRanges(covered,duration)){if(a-at>=.2)gaps.push([at,a]);at=Math.max(at,b);}
  if(duration-at>=.2)gaps.push([at,duration]);
  const chunks=[];
  for(const [a,b] of gaps){
    let start=a;
    while(b-start>config.seconds+config.min){const target=start+config.seconds,end=quietestPoint(pcm,Math.max(start+config.min,target-config.search),Math.min(b-config.min,target+config.search),target);chunks.push({start,end});start=end;}
    chunks.push({start,end:b});
  }
  return chunks.map((c,index)=>({index,start:round3(c.start),end:round3(c.end)}));
}
// The next minute to analyze: the one under the playhead, then the following ones, then earlier gaps.
export function nextChunk(pending,position){if(!Number.isFinite(position))return 0;const i=pending.findIndex(c=>c.end>position+.5);return i>=0?i:0;}
// Each minute is analyzed with a short margin of neighbouring audio. It keeps speech whose
// midpoint lies inside the minute and clips music and effects to the minute's bounds.
export function ownChunk(doc,chunk,duration){
  const last=chunk.end>=duration-.01;
  doc.cues=doc.cues.flatMap(cue=>{
    if(cue.kind==='speech'){const mid=(cue.start+cue.end)/2;return mid>=chunk.start&&(mid<chunk.end||last)?[cue]:[];}
    const start=Math.max(cue.start,chunk.start),end=Math.min(cue.end,chunk.end);if(end-start<.05)return [];
    if(start===cue.start&&end===cue.end)return [cue];
    const clipped={...cue,start:round3(start),end:round3(end)};
    if(cue.volume_profile)clipped.volume_profile=trimVolumeProfile(cue.volume_profile,clipped.start,clipped.end);
    return [clipped];
  });
  return doc;
}
function sameUtterance(a,b){
  const overlap=Math.min(a.end,b.end)-Math.max(a.start,b.start),shorter=Math.min(a.end-a.start,b.end-b.start);
  if(!(shorter>0)||overlap<.3*shorter)return false;
  const x=normalized(a.text),y=normalized(b.text);if(!x||!y)return false;
  return x.includes(y)||y.includes(x)||similarity(x,y)>=.6;
}
// A music or effect description continuing across a minute boundary becomes one caption again.
function joinCues(a,b,reference){
  const [first,second]=a.start<=b.start?[a,b]:[b,a],start=first.start,end=Math.max(first.end,second.end),span=Math.max(.001,end-start);
  const energy=[first,second].reduce((sum,c)=>sum+10**((c.dbfs??-120)/10)*(c.end-c.start),0),level=10*Math.log10(Math.max(1e-12,energy/span)),relative=clamp(level-reference,-120,120);
  const joined={...first,start,end,dbfs:round3(level),relative_db:round3(relative),scale:round3(clamp(1+relative/40,.75,1.55)),confidence:Math.max(first.confidence??0,second.confidence??0)||null};
  if(first.volume_profile||second.volume_profile)joined.volume_profile=[...new Map([...(first.volume_profile||[]),...(second.volume_profile||[])].map(p=>[p.time,p])).values()].sort((x,y)=>x.time-y.time).slice(0,12002);
  return joined;
}
export function mergeStreamCues(cues,part,chunk,reference){
  const prefix=`m${Math.round(chunk.start*10)}-`,merged=[...cues],music={};
  for(const raw of part.cues){
    const cue={...raw,id:prefix+raw.id};
    if(cue.kind==='speech'){
      const duplicate=merged.findIndex(c=>c.kind==='speech'&&sameUtterance(c,cue));
      if(duplicate<0)merged.push(cue);else if(normalized(cue.text).length>normalized(merged[duplicate].text).length*1.2)merged[duplicate]=cue;
      continue;
    }
    const touching=merged.findIndex(c=>c.kind===cue.kind&&c.text===cue.text&&(Math.abs(c.end-cue.start)<=.25||Math.abs(cue.end-c.start)<=.25));
    if(touching>=0){merged[touching]=joinCues(merged[touching],cue,reference);continue;}
    merged.push(cue);if(part.metadata.music_analysis?.[raw.id])music[cue.id]=part.metadata.music_analysis[raw.id];
  }
  return {cues:merged.sort((a,b)=>a.start-b.start||a.end-b.end),music};
}
// Per-minute diagnostics stay out of the stored document, which is rewritten every minute.
function streamMetadata(meta={}){
  const {asr_diagnostics,speech_filter,speech_timing,asr_tag_filter,analysis_range,screen_correction,music_analysis,speech_reference,ai_correction,analyzed_ranges,stream_chunks,partial,...kept}=meta;
  return kept;
}
function compatibleBase(base,videoId,duration,language){
  const meta=base?.metadata;
  if(!base||base.video_id!==videoId||meta?.progressive!==true||meta.audio_analyzed!==true||(meta.speech_language||'ko')!==language||Math.abs(base.duration-duration)>Math.max(2,duration*.01))return null;
  return base;
}
export async function analyzeFullStreaming({blob,videoId,title='',expectedDuration,options={},references=[],cloud=null,correction=null,resume=null,position=null,onChunk,onProgress,signal}={}){
  check(signal);
  onProgress?.({progress:0,message:'브라우저에서 전체 오디오 읽는 중'});
  const pcm=await decode(blob,signal,MODEL_CONFIG.maxFullSeconds);
  if(!Number.isFinite(expectedDuration)||Math.abs(pcm.length/SR-expectedDuration)>Math.max(2,expectedDuration*.01))throw new Error('전체 오디오의 길이가 영상과 맞지 않아 결과를 적용하지 않았습니다.');
  const duration=round3(pcm.length/SR),language=options.language||'ko',reference=referenceLevel(pcm),base=compatibleBase(resume,videoId,duration,language);
  let cues=(base?.cues||[]).filter(c=>c.end<=duration+.05),covered=base?coveredRanges(base.metadata.analyzed_ranges,duration):[];
  let meta=base?streamMetadata(base.metadata):null,speechReference=base?.metadata.speech_reference||null,aiRecord=base?.metadata.ai_correction||null;
  const music={...(base?.metadata.music_analysis||{})},warnings=[...(base?.warnings||[])],chunkLog=[...(base?.metadata.stream_chunks||[])].slice(-200),warn=text=>{if(!warnings.includes(text))warnings.push(text);};
  const pending=planChunks(pcm,duration,covered);
  let cloudOn=cloud?.enabled===true,correctionOn=correction?.enabled===true;
  const documentNow=complete=>validateDocument({schema_version:'1.0',video_id:videoId,title:String(title||'').slice(0,300),duration,cues,warnings:warnings.slice(0,100),metadata:{...(meta||{}),engine:meta?.engine||'browser',audio_analyzed:true,partial:!complete,progressive:true,analysis_scope:'full-video',analysis_range:[0,duration],analyzed_ranges:covered,reference_dbfs:reference,speech_language:language,stream_chunk_seconds:STREAM.seconds,stream_chunks:chunkLog,music_analysis:music,...(speechReference?{speech_reference:speechReference}:{}),...(aiRecord?{ai_correction:aiRecord}:{})}});
  const session=createInferenceSession(),run=(p,o,cb,s,extra={})=>session.run(p,o,cb,s,{...extra,keep:true});
  try{
    while(pending.length){
      check(signal);
      let at=null;try{at=await position?.();}catch{}
      const [chunk]=pending.splice(nextChunk(pending,at),1),done=coveredSeconds(covered),length=chunk.end-chunk.start;
      const label=`${clockTime(chunk.start)}–${clockTime(chunk.end)}`;
      const ready=done?`자막 준비 ${clockTime(done)}/${clockTime(duration)} · `:'';
      const report=(fraction,message)=>onProgress?.({progress:Math.min(.999,(done+length*clamp(fraction,0,1))/duration),message:`${ready}${label} 구간 · ${message}`});
      const fromModel=update=>report(Number.isFinite(update.progress)?(update.progress-.05)/.7:0,update.message||'분석 중');
      const from=Math.max(0,chunk.start-STREAM.pad),to=Math.min(duration,chunk.end+STREAM.pad),slice=pcm.subarray(Math.round(from*SR),Math.round(to*SR));
      report(0,'소리 분석 시작');
      let result;
      if(cloudOn){
        result=await withCloudSpeech(slice,{videoId,title,options,cloud,onProgress:fromModel,signal,run});
        if(result.runtime?.cloud_fallback){cloudOn=false;warn(`${result.runtime.cloud_fallback} 이후 구간의 대사는 이 기기에서 분석했습니다.`);}
        else warn('대사는 온소리 클라우드(외부 AI 업체 DeepInfra)에서 인식했고, 음악·효과음은 이 기기에서 분석했습니다.');
      }else result=await run(slice,options,fromModel,signal);
      check(signal);
      const part=ownChunk(assembleDocument({pcm:slice,asr:result.asr,windows:result.windows,runtime:result.runtime,videoId,title,startTime:from,options,reference}),chunk,duration);
      if(options.use_caption_references!==false){applyReferences(part,references,'native');const r=part.metadata.speech_reference;speechReference={method:r.method,available:r.available,corrected:(speechReference?.corrected||0)+r.corrected};}
      if(correctionOn){
        const context=cues.filter(c=>c.kind==='speech'&&c.start<chunk.start).slice(-AI_CORRECTION.contextLines).map(c=>c.text);
        const error=await correctSpeech(part,correction,{context,signal,onProgress:message=>report(.97,message)});
        if(error){warn(correctionWarning(error));if(FATAL_CORRECTION_CODES.includes(error.code))correctionOn=false;}
        aiRecord=mergeCorrectionRecords(aiRecord,part.metadata.ai_correction);
      }
      for(const text of part.warnings)warn(text);
      meta??=streamMetadata(part.metadata);
      const merged=mergeStreamCues(cues,part,chunk,reference);cues=merged.cues;Object.assign(music,merged.music);
      for(const id of Object.keys(music))if(!cues.some(c=>c.id===id))delete music[id];
      covered=coveredRanges([...covered,[chunk.start,chunk.end]],duration);
      chunkLog.push({start:chunk.start,end:chunk.end,device:result.runtime?.device||null,speech:result.runtime?.speech==='cloud'?'cloud':'device',...(result.runtime?.gpu_fallback?{gpu_fallback:String(result.runtime.gpu_fallback).slice(0,120)}:{})});
      const doc=documentNow(!pending.length);
      check(signal);await onChunk?.(doc,{chunk,remaining:pending.length});
      if(!pending.length){onProgress?.({progress:1,message:'영상 전체 자막 분석 완료'});return doc;}
    }
    return documentNow(true);
  }finally{session.close();}
}
