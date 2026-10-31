// Build a draft evaluation case from screen-subtitle OCR evidence (server/screen_ocr.py output).
// Usage: node eval/make_case.mjs --ocr <screen-ocr.json> --video-id <id> --duration <s> --title <t> --out <case.json> [--audio <wav>]
// Every speech line starts as 'screen-ocr-draft': machine evidence only. Reviewers change
// status to 'human-verified' (listened and confirmed, text fixed if needed) or 'disputed'.
// An existing case file is never overwritten, so human edits survive re-runs.
import fs from 'node:fs';
import crypto from 'node:crypto';

const args = process.argv.slice(2), get = name => {const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined;};
for (const name of ['--ocr', '--video-id', '--duration', '--out']) if (!get(name)) {console.error(`missing ${name}`); process.exit(2);}
if (fs.existsSync(get('--out'))) {console.error(`${get('--out')} exists; edit it instead of regenerating`); process.exit(1);}
const ocr = JSON.parse(fs.readFileSync(get('--ocr'), 'utf8')), duration = Number(get('--duration'));
const observations = (ocr.observations || []).map(([time, text, confidence]) => ({time, text, confidence}));
const compact = t => String(t).replace(/\s+/gu, '');
const speech = (ocr.references || []).filter(r => r.video_id === get('--video-id')).sort((a, b) => a.start - b.start).map((r, i) => {
  const seen = observations.filter(o => o.time >= r.start && o.time <= r.end && compact(o.text) === compact(r.text));
  return {id: `s${String(i + 1).padStart(3, '0')}`, start: Math.round(r.start * 1000) / 1000, end: Math.round(r.end * 1000) / 1000, text: r.text,
    status: 'screen-ocr-draft', evidence: {source: r.source, model: ocr.model, observations: seen.length,
      min_confidence: seen.length ? Math.min(...seen.map(o => o.confidence)) : null}, review: []};
});
// Neutral 10-second grid for music labels, independent of any system's own music cues.
const music = Array.from({length: Math.ceil(duration / 10)}, (_, i) => ({id: `m${String(i + 1).padStart(3, '0')}`, start: i * 10, end: Math.min(duration, (i + 1) * 10),
  status: 'unlabeled', present: null, instruments: [], mood: null, genre: null, vocals: [], tempo: null, notes: ''}));
const audio = get('--audio') && {path: get('--audio'), sha256: crypto.createHash('sha256').update(fs.readFileSync(get('--audio'))).digest('hex')};
const testCase = {
  case_id: `ref-${get('--video-id').replace(/^-/, '')}`, video_id: get('--video-id'), title: get('--title') || '', duration,
  url: `https://www.youtube.com/watch?v=${get('--video-id')}`, created_at: new Date().toISOString(), audio: audio || null,
  rules: {
    speech: 'Text a viewer hears. Screen subtitles are evidence, not truth: confirm by listening; keep the speaker’s words even if ungrammatical.',
    music: 'Label only what is audible in that window. Use the extension vocabulary words (e.g. 피아노, 기타, 부드럽고 다정한); leave null/[] when unsure.',
    reviewers: 'At least two people label independently, then reconcile. Record each reviewer in review[].',
  },
  speech_reference: speech, music_reference: music, sound_reference: [],
};
fs.writeFileSync(get('--out'), JSON.stringify(testCase, null, 2));
console.log(`speech lines ${speech.length}, music windows ${music.length} -> ${get('--out')}`);
