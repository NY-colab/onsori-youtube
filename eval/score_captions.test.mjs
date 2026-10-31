import test from 'node:test';
import assert from 'node:assert/strict';
import {normalize, editDistance, alignSpeech, musicClaims, scoreRun, lostSounds, DIAGNOSTIC} from './score_captions.mjs';

const cue = (start, end, text, kind = 'speech', extra = {}) => ({start, end, text, kind, scale: 1, ...extra});

test('Korean CER ignores spacing and punctuation but counts syllable substitutions', () => {
  assert.equal(normalize('이것은 옷이오,이불이오?'), '이것은옷이오이불이오');
  assert.equal(normalize('- 한양의  작은 옷 가게.', true), '한양의 작은 옷 가게');
  assert.equal(editDistance(normalize('이것은 옷이오,이불이오?'), normalize('이것은 5시오 이불이요?')), 3);
  assert.equal(editDistance('', '가나'), 2);
});

test('one long ASR cue spanning two subtitle lines is scored as one group', () => {
  const refs = [{id: 's1', start: 18.25, end: 19.25, text: '한양의 작은 옷가게'}, {id: 's2', start: 20.25, end: 23.25, text: '뒤편 창고는 현대와 이어져 있었습니다.'}];
  const hyps = [cue(15, 23, '-한양의 작은 옷 가게 뒤편 창고는 현대와 이어져 있었습니다.'), cue(60, 61, '자막에 없는 말')];
  const groups = alignSpeech(refs, hyps);
  assert.deepEqual(groups.map(g => [g.refs, g.hyps]), [[[0, 1], [0]], [[], [1]]]);
  const r = scoreRun({speech_reference: refs.map(x => ({...x, status: 'screen-ocr-draft'}))}, {cues: hyps});
  assert.equal(r.speech.cer_nospace, 0);
  assert.equal(r.speech.unreferenced_cues, 1);
  assert.equal(r.speech.missing_groups, 0);
});

test('missing speech and substitutions raise CER; errors keep reference and hypothesis', () => {
  const refs = [{id: 's1', start: 5.9, end: 8.2, text: '이것은 옷이오,이불이오?', status: 'screen-ocr-draft'}, {id: 's2', start: 30, end: 31, text: '가벼워요', status: 'human-verified'}];
  const r = scoreRun({speech_reference: refs}, {cues: [cue(5, 8.4, '이것은 5시오 이불이요?')]});
  assert.equal(r.speech.missing_groups, 1);
  assert.equal(r.speech.edits, 3 + 4);
  assert.equal(r.speech.errors[0].missing, true);
  assert.equal(r.speech.errors.find(e => !e.missing).hypothesis, '이것은 5시오 이불이요?');
});

test('viewer text diagnostics, music claims and paragraph size jumps are reported, not fixed', () => {
  assert.ok(DIAGNOSTIC.test('♪ 음악 · 악기·분위기 미확인'));
  assert.ok(!DIAGNOSTIC.test('♪ 배경 음악이 이어짐'));
  assert.deepEqual(musicClaims('♪ 부드럽고 다정한 음악 · 어쿠스틱 기타·피아노 연주').map(c => c.word).sort(), ['부드럽고 다정한', '어쿠스틱 기타', '피아노'].sort());
  assert.deepEqual(musicClaims('♪ 배경 음악이 이어짐'), []);
  const doc = {cues: [cue(0, 2, '그러니까', 'speech', {scale: .8}), cue(2.1, 4, '이건 옷이오.', 'speech', {scale: 1.1}), cue(4.1, 6, '다음 말', 'speech', {scale: .8}),
    cue(0, 10, '♪ 피아노 연주', 'music'), cue(10, 20, '♪ 음악 · 악기·분위기 미확인', 'music')]};
  const r = scoreRun({speech_reference: [], music_reference: [{start: 0, end: 10, status: 'human-labeled', instruments: ['기타']}]}, doc);
  assert.equal(r.size.paragraph_jumps.length, 1); // only the unfinished sentence that changes size
  assert.equal(r.viewer_text.diagnostic_leaks.length, 1);
  assert.equal(r.music.claims.unsupported, 1);
  assert.equal(r.music.generic, 1);
});

test('sound events lost by a stem input are listed by time overlap', () => {
  const base = {cues: [cue(20, 22, '덜컥 문이 움직이는 소리', 'sound'), cue(40, 41, '에취! 재채기 소리', 'sound')]};
  const stem = {cues: [cue(20.3, 21.5, '덜컥 문이 움직이는 소리', 'sound')]};
  assert.deepEqual(lostSounds(base, stem).map(s => s.start), [40]);
});
