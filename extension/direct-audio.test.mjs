import test from 'node:test';
import assert from 'node:assert/strict';
import {lookupAudio,downloadAudio,acquireAudio} from './direct-audio.js';
import {selectFullSource} from './full-source.js';
const id='abcdefghijk',url='https://r1.googlevideo.com/videoplayback?id=audio';
const source={videoId:id,title:'test',duration:361};
const response=()=>({playabilityStatus:{status:'OK'},videoDetails:{videoId:id,title:'test',lengthSeconds:'361'},streamingData:{adaptiveFormats:[{url,mimeType:'audio/mp4',contentLength:'4',bitrate:128000}]}});
const json=v=>new Response(JSON.stringify(v));
test('missing page URLs pass metadata to direct lookup without requiring recording',()=>{
  const selected=selectFullSource({...source,formats:[]},id,'ko',{allowLookup:true});
  assert.equal(selected.url,null);assert.equal(selected.duration,361);
  assert.throws(()=>selectFullSource({...source,duration:1201},id,'ko',{allowLookup:true}),/20분/);
});
test('anonymous player lookup uses pinned client and validates video and duration',async()=>{
  const calls=[];let data=response();
  const fetcher=async(u,o)=>{calls.push({u,o});return u.includes('/watch?')?new Response('"VISITOR_DATA":"anonymous-context"'):json(data);};
  const resolved=await lookupAudio(source,{fetcher});
  assert.equal(resolved.bytes,4);assert.equal(resolved.transport,'youtube-player-visionos');
  assert.equal(calls[1].o.credentials,'omit');assert.equal(calls[1].o.redirect,'error');
  assert.equal(calls[1].o.headers['X-Goog-Visitor-Id'],'anonymous-context');
  assert.equal(JSON.parse(calls[1].o.body).context.client.clientName,'VISIONOS');
  data=response();data.videoDetails.videoId='zzzzzzzzzzz';await assert.rejects(()=>lookupAudio(source,{fetcher}),/영상 정보/);
  data=response();data.videoDetails.lengthSeconds='10';await assert.rejects(()=>lookupAudio(source,{fetcher}),/길이/);
  data={playabilityStatus:{status:'LOGIN_REQUIRED'}};await assert.rejects(()=>lookupAudio(source,{fetcher}),/LOGIN_REQUIRED/);
});
test('download assembles exact byte ranges, rejects short content and foreign hosts',async()=>{
  const bytes=new Uint8Array(1048581);bytes[1048576]=77;const calls=[];
  const blob=await downloadAudio({...source,url,bytes:bytes.length,mimeType:'audio/mp4'},{fetcher:async(u,o)=>{
    const [a,b]=new URL(u).searchParams.get('range').split('-').map(Number);calls.push([a,b]);assert.equal(o.credentials,'omit');return new Response(bytes.slice(a,b+1));
  }});
  assert.deepEqual(calls,[[0,1048575],[1048576,1048580]]);assert.equal(blob.size,bytes.length);assert.equal(new Uint8Array(await blob.arrayBuffer())[1048576],77);
  await assert.rejects(()=>downloadAudio({...source,url,bytes:4},{fetcher:async()=>new Response('ab')}),/누락/);
  await assert.rejects(()=>downloadAudio({...source,url:'https://evil.test/a'}),/주소/);
});
test('expired page URL retries one fresh direct source and preserves native reference track',async()=>{
  let lookups=0;const track={url:'https://www.youtube.com/api/timedtext?v='+id,kind:'native'};
  const result=await acquireAudio({...source,url:url+'&old=1',bytes:4,track},{fetcher:async(u)=>{
    if(u.includes('old=1'))return new Response('',{status:403});
    if(u.includes('/watch?')){lookups++;return new Response('"VISITOR_DATA":"anonymous-context"');}
    if(u.includes('/youtubei/'))return json(response());return new Response('abcd');
  }});
  assert.equal(lookups,1);assert.equal(await result.blob.text(),'abcd');assert.deepEqual(result.source.track,track);
});
test('abort during download never starts a fallback lookup',async()=>{
  const controller=new AbortController();let calls=0;
  await assert.rejects(()=>acquireAudio({...source,url,bytes:4},{signal:controller.signal,fetcher:async()=>{calls++;controller.abort();throw new DOMException('cancel','AbortError');}}),{name:'AbortError'});
  assert.equal(calls,1);
});
