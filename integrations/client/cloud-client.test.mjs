import test from 'node:test';
import assert from 'node:assert/strict';
import {createCloudClient, completedDocument} from './cloud-client.mjs';

const token = 'test-only-operator-token-'.repeat(2);
const fixture = () => ({status:'done', result:{schema_version:'1.0', video_id:'-wbEQJ_ZXyk', title:'Synthetic only', duration:1,
  cues:[{id:'s1', start:0, end:1, text:'SYNTHETIC TEST', kind:'speech', scale:1, source:'mock-synthetic', review_required:true}],
  metadata:{provider:'mock', synthetic:true, analysis_scope:'speech-only', review_required:true}}});
const submitOptions = () => ({audio:new Blob([new Uint8Array(64)]), consent:true, key:'test-key-12345', allowMock:true});

test('rejects credentials in URL, insecure remote and non-origin URL', () => {
  for (const baseUrl of ['http://remote.example','https://u:p@example.org','https://example.org/api','https://example.org/?token=secret']) {
    assert.throws(() => createCloudClient({baseUrl, token}));
  }
  assert.throws(() => createCloudClient({baseUrl:'http://127.0.0.1:8000', token}));
  assert.doesNotThrow(() => createCloudClient({baseUrl:'http://127.0.0.1:8000', token, allowLoopback:true}));
});

test('requires consent before any network request', async () => {
  let calls=0;
  const client=createCloudClient({baseUrl:'https://gateway.example', token, fetchImpl:async()=>{calls++;}});
  await assert.rejects(client.submit({...submitOptions(),consent:false})); assert.equal(calls,0);
});

test('requires separate paid selection even when server enables provider', async () => {
  let calls=0;
  const client=createCloudClient({baseUrl:'https://gateway.example', token, fetchImpl:async()=>{calls++;return Response.json({enabled:true,provider:'deepinfra'});}});
  await assert.rejects(client.submit(submitOptions()),/명시적으로/); assert.equal(calls,1);
});

test('never retries ambiguous POST, preserves key and prevents redirects', async () => {
  const calls=[];
  const client=createCloudClient({baseUrl:'https://gateway.example', token, fetchImpl:async(url,options)=>{
    calls.push({url, options}); if (options.method==='POST') throw new Error('sensitive provider text');
    return Response.json({enabled:true,provider:'mock'});
  }});
  await assert.rejects(client.submit(submitOptions()),/자동 재제출하지 않았습니다/);
  assert.equal(calls.length,2); assert.equal(calls[1].options.headers['Idempotency-Key'],'test-key-12345');
  assert.equal(calls[1].options.redirect,'error'); assert.equal(calls[1].options.body.get('consent'),'true');
});

test('HTTP errors never surface upstream sensitive body', async () => {
  const client=createCloudClient({baseUrl:'https://gateway.example', token, fetchImpl:async()=>new Response('SECRET AUDIO',{status:401})});
  await assert.rejects(client.status(), error=>error.message.includes('401')&&!error.message.includes('SECRET'));
});

test('completion gate rejects unfinished, mismatched or synthetic results', () => {
  const job=fixture();
  assert.throws(()=>completedDocument({...job,status:'running'}));
  assert.throws(()=>completedDocument(job,{videoId:'-wbEQJ_ZXyk'}),/모의 결과/);
  assert.throws(()=>completedDocument(job,{videoId:'otherVideo1',allowMock:true}),/일치하지/);
  assert.equal(completedDocument(job,{videoId:'-wbEQJ_ZXyk',allowMock:true}).cues.length,1);
});

test('does not accept fabricated loudness or invalid timings', () => {
  const job=fixture(); job.result.cues[0].scale=1.5;
  assert.throws(()=>completedDocument(job,{videoId:'-wbEQJ_ZXyk',allowMock:true}),/규격/);
  job.result.cues[0].scale=1; job.result.cues[0].end=10;
  assert.throws(()=>completedDocument(job,{videoId:'-wbEQJ_ZXyk',allowMock:true}));
});

test('rejects path injection in status/delete before networking', async () => {
  const client=createCloudClient({baseUrl:'https://gateway.example', token, fetchImpl:()=>{throw new Error('should not fetch');}});
  assert.throws(()=>client.get('../metrics')); assert.throws(()=>client.cancel('abc?token=leak'));
});
