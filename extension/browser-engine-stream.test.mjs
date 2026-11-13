import test from 'node:test';
import assert from 'node:assert/strict';
import {planChunks,coveredRanges,nextChunk,ownChunk,mergeStreamCues,analyzeFullStreaming,STREAM} from './browser-engine.js';
import {validateDocument} from './core.js';
const SR=16000,videoId='abcdefghijk';

test('minutes are cut at quiet points, analyzed ranges are never planned again, and the playhead comes first',()=>{
  const pcm=new Float32Array(200*SR).fill(.2);pcm.fill(0,Math.round(63*SR),Math.round(63.4*SR));
  const chunks=planChunks(pcm,200);
  assert.ok(chunks[0].end>=63.1&&chunks[0].end<=63.3,`quiet boundary ${chunks[0].end}`);
  assert.equal(chunks[0].start,0);assert.equal(chunks.at(-1).end,200);
  for(let i=1;i<chunks.length;i++)assert.equal(chunks[i].start,chunks[i-1].end);
  assert.ok(chunks.every(c=>c.end-c.start<=STREAM.seconds+STREAM.search+STREAM.min&&c.end-c.start>=STREAM.min));
  const resumed=planChunks(pcm,200,[[0,63.2],[120,130]]);
  assert.deepEqual(resumed.map(c=>[c.start,c.end]),[[63.2,120],[130,200]]);
  assert.deepEqual(planChunks(pcm,200,[[0,199.9]]),[]);
  assert.deepEqual(coveredRanges([[60,120],[0,60.02],[150,140],[130,135],[190,260]],200),[[0,120],[130,135],[190,200]]);
  const pending=[{start:0,end:60},{start:60,end:120},{start:120,end:180}];
  assert.equal(nextChunk(pending,95),1);assert.equal(nextChunk(pending,119.8),2);assert.equal(nextChunk(pending,500),0);assert.equal(nextChunk(pending,null),0);
});
test('a line across a minute boundary is kept once, and continuing music becomes one caption',()=>{
  const speech=(id,start,end,text)=>({id,start,end,text,kind:'speech',scale:1,dbfs:-20,relative_db:0,confidence:null,source:'whisper-browser-wasm',review_required:true});
  const music=(id,start,end)=>({id,start,end,text:'♬ 피아노 연주 ♬',kind:'music',scale:1,dbfs:-20,relative_db:0,confidence:.8,source:'AST-browser-wasm',review_required:true,volume_profile:[{time:start,scale:1,dbfs:-20},{time:end,scale:1,dbfs:-20}]});
  const a=ownChunk({cues:[speech('s1',10,12,'첫 문장'),speech('s2',58.5,60.4,'경계에 걸친'),speech('late',59.9,62,'다음 구간 몫'),music('m1',50,61.5)],metadata:{music_analysis:{m1:{instruments:[]}}}},{start:0,end:60},300);
  assert.deepEqual(a.cues.map(c=>c.id),['s1','s2','m1']);assert.equal(a.cues[2].end,60);assert.equal(a.cues[2].volume_profile.at(-1).time,60);
  const first=mergeStreamCues([],a,{start:0},-20);assert.ok(first.music['m0-m1']);
  const b=ownChunk({cues:[speech('s3',58.6,62,'경계에 걸친 문장입니다'),speech('s4',70,72,'다음 문장'),music('m2',58.5,75)],metadata:{music_analysis:{m2:{instruments:[]}}}},{start:60,end:120},300);
  const merged=mergeStreamCues(first.cues,b,{start:60},-20);
  assert.deepEqual(merged.cues.filter(c=>c.kind==='speech').map(c=>c.text),['첫 문장','경계에 걸친 문장입니다','다음 문장']);
  const tunes=merged.cues.filter(c=>c.kind==='music');assert.equal(tunes.length,1);assert.equal(tunes[0].start,50);assert.equal(tunes[0].end,75);assert.equal(tunes[0].id,'m0-m1');
  assert.ok(new Set(merged.cues.map(c=>c.id)).size===merged.cues.length);
  validateDocument({schema_version:'1.0',video_id:videoId,title:'',duration:300,cues:merged.cues,warnings:[],metadata:{}});
});

function installMocks(duration){
  const originalAudio=Object.getOwnPropertyDescriptor(globalThis,'AudioContext'),originalWorker=Object.getOwnPropertyDescriptor(globalThis,'Worker');
  const state={workers:0,terminated:0,posts:[],spoken:0};
  class AudioMock{async decodeAudioData(){const pcm=new Float32Array(Math.round(duration*SR)).fill(.1);return {duration,length:pcm.length,sampleRate:SR,numberOfChannels:1,getChannelData:()=>pcm};}async close(){}}
  class WorkerMock{
    constructor(){state.workers++;}
    postMessage(message){state.posts.push({keep:message.keep,seconds:message.pcm.byteLength/4/SR});const n=++state.spoken;queueMicrotask(()=>{this.onmessage?.({data:{type:'progress',progress:.5,message:'한국어 대사 분석'}});this.onmessage?.({data:{type:'result',asr:{text:`대사 ${n}`,chunks:[{text:`대사 ${n}번입니다`,timestamp:[3,5]}]},windows:[],runtime:{device:'wasm'}}});});}
    terminate(){state.terminated++;}
  }
  Object.defineProperty(globalThis,'AudioContext',{configurable:true,value:AudioMock});Object.defineProperty(globalThis,'Worker',{configurable:true,value:WorkerMock});
  state.restore=()=>{if(originalAudio)Object.defineProperty(globalThis,'AudioContext',originalAudio);else delete globalThis.AudioContext;if(originalWorker)Object.defineProperty(globalThis,'Worker',originalWorker);else delete globalThis.Worker;};
  return state;
}
test('streaming reuses one worker, starts at the playhead, publishes each minute and resumes only what is missing',async()=>{
  const mocks=installMocks(150);
  try{
    const published=[],progress=[];
    const args={blob:new Blob(['audio']),videoId,title:'영상',expectedDuration:150,options:{event_detection:false},position:async()=>100,onProgress:p=>progress.push(p)};
    const doc=await analyzeFullStreaming({...args,onChunk:d=>published.push(d)});
    assert.equal(mocks.workers,1);assert.equal(mocks.terminated,1);assert.ok(mocks.posts.every(p=>p.keep===true));
    assert.equal(published.length,3);assert.ok(published.slice(0,2).every(d=>d.metadata.partial===true&&d.metadata.progressive===true));
    const firstRange=published[0].metadata.analyzed_ranges;assert.equal(firstRange.length,1);assert.ok(firstRange[0][0]<=100&&firstRange[0][1]>100,'first minute holds the playhead');
    assert.equal(doc.metadata.partial,false);assert.deepEqual(doc.metadata.analyzed_ranges,[[0,150]]);assert.equal(doc.metadata.analysis_scope,'full-video');
    assert.equal(doc.cues.filter(c=>c.kind==='speech').length,3);assert.equal(doc.duration,150);
    assert.ok(progress.every(p=>p.progress>=0&&p.progress<=1));assert.ok(progress.some(p=>/구간/.test(p.message)));
    for(const p of mocks.posts)assert.ok(p.seconds<=STREAM.seconds+STREAM.min+2*STREAM.pad+.01);
    mocks.posts.length=0;
    const resumed=await analyzeFullStreaming({...args,resume:published[0],onChunk:()=>{}});
    assert.equal(mocks.posts.length,2);assert.deepEqual(resumed.metadata.analyzed_ranges,[[0,150]]);assert.equal(resumed.cues.filter(c=>c.kind==='speech').length,3);
    assert.ok(resumed.cues.some(c=>c.text===published[0].cues[0].text));
    mocks.posts.length=0;
    const otherLanguage=await analyzeFullStreaming({...args,options:{event_detection:false,language:'en'},resume:published[0]});assert.equal(mocks.posts.length,3);assert.equal(otherLanguage.metadata.speech_language,'en');
    const controller=new AbortController();controller.abort();await assert.rejects(analyzeFullStreaming({...args,signal:controller.signal}),{name:'AbortError'});
    await assert.rejects(analyzeFullStreaming({...args,expectedDuration:300}),/길이가 영상과 맞지/);
  }finally{mocks.restore();}
});
test('a Haiku failure keeps raw text, and a rejected key stops correcting later minutes',async()=>{
  const mocks=installMocks(130);
  try{
    const doc=await analyzeFullStreaming({blob:new Blob(['audio']),videoId,title:'영상',expectedDuration:130,options:{event_detection:false},correction:{enabled:true,apiKey:'not-a-valid-key'}});
    assert.equal(doc.cues.filter(c=>c.kind==='speech').length,2);assert.ok(doc.cues.every(c=>!c.ai_correction));
    assert.equal(doc.metadata.ai_correction.status,'failed');assert.ok(doc.warnings.some(w=>/AI 자막 보정/.test(w)));
  }finally{mocks.restore();}
});
