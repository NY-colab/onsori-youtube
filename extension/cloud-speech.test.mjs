import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeWav,cloudChunks,transcribeInCloud,CloudSpeechError} from './cloud-speech.js';
import {CLOUD} from './cloud-config.js';

const pcm=new Float32Array(16000*2).fill(.25);
const done=(cues,meta={})=>({id:'job1',status:'done',result:{cues,metadata:{analysis_scope:'speech-only',synthetic:false,model:'nemotron',...meta}}});
const json=(body,status=200)=>new Response(JSON.stringify(body),{status});

function server(steps){
  const calls=[];
  const fetchImpl=async(url,init={})=>{
    calls.push({url,method:init.method||'GET',auth:init.headers?.Authorization,key:init.headers?.['Idempotency-Key'],body:init.body});
    const next=steps.shift();assert.ok(next,'unexpected request '+url);return typeof next==='function'?next(url,init):next;
  };
  return {calls,fetchImpl};
}
const cloud=(keys=['osi_first'])=>{const asked=[];return {asked,enabled:true,key:async renew=>{asked.push(renew);return renew?keys[1]:keys[0];}};};

test('WAV upload is 16 kHz mono PCM16 with clamped samples',()=>{
  const view=new DataView(encodeWav(new Float32Array([0,1,-1,2,-2])));
  assert.equal(String.fromCharCode(...new Uint8Array(view.buffer,0,4)),'RIFF');
  assert.equal(view.getUint16(22,true),1);assert.equal(view.getUint32(24,true),16000);assert.equal(view.getUint16(34,true),16);
  assert.deepEqual([0,1,2,3,4].map(i=>view.getInt16(44+i*2,true)),[0,32767,-32768,32767,-32768]);
});

test('a finished job becomes speech chunks; synthetic or malformed results are refused',()=>{
  const asr=cloudChunks(done([{kind:'speech',start:.5,end:1.5,text:' 안녕하세요 '}]),2);
  assert.deepEqual(asr.chunks,[{text:'안녕하세요',timestamp:[.5,1.5]}]);assert.equal(asr.diagnostics.synthetic,false);
  assert.throws(()=>cloudChunks(done([{kind:'speech',start:0,end:1,text:'x'}],{synthetic:true}),2),CloudSpeechError);
  assert.equal(cloudChunks(done([{kind:'speech',start:0,end:1,text:'x'}],{synthetic:true}),2,{allowSynthetic:true}).diagnostics.synthetic,true);
  for(const cue of [{kind:'music',start:0,end:1,text:'x'},{kind:'speech',start:1,end:1,text:'x'},{kind:'speech',start:0,end:9,text:'x'},{kind:'speech',start:0,end:1,text:''}])
    assert.throws(()=>cloudChunks(done([cue]),2),CloudSpeechError);
});

test('upload, poll and result use the install key and one idempotency key',async()=>{
  const {calls,fetchImpl}=server([json({id:'job1',status:'queued'},202),json({id:'job1',status:'running'}),json(done([{kind:'speech',start:0,end:1,text:'대사'}]))]);
  const waits=[];const asr=await transcribeInCloud(pcm,{videoId:'abcdefghijk',title:'영상',cloud:cloud(),fetchImpl,sleep:async s=>waits.push(s)});
  assert.equal(asr.chunks[0].text,'대사');
  assert.deepEqual(calls.map(c=>[c.method,c.url]),[['POST',CLOUD.origin+'/v1/jobs'],['GET',CLOUD.origin+'/v1/jobs/job1'],['GET',CLOUD.origin+'/v1/jobs/job1']]);
  assert.ok(calls.every(c=>c.auth==='Bearer osi_first'));assert.match(calls[0].key,/^[0-9a-f-]{36}$/);
  assert.equal(calls[0].body.get('consent'),'true');assert.equal(calls[0].body.get('video_id'),'abcdefghijk');assert.equal(calls[0].body.get('file').size,44+pcm.length*2);
  assert.deepEqual(waits,[CLOUD.pollSeconds,CLOUD.pollSeconds]);
});

test('an unknown key is renewed once and the same upload retried',async()=>{
  const c=cloud(['osi_old','osi_new']);
  const {calls,fetchImpl}=server([json({detail:'unauthorized'},401),json(done([{kind:'speech',start:0,end:1,text:'대사'}]),200)]);
  await transcribeInCloud(pcm,{cloud:c,fetchImpl,sleep:async()=>{}});
  assert.deepEqual(c.asked,[false,true]);assert.equal(calls[1].auth,'Bearer osi_new');assert.equal(calls[0].key,calls[1].key);
});

test('daily limits, disabled servers and network failures explain why the device takes over',async()=>{
  for(const [response,message] of [[json({detail:'install_daily_limit'},429),'오늘 클라우드 사용량을 다 썼습니다.'],[json({detail:'daily_audio_limit'},429),'오늘 클라우드 서버 전체 사용량을 다 썼습니다.'],[json({detail:'provider_disabled'},503),'클라우드 대사 분석이 꺼져 있습니다.'],[()=>{throw new TypeError('offline');},'클라우드 서버에 연결하지 못했습니다.']]){
    const {fetchImpl}=server([response]);
    await assert.rejects(transcribeInCloud(pcm,{cloud:cloud(),fetchImpl,sleep:async()=>{}}),error=>error.name==='CloudSpeechError'&&error.message===message);
  }
  const {fetchImpl}=server([json({id:'job1',status:'queued'},202),json({id:'job1',status:'error',error:'provider_timeout_billing_uncertain_no_retry'})]);
  await assert.rejects(transcribeInCloud(pcm,{cloud:cloud(),fetchImpl,sleep:async()=>{}}),CloudSpeechError);
});

test('cancelling while the server works deletes the job',async()=>{
  const controller=new AbortController();
  const {calls,fetchImpl}=server([json({id:'job1',status:'queued'},202),json({},200)]);
  const sleep=()=>new Promise((_,reject)=>{controller.abort();reject(new DOMException('분석을 취소했습니다.','AbortError'));});
  await assert.rejects(transcribeInCloud(pcm,{cloud:cloud(),fetchImpl,sleep,signal:controller.signal}),error=>error.name==='AbortError');
  assert.deepEqual(calls.map(c=>[c.method,c.url]),[['POST',CLOUD.origin+'/v1/jobs'],['DELETE',CLOUD.origin+'/v1/jobs/job1']]);
});
