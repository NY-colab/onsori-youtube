// Score one or more OnSori caption results against an evaluation case.
// Usage: node eval/score_captions.mjs --case <case.json> --run <label>=<result.json> [...] --out <report.json> [--md <report.md>]
// A result may be a caption document or a qa-inference wrapper ({result: document}).
// Nothing here edits captions: it only measures, so a better score cannot come from
// rewriting a sentence for this video.
import fs from 'node:fs';
import path from 'node:path';
import {INSTRUMENTS, MOODS, GENRES, VOCALS, EVENTS} from '../extension/browser-engine-vocabulary.js';

export const PAD = 1.0; // seconds of slack around a reference line (subtitle display time vs speech time)
// Internal analysis/diagnostic wording that must never reach viewers.
export const DIAGNOSTIC = /미확인|분석\s*실패|확인되지\s*않|진단|오류|unknown|error|undefined|null/i;

export function normalize(text, keepSpaces = false) {
  const t = String(text || '').normalize('NFC').replace(/[^\p{L}\p{N}\s]/gu, '');
  return keepSpaces ? t.replace(/\s+/gu, ' ').trim() : t.replace(/\s+/gu, '');
}
export function editDistance(a, b) {
  const x = Array.from(a), y = Array.from(b);
  let prev = Array.from({length: y.length + 1}, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[y.length];
}
const overlap = (a, b, pad = 0) => Math.min(a.end + pad, b.end) - Math.max(a.start - pad, b.start);

// Group reference lines and hypothesis cues that overlap in time, so one long ASR cue
// covering two subtitle lines (or the reverse) is compared as a whole.
export function alignSpeech(refs, hyps, pad = PAD) {
  const nodes = [...refs.map((r, i) => ({type: 'ref', i, start: r.start, end: r.end})), ...hyps.map((h, i) => ({type: 'hyp', i, start: h.start, end: h.end}))];
  const parent = nodes.map((_, i) => i), find = i => parent[i] === i ? i : (parent[i] = find(parent[i]));
  for (let a = 0; a < nodes.length; a++) for (let b = a + 1; b < nodes.length; b++) {
    const [r, h] = nodes[a].type === 'ref' ? [nodes[a], nodes[b]] : [nodes[b], nodes[a]];
    if (r.type === 'ref' && h.type === 'hyp' && overlap(r, h, pad) > 0) parent[find(a)] = find(b);
  }
  const groups = new Map();
  nodes.forEach((n, k) => {const g = groups.get(find(k)) || {refs: [], hyps: []}; g[n.type === 'ref' ? 'refs' : 'hyps'].push(n.i); groups.set(find(k), g);});
  return [...groups.values()].map(g => ({refs: g.refs.sort((a, b) => refs[a].start - refs[b].start), hyps: g.hyps.sort((a, b) => hyps[a].start - hyps[b].start)}))
    .sort((a, b) => Math.min(...a.refs.map(i => refs[i].start), ...a.hyps.map(i => hyps[i].start)) - Math.min(...b.refs.map(i => refs[i].start), ...b.hyps.map(i => hyps[i].start)));
}

const claimWords = Object.fromEntries([['instrument', INSTRUMENTS], ['mood', MOODS], ['genre', GENRES], ['vocal', VOCALS]]
  .map(([k, vocab]) => [k, Object.values(vocab).sort((a, b) => b.length - a.length)]));
export function musicClaims(text) {
  const claims = [];
  let rest = String(text || '');
  for (const [kind, words] of Object.entries(claimWords)) for (const word of words) {
    if (rest.includes(word)) {claims.push({kind, word}); rest = rest.split(word).join(' ');}
  }
  return claims;
}
const median = xs => {if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;};
const round = (x, d = 3) => x == null ? null : Math.round(x * 10 ** d) / 10 ** d;

export function scoreRun(testCase, doc) {
  const refs = testCase.speech_reference || [], cues = doc.cues || [];
  const speech = cues.filter(c => c.kind === 'speech'), music = cues.filter(c => c.kind === 'music'), sound = cues.filter(c => c.kind === 'sound');
  const groups = alignSpeech(refs, speech);
  let edits = 0, chars = 0, editsSpaced = 0, charsSpaced = 0;
  const lines = [], unreferenced = [], startErr = [], endErr = [];
  for (const g of groups) {
    const refText = g.refs.map(i => refs[i].text).join(' '), hypText = g.hyps.map(i => speech[i].text).join(' ');
    if (!g.refs.length) {unreferenced.push({start: speech[g.hyps[0]].start, end: speech[g.hyps.at(-1)].end, text: hypText}); continue;}
    const r = normalize(refText), h = normalize(hypText), e = editDistance(r, h);
    const rs = normalize(refText, true), hs = normalize(hypText, true);
    edits += e; chars += Array.from(r).length; editsSpaced += editDistance(rs, hs); charsSpaced += Array.from(rs).length;
    const rStart = refs[g.refs[0]].start, rEnd = refs[g.refs.at(-1)].end;
    if (g.hyps.length) {startErr.push(Math.abs(speech[g.hyps[0]].start - rStart)); endErr.push(Math.abs(speech[g.hyps.at(-1)].end - rEnd));}
    lines.push({ref_ids: g.refs.map(i => refs[i].id), status: [...new Set(g.refs.map(i => refs[i].status))].join('+'),
      start: round(rStart, 2), end: round(rEnd, 2), reference: refText, hypothesis: hypText || null,
      cer: round(Array.from(r).length ? e / Array.from(r).length : 0), missing: !g.hyps.length,
      corrected_by: [...new Set(g.hyps.map(i => speech[i].speech_correction?.reference_source).filter(Boolean))]});
  }
  // Sizes: each cue carries one scale for its whole display. Flag only adjacent pieces of
  // one unfinished sentence whose scales differ visibly, i.e. a paragraph that jumps.
  const jumps = [];
  for (let i = 1; i < speech.length; i++) {
    const a = speech[i - 1], b = speech[i];
    if (b.start - a.end < .25 && !/[.?!…。]["'」』)]*\s*$/u.test(a.text) && Math.abs((a.scale ?? 1) - (b.scale ?? 1)) >= .05)
      jumps.push({at: round(b.start, 2), from: a.scale, to: b.scale, before: a.text, after: b.text});
  }
  const scaleStats = list => list.length ? {min: Math.min(...list.map(c => c.scale ?? 1)), max: Math.max(...list.map(c => c.scale ?? 1))} : null;
  const labeled = (testCase.music_reference || []).filter(m => m.status === 'human-labeled');
  const musicRows = music.map(c => {
    const claims = musicClaims(c.text), labels = labeled.filter(m => overlap(m, c) > 0);
    const supported = claims.map(cl => {
      if (!labels.length) return {...cl, verdict: 'unlabeled'};
      const ok = labels.some(m => cl.kind === 'instrument' ? (m.instruments || []).includes(cl.word) : cl.kind === 'mood' ? m.mood === cl.word : cl.kind === 'genre' ? m.genre === cl.word : (m.vocals || []).includes(cl.word));
      return {...cl, verdict: ok ? 'supported' : 'unsupported'};
    });
    return {start: c.start, end: c.end, text: c.text, scale: c.scale, claims: supported};
  });
  const claimsAll = musicRows.flatMap(m => m.claims);
  return {
    counts: {speech: speech.length, music: music.length, sound: sound.length},
    speech: {reference_lines: refs.length, scored_groups: lines.length, cer_nospace: round(chars ? edits / chars : null), cer_spaced: round(charsSpaced ? editsSpaced / charsSpaced : null),
      reference_chars: chars, edits, missing_groups: lines.filter(l => l.missing).length, exact_groups: lines.filter(l => !l.missing && l.cer === 0).length,
      unreferenced_cues: unreferenced.length, timing_abs_error_s: {start_median: round(median(startErr), 2), end_median: round(median(endErr), 2)},
      errors: lines.filter(l => l.cer > 0).sort((a, b) => b.cer - a.cer), unreferenced},
    music: {cues: music.length, generic: musicRows.filter(m => !m.claims.length).length, with_claims: musicRows.filter(m => m.claims.length).length,
      claims: {total: claimsAll.length, supported: claimsAll.filter(c => c.verdict === 'supported').length, unsupported: claimsAll.filter(c => c.verdict === 'unsupported').length, unlabeled: claimsAll.filter(c => c.verdict === 'unlabeled').length},
      labeled_segments: labeled.length, rows: musicRows},
    // Speech may legitimately say "오류"; diagnostics only ever leak through generated sound/music text.
    viewer_text: {diagnostic_leaks: cues.filter(c => c.kind !== 'speech' && DIAGNOSTIC.test(c.text)).map(c => ({kind: c.kind, start: c.start, text: c.text}))},
    size: {speech: scaleStats(speech), music: scaleStats(music), sound: scaleStats(sound), paragraph_jumps: jumps},
    sound: {cues: sound.map(c => ({start: c.start, end: c.end, text: c.text}))},
  };
}

// Sound events present in a baseline run but absent (no time overlap) in a stem run.
export function lostSounds(base, stem) {
  const other = (stem.cues || []).filter(c => c.kind === 'sound');
  return (base.cues || []).filter(c => c.kind === 'sound' && !other.some(o => overlap(o, c, .5) > 0)).map(c => ({start: c.start, end: c.end, text: c.text}));
}

function markdown(report) {
  const runs = Object.entries(report.runs), out = [`# 온소리 평가 · ${report.case_id}`, '', `- 영상: ${report.video_id} · 기준 대사 ${report.reference_lines}줄 (상태: ${JSON.stringify(report.reference_status)})`, `- 생성: ${report.generated_at}`, '- CER은 화면 자막 OCR 초안 대비이며 사람 청취 확인 전에는 참고 수치다.', ''];
  out.push('| 실행 | 대사/음악/효과음 | CER(공백 제외) | CER(공백 포함) | 정확 일치 그룹 | 누락 그룹 | 기준 없는 대사 | 음악 구체 묘사 | 근거 없는 묘사 | 내부 문구 노출 | 단락 크기 점프 |', '|---|---|---|---|---|---|---|---|---|---|---|');
  for (const [label, r] of runs) out.push(`| ${label} | ${r.counts.speech}/${r.counts.music}/${r.counts.sound} | ${r.speech.cer_nospace} | ${r.speech.cer_spaced} | ${r.speech.exact_groups}/${r.speech.scored_groups} | ${r.speech.missing_groups} | ${r.speech.unreferenced_cues} | ${r.music.with_claims}/${r.music.cues} | ${r.music.claims.unsupported} (미라벨 ${r.music.claims.unlabeled}) | ${r.viewer_text.diagnostic_leaks.length} | ${r.size.paragraph_jumps.length} |`);
  for (const [label, r] of runs) {
    out.push('', `## ${label} · 오류 상위 12개`, '', '| 시각 | 기준(화면 자막) | 인식 결과 | CER |', '|---|---|---|---|');
    for (const e of r.speech.errors.slice(0, 12)) out.push(`| ${e.start}–${e.end} | ${e.reference} | ${e.hypothesis ?? '(누락)'} | ${e.cer} |`);
  }
  if (report.stem_effects?.length) {out.push('', '## 분리 입력의 효과음 손실 후보', ''); for (const s of report.stem_effects) out.push(`- ${s.base} → ${s.stem}: ${s.lost.length}건 ${s.lost.slice(0, 6).map(x => `${x.start}s ${x.text}`).join(', ')}`);}
  return out.join('\n') + '\n';
}

if (import.meta.url === new URL(process.argv[1], 'file:').href || process.argv[1]?.endsWith('score_captions.mjs')) {
  const args = process.argv.slice(2), get = name => args[args.indexOf(name) + 1];
  if (!args.includes('--case') || !args.includes('--run') || !args.includes('--out')) {
    console.error('usage: score_captions.mjs --case <case.json> --run <label>=<result.json> [...] --out <report.json> [--md <report.md>] [--stem <base>:<stem>]');
    process.exit(2);
  }
  const testCase = JSON.parse(fs.readFileSync(get('--case'), 'utf8'));
  const docs = {};
  args.forEach((a, i) => {
    if (a !== '--run') return;
    const [label, file] = args[i + 1].split(/=(.*)/s);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')), doc = raw.result?.cues ? raw.result : raw;
    if (!Array.isArray(doc.cues)) throw new Error(`${file}: no cues`);
    if (doc.video_id !== testCase.video_id) throw new Error(`${file}: video ${doc.video_id} is not ${testCase.video_id}`);
    docs[label] = {file: path.resolve(file), doc};
  });
  const report = {case_id: testCase.case_id, video_id: testCase.video_id, generated_at: new Date().toISOString(),
    reference_lines: (testCase.speech_reference || []).length,
    reference_status: (testCase.speech_reference || []).reduce((m, r) => ({...m, [r.status]: (m[r.status] || 0) + 1}), {}),
    runs: Object.fromEntries(Object.entries(docs).map(([label, {file, doc}]) => [label, {file, ...scoreRun(testCase, doc)}])),
    stem_effects: args.flatMap((a, i) => a === '--stem' ? [args[i + 1]] : []).map(pair => {const [base, stem] = pair.split(':'); return {base, stem, lost: lostSounds(docs[base].doc, docs[stem].doc)};})};
  fs.writeFileSync(get('--out'), JSON.stringify(report, null, 2));
  if (args.includes('--md')) fs.writeFileSync(get('--md'), markdown(report));
  for (const [label, r] of Object.entries(report.runs)) console.log(`${label}: CER ${r.speech.cer_nospace} (spaced ${r.speech.cer_spaced}) exact ${r.speech.exact_groups}/${r.speech.scored_groups} missing ${r.speech.missing_groups} unreferenced ${r.speech.unreferenced_cues} | music ${r.music.with_claims}/${r.music.cues} specific, unsupported ${r.music.claims.unsupported} | leaks ${r.viewer_text.diagnostic_leaks.length} | jumps ${r.size.paragraph_jumps.length}`);
}
