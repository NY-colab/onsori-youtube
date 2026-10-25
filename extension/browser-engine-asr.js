import {normalized,similarity,matchingBlocks} from './browser-engine-signal.js';

export function isDecoderLoop(text,duration){
  const plain=normalized(text);if(plain.length<=80||plain.length/Math.max(.02,duration)<=18)return false;
  for(let size=1;size<=12;size++){const counts=new Map();for(let i=0;i+size<=plain.length;i++){const token=plain.slice(i,i+size),state=counts.get(token)||{count:0,end:0};if(i>=state.end){state.count++;state.end=i+size;counts.set(token,state);}}if([...counts.values()].some(state=>state.count>=8&&state.count*size/plain.length>=.7))return true;}
  return false;
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
      if(isDecoderLoop(text,b-a)){rejected.push({start:a,end:b,text:text.slice(0,2000),reason:'high-rate periodic decoder repetition'});continue;}
      const midpoint=(a+b)/2;candidates.push({text,start:a,end:b,index,owned:midpoint>=left&&(midpoint<right||index===windows.length-1),plain:normalized(text)});
    }
  }
  const selected=[];
  for(const candidate of candidates.sort((a,b)=>Number(b.owned)-Number(a.owned)||b.plain.length-a.plain.length||a.start-b.start)){
    const duplicate=selected.findIndex(previous=>{
      if(Math.abs(previous.index-candidate.index)!==1)return false;
      const overlap=Math.min(previous.end,candidate.end)-Math.max(previous.start,candidate.start);if(overlap<.1||overlap/Math.min(previous.end-previous.start,candidate.end-candidate.start)<.35)return false;
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
  return {text:chunks.map(c=>c.text).join(' '),chunks,diagnostics:{method:'independent 8s audio / 3s overlap; local endpoints bounded to audio; time+text/jamo overlap dedup and center ownership',time_base:'recording-relative seconds',windows:windows.length,rejected}};
}
