// Burned-in subtitles read from video frames (user request 2026-11-24): when a video carries its
// dialogue as on-screen text, those lines are used as the speech captions. Pure logic only;
// screen-reader.js samples the frames and runs the OCR.
import {normalized,similarity} from './browser-engine-signal.js';

export const SCREEN_OCR=Object.freeze({
  step:.5,             // seconds between sampled frames
  band:.35,            // bottom share of the picture that is read
  width:.8,            // centred share of its width (subtitles are centred; corners hold logos)
  scale:2,             // enlargement for OCR (360p text is then about 30 px high)
  minConfidence:80,    // Tesseract 0..100, per accepted word group
  singleFrameConfidence:90, // a line seen on one frame only must be this sure
  minHangul:.5,        // share of letters that are Hangul; drops logos, credits and English notices
  probeFrames:16,      // frames sampled over the whole video to decide
  probeShare:.2,       // share of probe frames that must show a subtitle line
  probeMinLines:2,     // distinct texts among those frames
  sameText:.6,         // similarity at which consecutive frames show the same line
});

const letters=text=>Array.from(String(text||'')).filter(c=>/\p{L}/u.test(c));
export function hangulShare(text){const l=letters(text);return l.length?l.filter(c=>/[가-힣ㄱ-ㆎ]/u.test(c)).length/l.length:0;}
// One OCR result -> the subtitle text it shows, or '' when it shows none worth keeping.
export function subtitleText(groups,config=SCREEN_OCR){
  const kept=(groups||[]).filter(g=>g&&g.confidence>=config.minConfidence&&hangulShare(g.text)>=config.minHangul);
  const text=kept.map(g=>String(g.text).trim().replace(/\s+/g,' ')).join(' ').trim();
  return letters(text).length>=2?{text,confidence:Math.min(...kept.map(g=>g.confidence))}:{text:'',confidence:0};
}
// Frames sampled across the whole video decide whether its dialogue is burned in.
export function looksSubtitled(observations,config=SCREEN_OCR){
  const shown=observations.filter(o=>o.text);
  const distinct=[];for(const o of shown){const n=normalized(o.text);if(!distinct.some(d=>similarity(d,n)>=config.sameText))distinct.push(n);}
  return observations.length>0&&shown.length/observations.length>=config.probeShare&&distinct.length>=config.probeMinLines;
}
// Consecutive frames showing the same text become one line timed from its first to its last frame.
// The text is the variant seen most often (ties: higher confidence), so one misread frame does not win.
export function screenLines(observations,config=SCREEN_OCR){
  const rows=[...observations].filter(o=>Number.isFinite(o.time)).sort((a,b)=>a.time-b.time),groups=[];
  // One blank or unreadable frame inside a line (a flash, a fade) does not split it.
  let current=null;
  for(const row of rows){
    if(!row.text)continue;
    const n=normalized(row.text),last=current?.rows.at(-1);
    if(current&&row.time-last.time<=config.step*2.5+1e-6&&similarity(normalized(last.text),n)>=config.sameText)current.rows.push(row);
    else{current={rows:[row]};groups.push(current);}
  }
  return groups.flatMap(({rows})=>{
    if(rows.length===1&&rows[0].confidence<config.singleFrameConfidence)return [];
    const votes=new Map();for(const r of rows){const v=votes.get(r.text)||{text:r.text,count:0,confidence:0};v.count++;v.confidence=Math.max(v.confidence,r.confidence);votes.set(r.text,v);}
    const best=[...votes.values()].sort((a,b)=>b.count-a.count||b.confidence-a.confidence)[0];
    const half=config.step/2;
    return [{start:Math.max(0,Math.round((rows[0].time-half)*1000)/1000),end:Math.round((rows.at(-1).time+half)*1000)/1000,text:best.text,confidence:Math.round(best.confidence)}];
  });
}
