import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const code=(await readFile(new URL('./source-bridge-entry.js',import.meta.url),'utf8')).replace(/^import[^\n]+\n/gm,'');
test('page lookup is extension-only, same-video, anonymous and cancellable',async()=>{
  const listeners=[],calls=[];let complete;
  const location={href:'https://www.youtube.com/watch?v=abcdefghijk',origin:'https://www.youtube.com',pathname:'/watch'};
  vm.runInNewContext(code,{URL,AbortController,location,chrome:{runtime:{id:'ours',onMessage:{addListener:f=>listeners.push(f)}}},lookupAudio(source,options){calls.push({source,options});return new Promise(resolve=>complete=resolve);}});
  const request={type:'LOOKUP_FULL_AUDIO',captureId:'one',source:{videoId:'abcdefghijk',duration:361}},sender={id:'ours'};
  let result;
  listeners[0](request,{id:'other'},r=>result=r);assert.equal(calls.length,0);
  listeners[0]({...request,source:{videoId:'zzzzzzzzzzz'}},sender,r=>result=r);assert.equal(result.ok,false);assert.equal(calls.length,0);
  assert.equal(listeners[0](request,sender,r=>result=r),true);assert.equal(calls[0].options.origin,location.origin);
  listeners[0]({type:'CANCEL_AUDIO_LOOKUP',captureId:'other'},sender,()=>{});assert.equal(calls[0].options.signal.aborted,false);
  listeners[0]({type:'CANCEL_AUDIO_LOOKUP',captureId:'one'},sender,()=>{});assert.equal(calls[0].options.signal.aborted,true);
  complete({videoId:'abcdefghijk'});await new Promise(r=>setImmediate(r));assert.equal(result.ok,false);
  listeners[0]({...request,captureId:'two'},sender,r=>result=r);complete({videoId:'abcdefghijk'});await new Promise(r=>setImmediate(r));assert.equal(result.ok,true);
});
