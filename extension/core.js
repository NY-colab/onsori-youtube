export const DEFAULT_SETTINGS = Object.freeze({typographyVersion:2,autoAnalyze:true,enabled:true,showSpeech:true,showSound:true,showMusic:true,infoLevel:'standard',effectStrength:1,baseSize:14,offset:0,positionX:50,positionY:88});
export const KIND_NAMES = Object.freeze({speech:'대사',sound:'효과음',music:'음악'});
export function normalizeSettings(value={}) {
  const s={...DEFAULT_SETTINGS};
  for(const key of ['autoAnalyze','enabled','showSpeech','showSound','showMusic']) if(typeof value[key]==='boolean') s[key]=value[key];
  if(['simple','standard','rich'].includes(value.infoLevel)) s.infoLevel=value.infoLevel;
  if([0,.5,1].includes(Number(value.effectStrength))) s.effectStrength=Number(value.effectStrength);
  // Migrate stored pre-v2 preferences exactly once, including custom sizes.
  if(value.baseSize!=null&&Number.isFinite(Number(value.baseSize))) s.baseSize=Math.min(28,Math.max(8,Number(value.baseSize)*(value.typographyVersion===2?1:.5)));
  if(Number.isFinite(Number(value.offset))) s.offset=Math.min(30,Math.max(-30,Number(value.offset)));
  for(const key of ['positionX','positionY']) if(value[key]!=null&&Number.isFinite(Number(value[key]))) s[key]=Math.min(100,Math.max(0,Number(value[key])));
  return s;
}
function fail(message){throw new Error(message);}
function number(value,label,min,max){if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max) fail(`${label} 값이 올바르지 않습니다.`);return value;}
function string(value,label,max=5000){if(typeof value!=='string'||value.length>max) fail(`${label}은 ${max}자 이내의 문자열이어야 합니다.`);return value.replace(/\u0000/g,'');}
function nullableNumber(value,label,min,max){return value==null?null:number(value,label,min,max);}
export function validateDocument(input){
  if(!input||typeof input!=='object'||Array.isArray(input)) fail('자막 JSON 객체를 선택해 주세요.');
  if(input.schema_version!=='1.0') fail('지원하는 자막 형식은 schema_version 1.0입니다.');
  const duration=number(input.duration,'영상 길이',Number.MIN_VALUE,86400);
  const video_id=input.video_id==null?null:string(input.video_id,'영상 ID',11);
  if(video_id!==null&&!/^[A-Za-z0-9_-]{11}$/.test(video_id))fail('YouTube 영상 ID는 영문, 숫자, _ 또는 -로 구성된 11자리여야 합니다.');
  if(!Array.isArray(input.cues)||input.cues.length>10000) fail('자막은 10,000개 이하여야 합니다.');
  const ids=new Set();
  const cues=input.cues.map((c,i)=>{
    if(!c||typeof c!=='object'||Array.isArray(c)) fail(`${i+1}번 자막 형식이 올바르지 않습니다.`);
    const id=string(c.id,`${i+1}번 ID`,100);if(!id||ids.has(id)) fail('자막 ID가 비어 있거나 중복됩니다.');ids.add(id);
    const start=number(c.start,`${i+1}번 시작 시간`,0,86400),end=number(c.end,`${i+1}번 종료 시간`,0,86400);
    if(end<=start||end>duration+.05) fail(`${i+1}번 자막의 시간 범위가 영상 길이와 맞지 않습니다.`);
    if(!Object.hasOwn(KIND_NAMES,c.kind)) fail(`${i+1}번 자막 유형이 올바르지 않습니다.`);
    const text=string(c.text,`${i+1}번 자막`,2000);if(!text.length)fail(`${i+1}번 자막 내용을 입력해 주세요.`);
    const cue={id,start,end,text,kind:c.kind,dbfs:nullableNumber(c.dbfs,'음량',-120,12),relative_db:nullableNumber(c.relative_db,'상대 음량',-120,120),scale:number(c.scale??1,'크기 배율',.75,1.55),confidence:nullableNumber(c.confidence,'신뢰도',0,1),source:string(c.source??'import','분석 출처',200),review_required:typeof c.review_required==='boolean'?c.review_required:true};
    if(Object.hasOwn(c,'volume_profile')){
      if(!Array.isArray(c.volume_profile)||c.volume_profile.length>12002)fail('시간별 음량 정보는 12,002개 이하여야 합니다.');
      let previous=-Infinity;
      cue.volume_profile=c.volume_profile.map(point=>{
        if(!point||typeof point!=='object'||Array.isArray(point))fail('시간별 음량 정보 형식이 올바르지 않습니다.');
        const time=number(point.time,'음량 시각',Math.max(0,start-.05),Math.min(86400,end+.05));
        if(time<=previous)fail('음량 시각은 중복 없이 증가해야 합니다.');previous=time;
        return {time,scale:number(point.scale,'시간별 크기 배율',.75,1.55),dbfs:number(point.dbfs,'시간별 음량',-120,12)};
      });
    }
    if(c.details!=null) cue.details=string(c.details,'상세 설명',4000);
    if(c.speech_correction!=null){
      const r=c.speech_correction;
      if(!r||typeof r!=='object'||!['youtube-human-caption','youtube-native-caption','youtube-screen-ocr'].includes(r.reference_source)||r.reference_video_id!==video_id)fail('대사 교정 출처가 올바르지 않습니다.');
      const reference_start=number(r.reference_start,'참조 시작',0,86400),reference_end=number(r.reference_end,'참조 종료',0,86400);
      if(reference_end<=reference_start||!Array.isArray(r.original_words)||r.original_words.length>1000)fail('대사 교정 기록이 올바르지 않습니다.');
      cue.speech_correction={original_text:string(r.original_text,'교정 전 대사',2000),original_source:string(r.original_source,'교정 전 출처',200),corrected_text:string(r.corrected_text,'교정 대사',2000),reference_source:r.reference_source,reference_video_id:video_id,reference_start,reference_end,similarity:number(r.similarity,'대사 일치도',0,1),word_timing_status:'cleared_after_source_correction',original_words:r.original_words.map(w=>{const start=number(w.start,'원본 단어 시작',0,86400),end=number(w.end,'원본 단어 종료',0,86400);if(end<=start)fail('원본 단어 시각이 올바르지 않습니다.');return {start,end,text:string(w.text,'원본 단어',500)};})};
    }
    if(c.words!=null){if(!Array.isArray(c.words)||c.words.length>1000) fail('단어 정보가 너무 많습니다.');cue.words=c.words.map(w=>{const ws=number(w.start,'단어 시작',Math.max(0,start-.05),Math.min(86400,end+.05)),we=number(w.end,'단어 종료',Math.max(0,start-.05),Math.min(86400,end+.05));if(we<=ws)fail('단어 시간 범위가 올바르지 않습니다.');return {start:ws,end:we,text:string(w.text,'단어',500)};});}
    return cue;
  }).sort((a,b)=>a.start-b.start||a.end-b.end);
  const warnings=Array.isArray(input.warnings)?input.warnings.slice(0,100).map(w=>string(w,'알림',2000)):[];
  // Copy only plain JSON metadata and impose a bounded serialized size.
  let metadata={};if(input.metadata&&typeof input.metadata==='object'&&!Array.isArray(input.metadata)){const raw=JSON.stringify(input.metadata);if(raw.length>200000)fail('메타데이터가 너무 큽니다.');metadata=JSON.parse(raw);}
  return {schema_version:'1.0',video_id,title:string(input.title??'제목 없는 자막','제목',300),duration,cues,warnings,metadata};
}
export function parseDocument(text){if(typeof text!=='string'||text.length>10*1024*1024)fail('자막 JSON은 10MB 이하만 가져올 수 있습니다.');let value;try{value=JSON.parse(text);}catch{fail('JSON 파일을 읽을 수 없습니다. 파일 내용을 확인해 주세요.');}return validateDocument(value);}
export function youtubeId(value){try{const u=new URL(value);if(!['youtube.com','www.youtube.com','m.youtube.com','youtu.be'].includes(u.hostname)||!['http:','https:'].includes(u.protocol))return null;const id=u.hostname==='youtu.be'?u.pathname.slice(1).split('/')[0]:u.pathname==='/watch'?u.searchParams.get('v'):u.pathname.match(/^\/(shorts|embed|live)\/([^/]+)/)?.[2];return /^[\w-]{11}$/.test(id||'')?id:null;}catch{return null;}}
export function activeCues(doc,time,settings=DEFAULT_SETTINGS){if(!doc||!settings.enabled||!Number.isFinite(time))return [];const at=time-Number(settings.offset||0);return doc.cues.filter(c=>c.start<=at&&c.end>at&&settings[{speech:'showSpeech',sound:'showSound',music:'showMusic'}[c.kind]]);}
function volumePointAt(profile,time){
  if(time<=profile[0].time)return {...profile[0],time};
  if(time>=profile.at(-1).time)return {...profile.at(-1),time};
  let low=0,high=profile.length-1;
  while(high-low>1){const mid=(low+high)>>1;if(profile[mid].time<=time)low=mid;else high=mid;}
  const a=profile[low],b=profile[high],ratio=(time-a.time)/(b.time-a.time);
  return {time,scale:a.scale+(b.scale-a.scale)*ratio,dbfs:a.dbfs+(b.dbfs-a.dbfs)*ratio};
}
// Timing edits keep the measured curve within the newly selected interval.
export function trimVolumeProfile(profile,start,end){
  if(!profile?.length)return undefined;
  const points=profile.filter(p=>p.time>start&&p.time<end);
  // At most two new edge points; retain the validated document size bound.
  if(points.length>12000)points.splice(12000);
  return [volumePointAt(profile,start),...points,volumePointAt(profile,end)];
}
export function captionSize(cue,settings=DEFAULT_SETTINGS){
  // The analyzer calculates scale from RMS over the entire cue interval.
  // Keep that value throughout the cue; the 100 ms profile is diagnostic only.
  const scale=cue.scale??1;
  return Math.round(settings.baseSize*(1+(scale-1)*settings.effectStrength)*10)/10;
}
export function readyDocument(entry,operation={},videoId){
  if(!entry?.ready||entry.displayVersion!==2||entry.document?.video_id!==videoId)return null;
  if(operation.videoId===videoId&&['requesting','preparing','capturing','uploading','queued','running'].includes(operation.phase))return null;
  if(entry.origin!=='import'&&(entry.document.metadata?.partial===true||entry.document.metadata?.audio_analyzed===false))return null;
  return entry.document;
}
export function captionText(cue,level='standard'){
  if(cue.kind==='speech')return cue.text;
  if(level==='simple')return `[${KIND_NAMES[cue.kind]}]`;
  // Also covers documents cached before the music wording update.
  const legacy=cue.kind==='music'&&/미확인|분석 실패|분석 불가/.test(cue.text);
  const text=legacy?`♪ ${cue.relative_db>=8?'크게 들리는 ':cue.relative_db<=-8?'작게 들리는 ':''}배경 음악이 이어짐`:cue.text;
  const base=text.startsWith('[')?text:`[${text}]`;
  return level==='rich'&&cue.details&&!legacy?`${base} · ${cue.details}`:base;
}
export function clockTime(seconds,decimal=false){const t=Math.max(0,Number(seconds)||0),h=Math.floor(t/3600),m=Math.floor(t%3600/60),s=Math.floor(t%60);return `${h?`${h}:`:''}${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}${decimal?'.'+String(Math.floor((t%1)*1000)).padStart(3,'0'):''}`;}
export function subtitleFile(doc,format){const d=validateDocument(doc);if(format==='json')return JSON.stringify(d,null,2);if(!['srt','vtt'].includes(format))fail('지원하지 않는 내보내기 형식입니다.');const stamp=s=>{const ms=Math.round(s*1000),h=Math.floor(ms/3600000),m=Math.floor(ms%3600000/60000),sec=Math.floor(ms%60000/1000);return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}${format==='srt'?',':'.'}${String(ms%1000).padStart(3,'0')}`;};
  // Conventional subtitle players generally show only one event at a time.
  // Flatten overlap boundaries so dialogue and sound descriptions remain together.
  const points=[...new Set(d.cues.flatMap(c=>[Math.round(c.start*1000)/1000,Math.round(c.end*1000)/1000]))].sort((a,b)=>a-b),intervals=[];
  for(let i=0;i<points.length-1;i++){const a=points[i],b=points[i+1],active=d.cues.filter(c=>c.start<b-.0001&&c.end>a+.0001).sort((x,y)=>(x.kind!=='speech')-(y.kind!=='speech')||x.start-y.start||x.id.localeCompare(y.id));if(!active.length||b<=a)continue;const text=active.map(c=>c.text.replace(/</g,'‹').replace(/>/g,'›').replace(/\r/g,'').replace(/\n\n/g,'\n')).join('\n');const last=intervals.at(-1);if(last&&last.text===text&&Math.abs(last.end-a)<.001)last.end=b;else intervals.push({start:a,end:b,text});}
  return (format==='vtt'?'WEBVTT\n\n':'')+intervals.map((c,i)=>`${i+1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.text}\n`).join('\n')+'\n';
}

// Keep simultaneous captions inside the picture using one common scale factor.
// This preserves the relative loud/quiet size ratio while avoiding top clipping.
export function fitCaptionBox(box,maxHeight){
  const rows=[...box.children];if(!rows.length||maxHeight<=0)return 1;
  const sizes=rows.map(row=>parseFloat(getComputedStyle(row).fontSize));let factor=1;
  for(let i=0;i<8&&box.getBoundingClientRect().height>maxHeight+.5;i++){
    factor*=Math.min(.95,Math.sqrt(maxHeight/box.getBoundingClientRect().height)*.95);
    rows.forEach((row,j)=>row.style.setProperty('font-size',`${sizes[j]*factor}px`,'important'));
  }
  return factor;
}

// Reuse caption nodes during playback. Quantization avoids needless layout work;
// every changed fit starts from desired sizes, never from previously shrunk rows.
const captionLayouts=new WeakMap();
export function updateCaptionSizes(box,cues,settings,time,responsiveScale,maxHeight,layoutKey=''){
  const rows=[...box.children],sizes=cues.map(c=>Math.round(captionSize(c,settings,time)*responsiveScale*2)/2);
  const key=`${layoutKey}|${maxHeight}|${sizes.join(',')}`,previous=captionLayouts.get(box);
  if(previous?.key===key&&rows.length===previous.rows.length&&rows.every((row,i)=>row===previous.rows[i]))return false;
  rows.forEach((row,i)=>{if(sizes[i]!==undefined){row.style.setProperty('font-size',`${sizes[i]}px`,'important');row.style.setProperty('--cue-size',`${sizes[i]}px`);row.style.setProperty('--font-size',`${sizes[i]}px`);}});
  fitCaptionBox(box,maxHeight);captionLayouts.set(box,{key,rows});return true;
}

// Coordinates are the caption box center within the visible picture. Clamp the
// measured box to the intersection of video and viewport, including fullscreen.
export function captionPosition(settings,bounds,size){
  const width=Math.max(0,bounds.width),height=Math.max(0,bounds.height);
  const halfW=Math.min(width,Math.max(0,size.width))/2,halfH=Math.min(height,Math.max(0,size.height))/2;
  const clamp=(value,min,max)=>Math.min(max,Math.max(min,value));
  return {left:bounds.left+clamp(width*settings.positionX/100,halfW,width-halfW),top:bounds.top+clamp(height*settings.positionY/100,halfH,height-halfH)};
}
