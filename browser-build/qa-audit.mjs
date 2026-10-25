import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {validateDocument,captionSize} from '../extension/core.js';
import {volumeStyle} from '../extension/browser-engine-signal.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),qa=path.resolve(root,'../../work/onsori/browser-store/engine-qa');
function wavPcm16(bytes){let rate,channels,data;for(let p=12;p+8<=bytes.length;){const tag=bytes.toString('ascii',p,p+4),size=bytes.readUInt32LE(p+4),start=p+8;if(tag==='fmt '){assert.equal(bytes.readUInt16LE(start),1);channels=bytes.readUInt16LE(start+2);rate=bytes.readUInt32LE(start+4);assert.equal(bytes.readUInt16LE(start+14),16);}if(tag==='data')data=bytes.subarray(start,start+size);p=start+size+(size%2);}assert.equal(rate,16000);assert.equal(channels,1);assert.ok(data);return Float32Array.from({length:data.length/2},(_,i)=>data.readInt16LE(i*2)/32768);}
const results=[];
for(const [report,audio] of [['actual-inference.json','korean.wav'],['actual-inference-60.json','korean-60.wav']]){
  const r=JSON.parse(await fs.readFile(path.join(qa,report),'utf8')),d=validateDocument(r.result),pcm=wavPcm16(await fs.readFile(path.join(qa,audio))),offset=d.metadata.analysis_range[0];
  assert.equal(r.state,'done');assert.equal(r.page_errors.length,0);assert.equal(r.remote_executable_requests.length,0);assert.equal(r.network.filter(x=>x.method!=='GET').length,0);
  for(const cue of d.cues){const expected=volumeStyle(pcm,cue.start-offset,cue.end-offset,d.metadata.reference_dbfs);assert.ok(Math.abs(cue.dbfs-expected.dbfs)<=.03,`${report} ${cue.id}: whole-cue RMS`);assert.ok(Math.abs(cue.scale-expected.scale)<=.002,`${report} ${cue.id}: fixed scale`);assert.equal(captionSize(cue),captionSize({...cue,volume_profile:[]}));}
  assert.ok(d.cues.filter(c=>c.kind==='speech').every(c=>c.end-c.start<=8.001),'speech timestamps stay within independently recognized audio');
  assert.ok((d.metadata.speech_filter?.rejected||[]).every(x=>x.start>=offset&&x.end<=d.duration));
  results.push({report,seconds:pcm.length/16000,cues:d.cues.length,speech:d.cues.filter(c=>c.kind==='speech').length,elapsed_ms:r.elapsed_ms,whole_cue_rms:true,fixed_scale:true,speech_window_bounds:true,no_remote_executable:true,no_upload_requests:true});
}
await fs.writeFile(path.join(qa,'audit.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));
