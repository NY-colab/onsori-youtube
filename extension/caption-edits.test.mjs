import test from 'node:test';
import assert from 'node:assert/strict';
import {applyEdits,upsertEdit,editKey,editCount,editableCues,subtitleFile,normalizeSettings,DEFAULT_SETTINGS} from './core.js';
const cue=(patch={})=>({id:'speech-1',start:0,end:4,text:'안녕하세요',kind:'speech',dbfs:-20,relative_db:0,scale:1,confidence:.9,source:'test',review_required:true,...patch});
const doc=(cues,patch={})=>({schema_version:'1.0',video_id:'abcdefghijk',title:'검증 자막',duration:10,cues,warnings:[],metadata:{},...patch});
const ID='abcdefghijk';

test('hand edits replace, hide and restore captions and survive re-analysis renaming',()=>{
  const a=cue({id:'s1',start:1,end:3,text:'금니가 올랐다'}),b=cue({id:'s2',start:4,end:6,text:'둘째 줄'}),d=doc([a,b]);
  assert.equal(editKey(ID),'ed:abcdefghijk');
  let store=upsertEdit(null,ID,a,{text:'  금리가\n올랐다 '});
  let out=applyEdits(d,store);
  assert.equal(out.cues[0].text,'금리가 올랐다');
  assert.equal(out.cues[0].user_edit.original_text,'금니가 올랐다');
  assert.equal(out.cues[0].review_required,false);
  assert.equal(out.cues[1],b);
  assert.equal(editCount(store,ID),1);
  // Re-analysis may rename cue ids; the original text and start still find the edit.
  assert.equal(applyEdits(doc([{...a,id:'x9',start:1.4},b]),store).cues[0].text,'금리가 올랐다');
  // Editing an edited cue keeps one record whose original is the analysis text.
  store=upsertEdit(store,ID,out.cues[0],{text:'금리가 또 올랐다'});
  assert.equal(store.edits.length,1);
  assert.equal(store.edits[0].orig,'금니가 올랐다');
  store=upsertEdit(store,ID,b,{deleted:true});
  assert.deepEqual(applyEdits(d,store).cues.map(c=>c.id),['s1']);
  store=upsertEdit(store,ID,applyEdits(d,store).cues[0],{restore:true});
  assert.equal(applyEdits(d,store).cues[0].text,'금니가 올랐다');
  assert.equal(editCount(store,ID),1);
});

test('typing the original text back removes the edit and an empty box hides the caption',()=>{
  const a=cue({id:'s1',start:1,end:3,text:'금니가 올랐다'});
  assert.equal(upsertEdit(null,ID,a,{text:'금니가 올랐다'}).edits.length,0);
  assert.equal(upsertEdit(null,ID,a,{text:'   '}).edits[0].deleted,true);
  assert.equal(upsertEdit(null,ID,a,{text:'가'.repeat(900)}).edits[0].text.length,500);
});

test('edits stay with their video and are kept in exported JSON',()=>{
  const a=cue({id:'s1',start:1,end:3,text:'금니가 올랐다'}),d=doc([a]);
  assert.equal(applyEdits(d,{...upsertEdit(null,ID,a,{text:'x'}),video_id:'zzzzzzzzzzz'}),d);
  assert.equal(applyEdits(d,null),d);
  const exported=JSON.parse(subtitleFile(applyEdits(d,upsertEdit(null,ID,a,{text:'금리'})),'json'));
  assert.equal(exported.cues[0].text,'금리');
  assert.equal(exported.cues[0].user_edit.original_text,'금니가 올랐다');
});

test('the editor offers the caption on screen, or the one just before the playhead',()=>{
  const d=doc([cue({id:'s1',start:1,end:3}),cue({id:'s2',start:4,end:6})]);
  assert.deepEqual(editableCues(d,2).map(c=>c.id),['s1']);
  assert.deepEqual(editableCues(d,3.5).map(c=>c.id),['s1']);
  assert.deepEqual(editableCues(d,0.5).map(c=>c.id),['s1']);
  assert.deepEqual(editableCues(d,4.5).map(c=>c.id),['s2']);
  assert.equal(normalizeSettings({editMode:true}).editMode,true);
  assert.equal(DEFAULT_SETTINGS.editMode,false);
});
