import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {validateDocument,parseDocument,youtubeId,readyDocument,activeCues,captionSize,trimVolumeProfile,updateCaptionSizes,captionText,subtitleFile,normalizeSettings,DEFAULT_SETTINGS} from './core.js';
const cue=(patch={})=>({id:'speech-1',start:0,end:4,text:'안녕하세요.',kind:'speech',dbfs:-20,relative_db:0,scale:1,confidence:.9,source:'test',review_required:true,...patch});
const doc=(cues=[cue()],patch={})=>({schema_version:'1.0',video_id:'abcdefghijk',title:'검증 자막',duration:10,cues,warnings:[],metadata:{},...patch});
test('normalizes and sorts without accepting invalid times or text',()=>{
  assert.equal(validateDocument(doc([cue({id:'late',start:5,end:8}),cue()])).cues[0].id,'speech-1');
  for(const patch of [{start:NaN},{start:Infinity},{start:-1},{end:0},{end:11},{text:''},{text:'x'.repeat(2001)},{kind:'script'},{scale:1.56},{dbfs:-121},{relative_db:121},{id:'x'.repeat(101)}])assert.throws(()=>validateDocument(doc([cue(patch)])),JSON.stringify(patch));
  assert.throws(()=>validateDocument(doc([cue(),cue()])));
  assert.throws(()=>validateDocument(doc([],{duration:0})));
  assert.throws(()=>validateDocument(doc([],{video_id:'bad'})));
  assert.throws(()=>validateDocument(doc(Array.from({length:10001},(_,i)=>cue({id:String(i)})))));
});
test('import keeps hostile strings literal and bounds JSON',()=>{
  const text='<img src=x onerror=alert(1)>',parsed=parseDocument(JSON.stringify(doc([cue({text})])));
  assert.equal(parsed.cues[0].text,text);
  assert.throws(()=>parseDocument('<html>'));
  assert.throws(()=>parseDocument(' '.repeat(10*1024*1024+1)));
  assert.throws(()=>validateDocument(doc([cue({words:[{start:3,end:2,text:'oops'}]})])));
  assert.throws(()=>validateDocument(doc([cue({words:[{start:0,end:0,text:''}]})])));
});
test('YouTube links accept watch/shorts/share/live and reject foreign origins',()=>{
  for(const url of ['https://www.youtube.com/watch?v=abcdefghijk','https://m.youtube.com/shorts/abcdefghijk','https://youtu.be/abcdefghijk?t=42','https://www.youtube.com/live/abcdefghijk'])assert.equal(youtubeId(url),'abcdefghijk');
  for(const url of ['https://youtube.com.evil.com/watch?v=abcdefghijk','javascript:alert(1)','https://www.youtube.com/watch?v=short','https://example.com/abcdefghijk'])assert.equal(youtubeId(url),null);
});
test('sync uses absolute currentTime, offset, filters, seek, and half-open ends',()=>{
  const d=doc([cue(),cue({id:'sound',kind:'sound',start:2,end:3,text:'문 닫힘'})]);
  assert.equal(activeCues(d,0,DEFAULT_SETTINGS).length,1);
  assert.equal(activeCues(d,2.5,DEFAULT_SETTINGS).length,2);
  assert.equal(activeCues(d,4,DEFAULT_SETTINGS).length,0);
  assert.equal(activeCues(d,4,{...DEFAULT_SETTINGS,offset:1}).length,1);
  assert.equal(activeCues(d,2.5,{...DEFAULT_SETTINGS,showSpeech:false}).at(0).kind,'sound');
  assert.equal(activeCues(d,2.5,{...DEFAULT_SETTINGS,enabled:false}).length,0);
  assert.equal(activeCues(d,1,DEFAULT_SETTINGS).at(0).id,'speech-1');
});
test('volume typography preserves distinctions and honors strength zero',()=>{
  const quiet=cue({scale:.75}),loud=cue({scale:1.55});
  assert.ok(captionSize(quiet)<captionSize(loud));
  assert.equal(captionSize(quiet,{...DEFAULT_SETTINGS,effectStrength:0}),14);
  assert.equal(captionSize(loud,{...DEFAULT_SETTINGS,effectStrength:0}),14);
  assert.equal(captionSize(loud,{...DEFAULT_SETTINGS,effectStrength:.5}),17.8);
  assert.equal(normalizeSettings({baseSize:100,offset:-100}).baseSize,28);
  assert.equal(normalizeSettings({baseSize:100,offset:-100}).offset,-30);
});
test('three levels expose different amount of sound information',()=>{
  const c=cue({kind:'sound',text:'문이 세게 닫힘',details:'가까운 곳에서 날카롭게 울림'});
  assert.equal(captionText(c,'simple'),'[효과음]');
  assert.equal(captionText(c,'standard'),'[문이 세게 닫힘]');
  assert.match(captionText(c,'rich'),/가까운 곳/);
  assert.equal(captionText(cue(),'simple'),'안녕하세요.');
});
test('SRT/VTT flatten overlapping sound and speech and neutralize HTML markup',()=>{
  const d=doc([cue({text:'<b>안녕</b>'}),cue({id:'effect',kind:'sound',start:1,end:2,text:'[문 닫힘]'})]);
  const srt=subtitleFile(d,'srt');assert.match(srt,/00:00:01,000 --> 00:00:02,000\n‹b›안녕‹\/b›\n\[문 닫힘\]/);assert.doesNotMatch(srt,/<b>/);assert.match(srt,/00:00:02,000 --> 00:00:04,000/);
  assert.ok(subtitleFile(d,'vtt').startsWith('WEBVTT\n\n'));assert.equal(JSON.parse(subtitleFile(d,'json')).cues[0].text,'<b>안녕</b>');
});
test('studio and extension share byte-identical core logic',async()=>{assert.equal(await readFile(new URL('./core.js',import.meta.url),'utf8'),await readFile(new URL('../web/core.js',import.meta.url),'utf8'));});

const profile=[{time:1,scale:.75,dbfs:-50},{time:2,scale:1.55,dbfs:-10},{time:3,scale:1,dbfs:-30}];
test('legacy font preferences migrate to half size once, retaining dynamic ratios',()=>{
  for(const size of [16,28,40,56]){
    const migrated=normalizeSettings({baseSize:size});
    assert.equal(migrated.baseSize,size/2);assert.equal(migrated.typographyVersion,2);
    assert.deepEqual(normalizeSettings(migrated),migrated);
    for(const scale of [.75,1,1.55])assert.ok(Math.abs(captionSize(cue({scale}),migrated)-size*scale/2)<.051);
  }
  assert.equal(normalizeSettings().baseSize,14);
  assert.equal(normalizeSettings({typographyVersion:2,baseSize:18}).baseSize,18);
});
test('old cached music uses neutral wording without inventing an instrument or leaking failure text',()=>{
  const old=cue({kind:'music',text:'♪ 음악 · 악기·분위기 미확인',details:'프린터 소리',relative_db:-12});
  assert.equal(captionText(old,'rich'),'[♪ 작게 들리는 배경 음악이 이어짐]');
  assert.equal(captionText({...old,text:'♪ 피아노 연주 · 규칙적인 박자가 이어짐'},'standard'),'[♪ 피아노 연주 · 규칙적인 박자가 이어짐]');
});
test('corrected speech provenance survives validation and JSON export',()=>{
  const record={original_text:'입는 오시예요.',original_source:'faster-whisper',corrected_text:'입는 옷이에요.',reference_source:'youtube-human-caption',reference_video_id:'abcdefghijk',reference_start:0,reference_end:4,similarity:.85,original_words:[{start:0,end:1,text:'입는'}],word_timing_status:'cleared_after_source_correction'};
  const source=doc([cue({text:'입는 옷이에요.',speech_correction:record})]);
  assert.deepEqual(JSON.parse(subtitleFile(source,'json')).cues[0].speech_correction,record);
  assert.throws(()=>validateDocument(doc([cue({speech_correction:{...record,reference_video_id:'zzzzzzzzzzz'}})])));
});
test('whole-cue RMS scale stays fixed despite accents, seeking, offset and playback time',()=>{
  const c=validateDocument(doc([cue({scale:1.2,volume_profile:profile})])).cues[0];
  assert.deepEqual(c.volume_profile,profile);
  for(const kind of ['speech','sound','music'])for(const time of [0,1,1.5,2,3,4,NaN])assert.equal(captionSize({...c,kind},DEFAULT_SETTINGS,time),16.8);
  assert.equal(captionSize(c,{...DEFAULT_SETTINGS,offset:2},3.5),16.8);
  assert.equal(captionSize(c,{...DEFAULT_SETTINGS,effectStrength:.5},2),15.4);
  assert.equal(captionSize(c,{...DEFAULT_SETTINGS,effectStrength:0},2),14);
  assert.equal(captionSize(c),16.8);
  assert.equal(captionSize(cue({scale:1.55}),DEFAULT_SETTINGS,2),21.7);
  assert.deepEqual(JSON.parse(subtitleFile(doc([c]),'json')).cues[0].volume_profile,profile);
  assert.equal(captionSize(cue({volume_profile:[profile[0]]}),DEFAULT_SETTINGS,2),14);
  const empty=validateDocument(doc([cue({scale:1.55,volume_profile:[]})])).cues[0];
  assert.deepEqual(empty.volume_profile,[]);
  assert.equal(captionSize(empty,DEFAULT_SETTINGS,2),21.7);
});
test('measured profile rejects malformed points, ranges, duplicate and unsorted times',()=>{
  const point={time:1,scale:1,dbfs:-20};
  const invalid=[null,{},Array(12003).fill(point),[null],[[]],[{...point,time:NaN}],[{...point,time:Infinity}],[{...point,time:-.1}],[{...point,time:4.06}],[{...point,scale:.74}],[{...point,scale:1.56}],[{...point,scale:NaN}],[{...point,dbfs:-121}],[{...point,dbfs:13}],[{...point,dbfs:NaN}],[{...point,dbfs:null}],[point,point],[{...point,time:2},point]];
  for(const volume_profile of invalid)assert.throws(()=>validateDocument(doc([cue({volume_profile})])));
  assert.equal(validateDocument(doc([cue({start:1,volume_profile:[{time:.96,scale:.75,dbfs:-120},{time:4.04,scale:1.55,dbfs:12}]})])).cues[0].volume_profile.length,2);
});
test('playhead updates reuse nodes and skip unchanged quantized sizes, restoring desired sizes before fit',()=>{
  const original=globalThis.getComputedStyle;
  globalThis.getComputedStyle=row=>({fontSize:row.style.fontSize});
  let measurements=0;
  const row={style:{fontSize:'0px',setProperty(name,value){if(name==='font-size')this.fontSize=value;}}};
  const box={children:[row],getBoundingClientRect(){measurements++;return {height:parseFloat(row.style.fontSize)*3};}};
  const c=cue({scale:1.55,volume_profile:profile});
  try{
    assert.equal(updateCaptionSizes(box,[c],DEFAULT_SETTINGS,2,1,50,'wide'),true);
    const shrunk=parseFloat(row.style.fontSize);assert.ok(shrunk<21.5);
    const count=measurements;
    assert.equal(updateCaptionSizes(box,[c],DEFAULT_SETTINGS,2,1,50,'wide'),false);
    assert.equal(measurements,count);
    assert.equal(updateCaptionSizes(box,[c],DEFAULT_SETTINGS,2,1,500,'wide'),true);
    assert.equal(parseFloat(row.style.fontSize),21.5);
    assert.equal(updateCaptionSizes(box,[c],DEFAULT_SETTINGS,1,1,500,'wide'),false);
    assert.equal(parseFloat(row.style.fontSize),21.5);
    assert.equal(box.children[0],row);
    updateCaptionSizes(box,[c],{...DEFAULT_SETTINGS,effectStrength:0},2,1,500,'wide');
    assert.equal(parseFloat(row.style.fontSize),14);
    updateCaptionSizes(box,[c],{...DEFAULT_SETTINGS,effectStrength:0,baseSize:40},2,1,500,'wide');
    assert.equal(parseFloat(row.style.fontSize),40);
    updateCaptionSizes(box,[c],DEFAULT_SETTINGS,2,1,500,'wide');
    assert.equal(parseFloat(row.style.fontSize),21.5);
    const empty=cue({scale:.75,volume_profile:[]});
    updateCaptionSizes(box,[empty],DEFAULT_SETTINGS,1,1,500,'wide');
    assert.equal(parseFloat(row.style.fontSize),10.5);
    const staticCount=measurements;
    assert.equal(updateCaptionSizes(box,[empty],DEFAULT_SETTINGS,2,1,500,'wide'),false);
    assert.equal(measurements,staticCount);
  }finally{globalThis.getComputedStyle=original;}
});

test('playback only selects explicitly completed results, never legacy, pending or partial data',()=>{
  const document=doc(),entry={document,ready:true,displayVersion:2,origin:'analysis'},id=document.video_id;
  for(const phase of ['requesting','preparing','capturing','uploading','queued','running'])assert.equal(readyDocument(entry,{videoId:id,phase},id),null);
  assert.equal(readyDocument(entry,{videoId:id,phase:'done'},id),document);
  assert.equal(readyDocument(entry,{videoId:'zzzzzzzzzzz',phase:'running'},id),document);
  assert.equal(readyDocument({document},{},id),null);
  assert.equal(readyDocument({...entry,ready:false},{phase:'error'},id),null);
  assert.equal(readyDocument({...entry,ready:false},{phase:'cancelled'},id),null);
  assert.equal(readyDocument(entry,{},'zzzzzzzzzzz'),null);
  const partial={...entry,document:{...document,metadata:{partial:true,audio_analyzed:false}}};
  assert.equal(readyDocument(partial,{phase:'done'},id),null);
  assert.equal(readyDocument({...partial,origin:'import'},{},id),partial.document);
});

test('timing edits clip measured curves with interpolated boundary points',()=>{
  const trimmed=trimVolumeProfile(profile,1.5,2.5);
  assert.deepEqual(trimmed.map(p=>p.time),[1.5,2,2.5]);
  assert.equal(trimmed[0].scale,1.15);
  assert.equal(trimmed[0].dbfs,-30);
  assert.equal(trimmed.at(-1).scale,1.275);
  assert.equal(validateDocument(doc([cue({start:1.5,end:2.5,volume_profile:trimmed})])).cues[0].volume_profile.length,3);
  assert.deepEqual(trimVolumeProfile(profile,0,.5).map(p=>p.scale),[.75,.75]);
  assert.equal(trimVolumeProfile(undefined,0,4),undefined);
});

test('position preferences are normalized and measured centers stay inside the video viewport',async()=>{
  const {captionPosition}=await import('./core.js');
  assert.equal(normalizeSettings().positionX,50);assert.equal(normalizeSettings().positionY,88);
  assert.equal(normalizeSettings({positionX:-4,positionY:'120'}).positionX,0);assert.equal(normalizeSettings({positionX:-4,positionY:'120'}).positionY,100);
  assert.equal(normalizeSettings({positionX:NaN,positionY:null}).positionY,88);
  const bounds={left:20,top:30,width:300,height:160},size={width:200,height:60};
  assert.deepEqual(captionPosition({...DEFAULT_SETTINGS,positionX:0,positionY:0},bounds,size),{left:120,top:60});
  assert.deepEqual(captionPosition({...DEFAULT_SETTINGS,positionX:100,positionY:100},bounds,size),{left:220,top:160});
  assert.deepEqual(captionPosition(DEFAULT_SETTINGS,{left:0,top:0,width:1920,height:1080},{width:600,height:100}),{left:960,top:950.4});
  assert.deepEqual(captionPosition(DEFAULT_SETTINGS,{left:0,top:0,width:80,height:40},{width:200,height:90}),{left:40,top:20});
});
