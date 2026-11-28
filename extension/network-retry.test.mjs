import test from 'node:test';
import assert from 'node:assert/strict';
import {retryNetwork,isNetworkError,modelDownloadError} from './network-retry.js';
import {boundedDownload} from './full-source.js';

const dropped=()=>new TypeError('Failed to fetch');
const ok=bytes=>new Response(new Uint8Array(bytes),{status:200,headers:{'content-length':String(bytes)}});
const noWait=async()=>{};

test('network errors are recognised; other TypeErrors are not',()=>{
  assert.ok(isNetworkError(dropped()));assert.ok(isNetworkError(new TypeError('network error')));
  assert.ok(!isNetworkError(new TypeError("Cannot read properties of undefined (reading 'x')")));
  assert.ok(!isNetworkError(new Error('Failed to fetch')));
});

test('a dropped download is retried, then reported in Korean with what was being received',async()=>{
  let calls=0;
  const flaky=async()=>{calls++;if(calls<3)throw dropped();return ok(10);};
  assert.equal((await boundedDownload('https://x',{fetcher:flaky,sleep:noWait})).size,10);assert.equal(calls,3);
  calls=0;const down=async()=>{calls++;throw dropped();};
  await assert.rejects(boundedDownload('https://x',{fetcher:down,sleep:noWait,what:'자막을'}),e=>e.message==='인터넷 연결이 끊겨 YouTube에서 자막을 받지 못했습니다. 연결을 확인하고 다시 시도해 주세요.');
  assert.equal(calls,3);
  calls=0;const http=async()=>{calls++;return new Response('',{status:403});};
  await assert.rejects(boundedDownload('https://x',{fetcher:http,sleep:noWait}),/\(403\)/);assert.equal(calls,1);
  const slow=async()=>{throw new DOMException('The operation was aborted due to timeout','TimeoutError');};
  await assert.rejects(boundedDownload('https://x',{fetcher:slow,sleep:noWait}),/YouTube 응답이 늦어 영상 소리를 받지 못했습니다/);
  const controller=new AbortController();controller.abort();calls=0;
  await assert.rejects(boundedDownload('https://x',{fetcher:down,signal:controller.signal,sleep:noWait}),e=>e.name==='TypeError');assert.equal(calls,1);
});

test('model loads are retried and end with a Korean network error marked as network',async()=>{
  let calls=0;
  await assert.rejects(retryNetwork(async()=>{calls++;throw dropped();},{sleep:noWait,giveUp:modelDownloadError}),e=>e.network===true&&/AI 모델 파일을 내려받지 못했습니다/.test(e.message));
  assert.equal(calls,3);
  calls=0;await assert.rejects(retryNetwork(async()=>{calls++;throw new Error('Could not locate file');},{sleep:noWait}),/Could not locate/);assert.equal(calls,1);
});
