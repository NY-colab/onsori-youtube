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
test('player caption request (with pot) becomes the track; json3 words become caption lines',async()=>{
  const {captionWords,captionLines}=await import('./full-source.js');
  const id='abcdefghijk',base={videoId:id,title:'t',duration:100,formats:[{url:'https://r1.googlevideo.com/videoplayback?id=1',mimeType:'audio/mp4'}],tracks:[{url:`https://www.youtube.com/api/timedtext?v=${id}&lang=ko&kind=asr`,language:'ko',kind:'asr'}]};
  const attested=`https://www.youtube.com/api/timedtext?v=${id}&lang=ko&kind=asr&pot=abc&fmt=json3`;
  assert.equal(selectFullSource({...base,captionRequest:{url:attested,language:'ko',kind:'asr'}},id).track.attested,true);
  assert.ok(!selectFullSource({...base,captionRequest:{url:attested.replace('&pot=abc',''),language:'ko',kind:'asr'}},id).track.attested,'no pot, no attested text');
  assert.ok(!selectFullSource({...base,captionRequest:{url:attested,language:'en',kind:'asr'}},id).track.attested,'other language');
  assert.ok(!selectFullSource({...base,captionRequest:{url:attested.replace(id,'zzzzzzzzzzz'),language:'ko',kind:'asr'}},id).track.attested,'other video');
  const json={events:[
    {tStartMs:1000,dDurationMs:4000,segs:[{utf8:'이것은'},{utf8:' 옷이요?',tOffsetMs:600}]},
    {tStartMs:2000,dDurationMs:3000,segs:[{utf8:'\n'}]},
    {tStartMs:3000,dDurationMs:2000,segs:[{utf8:'>> 입는'},{utf8:' 옷이에요.',tOffsetMs:400}]},
    {tStartMs:6000,dDurationMs:2000,segs:[{utf8:'[음악]'}]},
    {tStartMs:9000,dDurationMs:2000,segs:[{utf8:'Ja.'},{utf8:' 한번',tOffsetMs:200},{utf8:' 걸쳐',tOffsetMs:500}]},
  ]};
  const {words,tags}=captionWords(json,100);
  assert.deepEqual(tags.map(t=>[t.start,t.text]),[[6,'[음악]']]);
  assert.deepEqual(words.map(w=>w.text),['이것은','옷이요?','입는','옷이에요.','한번','걸쳐']);
  const lines=captionLines(words);
  assert.deepEqual(lines.map(l=>l.text),['이것은 옷이요?','입는 옷이에요.','한번 걸쳐']);
  assert.equal(lines[0].start,1);assert.equal(lines[0].end,3,'a line ends where the next word starts');
  assert.ok(lines.every(l=>l.end>l.start));
});
