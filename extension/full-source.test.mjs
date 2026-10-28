import test from 'node:test';
import assert from 'node:assert/strict';
import {selectFullSource,mediaUrl,captionUrl,boundedDownload,parseCaptionReferences} from './full-source.js';
const id='abcdefghijk',url='https://r1---sn-a.googlevideo.com/videoplayback?id=audio',data={videoId:id,title:'영상',duration:361,formats:[{url,mimeType:'audio/mp4; codecs="mp4a.40.2"',bitrate:128000}],tracks:[]};
test('whole source exceeds 60 seconds and chooses direct audio only',()=>{
  assert.equal(selectFullSource(data,id).duration,361);
  assert.throws(()=>selectFullSource({...data,formats:[{url,mimeType:'video/mp4'}]},id),/전체 오디오 주소/);
  assert.throws(()=>selectFullSource({...data,formats:[{signatureCipher:'secret',mimeType:'audio/mp4'}]},id),/전체 오디오 주소/);
  assert.throws(()=>selectFullSource({...data,formats:[{...data.formats[0],drm:true}]},id),/전체 오디오 주소/);
  assert.throws(()=>selectFullSource({...data,videoId:'zzzzzzzzzzz'},id),/영상 정보/);
  assert.throws(()=>selectFullSource({...data,duration:1201},id),/20분/);
  assert.throws(()=>selectFullSource({...data,live:true},id),/실시간/);
});
test('page-provided URLs cannot turn extension into arbitrary credentialed fetch proxy',()=>{
  for(const value of ['http://r.googlevideo.com/videoplayback','https://googlevideo.com.evil.test/videoplayback','https://evilgooglevideo.com/videoplayback','https://r.googlevideo.com:999/videoplayback','https://user:pass@r.googlevideo.com/videoplayback','http://127.0.0.1/videoplayback','https://r.googlevideo.com/other'])assert.equal(mediaUrl(value),null);
  assert.equal(captionUrl('https://www.youtube.com/api/timedtext?v=zzzzzzzzzzz',id),null);
  assert.equal(captionUrl('https://www.youtube.com/api/timedtext?v='+id,id),'https://www.youtube.com/api/timedtext?v='+id+'&fmt=json3');
});
test('bounded download validates status and streamed bytes without cookies or redirects',async()=>{
  let options;const blob=await boundedDownload(url,{fetcher:async(_,o)=>{options=o;return new Response('abcd',{headers:{'content-length':'4','content-type':'audio/mp4'}});}});
  assert.equal(await blob.text(),'abcd');assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');assert.equal(options.cache,'no-store');
  await assert.rejects(()=>boundedDownload(url,{maxBytes:3,fetcher:async()=>new Response('abcd')}),/허용 크기/);
  await assert.rejects(()=>boundedDownload(url,{maxBytes:3,fetcher:async()=>new Response('abcd',{headers:{'content-length':'4'}})}),/100MB/);
  await assert.rejects(()=>boundedDownload(url,{fetcher:async()=>new Response('',{status:403})}),/403/);
  const controller=new AbortController();controller.abort();await assert.rejects(()=>boundedDownload(url,{signal:controller.signal,fetcher:async()=>new Response('abcd')}),{name:'AbortError'});
});
test('transcript references preserve video identity and reject malformed or excessive ranges',()=>{
  const refs=parseCaptionReferences({events:[{tStartMs:1000,dDurationMs:2000,segs:[{utf8:'이것은 옷이오'}]},{tStartMs:4000,dDurationMs:200000,segs:[{utf8:'잘못된 범위입니다'}]},{tStartMs:-10,dDurationMs:1000,segs:[{utf8:'잘못된 시작입니다'}]}]},id,361);
  assert.deepEqual(refs,[{video_id:id,start:1,end:3,text:'이것은 옷이오',source:'youtube-native-caption'}]);
});
