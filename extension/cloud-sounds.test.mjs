import test from 'node:test';
import assert from 'node:assert/strict';
import {soundPieces,describeSoundsInCloud,CloudSoundError,SOUND_STOP_CODES} from './cloud-sounds.js';
import {assembleDocument} from './browser-engine-signal.js';
import {analyzeFullStreaming} from './browser-engine.js';
import {CLOUD} from './cloud-config.js';
const SR=16000;

test('a minute is sent as pieces of at most 30 s',()=>{
  assert.deepEqual(soundPieces(0,60),[[0,30],[30,60]]);
  assert.equal(soundPieces(60,121.5).length,3);assert.ok(soundPieces(60,121.5).every(([a,b])=>b-a<=30));
  assert.deepEqual(soundPieces(300,315),[[300,315]]);
});

test('pieces go to the server with consent and come back in video time; failures carry the server code',async()=>{
  const calls=[],cloud={key:async()=> 'osi_key',allowSynthetic:false};
  const fetchImpl=async(url,init)=>{calls.push({url,init});const seconds=(await init.body.arrayBuffer()).byteLength/2/SR;
    return new Response(JSON.stringify({model:'gemini-4-hydrogen',events:[{start:1,end:seconds+5,kind:'music',text:'잔잔한 피아노 연주'},{start:2,end:3,kind:'speech',text:'대사'},{start:4,end:4.5,kind:'sound',text:' 문  닫히는 소리 '}]}),{status:200});};
  const pcm=new Float32Array(90*SR);
  const result=await describeSoundsInCloud(pcm,{from:30,to:90,cloud,fetchImpl});
  assert.equal(calls.length,2);assert.ok(calls.every(c=>c.url===`${CLOUD.origin}/v1/sounds`&&c.init.headers['X-OnSori-Consent']==='sounds'&&c.init.headers.Authorization==='Bearer osi_key'&&c.init.credentials==='omit'));
  assert.deepEqual(result.events.map(e=>[e.kind,e.start,e.end,e.text]),[['music',31,60,'잔잔한 피아노 연주'],['sound',34,34.5,'문 닫히는 소리'],['music',61,90,'잔잔한 피아노 연주'],['sound',64,64.5,'문 닫히는 소리']]);
  assert.equal(result.model,'gemini-4-hydrogen');
  const quota=async()=>new Response(JSON.stringify({detail:'sound_quota'}),{status:429});
  await assert.rejects(describeSoundsInCloud(pcm,{from:0,to:30,cloud,fetchImpl:quota}),e=>e instanceof CloudSoundError&&e.code==='sound_quota'&&/한도/.test(e.message)&&SOUND_STOP_CODES.includes(e.code));
  const synthetic=async()=>new Response(JSON.stringify({events:[],model:'mock',synthetic:true}),{status:200});
  await assert.rejects(describeSoundsInCloud(pcm,{from:0,to:30,cloud,fetchImpl:synthetic}),{code:'synthetic_result'});
  let renewed=0;const keyed={key:async renew=>{if(renew)renewed++;return renew?'osi_new':'osi_old';}};
  const expired=async(url,init)=>new Response(JSON.stringify(init.headers.Authorization==='Bearer osi_new'?{events:[]}:{detail:'unauthorized'}),{status:init.headers.Authorization==='Bearer osi_new'?200:401});
  assert.deepEqual((await describeSoundsInCloud(pcm,{from:0,to:20,cloud:keyed,fetchImpl:expired})).events,[]);assert.equal(renewed,1);
});

test('Hydrogen music replaces AST music; AST effects take Hydrogen names; Hydrogen-only effects are dropped',()=>{
  const pcm=new Float32Array(10*SR).fill(.1);
  const windows=[{start:0,end:2,labels:[{label:'Music',score:.6},{label:'Speech',score:.01}]},{start:4,end:6,labels:[{label:'Knock',score:.5},{label:'Speech',score:.01}]}];
  const plain=assembleDocument({pcm,asr:null,windows,videoId:'abcdefghijk',options:{}});
  assert.ok(plain.cues.some(c=>c.kind==='music'&&c.source.startsWith('AST')));assert.ok(plain.cues.some(c=>c.kind==='sound'&&/똑똑/.test(c.text)));
  const cloudSounds=[{kind:'music',start:0,end:3,text:'잔잔한 피아노 연주'},{kind:'sound',start:4.5,end:5,text:'문 두드리는 소리'},{kind:'sound',start:8,end:9,text:'관중 환호'}];
  const doc=assembleDocument({pcm,asr:null,windows,videoId:'abcdefghijk',options:{},cloudSounds});
  const music=doc.cues.filter(c=>c.kind==='music'),sound=doc.cues.filter(c=>c.kind==='sound');
  assert.deepEqual(music.map(c=>[c.text,c.source,c.start,c.end]),[['♬ 잔잔한 피아노 연주 ♬','gemini-4-hydrogen',0,3]]);
  assert.ok(Number.isFinite(music[0].scale)&&Array.isArray(music[0].volume_profile));
  assert.equal(sound.length,1);assert.equal(sound[0].text,'♪ 문 두드리는 소리 ♪');assert.match(sound[0].source,/^AST-browser-.*\+gemini-4-hydrogen$/);
  assert.ok(!doc.cues.some(c=>/관중/.test(c.text)));
});

test('once the Gemini budget is spent, later minutes keep the on-device result without asking again',async()=>{
  const originalAudio=Object.getOwnPropertyDescriptor(globalThis,'AudioContext'),originalWorker=Object.getOwnPropertyDescriptor(globalThis,'Worker'),originalFetch=globalThis.fetch;
  class AudioMock{async decodeAudioData(){const pcm=new Float32Array(130*SR).fill(.1);return {duration:130,length:pcm.length,sampleRate:SR,numberOfChannels:1,getChannelData:()=>pcm};}async close(){}}
  class WorkerMock{postMessage(){queueMicrotask(()=>this.onmessage?.({data:{type:'result',asr:{text:'',chunks:[]},windows:[{start:0,end:2,labels:[{label:'Music',score:.6}]}],runtime:{device:'wasm'}}}));}terminate(){}}
  const calls=[];
  Object.defineProperty(globalThis,'AudioContext',{configurable:true,value:AudioMock});Object.defineProperty(globalThis,'Worker',{configurable:true,value:WorkerMock});
  globalThis.fetch=async url=>{calls.push(url);return new Response(JSON.stringify({detail:'sound_quota'}),{status:429});};
  try{
    const doc=await analyzeFullStreaming({blob:new Blob(['audio']),videoId:'abcdefghijk',title:'영상',expectedDuration:130,options:{},captions:{kind:'auto',lines:[{start:1,end:3,text:'대사'}]},cloud:{enabled:true,speech:false,sounds:true,key:async()=>'osi_key'}});
    assert.ok(calls.length>=1&&calls.length<=3,'only the first minute was sent');
    assert.ok(doc.warnings.some(w=>/Gemini 사용 한도/.test(w)&&/이 기기에서/.test(w)));
    assert.ok(doc.cues.some(c=>c.kind==='music'&&c.source.startsWith('AST')),'AST music is kept');
    assert.deepEqual(doc.metadata.stream_chunks.map(c=>c.sounds),doc.metadata.stream_chunks.map(()=> 'device'));
  }finally{
    globalThis.fetch=originalFetch;
    if(originalAudio)Object.defineProperty(globalThis,'AudioContext',originalAudio);else delete globalThis.AudioContext;
    if(originalWorker)Object.defineProperty(globalThis,'Worker',originalWorker);else delete globalThis.Worker;
  }
});

test('speaker turns: known names go up, who-speaks-when comes back, lines take the overlapping speaker',async()=>{
  const calls=[],cloud={key:async()=>'osi_key',allowSynthetic:false};
  const fetchImpl=async(url,init)=>{calls.push(init.headers);
    return new Response(JSON.stringify({model:'gemini-4-hydrogen',events:[],speech:[{start:0,end:2,speaker:'가게 주인(남)'},{start:2.5,end:4,speaker:' 조선  손님(여) '},{start:5,end:4,speaker:'거꾸로'},{start:6,end:7,speaker:''}]}),{status:200});};
  const pcm=new Float32Array(30*SR);
  const result=await describeSoundsInCloud(pcm,{from:0,to:30,cloud,fetchImpl,speakers:['가게 주인(남)']});
  assert.deepEqual(JSON.parse(decodeURIComponent(calls[0]['X-OnSori-Speakers'])),['가게 주인(남)']);
  assert.deepEqual(result.speech,[{start:0,end:2,speaker:'가게 주인(남)'},{start:2.5,end:4,speaker:'조선 손님(여)'}]);
  await describeSoundsInCloud(pcm,{from:0,to:30,cloud,fetchImpl});assert.equal(calls[1]['X-OnSori-Speakers'],undefined);
  const old=async()=>new Response(JSON.stringify({events:[]}),{status:200});
  assert.deepEqual((await describeSoundsInCloud(pcm,{from:0,to:30,cloud,fetchImpl:old})).speech,[]);
  const lines=[{start:10,end:12,text:'어서 오세요'},{start:12.5,end:14,text:'이건 무엇이오'},{start:14.2,end:14.5,text:'네'},{start:20,end:22,text:'혼잣말'}];
  const doc=assembleDocument({pcm:new Float32Array(30*SR).fill(.1),asr:null,windows:[],videoId:'abcdefghijk',startTime:0,options:{},captions:{kind:'auto',lines},
    cloudSpeakers:[{start:10.1,end:12,speaker:'가게 주인(남)'},{start:12.4,end:14.1,speaker:'조선 손님(여)'},{start:21.9,end:22.5,speaker:'조선 손님(여)'}]});
  assert.deepEqual(doc.cues.filter(c=>c.kind==='speech').map(c=>c.speaker??null),['가게 주인(남)','조선 손님(여)',null,null]);
});

test('with no names known yet, the first piece goes alone and the others carry its names',async()=>{
  const order=[],cloud={key:async()=>'osi_key',allowSynthetic:false};let pending=0,maxPending=0;
  const fetchImpl=async(url,init)=>{pending++;maxPending=Math.max(maxPending,pending);const sent=init.headers['X-OnSori-Speakers'];order.push(sent?JSON.parse(decodeURIComponent(sent)):[]);
    await new Promise(r=>setTimeout(r,5));pending--;return new Response(JSON.stringify({events:[],speech:[{start:1,end:2,speaker:'가게 주인(남)'}]}),{status:200});};
  const pcm=new Float32Array(90*SR);
  await describeSoundsInCloud(pcm,{from:0,to:90,cloud,fetchImpl});
  assert.deepEqual(order,[[],['가게 주인(남)'],['가게 주인(남)']]);assert.equal(maxPending,2);
  order.length=0;maxPending=0;
  await describeSoundsInCloud(pcm,{from:0,to:90,cloud,fetchImpl,speakers:['조선 손님(여)']});
  assert.deepEqual(order,[['조선 손님(여)'],['조선 손님(여)'],['조선 손님(여)']]);assert.equal(maxPending,3);
});
