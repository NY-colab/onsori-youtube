import test from 'node:test';
import assert from 'node:assert/strict';
import {screenLines,looksSubtitled,subtitleText,hangulShare,SCREEN_OCR} from './screen-lines.js';
import {selectScreenVideo,selectFullSource} from './full-source.js';

const row=(time,text,confidence=92)=>({time,text,confidence});
test('consecutive frames of one subtitle become one line with the most-seen reading',()=>{
  const rows=[row(16.75,'아픈 큰누나',94),row(17.25,'아픈 큰누나',94),row(17.75,'아픈 콘누나',87),row(18.25,'사랑하는 부모님',96),row(18.75,'사랑하는 부모님',96),row(19.25,''),row(19.75,'사랑하는 부모님',96),
    row(22.25,'첨없는 사존동생든',89),row(22.75,'철없는 사존동생든',88),row(23.25,'철없는 사존동생든',77),row(30,'왜',85),row(40,'짧게 한 번',93)];
  assert.deepEqual(screenLines(rows).map(l=>[l.start,l.end,l.text]),[[16.5,18,'아픈 큰누나'],[18,20,'사랑하는 부모님'],[22,23.5,'철없는 사존동생든'],[39.75,40.25,'짧게 한 번']]);
});
test('only confident, mostly-Hangul text counts as a subtitle',()=>{
  assert.equal(subtitleText([{text:'아픈 큰누나',confidence:94}]).text,'아픈 큰누나');
  assert.equal(subtitleText([{text:'IMAX IS A REGISTERED TRADEMARK',confidence:93}]).text,'');
  assert.equal(subtitleText([{text:'다들 SYOR 을라가요!',confidence:75}]).text,'');
  assert.equal(subtitleText([{text:'가',confidence:99}]).text,'');
  assert.ok(hangulShare('ASA 높은 URS 된 회사에만 원서 낼 거야')>=SCREEN_OCR.minHangul);
});
test('a video is treated as subtitled when enough probe frames show different lines',()=>{
  const probe=t=>Array.from({length:24},(_,i)=>row(i,t(i)));
  const said=['다들 옥상으로 올라가요!','아픈 큰누나','사랑하는 부모님','내가 여기서 나가면','그리고 나인가?','더 이상은 안됩니다','우리 완등 가자','그래 가자'];
  assert.ok(looksSubtitled(probe(i=>i%3===0?said[i/3]:'')));
  assert.ok(!looksSubtitled(probe(i=>i%2===0?'채널 로고 문구':'')));   // one repeated text: a logo, not dialogue
  assert.ok(!looksSubtitled(probe(i=>i===3?'한 번 보인 글자':'')));
  assert.ok(!looksSubtitled([]));
});
test('a small H.264 stream of at least 360 lines is chosen for reading subtitles',()=>{
  const v=(height,mime,bitrate,len=1e6)=>({url:`https://rr1.googlevideo.com/videoplayback?h=${height}${mime}`,mimeType:mime,height,bitrate,contentLength:String(len)});
  const formats=[v(1080,'video/mp4; codecs="avc1"',4e6),v(360,'video/webm; codecs="vp9"',3e5),v(360,'video/mp4; codecs="avc1"',4e5),v(240,'video/mp4; codecs="avc1"',2e5),{...v(480,'video/mp4',5e5),drm:true},v(720,'video/mp4',1e6,200*1024*1024)];
  assert.equal(selectScreenVideo(formats).height,360);assert.match(selectScreenVideo(formats).mimeType,/avc1/);
  assert.equal(selectScreenVideo([v(240,'video/mp4',2e5),v(144,'video/mp4',1e5)]).height,240);
  assert.equal(selectScreenVideo([v(144,'video/mp4',1e5)]),null);
  const audio={url:'https://rr1.googlevideo.com/videoplayback?a',mimeType:'audio/mp4; codecs="mp4a.40.2"',bitrate:128000,contentLength:'100'};
  assert.equal(selectFullSource({videoId:'abcdefghijk',duration:80,formats:[audio,...formats]},'abcdefghijk').video.height,360);
});
