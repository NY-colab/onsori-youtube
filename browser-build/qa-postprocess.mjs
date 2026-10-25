// Replay saved real inference only. This does NOT rerun or relabel model output.
import fs from 'node:fs/promises';import path from 'node:path';import {fileURLToPath} from 'node:url';import assert from 'node:assert/strict';
import {removeAsrMetaTags} from '../extension/browser-engine-signal.js';import {isDecoderLoop} from '../extension/browser-engine-asr.js';import {validateDocument} from '../extension/core.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),qa=path.resolve(root,'../../work/onsori/browser-store/engine-qa'),source='actual-inference-60.json';
const report=JSON.parse(await fs.readFile(path.join(qa,source),'utf8')),before=report.result,after=validateDocument(removeAsrMetaTags(structuredClone(before))),removed=after.metadata.asr_tag_filter?.removed||[];
assert.deepEqual(removed.map(c=>c.text),['(끝)','(끝끝)']);assert.equal(after.cues.length,before.cues.length-2);
assert.deepEqual(after.cues,before.cues.filter(c=>!removed.some(r=>r.text===c.text&&r.start===c.start&&r.end===c.end)));
for(const row of before.metadata.asr_diagnostics?.rejected||[])assert.ok(isDecoderLoop(row.text,row.end-row.start),'current non-overlapping periodicity filter preserves observed rejection');
const result={source_report:source,inference_repeated:false,method:'Current production pure postprocessor replay over saved actual 60s model document. Original inference report remains unchanged.',removed,document:after};
await fs.writeFile(path.join(qa,'postprocess-60.json'),JSON.stringify(result,null,2));await fs.writeFile(path.join(qa,'engine-document-60.json'),JSON.stringify(after,null,2));console.log(JSON.stringify({source,inference_repeated:false,removed,speech:after.cues.filter(c=>c.kind==='speech').map(c=>({start:c.start,end:c.end,text:c.text}))},null,2));
