import test from 'node:test';
import assert from 'node:assert/strict';
import {createFrameCollector} from './screen-frames.js';
const video={videoWidth:1280,videoHeight:720};
const snap=time=>({videoId:'abcdefghijk',time,ad:false,paused:false});
test('video pixels only: crop and timestamps, ads, pauses and video changes are bounded',()=>{
 const draws=[];const c=createFrameCollector(()=>({getContext:()=>({drawImage:(...x)=>draws.push(x)}),toDataURL:()=> 'data:image/jpeg;base64,YWJj'}));
 c.reset('abcdefghijk');c.observe(video,snap(1));c.observe(video,snap(1.1));c.observe(video,{...snap(2),ad:true});c.observe(video,{...snap(3),paused:true});c.observe(video,{...snap(4),videoId:'zzzzzzzzzzz'});
 assert.equal(c.snapshot().length,1);assert.equal(draws[0][0],video);assert.equal(draws[0][2],432);
 c.observe(video,snap(1.25));assert.equal(c.snapshot().length,1);
 c.observe(video,snap(1.5));assert.equal(c.snapshot().length,2);
 for(let t=2;t<100;t+=.25)c.observe(video,snap(t));assert.equal(c.snapshot().length,121);
 c.reset('abcdefghijk');assert.equal(c.snapshot().length,0);
});
test('canvas denial is respected and does not break audio collection',()=>{
 let attempts=0;const c=createFrameCollector(()=>{attempts++;throw new Error('SecurityError');});
 c.reset('abcdefghijk');c.observe(video,snap(1));c.observe(video,snap(2));assert.equal(attempts,1);assert.equal(c.status(),'unavailable');assert.deepEqual(c.snapshot(),[]);
});
