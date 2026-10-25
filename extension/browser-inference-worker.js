import {MODEL_CONFIG} from './model-config.js';
import {dbfs} from './browser-engine-signal.js';
import {mergeAsrWindows} from './browser-engine-asr.js';

// A dedicated worker keeps WASM execution off the offscreen document/UI thread.
// Terminating this worker is the cancellation boundary, including model loading.
self.onmessage=async ({data})=>{
  if(data?.type!=='analyze')return;
  let asr,events;
  const progress=(value,message)=>self.postMessage({type:'progress',progress:value,message});
  try{
    const {pipeline,env}=await import('./vendor/transformers/transformers.min.js');
    env.allowLocalModels=false;
    env.allowRemoteModels=true;
    env.useBrowserCache=true;
    env.backends.onnx.wasm.wasmPaths=new URL('./vendor/transformers/',import.meta.url).href;
    env.backends.onnx.wasm.numThreads=1; // MV3 pages are not cross-origin isolated.
    env.backends.onnx.wasm.proxy=false;
    const pcm=new Float32Array(data.pcm), duration=pcm.length/MODEL_CONFIG.sampleRate;
    const reportDownload=(base,label)=>{let last=0;return event=>{
      if(event.status==='progress'){
        if(performance.now()-last<500)return;last=performance.now();
        progress(base,`${label} 모델 내려받기 ${Math.round(event.progress||0)}% · ${event.file||''}`);
      }
      else if(event.status==='initiate')progress(base,`${label} 모델 준비 · ${event.file||''}`);
    };};
    progress(.08,'브라우저에서 한국어 Whisper 모델 준비 중 (첫 실행은 모델을 내려받습니다)');
    asr=await pipeline('automatic-speech-recognition',MODEL_CONFIG.whisper.id,{revision:MODEL_CONFIG.whisper.revision,dtype:MODEL_CONFIG.whisper.dtype,device:'wasm',progress_callback:reportDownload(.1,'대사')});
    progress(.22,'한국어 대사와 시각 분석 중');
    const speechWindows=[];
    for(let start=0;start<duration;start+=5){
      const end=Math.min(start+8,duration),samples=pcm.subarray(Math.floor(start*16000),Math.floor(end*16000));
      if(dbfs(samples)>-65){
        // Explicit short independent calls avoid automatic long-audio stride
        // merging, whose Korean segment endpoints can drift across a recording.
        const output=await asr(samples,{language:data.language==='auto'?undefined:(data.language||'ko'),task:'transcribe',return_timestamps:true,chunk_length_s:0,stride_length_s:0,force_full_sequences:false});
        speechWindows.push({start,end,output});
      }else speechWindows.push({start,end,output:{text:'',chunks:[]}});
      progress(.22+.2*end/duration,`한국어 대사 분석 ${Math.ceil(end)}/${Math.ceil(duration)}초`);
      if(end===duration)break;
    }
    const output=mergeAsrWindows(speechWindows);
    // Free Whisper before loading AST: two model sessions need not coexist.
    await asr.dispose();asr=null;
    let windows=[];
    if(data.events!==false){
      progress(.44,'음악·효과음 AST 모델 준비 중');
      events=await pipeline('audio-classification',MODEL_CONFIG.events.id,{revision:MODEL_CONFIG.events.revision,dtype:MODEL_CONFIG.events.dtype,device:'wasm',progress_callback:reportDownload(.46,'음향')});
      for(let start=0;start<duration;start+=2){
        const end=Math.min(start+2,duration),samples=pcm.subarray(Math.floor(start*16000),Math.floor(end*16000));
        // Silence is measured, never converted into invented classifier labels.
        if(dbfs(samples)>-65){
          // AudioSet is multi-label. Transformers.js 3.x's generic audio
          // pipeline applies softmax, which suppresses simultaneous music and
          // effects. Apply the AST training-time independent sigmoid instead.
          const inputs=await events.processor(samples),prediction=await events.model(inputs);
          const labels=Array.from(prediction.logits.data,(logit,i)=>({label:events.model.config.id2label[i],score:1/(1+Math.exp(-logit))})).sort((a,b)=>b.score-a.score);
          windows.push({start,end,labels});
        }
        progress(.5+.2*end/duration,`음악·효과음 분석 ${Math.round(end)}/${Math.ceil(duration)}초`);
      }
      await events.dispose();events=null;
    }
    self.postMessage({type:'result',asr:output,windows});
  }catch(error){self.postMessage({type:'error',message:`브라우저 AI 분석 실패: ${error?.message||String(error)}`});}
  finally{try{await asr?.dispose();await events?.dispose();}catch{}}
};
