import test from 'node:test';
import assert from 'node:assert/strict';
import {createCaptionCollector,nativeCaptionText} from './native-captions.js';
const snap=time=>({videoId:'abcdefghijk',time,paused:false,ad:false});
test('native caption evidence uses video time and merges consecutive observations',()=>{
  const c=createCaptionCollector();c.reset('abcdefghijk');
  for(const time of [2,2.25,2.5,2.75])c.observe(snap(time),'입는 옷이에요.');
  assert.deepEqual(c.snapshot(),[{video_id:'abcdefghijk',start:2,end:2.85,text:'입는 옷이에요.',source:'youtube-native-caption'}]);
  const copy=c.snapshot();copy[0].text='tampered';assert.equal(c.snapshot()[0].text,'입는 옷이에요.');
});
test('seeks, ads, pauses and different videos cannot extend or mix caption evidence',()=>{
  const c=createCaptionCollector();c.reset('abcdefghijk');
  c.observe(snap(2),'같은 대사');c.observe(snap(2.25),'같은 대사');
  for(const extra of [{ad:true},{paused:true},{videoId:'zzzzzzzzzzz'}])c.observe({...snap(8),...extra},'오염');
  c.observe(snap(10),'같은 대사');c.observe(snap(10.25),'같은 대사');
  assert.equal(c.snapshot().length,2);assert.ok(c.snapshot().every(x=>x.end-x.start<1));
  c.reset('zzzzzzzzzzz');assert.deepEqual(c.snapshot(),[]);
});
test('only native caption DOM is read, with bounded normalized text',()=>{
  const player={querySelectorAll(selector){assert.equal(selector,'.ytp-caption-window-container .ytp-caption-segment');return [{textContent:' 입는  옷이에요.'},{textContent:'한 번\n걸쳐보세요.'}];}};
  assert.equal(nativeCaptionText(player),'입는 옷이에요. 한 번 걸쳐보세요.');assert.equal(nativeCaptionText(null),'');
});
