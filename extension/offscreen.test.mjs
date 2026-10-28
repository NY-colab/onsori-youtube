import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import * as fullSource from './full-source.js';
const source=(await readFile(new URL('./offscreen.js',import.meta.url),'utf8')).replace(/^import[^\n]+\n/gm,'');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
function harness(config={}){
  let receiver,now=10000;const streams=[],recorders=[],contexts=[],messages=[],requests=[],timers=[],intervals=[];
  function makeStream(){const track={readyState:'live',stops:0,stop(){this.stops++;this.readyState='ended';this.ended?.();},addEventListener(type,fn){this[type]=fn;}};const stream={track,getTracks:()=>[track],getAudioTracks:()=>[track]};streams.push(stream);return stream;}
  class Recorder{
    static isTypeSupported(){return true;}
    constructor(stream,{mimeType}){this.stream=stream;this.mimeType=mimeType;this.state='inactive';recorders.push(this);}
    start(){if(config.startError)throw new Error('recorder start failed');this.state='recording';}
    stop(){this.state='inactive';this.stops=(this.stops||0)+1;}
    chunk(value='x'.repeat(3000)){this.ondataavailable?.({data:new Blob([value])});}
    finish(){return this.onstop?.();}
  }
  class Context{
    constructor(){this.closed=0;contexts.push(this);}
    createMediaStreamSource(){return {connect(){}};}
    createAnalyser(){return {fftSize:2048,getFloatTimeDomainData(array){array.fill(config.level||0);}};}
    async resume(){if(config.resumeError)throw new Error('resume failed');}
    async close(){this.closed++;}
  }
  const sandbox={...fullSource,async boundedDownload(url,options){if(config.downloadGate)await config.downloadGate;if(options.signal.aborted)throw new DOMException('aborted','AbortError');if(config.downloadError)throw new Error('download failed');return new Blob(['x'.repeat(3000)]);},DOMException,chrome:{runtime:{onMessage:{addListener(fn){receiver=fn;}},async sendMessage(message){messages.push(message);if(config.messageGate&&message.type==='CAPTURE_ANALYZING')await config.messageGate;return {ok:true};}}},navigator:{mediaDevices:{async getUserMedia(options){assert.equal(options.video,false);assert.equal(options.audio.mandatory.chromeMediaSource,'tab');if(config.mediaGate)await config.mediaGate;return makeStream();}}},AudioContext:Context,MediaRecorder:Recorder,Blob,FormData,AbortController,AbortSignal,Float32Array,Math,Number,Date:class extends Date{static now(){return now;}},performance:{now:()=>now},setTimeout(fn,ms){const entry={fn,ms,cleared:false};timers.push(entry);return entry;},clearTimeout(entry){if(entry)entry.cleared=true;},setInterval(fn,ms){const entry={fn,ms,cleared:false};intervals.push(entry);return entry;},clearInterval(entry){if(entry)entry.cleared=true;},async analyzeRecording(args){requests.push(args);args.onProgress({progress:.25,message:'모델 다운로드 중'});if(config.analysisGate)await config.analysisGate;if(config.analysisError)throw new Error('model failed');return {schema_version:'1.0',video_id:args.videoId,title:args.title,duration:30,cues:[],warnings:[],metadata:{audio_analyzed:true}};}};
  vm.runInNewContext(source,sandbox);
  const send=payload=>new Promise(resolve=>receiver({target:'offscreen',...payload},{},resolve));
  const prepare=(captureId='one')=>send({type:'CAPTURE_PREPARE',streamId:'tab-only',captureId});
  const record=(captureId='one',extra={})=>send({type:'CAPTURE_RECORD',captureId,videoId:'abcdefghijk',title:'영상',startTime:12,options:{language:'ko'},...extra});
  return {send,prepare,record,streams,recorders,contexts,messages,requests,timers,intervals,advance(ms){now+=ms;}};
}
test('normal recording preserves tab-only capture, final chunk and local inference metadata',async()=>{
  const h=harness();await h.prepare();h.advance(250);assert.equal((await h.record('one',{snapshotAt:10000})).startTime,12.25);
  h.recorders[0].chunk();await h.send({type:'CAPTURE_STOP',captureId:'one'});h.recorders[0].chunk('tail');await h.recorders[0].finish();
  assert.equal(h.streams[0].track.stops,1);assert.equal(h.contexts[0].closed,1);assert.equal(h.requests.length,1);
  const request=h.requests[0];assert.equal(request.blob.size,3004);assert.equal(request.startTime,12.25);assert.equal(request.videoId,'abcdefghijk');assert.equal(request.options.language,'ko');
  assert.equal(h.messages.at(-1).type,'ANALYSIS_COMPLETE');assert.equal(h.messages.at(-1).captureId,'one');
});
test('cancelled prepare stops its late stream and never starts an audio context',async()=>{
  const gate=deferred(),h=harness({mediaGate:gate.promise}),pending=h.prepare();await h.send({type:'CAPTURE_DISCARD',captureId:'one'});gate.resolve();await pending;
  assert.equal(h.streams[0].track.stops,1);assert.equal(h.contexts.length,0);assert.equal((await h.record()).ok,false);
});
test('late old recorder callbacks cannot clean up or analyze the new session',async()=>{
  const h=harness();await h.prepare();await h.record();const old=h.recorders[0];old.chunk();await h.prepare('two');await h.record('two');old.chunk();await old.finish();
  assert.equal(h.streams[1].track.stops,0);assert.equal(h.contexts[1].closed,0);assert.equal(h.requests.length,0);
  await h.send({type:'CAPTURE_DISCARD',captureId:'one'});assert.equal(h.streams[1].track.stops,0);
  h.recorders[1].chunk('y'.repeat(4000));await h.send({type:'CAPTURE_STOP',captureId:'two'});await h.recorders[1].finish();assert.equal(h.requests[0].blob.size,4000);
});
test('recorder error is terminal and cannot analyze corrupt audio',async()=>{
  const h=harness();await h.prepare();await h.record();h.recorders[0].chunk();await h.recorders[0].onerror({error:{message:'codec failed'}});await h.recorders[0].finish();
  assert.equal(h.messages.filter(m=>m.type==='CAPTURE_ERROR').length,1);assert.equal(h.requests.length,0);assert.equal(h.streams[0].track.stops,1);
});
test('cancel while analysis notification is pending suppresses inference',async()=>{
  const gate=deferred(),h=harness({messageGate:gate.promise});await h.prepare();await h.record();h.recorders[0].chunk();await h.send({type:'CAPTURE_STOP'});const pending=h.recorders[0].finish();await h.send({type:'CAPTURE_DISCARD'});gate.resolve();await pending;assert.equal(h.requests.length,0);
});
test('cancelled model inference is aborted and late result cannot publish',async()=>{
  const gate=deferred(),h=harness({analysisGate:gate.promise});await h.prepare();await h.record();h.recorders[0].chunk();await h.send({type:'CAPTURE_STOP'});const pending=h.recorders[0].finish();await tick();const signal=h.requests[0].signal;await h.send({type:'CAPTURE_DISCARD'});assert.equal(signal.aborted,true);gate.resolve();await pending;
  assert.equal(h.messages.some(m=>m.type==='ANALYSIS_COMPLETE'),false);assert.equal(h.requests.length,1);
});
test('duplicate start/stop and stale record cannot damage the active session',async()=>{
  const h=harness();await h.prepare();assert.equal((await h.record('old')).ok,false);assert.equal(h.streams[0].track.stops,0);await h.record();assert.equal((await h.record()).ok,false);assert.equal(h.streams[0].track.stops,0);
  await h.send({type:'CAPTURE_STOP'});await h.send({type:'CAPTURE_STOP'});assert.equal(h.recorders[0].stops,1);
});
test('failed audio setup, recorder start and stale clock release capture resources',async()=>{
  for(const config of [{resumeError:true},{startError:true},{}]){const h=harness(config);const prepared=await h.prepare();const result=config.resumeError?prepared:await h.record('one',config.startError?{}:{snapshotAt:8000});assert.equal(result.ok,false);assert.equal(h.streams[0].track.stops,1);assert.equal(h.contexts[0].closed,1);}
});
test('silent/active level telemetry is session scoped and stops after stop',async()=>{
  const h=harness();await h.prepare();await h.record();h.advance(1000);h.intervals[0].fn();await tick();const sample=h.messages.find(m=>m.type==='CAPTURE_LEVEL');assert.equal(sample.rms,0);assert.equal(sample.silentSeconds,1);assert.equal(sample.captureId,'one');assert.equal(h.intervals[0].ms,1000);
  await h.send({type:'CAPTURE_STOP'});assert.equal(h.intervals[0].cleared,true);h.intervals[0].fn();assert.equal(h.messages.filter(m=>m.type==='CAPTURE_LEVEL').length,1);
  const active=harness({level:0.5});await active.prepare();await active.record();active.advance(1000);active.intervals[0].fn();assert.equal(active.messages.at(-1).rms,0.5);assert.equal(active.messages.at(-1).silentSeconds,0);
});
test('track end stops recording and short data produces a clear error without inference',async()=>{
  const h=harness();await h.prepare();await h.record();h.streams[0].track.ended();assert.equal(h.recorders[0].state,'inactive');h.recorders[0].chunk('tiny');await h.recorders[0].finish();assert.equal(h.requests.length,0);assert.match(h.messages.at(-1).error,/짧습니다/);
});

test('model loading keeps worker alive every 15 seconds and cancellation clears heartbeat',async()=>{
  const gate=deferred(),h=harness({analysisGate:gate.promise});await h.prepare();await h.record();h.recorders[0].chunk();await h.send({type:'CAPTURE_STOP'});const pending=h.recorders[0].finish();await tick();
  const heartbeat=h.intervals.find(i=>i.ms===15000);assert.ok(heartbeat);heartbeat.fn();await tick();assert.ok(h.messages.filter(m=>m.type==='ANALYSIS_PROGRESS').length>=2);
  const session=await h.send({type:'GET_SESSION'});assert.equal(session.captureId,'one');assert.equal(session.analyzing,true);
  await h.send({type:'CAPTURE_DISCARD'});assert.equal(heartbeat.cleared,true);gate.resolve();await pending;assert.equal(h.messages.some(m=>m.type==='ANALYSIS_COMPLETE'),false);
});
test('model failure reports local error and clears heartbeat without publishing captions',async()=>{
  const h=harness({analysisError:true});await h.prepare();await h.record();h.recorders[0].chunk();await h.send({type:'CAPTURE_STOP'});await h.recorders[0].finish();assert.equal(h.messages.at(-1).type,'CAPTURE_ERROR');assert.equal(h.messages.at(-1).error,'model failed');assert.equal(h.messages.some(m=>m.type==='ANALYSIS_COMPLETE'),false);assert.equal(h.intervals.find(i=>i.ms===15000).cleared,true);
});
test('stale discard during inference does not abort the replacement capture',async()=>{
  const gate=deferred(),h=harness({analysisGate:gate.promise});await h.prepare();await h.record();h.recorders[0].chunk();await h.send({type:'CAPTURE_STOP'});const pending=h.recorders[0].finish();await tick();await h.prepare('two');await h.record('two');await h.send({type:'CAPTURE_DISCARD',captureId:'one'});gate.resolve();await pending;assert.equal(h.streams[1].track.stops,0);assert.equal(h.requests[0].signal.aborted,true);assert.equal(h.messages.some(m=>m.type==='ANALYSIS_COMPLETE'),false);
});

test('full video download analyzes complete source without MediaRecorder and supports cancellation',async()=>{
 const source={url:'https://r1.googlevideo.com/videoplayback?id=test',videoId:'abcdefghijk',title:'전체',duration:361};
 const h=harness();await h.send({type:'FULL_ANALYZE',captureId:'whole',source,options:{language:'ko'}});await tick();assert.equal(h.recorders.length,0);assert.equal(h.requests[0].scope,'full-video');assert.equal(h.requests[0].expectedDuration,361);assert.equal(h.requests[0].startTime,0);assert.equal(h.messages.at(-1).type,'ANALYSIS_COMPLETE');
 const gate=deferred(),c=harness({downloadGate:gate.promise});await c.send({type:'FULL_ANALYZE',captureId:'whole',source});await c.send({type:'CAPTURE_DISCARD',captureId:'whole'});gate.resolve();await tick();assert.equal(c.requests.length,0);assert.equal(c.messages.some(m=>m.type==='ANALYSIS_COMPLETE'),false);
});
test('whole download failure does not fall through to tab recording',async()=>{
 const h=harness({downloadError:true});await h.send({type:'FULL_ANALYZE',captureId:'whole',source:{url:'https://r1.googlevideo.com/videoplayback?id=test',videoId:'abcdefghijk',duration:361}});await tick();assert.equal(h.requests.length,0);assert.equal(h.recorders.length,0);assert.equal(h.messages.at(-1).type,'CAPTURE_ERROR');
});
