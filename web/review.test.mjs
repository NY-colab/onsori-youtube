import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectReviewMedia} from './review.js';
test('same-duration original keeps absolute time and document unchanged',()=>{
  const doc={duration:60,cues:[{start:32,end:35}],metadata:{analyzed_start:30,analyzed_end:60}};
  const before=JSON.stringify(doc),result=inspectReviewMedia(doc,60.2,34);
  assert.equal(result.time,34);assert.deepEqual(result.warnings,[]);assert.equal(JSON.stringify(doc),before);
});
test('full original attached to captured interval warns without shifting or stretching',()=>{
  const doc={duration:60,cues:[{start:30,end:60}],metadata:{analyzed_start:30,analyzed_end:60}};
  const result=inspectReviewMedia(doc,300,180);
  assert.equal(result.time,180);assert.equal(result.warnings.length,2);assert.match(result.warnings.join(' '),/0초 기준/);assert.match(result.warnings.join(' '),/범위 밖/);assert.equal(doc.cues[0].start,30);
});
test('shorter review source clamps transport only and warns about unreachable cues',()=>{
  const doc={duration:60,cues:[{start:50,end:60}]},result=inspectReviewMedia(doc,20,45);
  assert.equal(result.time,20);assert.equal(result.warnings.length,3);assert.equal(doc.cues[0].end,60);
});
