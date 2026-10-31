import {MODEL_CONFIG} from './model-config.js';
import {INSTRUMENTS,GENRES,MOODS,VOCALS,FAMILIES,EVENTS} from './browser-engine-vocabulary.js';

const SR=16000, clamp=(x,a,b)=>Math.max(a,Math.min(b,x)), round=(x,n=3)=>Number(x.toFixed(n));
export function dbfs(samples){let sum=0;for(const x of samples)sum+=x*x;return Math.max(-120,10*Math.log10(Math.max(1e-12,sum/Math.max(1,samples.length))));}
export function referenceLevel(pcm){const levels=[];for(let i=0;i<pcm.length;i+=800){const v=dbfs(pcm.subarray(i,i+800));if(v>-60)levels.push(v);}levels.sort((a,b)=>a-b);if(!levels.length)return -60;const m=levels.length>>1;return levels.length%2?levels[m]:(levels[m-1]+levels[m])/2;}
export function volumeStyle(pcm,start,end,reference){const level=dbfs(pcm.subarray(Math.max(0,Math.floor(start*SR)),Math.min(pcm.length,Math.floor(end*SR)))),relative=clamp(level-reference,-120,120);return {dbfs:round(level,2),relative_db:round(relative,2),scale:round(clamp(1+relative/40,.75,1.55))};}
export function volumeProfile(pcm,start,end,reference,offset=0){const profile=[];let previous;
  for(let index=0;;index++){const t=start+index*.1;if(t>=end-.0005)break;const level=dbfs(pcm.subarray(Math.round(t*SR),Math.round(Math.min(end,t+.1)*SR))),target=clamp(1+(level-reference)/32,.75,1.55);previous=previous===undefined?target:previous+(target>previous?.85:.35)*(target-previous);profile.push({time:round(t+offset),dbfs:round(level,2),scale:round(previous)});}
  if(profile.length&&round(end+offset)>profile.at(-1).time)profile.push({...profile.at(-1),time:round(end+offset)});return profile;
}
const musicLabels=new Set([...Object.keys(INSTRUMENTS),...Object.keys(GENRES),...Object.keys(MOODS),...Object.keys(VOCALS),'Music','Musical instrument','Background music','Song']);
export function isStandaloneAsrTag(text){
  const match=/^(?:\(([^()]*)\)|\[([^\[\]]*)\])$/.exec(String(text||'').trim());if(!match)return false;
  const inner=match[1]??match[2];if(!/^\p{L}{1,3}$/u.test(inner))return false;
  // Preserve short Korean sentence forms such as '(좋아요)' or '(맞아)'.
  return !/[가-힣](?:요|다|죠|네|까|해|오|아|어|지|자|래)$/u.test(inner);
}
export function removeAsrMetaTags(doc){
  const removed=[];doc.cues=doc.cues.filter(cue=>{
    if(cue.kind!=='speech'||!cue.source?.startsWith('whisper')||cue.speech_correction||!isStandaloneAsrTag(cue.text))return true;
    removed.push({start:cue.start,end:cue.end,text:cue.text,source:cue.source,reason:'short standalone bracketed ASR metadata tag'});return false;
  });
  if(removed.length)doc.metadata.asr_tag_filter={method:'standalone balanced bracket tag of 1–3 letters; no spaces or sentence punctuation; common Korean sentence endings exempt; raw preserved',removed:[...(doc.metadata.asr_tag_filter?.removed||[]),...removed]};
  return doc;
}
export function selectMusicTags(scores){
  const ranked=(vocab,threshold)=>Object.entries(vocab).filter(([label])=>(scores[label]||0)>=threshold).map(([label,text])=>({label,text,score:round(scores[label]||0,4)})).sort((a,b)=>b.score-a.score);
  let instruments=ranked(INSTRUMENTS,.2),rejected=new Set(),labels=new Set(instruments.map(x=>x.label));
  for(const [parent,children] of Object.entries(FAMILIES)){if(!labels.has(parent))continue;const present=children.filter(c=>labels.has(c)),supported=present.filter(c=>scores[c]>=Math.max(.3,scores[parent]*.75));if(supported.length)rejected.add(parent);for(const c of present)if(!supported.includes(c))rejected.add(c);}
  const one=(v,t,m)=>{const items=ranked(v,0);return items[0]?.score>=t&&(!items[1]||items[0].score-items[1].score>=m)?items[0]:null;};
  instruments=instruments.filter(x=>!rejected.has(x.label)).slice(0,2);
  return {instruments,genre:one(GENRES,.28,.08),mood:one(MOODS,.3,.1),vocal:one(VOCALS,.3,.08),rhythm:null,source:'AST/AudioSet (heuristic scores, not calibrated probabilities)'};
}
function describeMusic(tags){const parts=[];if(tags.mood)parts.push(`${tags.mood.text} 음악`);if(tags.instruments.length)parts.push(`${tags.instruments.map(x=>x.text).join('·')} 연주`);if(tags.genre)parts.push(`${tags.genre.text}풍`);if(tags.vocal)parts.push(`${tags.vocal.text} 함께 들림`);return '♪ '+(parts.join(' · ')||'배경 음악이 이어짐');}
export function assembleDocument({pcm,asr,windows=[],videoId=null,title='',startTime=0,options={}}){
  const length=pcm.length/SR,reference=referenceLevel(pcm),cues=[],music_analysis={},rejectedSpeech=[],keptSpeech=[];let counter=0;
  function add(start,end,text,kind,extra={}){
    start=clamp(start,0,length);end=clamp(end,0,length);if(end-start<.02||!text?.trim())return;
    const cue={id:`browser-${++counter}`,start:round(start+startTime),end:round(end+startTime),text:text.trim().slice(0,2000),kind,...volumeStyle(pcm,start,end,reference),confidence:null,source:kind==='speech'?'whisper-browser-wasm':'AST-browser-wasm',review_required:true,volume_profile:volumeProfile(pcm,start,end,reference,startTime),...extra};cues.push(cue);return cue;
  }
  if(asr?.text?.trim()&&!Array.isArray(asr.chunks))throw new Error('Whisper가 대사 시각을 반환하지 않았습니다. 분석 결과를 표시하지 않습니다.');
  for(const chunk of asr?.chunks||[]){
    const [a,b]=chunk.timestamp||[];if(!Number.isFinite(a))continue;
    // A leading "-" is Whisper's speaker-turn mark, not a spoken word.
    const end=clamp(Number.isFinite(b)?b:length,0,length),text=String(chunk.text||'').replace(/<\|[^|]*\|>/g,'').trim().replace(/^-+\s*/,'');if(a>=end)continue;
    // Whisper can hallucinate words over pure instruments or body sounds.
    // Suppress only where every overlapping AST window has very weak Speech
    // evidence and strong measured non-speech evidence; preserve mixed speech.
    const evidence=windows.filter(w=>w.end>a&&w.start<end).map(w=>({start:w.start,end:w.end,speech:Math.max(0,...w.labels.filter(x=>x.label==='Speech'||x.label==='Conversation'||x.label==='Narration, monologue').map(x=>x.score)),other:Math.max(0,...w.labels.filter(x=>musicLabels.has(x.label)||EVENTS[x.label]?.[2]==='sound').map(x=>x.score))}));
    const annotation=/^[\[(][^\[\]()]*[\])]?$/.test(text),speechScore=Math.max(0,...evidence.map(w=>w.speech));
    // Short stock phrases ("그러니까", "뭐야") also appear over quiet music where no
    // AST window hears speech at all. Long utterances keep the stricter rule above.
    const unheard=normalized(text).length<=8&&speechScore<.2;
    if(evidence.length&&(evidence.every(w=>w.speech<.05&&w.other>=.65)||unheard||(annotation&&evidence.every(w=>w.speech<.05)))){rejectedSpeech.push({start:round(a+startTime),end:round(end+startTime),text,reason:annotation&&speechScore<.05?'annotation without AST speech evidence':unheard?'short text without AST speech evidence':'strong non-speech AST evidence',evidence});continue;}
    if(evidence.length)keptSpeech.push([round(a+startTime,2),round(end+startTime,2),round(speechScore,3)]);
    if(dbfs(pcm.subarray(Math.floor(a*SR),Math.floor(end*SR)))>-60)add(a,end,text,'speech');
  }
  const events=[];
  for(const window of windows){
    if(!Array.isArray(window.labels)||!window.labels.length)throw new Error('AST가 음향 분석 결과를 반환하지 않았습니다.');
    const scores=Object.fromEntries(window.labels.filter(x=>typeof x.label==='string'&&Number.isFinite(x.score)).map(x=>[x.label,x.score]));
    const musicScore=Math.max(0,...Object.entries(scores).filter(([label])=>musicLabels.has(label)).map(([,score])=>score));
    if(musicScore>=.22)events.push({start:window.start,end:window.end,kind:'music',label:'Music',score:musicScore,scores});
    const sounds=window.labels.filter(x=>EVENTS[x.label]?.[2]==='sound'&&x.score>=.25).sort((a,b)=>b.score-a.score).slice(0,2);
    // AST windows are approximate, never advertised as exact event onset.
    for(const sound of sounds)events.push({start:window.start,end:window.end,kind:'sound',label:sound.label,score:sound.score,scores});
  }
  const merged=[];
  for(const event of events.sort((a,b)=>a.start-b.start)){
    const previous=merged.findLast(x=>x.label===event.label&&x.kind===event.kind&&Math.abs(x.end-event.start)<.05);
    if(previous){previous.end=event.end;previous.score=Math.max(previous.score,event.score);for(const [label,score] of Object.entries(event.scores))previous.scores[label]=Math.max(previous.scores[label]||0,score);}
    else merged.push({...event,scores:{...event.scores}});
  }
  for(const event of merged){
    const tags=event.kind==='music'?selectMusicTags(event.scores):null;
    const text=tags?(options.music_detail===false?'♪ 배경 음악이 이어짐':describeMusic(tags)):`${EVENTS[event.label][0]} ${EVENTS[event.label][1]}`;
    const bounds=event.kind==='sound'?activeBounds(pcm,event.start,event.end):[event.start,event.end];
    const cue=add(...bounds,text,event.kind,{confidence:clamp(event.score,0,1),details:'AI 음향 분류 추정 · 최대 2초 구간의 혼합 음량으로 시각을 보정하며 실제 발음 시각과 차이가 있습니다.'});
    if(cue&&tags)music_analysis[cue.id]=tags;
  }
  const doc={schema_version:'1.0',video_id:videoId,title:title.slice(0,300),duration:round(startTime+length),cues:cues.sort((a,b)=>a.start-b.start||a.end-b.end),warnings:['브라우저 AI 추정 결과입니다. 대사·음향 분류와 시각은 검토가 필요합니다.',...(options.event_detection===false?['음악·효과음 분석을 끈 결과입니다.']:[])],metadata:{engine:'browser-wasm',audio_analyzed:true,partial:false,analysis_range:[startTime,round(startTime+length)],reference_dbfs:reference,music_analysis,models:MODEL_CONFIG,asr_diagnostics:asr?.diagnostics||null,speech_filter:{method:'all overlapping AST windows Speech/Conversation/Narration <0.05 and music/sound >=0.65, or text of at most 8 letters/digits with Speech <0.2 in every overlapping window; skipped when event detection disabled',rejected:rejectedSpeech,kept_speech_evidence:keptSpeech},volume_profile_method:'100ms RMS; fixed recording median reference; fast attack .85 / slow release .35; display scale is whole-cue RMS',event_timing:'AST non-overlapping windows up to 2 seconds; transient bounds refined by mixed RMS, approximate onset/offset',rhythm_analysis:'not performed; no BPM inferred',speech_language:options.language||'ko'}};return removeAsrMetaTags(doc);
}
function activeBounds(pcm,start,end){const points=[];for(let t=start;t<end;t+=.05)points.push({t,level:dbfs(pcm.subarray(Math.floor(t*SR),Math.floor(Math.min(end,t+.05)*SR)))});const threshold=Math.max(-55,Math.max(...points.map(p=>p.level))-24),active=points.filter(p=>p.level>threshold);return active.length?[Math.max(start,active[0].t-.1),Math.min(end,active.at(-1).t+.15)]:[start,end];}

export function normalized(text){return String(text||'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');}
// SequenceMatcher-style recursively matched contiguous blocks (no dictionary rewriting).
export function matchingBlocks(a,b){const blocks=[];function walk(a0,a1,b0,b1){let size=0,ai=a0,bi=b0,previous=new Map();for(let i=a0;i<a1;i++){const current=new Map();for(let j=b0;j<b1;j++)if(a[i]===b[j]){const n=(previous.get(j-1)||0)+1;current.set(j,n);if(n>size){size=n;ai=i-n+1;bi=j-n+1;}}previous=current;}if(!size)return;if(a0<ai&&b0<bi)walk(a0,ai,b0,bi);blocks.push([ai,bi,size]);if(ai+size<a1&&bi+size<b1)walk(ai+size,a1,bi+size,b1);}walk(0,a.length,0,b.length);return blocks;}
export function similarity(a,b){return a.length+b.length?2*matchingBlocks(a,b).reduce((n,x)=>n+x[2],0)/(a.length+b.length):1;}
function spacing(text,original){const a=original.replace(/\s/gu,''),b=text.replace(/\s/gu,''),spaces=new Set(),mapped=new Set();let i=0;for(const ch of original){if(/\s/u.test(ch))spaces.add(i);else i++;}i=0;for(const ch of text){if(/\s/u.test(ch))mapped.add(i);else i++;}for(const [ai,bi,size] of matchingBlocks(a,b))if(size>=2)for(const p of spaces)if(p>=ai&&p<=ai+size)mapped.add(bi+p-ai);return Array.from(b,(ch,i)=>(i&&mapped.has(i)?' ':'')+ch).join('').replace(/\s+([,.!?])/g,'$1').replace(/([,!?])(?=[가-힣A-Za-z])/g,'$1 ');}
export function stableOcrReferences(observations,videoId){const groups=[];for(const row of [...observations].sort((a,b)=>a.time-b.time)){
  const text=String(row.text||'').replace(/\s+/g,' ').trim();if(!Number.isFinite(row.confidence)||row.confidence<MODEL_CONFIG.ocr.minConfidence||row.confidence>100||normalized(text).length<4||text.length>500||!Number.isFinite(row.time))continue;
  const previous=groups.at(-1);if(previous&&normalized(previous.text)===normalized(text)&&row.time>previous.last&&row.time-previous.last<=1.1){previous.last=row.time;previous.count++;if(row.confidence>previous.confidence){previous.text=text;previous.confidence=row.confidence;}}
  else groups.push({start:row.time,last:row.time,text,count:1,confidence:row.confidence});
  }return groups.filter(g=>g.count>=MODEL_CONFIG.ocr.minObservations&&g.last-g.start>=.8&&g.last-g.start<15).map(g=>({video_id:videoId,start:Math.max(0,g.start-.25),end:g.last+.25,text:g.text,source:'youtube-screen-ocr'}));}
export function selectOcrFrames(frames,doc,config=MODEL_CONFIG.ocr){
  const speech=doc.cues.filter(c=>c.kind==='speech'&&!c.speech_correction),selected=[];let previous=-Infinity;
  for(const frame of (Array.isArray(frames)?frames:[]).slice(0,241).sort((a,b)=>a.time-b.time)){
    if(frame.video_id!==doc.video_id||!Number.isFinite(frame.time)||frame.time<0||frame.time>doc.duration+.8||typeof frame.jpeg!=='string'||frame.jpeg.length>350000||!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(frame.jpeg))continue;
    if(frame.time-previous<config.minFrameGap||!speech.some(c=>frame.time>=c.start-.8&&frame.time<=c.end+.8))continue;
    selected.push(frame);previous=frame.time;if(selected.length>=config.maxFrames)break;
  }return selected;
}

export function applyReferences(doc,references,mode='native'){
  const screen=mode==='screen',allowed=screen?['youtube-screen-ocr']:['youtube-human-caption','youtube-native-caption'];
  const refs=(Array.isArray(references)?references:[]).slice(0,2000).filter(r=>r?.video_id===doc.video_id&&allowed.includes(r.source)&&Number.isFinite(r.start)&&Number.isFinite(r.end)&&r.start>=0&&r.end>r.start&&r.end<=doc.duration+(screen?.8:0)&&r.end-r.start<=15&&typeof r.text==='string'&&r.text.length<=500&&normalized(r.text).length>=4).sort((a,b)=>a.start-b.start);
  const speech=doc.cues.filter(c=>c.kind==='speech'),candidates=[];
  for(let i=0;i<speech.length;i++){
    const group=[];
    for(const last of speech.slice(i,i+(screen?3:1))){
      if(last.speech_correction||!last.source.includes('whisper'))break;if(group.length&&last.start-group.at(-1).end>1.2)break;group.push(last);
      const first=group[0],original=group.map(c=>c.text).join(' '),a=normalized(original);if(last.end-first.start>15)break;if(a.length<4)continue;
      const nearby=refs.filter(r=>r.end>=first.start&&r.start<=last.end);
      for(let j=0;j<nearby.length;j++){
        const parts=[];
        for(const tail of nearby.slice(j,j+4)){
          if(parts.length&&(tail.source!==parts[0].source||tail.start-parts.at(-1).end>(screen?1.2:.7)||tail.start<parts.at(-1).end-(screen?.3:.15)))break;
          parts.push(tail);const ref=parts[0];if(Math.abs(ref.start-first.start)>(screen?3.5:.8)||Math.abs(tail.end-last.end)>(screen?1.5:.8))continue;
          const overlap=Math.max(0,Math.min(last.end,tail.end)-Math.max(first.start,ref.start));if(overlap/(last.end-first.start)<(screen?.3:.75)||overlap/(tail.end-ref.start)<(screen?.6:.75))continue;
          const text=parts.map(r=>r.text.trim()).join(' '),b=normalized(text),score=similarity(a,b);if(!b.length||minRatio(a,b)<(screen?.75:.6)||/[\[\]♪]/.test(text))continue;
          if(screen){
            const jamo=similarity(a.normalize('NFD'),b.normalize('NFD'));
            const edge=(x,y)=>similarity(x,y)>=.66||similarity(x.normalize('NFD'),y.normalize('NFD'))>=.75;
            // Korean spacing/받침 errors can change two syllable blocks while
            // retaining almost all phonemes. Require stronger jamo evidence
            // for that narrow case, plus full-length and both-edge coverage.
            if(!edge(a.slice(0,3),b.slice(0,3))||!edge(a.slice(-3),b.slice(-3))||!((score>=.68&&jamo>=.8)||(score>=2/3&&jamo>=.88)))continue;
          }
          if(!screen&&score<(ref.source==='youtube-human-caption'?.64:.84))continue;
          candidates.push({group:[...group],text:screen?spacing(text,original):text,ref,tail,score,original});
        }
      }
    }
  }
  const used=new Set(),replacements=[];let count=0;
  candidates.sort((a,b)=>(b.ref.source==='youtube-human-caption')-(a.ref.source==='youtube-human-caption')||b.score-a.score||b.original.length-a.original.length);
  for(const {group,text,ref,tail,score,original} of candidates){if(group.some(c=>used.has(c.id))||(text===original&&group.length===1))continue;
    const cue={...group[0],end:group.at(-1).end,text,words:[],review_required:true};
    if(group.length>1){const duration=group.reduce((s,c)=>s+c.end-c.start,0);cue.dbfs=10*Math.log10(group.reduce((s,c)=>s+10**(c.dbfs/10)*(c.end-c.start),0)/duration);cue.relative_db=clamp(cue.dbfs-doc.metadata.reference_dbfs,-120,120);cue.scale=clamp(1+cue.relative_db/40,.75,1.55);cue.volume_profile=[...new Map(group.flatMap(c=>c.volume_profile||[]).map(p=>[p.time,p])).values()].sort((a,b)=>a.time-b.time);}
    cue.speech_correction={original_text:original,original_source:group[0].source,corrected_text:text,reference_source:ref.source,reference_video_id:doc.video_id,reference_start:ref.start,reference_end:tail.end,similarity:round(score,4),word_timing_status:'cleared_after_source_correction',original_words:group.flatMap(c=>c.words||[])};
    cue.source+='+'+ref.source;group.forEach(c=>used.add(c.id));replacements.push(cue);count++;
  }
  doc.cues=doc.cues.filter(c=>!used.has(c.id)).concat(replacements).sort((a,b)=>a.start-b.start||a.end-b.end);
  doc.metadata[screen?'screen_correction':'speech_reference']={available:refs.length,corrected:count,method:screen?'Tesseract word-length weighted confidence >=90/100; >=3 distinct repeated observations over >=0.8s; timestamp, character and Hangul-jamo agreement; exact source text':'timestamp and lexical agreement; exact caption text; native human authorship unverified'};
  return doc;
}
function minRatio(a,b){return Math.min(a.length,b.length)/Math.max(a.length,b.length,1);}
