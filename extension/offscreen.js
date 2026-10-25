let current;
const API='http://127.0.0.1:8765',HEADERS={'X-OnSori-Client':'onsori-local-v1'};
async function send(session,message){if(current!==session||session.discarded)return null;try{return await chrome.runtime.sendMessage({...message,captureId:session.captureId});}catch{return null;}}
function cleanup(session){
  clearTimeout(session.limitTimer);clearInterval(session.levelTimer);
  const stream=session.stream;session.stream=null;
  stream?.getTracks().forEach(track=>track.stop());
  const context=session.context;session.context=null;
  if(context)context.close().catch(()=>{});
}
function discard(session){if(!session)return;session.discarded=true;session.controller?.abort();cleanup(session);if(session.recorder?.state==='recording')session.recorder.stop();session.chunks=[];}
async function fail(session,error){if(session.failed||session.discarded)return;session.failed=true;cleanup(session);if(session.recorder?.state==='recording')session.recorder.stop();session.chunks=[];await send(session,{type:'CAPTURE_ERROR',error});}
async function prepare(message){
  discard(current);
  const session={captureId:message.captureId,chunks:[],bytes:0,discarded:false,failed:false,stopping:false};current=session;
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
  }catch(e){cleanup(session);throw e;}
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
  recorder.onstop=()=>upload(session);
  recorder.start(1000);session.started=performance.now();
  session.levelTimer=setInterval(()=>level(session),1000);
  session.limitTimer=setTimeout(()=>{send(session,{type:'CAPTURE_LIMIT'});stop(session);},60000);
  return {startedAt,startTime:session.meta.startTime};
}
function stop(session=current){if(!session||session.stopping)return;session.stopping=true;clearTimeout(session.limitTimer);clearInterval(session.levelTimer);if(session.recorder?.state==='recording')session.recorder.stop();else cleanup(session);}
async function upload(session){
  cleanup(session);
  if(current!==session||session.discarded||session.failed)return;
  const blob=new Blob(session.chunks,{type:session.recorder.mimeType});session.chunks=[];
  if(blob.size<2000){await fail(session,'녹음 구간이 너무 짧습니다. 영상을 재생하고 2초 이상 녹음해 주세요.');return;}
  await send(session,{type:'CAPTURE_UPLOADING'});
  if(current!==session||session.discarded)return;
  const evidence=await send(session,{type:'CAPTURE_REFERENCES'});
  if(current!==session||session.discarded)return;
  const form=new FormData();form.append('file',blob,'onsori-tab-audio.webm');
  form.append('options',JSON.stringify({...session.meta.options,caption_references:evidence?.references||[],screen_frames:evidence?.frames||[],video_id:session.meta.videoId,title:session.meta.title,start_time:session.meta.startTime}));
  const controller=new AbortController();session.controller=controller;
  const timeout=setTimeout(()=>controller.abort(),60000);
  try{
    const response=await fetch(API+'/api/jobs/upload',{method:'POST',headers:HEADERS,body:form,signal:controller.signal});
    let data;try{data=await response.json();}catch{throw new Error('분석 서버 응답을 읽을 수 없습니다.');}
    if(!response.ok)throw new Error(data.detail||data.error||`업로드 오류 (${response.status})`);
    if(current!==session||session.discarded){if(data.id)await fetch(API+'/api/jobs/'+encodeURIComponent(data.id),{method:'DELETE',headers:HEADERS,signal:AbortSignal.timeout(15000)}).catch(()=>{});return;}
    await send(session,{type:'CAPTURE_JOB',job:data});
  }catch(e){if(current===session&&!session.discarded)await fail(session,e.name==='AbortError'?'업로드 시간이 초과되었습니다. 로컬 서버를 확인해 주세요.':e.message||'오디오를 업로드하지 못했습니다.');}
  finally{clearTimeout(timeout);session.controller=null;}
}
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  if(message.target!=='offscreen')return;
  (async()=>{
    switch(message.type){
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
