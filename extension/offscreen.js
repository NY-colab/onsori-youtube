import {analyzeRecording} from './browser-engine.js';
import {acquireAudio} from './direct-audio.js';
import {captionUrl,boundedDownload,parseCaptionReferences,FULL_LIMITS} from './full-source.js';
let current;
async function send(session,message){if(current!==session||session.discarded)return null;try{return await chrome.runtime.sendMessage({...message,captureId:session.captureId});}catch{return null;}}
function cleanup(session){
  clearTimeout(session.limitTimer);clearInterval(session.levelTimer);
  const stream=session.stream;session.stream=null;
  stream?.getTracks().forEach(track=>track.stop());
  const context=session.context;session.context=null;
  if(context)context.close().catch(()=>{});
}
function discard(session){if(!session)return;session.discarded=true;session.controller?.abort();clearInterval(session.keepaliveTimer);cleanup(session);if(session.recorder?.state==='recording')session.recorder.stop();session.chunks=[];}
async function fail(session,error){if(session.failed||session.discarded)return;session.failed=true;cleanup(session);if(session.recorder?.state==='recording')session.recorder.stop();session.chunks=[];await send(session,{type:'CAPTURE_ERROR',error});}
async function prepare(message){
  discard(current);
  const session={captureId:message.captureId,chunks:[],bytes:0,discarded:false,failed:false,stopping:false,preparing:true};current=session;
  try{
    const stream=await navigator.mediaDevices.getUserMedia({audio:{mandatory:{chromeMediaSource:'tab',chromeMediaSourceId:message.streamId}},video:false});
    // A capture request can complete after cancellation or a newer request.
    if(current!==session||session.discarded){stream.getTracks().forEach(track=>track.stop());return;}
    session.stream=stream;session.context=new AudioContext();
    const source=session.context.createMediaStreamSource(stream);
    // Tab capture mutes the original tab. Keep its original audio audible.
    source.connect(session.context.destination);
    session.analyser=session.context.createAnalyser();session.analyser.fftSize=2048;source.connect(session.analyser);
    await session.context.resume();
    if(current!==session||session.discarded){cleanup(session);return;}
    const track=stream.getAudioTracks()[0];
    if(!track||track.readyState==='ended')throw new Error('탭 오디오 연결이 종료되었습니다. 다시 시작해 주세요.');
    track.addEventListener('ended',()=>{if(session.discarded||session.failed)return;if(session.recorder?.state==='recording')stop(session);else if(!session.stopping)fail(session,'탭 오디오 연결이 종료되었습니다. 다시 시작해 주세요.');});
  }catch(e){cleanup(session);throw e;}finally{session.preparing=false;}
}
function level(session){
  if(current!==session||session.discarded||session.failed||session.stopping)return;
  const samples=new Float32Array(session.analyser.fftSize);session.analyser.getFloatTimeDomainData(samples);
  let sum=0,peak=0;for(const sample of samples){sum+=sample*sample;peak=Math.max(peak,Math.abs(sample));}
  const rms=Math.sqrt(sum/samples.length),elapsed=(performance.now()-session.started)/1000;
  session.silentSince=rms<0.001?(session.silentSince??0):elapsed;
  send(session,{type:'CAPTURE_LEVEL',rms,peak,elapsed,bytes:session.bytes,silentSeconds:rms<0.001?elapsed-session.silentSince:0});
}
function start(message){
  const session=current;
  if(!session||session.discarded||session.failed||!session.stream||session.stopping)throw new Error('탭 오디오를 먼저 연결해 주세요.');
  if(session.recorder)throw new Error('이미 녹음 중입니다. 먼저 녹음을 종료해 주세요.');
  if(message.captureId&&session.captureId!==message.captureId)throw new Error('녹음 요청이 변경되었습니다. 다시 시작해 주세요.');
  const mime=['audio/webm;codecs=opus','audio/webm'].find(m=>MediaRecorder.isTypeSupported(m));
  if(!mime)throw new Error('이 Chrome에서는 WebM 오디오 녹음을 지원하지 않습니다. Chrome을 업데이트해 주세요.');
  const startedAt=Date.now(),delay=message.snapshotAt===undefined?0:startedAt-message.snapshotAt;
  if(!Number.isFinite(delay)||delay<0||delay>1000)throw new Error('영상 시각을 확인한 뒤 녹음 연결이 지연되었습니다. 다시 시작해 주세요.');
  session.meta={...message,startTime:message.startTime+delay/1000};
  const recorder=new MediaRecorder(session.stream,{mimeType:mime,audioBitsPerSecond:128000});session.recorder=recorder;
  recorder.ondataavailable=e=>{if(!session.discarded&&!session.failed&&e.data.size){session.chunks.push(e.data);session.bytes+=e.data.size;}};
  recorder.onerror=e=>fail(session,e.error?.message||'탭 오디오 녹음 오류입니다.');
  recorder.onstop=()=>analyze(session);
  recorder.start(1000);session.started=performance.now();
  session.levelTimer=setInterval(()=>level(session),1000);
  session.limitTimer=setTimeout(()=>{send(session,{type:'CAPTURE_LIMIT'});stop(session);},60000);
  return {startedAt,startTime:session.meta.startTime};
}
function stop(session=current){if(!session||session.stopping)return;session.stopping=true;clearTimeout(session.limitTimer);clearInterval(session.levelTimer);if(session.recorder?.state==='recording')session.recorder.stop();else cleanup(session);}
async function analyze(session){
  cleanup(session);
  if(current!==session||session.discarded||session.failed||session.analyzing)return;
  session.analyzing=true;
  const blob=new Blob(session.chunks,{type:session.recorder.mimeType});session.chunks=[];
  if(blob.size<2000){session.analyzing=false;await fail(session,'녹음 구간이 너무 짧습니다. 영상을 재생하고 2초 이상 녹음해 주세요.');return;}
  const controller=new AbortController();session.controller=controller;
  let progress={progress:0,message:'첫 분석은 AI 모델 다운로드가 필요합니다. 다운로드한 모델은 Chrome에 보관합니다.'};
  const report=update=>{progress={...progress,...update};return send(session,{type:'ANALYSIS_PROGRESS',...progress});};
  // Runtime messages every 15s keep the service worker alive while WASM computes.
  session.keepaliveTimer=setInterval(()=>report({}),15000);
  try{
    await send(session,{type:'CAPTURE_ANALYZING',...progress});
    if(current!==session||session.discarded)return;
    const evidence=await send(session,{type:'CAPTURE_REFERENCES'});
    if(current!==session||session.discarded)return;
    const document=await analyzeRecording({blob,videoId:session.meta.videoId,title:session.meta.title,startTime:session.meta.startTime,options:session.meta.options,references:evidence?.references||[],frames:session.meta.options?.capture_frames?evidence?.frames||[]:[],onProgress:report,signal:controller.signal});
    if(current!==session||session.discarded||controller.signal.aborted)return;
    const result=await send(session,{type:'ANALYSIS_COMPLETE',document});
    if(result&&!result.ok)throw new Error(result.error||'완료된 자막을 저장하지 못했습니다.');
    session.completed=true;
  }catch(e){if(current===session&&!session.discarded)await fail(session,e.name==='AbortError'?'분석을 취소했습니다.':e.message||'이 기기에서 소리를 분석하지 못했습니다.');}
  finally{clearInterval(session.keepaliveTimer);session.controller=null;session.analyzing=false;}
}
async function analyzeFull(message){
  discard(current);
  const session={captureId:message.captureId,analyzing:true,chunks:[],controller:new AbortController()};current=session;
  let source=message.source;const signal=session.controller.signal;
  let progress={progress:0,message:'영상 전체 오디오를 가져옵니다.'};
  const report=update=>{progress={...progress,...update};return send(session,{type:'ANALYSIS_PROGRESS',...progress});};
  session.keepaliveTimer=setInterval(()=>report({}),15000);
  try{
    if(!/^[\w-]{11}$/.test(source?.videoId)||!Number.isFinite(source.duration)||source.duration<=0||source.duration>FULL_LIMITS.seconds)throw new Error('전체 오디오 요청이 올바르지 않습니다.');
    const acquired=await acquireAudio(source,{signal,language:message.options?.language,
      lookup:async()=>{const result=await send(session,{type:'FULL_AUDIO_LOOKUP',language:message.options?.language});if(!result?.ok||!result.source)throw new Error(result?.error||'오디오 주소 조회가 끝났습니다. 다시 분석해 주세요.');return result.source;},
      onLookup:()=>report({progress:0,message:'YouTube에 전체 오디오를 직접 요청합니다. 재생하거나 녹음하지 않습니다.'}),
      onProgress:(bytes,total)=>report({progress:total ? .05*bytes/total : 0,message:`전체 오디오 받는 중 · ${(bytes/1048576).toFixed(1)} MB${total?' / '+(total/1048576).toFixed(1)+' MB':''}`})});
    source=acquired.source;const blob=acquired.blob;
    let references=[];
    if(message.options?.use_caption_references!==false&&captionUrl(source.track?.url,source.videoId)){
      try{const data=await boundedDownload(source.track.url,{signal,maxBytes:2*1024*1024});references=parseCaptionReferences(JSON.parse(await data.text()),source.videoId,source.duration);}catch(e){if(signal.aborted)throw e;}
    }
    if(current!==session||signal.aborted)return;
    const document=await analyzeRecording({blob,videoId:source.videoId,title:source.title,startTime:0,scope:'full-video',expectedDuration:source.duration,options:{...message.options,capture_frames:false},references,frames:[],onProgress:update=>report({...update,progress:.05+.95*update.progress}),signal});
    if(current!==session||signal.aborted)return;
    document.metadata.audio_transport=source.transport||'page-direct';
    const result=await send(session,{type:'ANALYSIS_COMPLETE',document});if(!result?.ok)throw new Error(result?.error||'전체 자막을 저장하지 못했습니다.');session.completed=true;
  }catch(e){if(current===session&&!session.discarded)await fail(session,e.message||'전체 분석을 완료하지 못했습니다. 다른 방법에서 탭 녹음을 선택해 주세요.');}
  finally{clearInterval(session.keepaliveTimer);session.analyzing=false;session.controller=null;}
}
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  if(message.target!=='offscreen')return;
  (async()=>{
    switch(message.type){
      case 'FULL_ANALYZE':void analyzeFull(message);break;
      case 'GET_SESSION':return {ok:true,captureId:current?.captureId,discarded:current?.discarded===true,failed:current?.failed===true,preparing:current?.preparing===true,analyzing:current?.analyzing===true,recording:current?.recorder?.state==='recording'};
      case 'CAPTURE_PREPARE':await prepare(message);break;
      case 'CAPTURE_RECORD':
        if(message.captureId&&message.captureId!==current?.captureId)throw new Error('녹음 요청이 변경되었습니다. 다시 시작해 주세요.');
        try{return {ok:true,...start(message)};}catch(e){if(current?.recorder?.state!=='recording')cleanup(current||{});throw e;}
      case 'CAPTURE_STOP':if(!message.captureId||message.captureId===current?.captureId)stop();break;
      case 'CAPTURE_DISCARD':if(!message.captureId||message.captureId===current?.captureId)discard(current);break;
      default:throw new Error('알 수 없는 녹음 요청입니다.');
    }
    return {ok:true};
  })().then(respond,e=>respond({ok:false,error:e.message}));return true;
});
