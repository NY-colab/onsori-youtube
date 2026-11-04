import {MODEL_CONFIG} from './model-config.js';
import {dbfs} from './browser-engine-signal.js';
import {mergeAsrWindows,speechWindows,gridWindows} from './browser-engine-asr.js';
import {webgpuReady,engineProfiles,maxNewTokens} from './browser-engine-device.js';

// A dedicated worker keeps WASM/WebGPU execution off the offscreen document/UI thread.
// Terminating this worker is the cancellation boundary, including model loading.
self.onmessage=async ({data})=>{
  if(data?.type!=='analyze')return;
  let asr,events;
  const progress=(value,message)=>self.postMessage({type:'progress',progress:value,message});
  const release=async()=>{try{await asr?.dispose();await events?.dispose();}catch{}asr=events=null;};
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
    const run=async ({device,whisper,events:eventModel,asrWindow})=>{
      const gpu=device==='webgpu',where=gpu?'GPU':'브라우저',gated=asrWindow.gate==='speech'&&data.events!==false;
      // Progress bands: AST runs first when it decides where Whisper listens.
      const [asrBand,astBand]=gated?[[.46,.7],[.22,.44]]:[[.22,.42],[.5,.7]];
      const classify=async ()=>{
        const windows=[];if(data.events===false)return windows;
        progress(astBand[0]-.04,'음악·효과음 AST 모델 준비 중');
        events=await pipeline('audio-classification',eventModel.id,{revision:eventModel.revision,dtype:eventModel.dtype,device,progress_callback:reportDownload(astBand[0]-.02,'음향')});
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
          progress(astBand[0]+(astBand[1]-astBand[0])*end/duration,`음악·효과음 분석 ${Math.round(end)}/${Math.ceil(duration)}초`);
        }
        // Free each model before loading the next: two sessions need not coexist.
        await events.dispose();events=null;
        return windows;
      };
      const transcribe=async plan=>{
        progress(asrBand[0]-.14,gpu?`GPU로 한국어 Whisper 모델 준비 중 (첫 실행은 약 ${MODEL_CONFIG.gpu.downloadMB}MB를 내려받습니다)`:'브라우저에서 한국어 Whisper 모델 준비 중 (첫 실행은 모델을 내려받습니다)');
        asr=await pipeline('automatic-speech-recognition',whisper.id,{revision:whisper.revision,dtype:whisper.dtype,device,progress_callback:reportDownload(asrBand[0]-.12,'대사')});
        progress(asrBand[0],`${where}에서 한국어 대사와 시각 분석 중`);
        const heard=[];
        for(const {start,end} of plan){
          const samples=pcm.subarray(Math.floor(start*16000),Math.floor(end*16000));
          if(dbfs(samples)>-65){
            // Explicit short independent calls avoid automatic long-audio stride
            // merging, whose Korean segment endpoints can drift across a recording.
            const output=await asr(samples,{language:data.language==='auto'?undefined:(data.language||'ko'),task:'transcribe',return_timestamps:true,chunk_length_s:0,stride_length_s:0,force_full_sequences:false,max_new_tokens:maxNewTokens(end-start)});
            heard.push({start,end,output});
          }else heard.push({start,end,output:{text:'',chunks:[]}});
          progress(asrBand[0]+(asrBand[1]-asrBand[0])*end/duration,`한국어 대사 분석 ${Math.ceil(end)}/${Math.ceil(duration)}초`);
        }
        const output=mergeAsrWindows(heard);
        await asr.dispose();asr=null;
        return output;
      };
      if(gated){const windows=await classify();return {asr:await transcribe(speechWindows(windows,duration,asrWindow)),windows};}
      const output=await transcribe(gridWindows(duration,asrWindow));
      return {asr:output,windows:await classify()};
    };
    const profiles=engineProfiles(await webgpuReady(),data.device);
    let fallback=null;
    for(const [index,profile] of profiles.entries()){
      try{
        const result=await run(profile);
        self.postMessage({type:'result',...result,runtime:{device:profile.device,whisper:profile.whisper,events:profile.events,asr_window:profile.asrWindow,gpu_fallback:fallback}});
        return;
      }catch(error){
        await release();
        if(index===profiles.length-1)throw error;
        fallback=String(error?.message||error).slice(0,300);
        progress(.08,'GPU 가속을 사용할 수 없어 CPU로 처음부터 다시 분석합니다');
      }
    }
  }catch(error){self.postMessage({type:'error',message:`브라우저 AI 분석 실패: ${error?.message||String(error)}`});}
  finally{await release();}
};
