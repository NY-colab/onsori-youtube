import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {selectFullSource} from './full-source.js';
const source=await readFile(new URL('./page-source.js',import.meta.url),'utf8');
const id='abcdefghijk',origin='https://www.youtube.com';
const response=(extra={},videoId=id)=>({videoDetails:{videoId,title:'영상',lengthSeconds:'361'},...extra});
function bridge(player,initial){
  let listener,reply;
  const window={ytInitialPlayerResponse:initial,addEventListener(type,fn){listener=fn;},postMessage(message){reply=message;}};
  vm.runInNewContext(source,{window,document:{querySelector(){return {getPlayerResponse(){if(player instanceof Error)throw player;return player;}};}},location:{href:origin+'/watch?v='+id,origin,pathname:'/watch'},URL});
  const request={source:window,origin,data:{type:'ONSORI_SOURCE_REQUEST',nonce:'test-nonce',videoId:id}};
  return {send(overrides={}){reply=undefined;listener({...request,...overrides});return reply;}};
}
const stream={adaptiveFormats:[{url:'https://r1.googlevideo.com/videoplayback?id=test',mimeType:'audio/mp4',bitrate:64000}]};
test('matching but stripped player response falls back to same-video initial media and captions',()=>{
  const initial=response({streamingData:stream,captions:{playerCaptionsTracklistRenderer:{captionTracks:[{baseUrl:origin+'/api/timedtext?v='+id,languageCode:'ko'}]}}});
  const data=bridge(response(),initial).send().data;
  const selected=selectFullSource(data,id);assert.equal(selected.duration,361);assert.equal(selected.url,stream.adaptiveFormats[0].url);assert.ok(selected.track);
});
test('SPA navigation cannot borrow an earlier video source or transcript',()=>{
  const old=response({streamingData:stream},'zzzzzzzzzzz');
  const data=bridge(response(),old).send().data;assert.equal(data.formats.length,0);
  assert.throws(()=>selectFullSource(data,id),/전체 오디오 주소/);
  assert.equal(bridge(old,old).send().data,null);
});
test('player exception retains matching initial data; foreign page messages get no reply',()=>{
  const b=bridge(new Error('not ready'),response({streamingData:stream}));
  assert.equal(selectFullSource(b.send().data,id).duration,361);
  assert.equal(b.send({origin:'https://example.com'}),undefined);
  assert.equal(b.send({source:{}}),undefined);
  assert.equal(b.send({data:{type:'ONSORI_SOURCE_REQUEST',nonce:'n',videoId:'zzzzzzzzzzz'}}),undefined);
});
