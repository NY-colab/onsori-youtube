import test from 'node:test';
import assert from 'node:assert/strict';
import {webgpuReady,engineProfiles,maxNewTokens} from './browser-engine-device.js';
import {MODEL_CONFIG} from './model-config.js';
import {assembleDocument} from './browser-engine-signal.js';
import {gridWindows,speechWindows,mergeAsrWindows} from './browser-engine-asr.js';

const gpu=(features,fail=false)=>({requestAdapter:async options=>{assert.equal(options.powerPreference,'high-performance');if(fail)throw new Error('lost');return features?{features:new Set(features)}:null;}});

test('WebGPU is used only with an adapter that exposes shader-f16',async()=>{
  assert.equal(await webgpuReady(gpu(['shader-f16'])),true);
  assert.equal(await webgpuReady(gpu([])),false);
  assert.equal(await webgpuReady(gpu(null)),false);
  assert.equal(await webgpuReady(gpu(['shader-f16'],true)),false);
  assert.equal(await webgpuReady(undefined),false);
});

test('GPU profile falls back to the unchanged CPU models, and wasm can be forced',()=>{
  const [first,second]=engineProfiles(true);
  assert.equal(first.device,'webgpu');assert.equal(first.whisper,MODEL_CONFIG.gpu.whisper);assert.equal(first.events,MODEL_CONFIG.gpu.events);
  assert.deepEqual(second,{device:'wasm',whisper:MODEL_CONFIG.whisper,events:MODEL_CONFIG.events,asrWindow:{seconds:8,step:5}});
  assert.deepEqual(first.asrWindow,{seconds:14,step:11,gate:'speech'});
  assert.equal(MODEL_CONFIG.whisper.dtype,'q8');assert.equal(MODEL_CONFIG.events.dtype,'q8');
  assert.deepEqual(engineProfiles(false),[second]);
  assert.deepEqual(engineProfiles(true,'wasm'),[second]);
  for(const model of [MODEL_CONFIG.gpu.whisper,MODEL_CONFIG.gpu.events])assert.match(model.revision,/^[0-9a-f]{40}$/);
});

test('generation cap fits dense speech in a window and stays under the Whisper limit',()=>{
  assert.equal(maxNewTokens(8),136);assert.equal(maxNewTokens(28),436);assert.equal(maxNewTokens(60),440);
});

test('document records the device and models that actually ran',()=>{
  const pcm=new Float32Array(16000*3).fill(.1),asr={text:'안녕하세요',chunks:[{text:'안녕하세요',timestamp:[0,2]}]};
  const gpuDoc=assembleDocument({pcm,asr,runtime:{device:'webgpu',whisper:MODEL_CONFIG.gpu.whisper,events:MODEL_CONFIG.gpu.events,gpu_fallback:null},videoId:'abcdefghijk',options:{event_detection:false}});
  assert.equal(gpuDoc.metadata.engine,'browser-webgpu');assert.equal(gpuDoc.metadata.models.whisper.id,MODEL_CONFIG.gpu.whisper.id);
  assert.equal(gpuDoc.cues[0].source,'whisper-browser-webgpu');
  const fallbackDoc=assembleDocument({pcm,asr,runtime:{device:'wasm',whisper:MODEL_CONFIG.whisper,events:MODEL_CONFIG.events,gpu_fallback:'lost'},videoId:'abcdefghijk',options:{event_detection:false}});
  assert.equal(fallbackDoc.metadata.engine,'browser-wasm');assert.equal(fallbackDoc.metadata.models.gpu_fallback,'lost');assert.equal(fallbackDoc.cues[0].source,'whisper-browser-wasm');
  assert.equal(assembleDocument({pcm,asr,videoId:'abcdefghijk',options:{event_detection:false}}).metadata.engine,'browser-wasm');
});

const ast=(start,end,speech,music=.9)=>({start,end,labels:[{label:'Speech',score:speech},{label:'Music',score:music}]});

test('CPU grid keeps the 8 s / 5 s windows; GPU Whisper hears only padded AST speech regions',()=>{
  assert.deepEqual(gridWindows(20,{seconds:8,step:5}),[{start:0,end:8},{start:5,end:13},{start:10,end:18},{start:15,end:20}]);
  const events=[ast(0,2,.9),ast(2,4,.5),ast(4,6,.01),ast(6,8,.02),ast(8,10,.3),ast(20,22,.6),ast(22,24,.6)];
  assert.deepEqual(speechWindows(events,40,{seconds:14,step:11}),[{start:0,end:4.5},{start:7.5,end:10.5},{start:19.5,end:24.5}]);
  assert.deepEqual(speechWindows(Array.from({length:15},(_,i)=>ast(i*2,i*2+2,.8)),30,{seconds:14,step:11}),[{start:0,end:14},{start:11,end:25},{start:22,end:30}]);
  assert.deepEqual(speechWindows([ast(0,2,.1)],10,{seconds:14,step:11}),[]);
});

const win=(start,end,...chunks)=>({start,end,output:{text:chunks.map(c=>c[0]).join(' '),chunks:chunks.map(([text,a,b])=>({text,timestamp:[a,b]}))}});

test('boundary fragments and verbatim repeats are merged; short genuine repeats stay',()=>{
  const fragment=mergeAsrWindows([win(0,14,['처음 인사입니다',1,3],['어깨도',12,14]),win(11,25,['어깨도 편하세요?',1,3.8])]).chunks.map(c=>c.text);
  assert.deepEqual(fragment,['처음 인사입니다','어깨도 편하세요?']);
  const repeat=mergeAsrWindows([win(0,14,['솜 대신 고운 오리털이 들어 있어요',2,6],['솜 대신 고운 오리털이 들어 있어요',6,14])]).chunks.map(c=>c.text);
  assert.deepEqual(repeat,['솜 대신 고운 오리털이 들어 있어요']);
  const genuine=mergeAsrWindows([win(0,8,['그럼요',1,2],['그럼요',2,3])]).chunks.map(c=>c.text);
  assert.deepEqual(genuine,['그럼요','그럼요']);
});

test('an over-long segment is bounded to the last AST speech run inside it',()=>{
  const pcm=new Float32Array(16000*30).fill(.1),asr={text:'이 천은 어디서 짠 것이냐',chunks:[{text:'이 천은 어디서 짠 것이냐',timestamp:[2,24]}]};
  const windows=Array.from({length:15},(_,i)=>ast(i*2,i*2+2,i>=9&&i<=11?.8:.01,.3));
  const d=assembleDocument({pcm,asr,windows,videoId:'abcdefghijk'});
  const cue=d.cues.find(c=>c.kind==='speech');
  assert.deepEqual([cue.start,cue.end],[18,24]);
  assert.deepEqual(d.metadata.speech_timing.retimed,[[2,24,18,24]]);
  const short=assembleDocument({pcm,asr:{text:'네',chunks:[{text:'네',timestamp:[18,20]}]},windows,videoId:'abcdefghijk'});
  assert.deepEqual(short.metadata.speech_timing.retimed,[]);
});

test('speech segments without any letter or digit are not shown',()=>{
  const pcm=new Float32Array(16000*4).fill(.1);
  const d=assembleDocument({pcm,asr:{text:'- – 네',chunks:[{text:' - ',timestamp:[0,1]},{text:'–',timestamp:[1,2]},{text:'네',timestamp:[2,3]}]},videoId:'abcdefghijk',options:{event_detection:false}});
  assert.deepEqual(d.cues.map(c=>c.text),['네']);
});
