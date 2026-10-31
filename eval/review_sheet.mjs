// Listening sheet for reviewers: one row per reference line with a timestamped link,
// the screen-subtitle text and each system's text. Reviewers fill final_text/status and
// copy the result back into case.json (status 'human-verified' or 'disputed').
// Usage: node eval/review_sheet.mjs --case <case.json> --run <label>=<result.json> [...] --out <sheet.csv>
import fs from 'node:fs';
import {PAD} from './score_captions.mjs';

const args = process.argv.slice(2), get = name => args[args.indexOf(name) + 1];
if (!args.includes('--case') || !args.includes('--out')) {console.error('usage: review_sheet.mjs --case <case.json> --run <label>=<result.json> [...] --out <sheet.csv>'); process.exit(2);}
const testCase = JSON.parse(fs.readFileSync(get('--case'), 'utf8')), refs = testCase.speech_reference || [];
const runs = args.flatMap((a, i) => a === '--run' ? [args[i + 1].split(/=(.*)/s)] : []).map(([label, file]) => {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')), doc = raw.result?.cues ? raw.result : raw;
  return {label, speech: doc.cues.filter(c => c.kind === 'speech')};
});
const csv = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
const rows = [['id', 'start', 'end', 'listen', 'screen_text', ...runs.map(r => r.label), 'status', 'reviewer_1', 'reviewer_2', 'final_text', 'notes']];
for (const [i, ref] of refs.entries()) {
  // Cues overlapping this line with the same slack the score uses.
  const texts = runs.map(r => r.speech.filter(c => Math.min(ref.end + PAD, c.end) - Math.max(ref.start - PAD, c.start) > 0).map(c => `[${c.start}–${c.end}] ${c.text}`).join(' / '));
  rows.push([ref.id, ref.start, ref.end, `https://www.youtube.com/watch?v=${testCase.video_id}&t=${Math.max(0, Math.floor(ref.start - 1))}s`, ref.text, ...texts, ref.status, '', '', '', '']);
}
fs.writeFileSync(get('--out'), '﻿' + rows.map(r => r.map(csv).join(',')).join('\r\n') + '\r\n'); // BOM: Excel opens Korean correctly
console.log(`${refs.length} rows -> ${get('--out')}`);
