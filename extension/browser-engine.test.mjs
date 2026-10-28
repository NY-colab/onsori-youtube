import test from 'node:test';
import assert from 'node:assert/strict';
import {validateDocument,captionSize} from './core.js';
import {analyzeRecording} from './browser-engine.js';
import {mergeAsrWindows,isDecoderLoop} from './browser-engine-asr.js';
import {assembleDocument,applyReferences,dbfs,volumeStyle,stableOcrReferences,selectOcrFrames,similarity,selectMusicTags,isStandaloneAsrTag,removeAsrMetaTags} from './browser-engine-signal.js';
const videoId='abcdefghijk';
const asrWindow=(start,end,text,a,b)=>({start,end,output:{text,chunks:[{text,timestamp:[a,b]}]}});
test('short standalone ASR tags are rejected with raw provenance while ordinary dialogue survives',()=>{
  for(const text of ['(끝)','(끝끝)','[박수]'])assert.equal(isStandaloneAsrTag(text),true);
  for(const text of ['끝났습니다.','네.','응.','(좋아요)','(맞아)','(안녕하세요 여러분.)','방금 끝이라고 말했어요.','오늘(월요일)은 모입니다.','(네, 좋아요.)'])assert.equal(isStandaloneAsrTag(text),false);
  const d=doc('(끝)');assert.equal(d.cues.length,0);assert.equal(d.metadata.asr_tag_filter.removed[0].text,'(끝)');
  const correct=doc('좋아요');correct.cues[0].text='(끝)';correct.cues[0].speech_correction={original_text:'좋아요'};removeAsrMetaTags(correct);assert.equal(correct.cues.length,1);
});
test('independent ASR windows bound null/overlong endpoints and shift local time once',()=>{
  const merged=mergeAsrWindows([asrWindow(0,8,'첫 번째 대사',5,null),asrWindow(5,13,'다음 대사',4,30)]);
  assert.deepEqual(merged.chunks.map(c=>c.timestamp),[[5,8],[9,13]]);
  assert.throws(()=>mergeAsrWindows([asrWindow(0,8,'시각 없는 대사',null,3)]),/시작 시각/);
});
test('ASR overlap dedup uses time, text and center ownership without erasing distinct speech',()=>{
  const merged=mergeAsrWindows([asrWindow(0,8,'이것은 옷이오',5,8),asrWindow(5,13,'이것은 옷이오',0,3.4),asrWindow(10,18,'다른 대사입니다',1,4)]);
  assert.equal(merged.chunks.length,2);assert.deepEqual(merged.chunks[0].timestamp,[5,8.4]);assert.equal(merged.chunks[1].text,'다른 대사입니다');
  assert.equal(mergeAsrWindows([asrWindow(0,8,'다시 말합니다',0,2),asrWindow(5,13,'다시 말합니다',2,4)]).chunks.length,2);
});
test('ASR overlap recognizes contained boundary clauses and rejects high-rate decoder loops',()=>{
  const merged=mergeAsrWindows([asrWindow(0,8,'가벼워서 더 편하실 거예요.',5,8),asrWindow(5,13,'편하실 거예요.',1,3)]);assert.equal(merged.chunks.length,1);assert.match(merged.chunks[0].text,/가벼워서/);
  assert.equal(isDecoderLoop('이것은 '+('옷이 '.repeat(100)),2),true);assert.equal(isDecoderLoop('안녕하세요 '.repeat(4),8),false);assert.equal(isDecoderLoop('안녕하세요 여러분 오늘 이 자리에 와주셔서 감사합니다. 즐겁고 편안한 시간 보내시기를 바랍니다.',8),false);
  assert.equal(isDecoderLoop('가'.repeat(25)+Array.from({length:75},(_,i)=>String.fromCharCode(0xAC01+i)).join(''),2),false);
  const rejected=mergeAsrWindows([asrWindow(0,8,'이것은 '+('옷이 '.repeat(100)),6,8)]);assert.equal(rejected.chunks.length,0);assert.equal(rejected.diagnostics.rejected.length,1);
});
function doc(text='이것은 오시오',startTime=0){const pcm=new Float32Array(64000).fill(.1);return assembleDocument({pcm,asr:{text,chunks:[{text,timestamp:[0,4]}]},videoId,title:'검수',startTime});}
test('measured whole-cue RMS produces one stable scale and absolute timestamps exactly once',()=>{
  const pcm=new Float32Array(64000);pcm.fill(.01,0,32000);pcm.fill(.5,32000);const d=assembleDocument({pcm,asr:{text:'대사',chunks:[{text:'대사',timestamp:[0,4]}]},videoId,startTime:100});
  const checked=validateDocument(d),c=checked.cues[0];assert.equal(c.start,100);assert.equal(c.end,104);assert.equal(c.volume_profile[0].time,100);assert.equal(c.volume_profile.at(-1).time,104);assert.ok(Math.abs(c.dbfs-dbfs(pcm))<.01);assert.equal(captionSize(c),captionSize({...c,volume_profile:[]}));assert.ok(new Set(c.volume_profile.map(p=>p.scale)).size>1);
});
test('screen references use Hangul jamo agreement, retain evidence, and clear inaccurate word times',()=>{
  const d=doc();d.cues[0].words=[{start:0,end:4,text:'이것은 오시오'}];const refs=stableOcrReferences([{time:.4,text:'이것은 옷이오',confidence:99},{time:1,text:'이것은 옷이오',confidence:98},{time:1.6,text:'이것은 옷이오',confidence:99},{time:2.2,text:'이것은 옷이오',confidence:99},{time:2.8,text:'이것은 옷이오',confidence:99},{time:3.4,text:'이것은 옷이오',confidence:99}],videoId);
  applyReferences(d,refs,'screen');assert.equal(d.cues[0].text,'이것은 옷이오');assert.equal(d.cues[0].speech_correction.original_text,'이것은 오시오');assert.equal(d.cues[0].words.length,0);assert.equal(d.cues[0].speech_correction.original_words.length,1);validateDocument(d);
});
test('unseen speech is never deleted by a short OCR fragment or mismatched video/time',()=>{
  const d=doc('안녕하세요 이것은 오시오 여러분 반갑습니다');const before=d.cues[0].text;applyReferences(d,[{video_id:videoId,start:0,end:4,text:'이것은 옷이오',source:'youtube-screen-ocr'}],'screen');assert.equal(d.cues[0].text,before);
  applyReferences(d,[{video_id:'01234567890',start:0,end:4,text:before+'!',source:'youtube-native-caption'}]);assert.equal(d.cues[0].text,before);
});
test('Tesseract OCR requires three high confidence observations across >=0.8s',()=>{
  assert.equal(stableOcrReferences([{time:1,text:'안녕하세요',confidence:99}],videoId).length,0);
  assert.equal(stableOcrReferences([{time:1,text:'안녕하세요',confidence:99},{time:1.5,text:'안녕하세요',confidence:93}],videoId).length,0);
  assert.equal(stableOcrReferences([{time:1,text:'안녕하세요',confidence:99},{time:1.5,text:'안녕하세요',confidence:99}],videoId).length,0);
  assert.equal(stableOcrReferences([{time:1,text:'안녕하세요',confidence:93},{time:1.5,text:'안녕하세요',confidence:92},{time:2,text:'안녕하세요',confidence:91}],videoId).length,1);
  assert.equal(stableOcrReferences([{time:1,text:'안녕하세요',confidence:93},{time:1.5,text:'안녕하세오',confidence:92},{time:2,text:'안녕하세요',confidence:91}],videoId).length,0);
  assert.equal(stableOcrReferences([{time:1,text:'안녕하세요',confidence:89},{time:1.5,text:'안녕하세요',confidence:89},{time:2,text:'안녕하세요',confidence:89}],videoId).length,0);
  for(const confidence of [undefined,NaN,101])assert.equal(stableOcrReferences([1,1.5,2].map(time=>({time,text:'안녕하세요',confidence})),videoId).length,0);
});
test('native caption matching conservatively preserves source spelling and time',()=>{
  const d=doc('안녕 하세요 여러분');applyReferences(d,[{video_id:videoId,start:.1,end:3.9,text:'안녕하세요 여러분',source:'youtube-native-caption'}]);assert.equal(d.cues[0].text,'안녕하세요 여러분');assert.equal(d.cues[0].start,0);assert.equal(d.cues[0].end,4);validateDocument(d);
});
test('screen correction can merge up to three adjacent cues, energy-average volume',()=>{
  const pcm=new Float32Array(64000);pcm.fill(.1,0,32000);pcm.fill(.4,32000);const d=assembleDocument({pcm,asr:{text:'이것은 오시오',chunks:[{text:'이것은',timestamp:[0,2]},{text:'오시오',timestamp:[2,4]}]},videoId});
  applyReferences(d,[{video_id:videoId,start:.2,end:3.9,text:'이것은 옷이오',source:'youtube-screen-ocr'}],'screen');assert.equal(d.cues.length,1);assert.equal(d.cues[0].text,'이것은 옷이오');assert.ok(Math.abs(d.cues[0].dbfs-dbfs(pcm))<.01);validateDocument(d);
});
test('music content comes only from supported AST tags; no rhythm or title is invented',()=>{
  const tags=selectMusicTags({Music:.9,Piano:.7,'Electric piano':.22});assert.equal(tags.instruments[0].label,'Piano');assert.equal(tags.mood,null);assert.equal(tags.genre,null);assert.equal(tags.rhythm,null);
  const d=assembleDocument({pcm:new Float32Array(64000).fill(.1),asr:{text:'',chunks:[]},windows:[{start:0,end:4,labels:[{label:'Music',score:.9},{label:'Piano',score:.7}]}],videoId});assert.match(d.cues[0].text,/피아노/);assert.equal(d.metadata.music_analysis[d.cues[0].id].mood,null);validateDocument(d);
});
test('no fabricated cues in silence and missing timestamp evidence fails closed',()=>{
  const d=assembleDocument({pcm:new Float32Array(64000),asr:{text:'안녕하세요',chunks:[{text:'안녕하세요',timestamp:[0,4]}]},videoId});assert.equal(d.cues.length,0);
  assert.throws(()=>assembleDocument({pcm:new Float32Array(64000),asr:{text:'hi'},videoId}),/시각/);
});
test('AST rejects strong non-speech hallucinations but preserves mixed or unclassified speech',()=>{
  const pcm=new Float32Array(64000).fill(.1),asr={text:'환각 대사',chunks:[{text:'환각 대사',timestamp:[0,4]}]},window=(speech,music)=>({start:0,end:4,labels:[{label:'Speech',score:speech},{label:'Music',score:music}]});
  const rejected=assembleDocument({pcm,asr,windows:[window(.001,.9)],videoId});assert.equal(rejected.cues.filter(c=>c.kind==='speech').length,0);assert.equal(rejected.metadata.speech_filter.rejected[0].text,'환각 대사');
  assert.equal(assembleDocument({pcm,asr,windows:[window(.2,.9)],videoId}).cues.filter(c=>c.kind==='speech').length,1);
  assert.equal(assembleDocument({pcm,asr,windows:[window(.001,.3)],videoId}).cues.filter(c=>c.kind==='speech').length,1);
  assert.equal(assembleDocument({pcm,asr,windows:[],videoId,options:{event_detection:false}}).cues.filter(c=>c.kind==='speech').length,1);
  const annotation={text:'(실제 대사입니다.)',chunks:[{text:'(실제 대사입니다.)',timestamp:[0,4]}]};assert.equal(assembleDocument({pcm,asr:annotation,windows:[window(.001,.3)],videoId}).cues.filter(c=>c.kind==='speech').length,0);assert.equal(assembleDocument({pcm,asr:annotation,windows:[window(.2,.9)],videoId}).cues.filter(c=>c.kind==='speech').length,1);
});
test('screen references cannot cross video identity or non-overlapping timestamps',()=>{
  const d=doc(),before=d.cues[0].text;for(const ref of [{video_id:'01234567890',start:0,end:4},{video_id:videoId,start:4.1,end:4.6}])applyReferences(d,[{...ref,text:'이것은 옷이오',source:'youtube-screen-ocr'}],'screen');assert.equal(d.cues[0].text,before);assert.equal(d.cues[0].speech_correction,undefined);
});
test('OCR frame sampling validates binding, JPEG bounds and repeated-observation spacing',()=>{
  const d=doc(),frames=Array.from({length:30},(_,i)=>({video_id:videoId,time:i/10,jpeg:'data:image/jpeg;base64,AAAA'}));frames.push({...frames[0],video_id:'wrong'});const chosen=selectOcrFrames(frames,d);assert.ok(chosen.length<=7);assert.ok(chosen.every((x,i)=>!i||x.time-chosen[i-1].time>=.45));assert.equal(similarity('가나다','가나다'),1);
});
test('aborted job never decodes or downloads models',async()=>{
  const controller=new AbortController();controller.abort();await assert.rejects(analyzeRecording({blob:new Blob(['none']),signal:controller.signal}),{name:'AbortError'});
});
test('full-video engine passes all 361 seconds to inference, while clip and truncated audio fail closed',async()=>{
  const originalAudio=Object.getOwnPropertyDescriptor(globalThis,'AudioContext'),originalWorker=Object.getOwnPropertyDescriptor(globalThis,'Worker');
  let duration=361,workers=0,terminated=0,closed=0,receivedSamples=0;
  class AudioMock{
    async decodeAudioData(){const pcm=new Float32Array(duration*16000).fill(.1);return {duration,length:pcm.length,sampleRate:16000,numberOfChannels:1,getChannelData:()=>pcm};}
    async close(){closed++;}
  }
  class WorkerMock{
    constructor(){workers++;}
    postMessage(message){receivedSamples=message.pcm.byteLength/4;queueMicrotask(()=>this.onmessage({data:{type:'result',asr:{text:'마지막 대사입니다',chunks:[{text:'마지막 대사입니다',timestamp:[357,361]}]},windows:[]}}));}
    terminate(){terminated++;}
  }
  Object.defineProperty(globalThis,'AudioContext',{configurable:true,value:AudioMock});Object.defineProperty(globalThis,'Worker',{configurable:true,value:WorkerMock});
  try{
    const args={blob:new Blob(['encoded audio']),videoId,options:{event_detection:false,capture_frames:false},scope:'full-video',expectedDuration:361};
    const result=await analyzeRecording(args);
    assert.equal(receivedSamples,361*16000);assert.equal(result.duration,361);assert.equal(result.metadata.analysis_scope,'full-video');assert.equal(result.cues.at(-1).end,361);assert.equal(workers,1);assert.equal(terminated,1);
    await assert.rejects(analyzeRecording({...args,scope:'clip'}),/최대 1분/);
    duration=60;await assert.rejects(analyzeRecording(args),/길이가 영상과 맞지/);
    assert.equal(workers,1);assert.equal(closed,3);
  }finally{
    if(originalAudio)Object.defineProperty(globalThis,'AudioContext',originalAudio);else delete globalThis.AudioContext;
    if(originalWorker)Object.defineProperty(globalThis,'Worker',originalWorker);else delete globalThis.Worker;
  }
});
