import {normalized,similarity,matchingBlocks} from './browser-engine-signal.js';

export function isDecoderLoop(text,duration){
  // U+FFFD means byte-level tokens did not form valid UTF-8; it is never dialogue.
  if(String(text).includes('�'))return true;
  const plain=normalized(text);
  // One to three characters repeated back to back over most of the text is a
  // decoder loop at any speaking rate (e.g. a syllable emitted for a whole window).
  for(let size=1;size<=3;size++)for(let i=0;i+size*8<=plain.length;i++){
    const unit=plain.slice(i,i+size);let run=1;while(plain.startsWith(unit,i+run*size))run++;
    if(run>=8&&run*size>=plain.length*.6)return true;
  }
  if(plain.length<=80||plain.length/Math.max(.02,duration)<=18)return false;
  for(let size=1;size<=12;size++){const counts=new Map();for(let i=0;i+size<=plain.length;i++){const token=plain.slice(i,i+size),state=counts.get(token)||{count:0,end:0};if(i>=state.end){state.count++;state.end=i+size;counts.set(token,state);}}if([...counts.values()].some(state=>state.count>=8&&state.count*size/plain.length>=.7))return true;}
  return false;
}

const windowShape=windows=>{const i=windows.findIndex((w,k)=>windows[k+1]&&windows[k+1].start<w.end),w=windows[i];return w?`${+(w.end-w.start).toFixed(1)}s / ${+(w.end-windows[i+1].start).toFixed(1)}s overlap`:'non-overlapping';};

// Fixed grid used when AST does not run first (CPU path, or effects disabled).
export function gridWindows(duration,{seconds,step}){const out=[];for(let start=0;start<duration;start+=step){const end=Math.min(start+seconds,duration);out.push({start,end});if(end===duration)break;}return out;}

const SPEECH_LABELS=new Set(['Speech','Conversation','Narration, monologue']);
// Whisper listens only where AST hears speech: padded speech regions split
// into overlapping windows. Pure music/effects windows never reach Whisper,
// and a window starts near the speech so captions do not start early.
export function speechWindows(events,duration,{seconds,step},{threshold=.15,gap=2,pad=.5}={}){
  const regions=[];
  for(const w of [...events].sort((a,b)=>a.start-b.start)){
    if(Math.max(0,...w.labels.filter(x=>SPEECH_LABELS.has(x.label)).map(x=>x.score))<threshold)continue;
    const last=regions.at(-1);if(last&&w.start-last.end<=gap)last.end=Math.max(last.end,w.end);else regions.push({start:w.start,end:w.end});
  }
  const out=[];
  for(const r of regions){
    const s=Math.max(0,r.start-pad),e=Math.min(duration,r.end+pad);
    for(let a=s;;a+=step){const b=Math.min(a+seconds,e);out.push({start:a,end:b});if(b>=e)break;}
  }
  return out;
}

// Independent ASR calls retain their own audio evidence. Never let a missing
// endpoint in one eight-second call extend to the end of the whole recording.
export function mergeAsrWindows(windows){
  const candidates=[],rejected=[];
  for(let index=0;index<windows.length;index++){
    const {start,end,output}=windows[index],duration=end-start;
    if(!(duration>0)||!Number.isFinite(start)||!Number.isFinite(end))throw new Error('ASR 오디오 구간이 올바르지 않습니다.');
    if(output?.text?.trim()&&!Array.isArray(output.chunks))throw new Error('Whisper가 대사 시각을 반환하지 않았습니다.');
    const left=index?(windows[index-1].end+start)/2:start,right=index+1<windows.length?(end+windows[index+1].start)/2:end;
    for(const chunk of output?.chunks||[]){
      const [rawStart,rawEnd]=chunk.timestamp||[],text=String(chunk.text||'').replace(/<\|[^|]*\|>/g,'').trim();if(!text)continue;
      if(!Number.isFinite(rawStart))throw new Error('Whisper 대사 시작 시각이 없습니다.');
      const a=start+Math.max(0,Math.min(duration,rawStart)),b=start+Math.max(0,Math.min(duration,Number.isFinite(rawEnd)?rawEnd:duration));if(b-a<.02)continue;
      if(isDecoderLoop(text,b-a)){rejected.push({start:a,end:b,text:text.slice(0,2000),reason:'periodic decoder repetition or invalid UTF-8'});continue;}
      const midpoint=(a+b)/2;candidates.push({text,start:a,end:b,index,owned:midpoint>=left&&(midpoint<right||index===windows.length-1),plain:normalized(text)});
    }
  }
  const selected=[];
  for(const candidate of candidates.sort((a,b)=>Number(b.owned)-Number(a.owned)||b.plain.length-a.plain.length||a.start-b.start)){
    const duplicate=selected.findIndex(previous=>{
      const distance=Math.abs(previous.index-candidate.index);if(distance>1)return false;
      const overlap=Math.min(previous.end,candidate.end)-Math.max(previous.start,candidate.start),shorter=Math.min(previous.end-previous.start,candidate.end-candidate.start);
      // A sentence repeated verbatim right after itself is a decoder repeat;
      // short replies ("그럼요") may genuinely repeat and are left alone.
      if(previous.plain===candidate.plain&&previous.plain.length>=6&&overlap>-1)return true;
      // A window-boundary fragment contained in the full sentence heard at the same time.
      const [part,whole]=previous.plain.length<=candidate.plain.length?[previous.plain,candidate.plain]:[candidate.plain,previous.plain];
      if(part.length>=2&&part!==whole&&whole.includes(part)&&overlap>=.5*shorter)return true;
      if(distance!==1)return false;
      if(overlap<.1||overlap/shorter<.35)return false;
      if(previous.plain===candidate.plain)return true;
      if(Math.min(previous.plain.length,candidate.plain.length)<4)return false;
      if(similarity(previous.plain,candidate.plain)>=.67&&similarity(previous.plain.normalize('NFD'),candidate.plain.normalize('NFD'))>=.75)return true;
      const coverage=(a,b)=>matchingBlocks(a,b).reduce((sum,block)=>sum+block[2],0)/Math.min(a.length,b.length);
      return overlap/Math.min(previous.end-previous.start,candidate.end-candidate.start)>=.5&&coverage(previous.plain,candidate.plain)>=.85&&coverage(previous.plain.normalize('NFD'),candidate.plain.normalize('NFD'))>=.88;
    });
    if(duplicate<0){selected.push(candidate);continue;}
    // Retain the fuller original utterance if the center-owned version is only
    // a short boundary fragment. Otherwise prefer the center-owned observation.
    const previous=selected[duplicate];
    if(candidate.plain.length>previous.plain.length*1.2||(candidate.owned&&!previous.owned&&candidate.plain.length>=previous.plain.length/1.2))selected[duplicate]=candidate;
  }
  const chunks=selected.sort((a,b)=>a.start-b.start||a.end-b.end).map(c=>({text:c.text,timestamp:[c.start,c.end]}));
  return {text:chunks.map(c=>c.text).join(' '),chunks,diagnostics:{method:`independent ${windowShape(windows)} audio windows; local endpoints bounded to audio; time+text/jamo overlap dedup and center ownership`,time_base:'recording-relative seconds',windows:windows.length,rejected}};
}
