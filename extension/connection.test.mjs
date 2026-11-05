import test from 'node:test';
import assert from 'node:assert/strict';
import {extensionConnected,contextLost,createSafeSend,disconnectMessage} from './connection.js';

const invalidated=()=>{throw new Error('Extension context invalidated.');};

test('a reloaded extension is detected without touching other APIs',()=>{
  assert.equal(extensionConnected(()=>({id:'abc'})),true);
  assert.equal(extensionConnected(()=>({})),false);
  assert.equal(extensionConnected(()=>undefined),false);
  assert.equal(extensionConnected(invalidated),false);
  assert.equal(contextLost(new Error('Extension context invalidated.'),()=>({id:'abc'})),true);
  assert.equal(contextLost(new Error('Could not establish connection.'),()=>({id:'abc'})),false);
});

test('safe send catches the synchronous invalidation error and reports it once per call',async()=>{
  let lost=0;
  const runtime={id:'abc',sendMessage:invalidated};
  const send=createSafeSend(()=>runtime,()=>lost++);
  assert.equal(await send({type:'AUTO_START'}),null);
  assert.equal(lost,1);
});

test('safe send reports a runtime whose id disappeared before calling it',async()=>{
  let lost=0,called=0;
  const send=createSafeSend(()=>({sendMessage(){called++;}}),()=>lost++);
  assert.equal(await send({type:'VIDEO_NAVIGATED'}),null);
  assert.equal(called,0);assert.equal(lost,1);
});

test('ordinary delivery failures resolve null without declaring the connection lost',async()=>{
  let lost=0;
  const ok=createSafeSend(()=>({id:'abc',sendMessage:async payload=>({ok:true,type:payload.type})}),()=>lost++);
  assert.deepEqual(await ok({type:'CANCEL'}),{ok:true,type:'CANCEL'});
  const noReceiver=createSafeSend(()=>({id:'abc',sendMessage:async()=>{throw new Error('Could not establish connection. Receiving end does not exist.');}}),()=>lost++);
  assert.equal(await noReceiver({type:'CANCEL'}),null);
  assert.equal(lost,0);
});

test('the notice says whether an analysis was interrupted and how to recover',()=>{
  assert.match(disconnectMessage(true),/진행 중이던 분석이 멈췄습니다/);
  assert.match(disconnectMessage(true),/다시 시작/);
  assert.doesNotMatch(disconnectMessage(false),/분석/);
  for(const busy of [true,false])assert.match(disconnectMessage(busy),/이 탭을 새로고침/);
});
