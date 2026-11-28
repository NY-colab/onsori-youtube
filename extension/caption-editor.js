// Hand-correction mode: with "자막 직접 수정 모드" on, clicking a caption on the video (or the
// "지금 자막 고치기" button) pauses the video and opens an editor over the picture for the captions
// shown at that moment. Saved text is stored only in this Chrome profile (ed:<videoId>).
import {KIND_NAMES,clockTime,editableCues,upsertEdit} from './core.js';

export const EDITOR_CSS=`.edit-pill,.editor{position:absolute;pointer-events:auto;box-sizing:border-box;color:#ededed;font:12px/1.6 "Malgun Gothic","Apple SD Gothic Neo",sans-serif;text-align:left;background:rgba(20,20,21,.95);border:1px solid rgba(237,237,237,.16);box-shadow:0 8px 24px rgba(0,0,0,.35)}
.edit-pill[hidden],.editor[hidden],.editor [hidden]{display:none!important}
.edit-pill{top:12px;right:12px;display:flex;align-items:center;gap:8px;border-radius:999px;padding:4px 4px 4px 12px}
.edit-pill span{color:#a2efcd;font-weight:600}
.editor{top:12px;left:50%;transform:translateX(-50%);width:min(560px,calc(100% - 24px));max-height:calc(100% - 24px);overflow:auto;border-radius:12px;padding:12px 16px}
.editor-head{display:flex;justify-content:space-between;align-items:center;gap:8px}
.editor-head strong{font-size:13px;font-weight:600}
.editor-head .when{color:#a1a1a6;font-variant-numeric:tabular-nums;margin-left:8px;font-weight:400}
.editor ol{list-style:none;margin:8px 0 0;padding:0;display:grid;gap:12px}
.editor li{display:grid;gap:4px}
.editor .meta{display:flex;align-items:center;gap:8px;color:#a1a1a6;font-variant-numeric:tabular-nums}
.editor .kind{color:#ededed;font-weight:600}
.editor .badge{color:#141415;background:#a2efcd;border-radius:4px;padding:0 6px;font-size:11px;font-weight:600}
.editor textarea{width:100%;box-sizing:border-box;min-height:44px;resize:vertical;border:1px solid rgba(237,237,237,.22);border-radius:8px;background:#0f0f10;color:#fff;padding:8px 10px;font:15px/1.5 "Malgun Gothic","Apple SD Gothic Neo",sans-serif}
.editor textarea:focus{outline:2px solid #a2efcd;outline-offset:1px;border-color:transparent}
.editor .row,.editor .foot{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.editor .foot{justify-content:space-between;margin-top:12px}
.editor .foot div{display:flex;gap:8px}
.editor .note{margin:8px 0 0;color:#a1a1a6}
.editor .note[data-tone=error]{color:#ff9ea3}
.editor .note[data-tone=ok]{color:#a2efcd}
.edit-pill button,.editor button{font:600 12px "Malgun Gothic","Apple SD Gothic Neo",sans-serif;cursor:pointer;border:1px solid rgba(237,237,237,.14);border-radius:8px;background:#2e2e31;color:#ededed;padding:6px 12px}
.edit-pill button{border-radius:999px}
.editor button:hover,.edit-pill button:hover{background:#3a3a3e}
.editor button.primary{background:#a2efcd;color:#141415;border-color:transparent}
.editor button.primary:hover{background:#8fe3bf}
.editor button.link{background:transparent;border:0;padding:0;color:#a1a1a6;text-decoration:underline;text-underline-offset:3px;font-weight:400}
.editor button:disabled{opacity:.45;cursor:default}
.editor button:focus-visible,.edit-pill button:focus-visible{outline:2px solid #a2efcd;outline-offset:2px}
.captions.editable .cue{pointer-events:auto;cursor:pointer}
.captions.editable .cue .line{outline:2px dashed rgba(162,239,205,.9);outline-offset:3px}
@media(max-width:480px){.editor{top:8px;width:calc(100% - 16px);padding:8px 12px}.edit-pill{top:8px;right:8px}}`;

// YouTube toggles playback on clicks that reach the player; keep the editor's own clicks inside.
const POINTER_EVENTS=['pointerdown','pointerup','mousedown','mouseup','click','dblclick'];
export function keepPointer(el){for(const type of POINTER_EVENTS)el.addEventListener(type,event=>event.stopPropagation());}

export function createCaptionEditor(root,{state,save}){
  const pill=document.createElement('div');pill.className='edit-pill';pill.hidden=true;
  pill.innerHTML='<span>자막 수정 모드</span><button type="button">지금 자막 고치기</button>';
  const panel=document.createElement('section');panel.className='editor';panel.hidden=true;panel.setAttribute('role','dialog');panel.setAttribute('aria-label','자막 직접 수정');
  panel.innerHTML='<div class="editor-head"><strong>자막 직접 수정<span class="when"></span></strong><button type="button" class="link" data-act="close">닫기</button></div><ol></ol><p class="note" role="status"></p><div class="foot"><div><button type="button" data-act="prev">◀ 이전 자막</button><button type="button" data-act="next">다음 자막 ▶</button></div><div><button type="button" class="primary" data-act="save">저장</button></div></div><p class="note">Enter 저장 · Esc 닫기 · 고친 자막은 이 PC의 Chrome에만 저장되고 다른 사람에게 보내지 않습니다.</p>';
  root.append(pill,panel);keepPointer(pill);keepPointer(panel);
  const $=sel=>panel.querySelector(sel),note=$('.note');let cues=[],open=false;
  const tell=(text,tone='')=>{note.textContent=text;note.dataset.tone=tone;};
  function shownCues(){const {doc,settings}=state();return doc?doc.cues.filter(c=>settings[{speech:'showSpeech',sound:'showSound',music:'showMusic'}[c.kind]]):[];}
  function draw(){
    const {doc}=state();const list=$('ol');list.replaceChildren();
    $('.when').textContent=cues.length?` · ${clockTime(cues[0].start)}`:'';
    if(!cues.length){tell('이 위치에는 고칠 자막이 없습니다.');}
    for(const cue of cues){
      const li=document.createElement('li');li.dataset.id=cue.id;
      const meta=document.createElement('div');meta.className='meta';
      const kind=document.createElement('span');kind.className='kind';kind.textContent=KIND_NAMES[cue.kind];
      const span=document.createElement('span');span.textContent=`${clockTime(cue.start)}–${clockTime(cue.end)}`;meta.append(kind,span);
      if(cue.user_edit){const badge=document.createElement('span');badge.className='badge';badge.textContent='고친 자막';meta.append(badge);}
      const box=document.createElement('textarea');box.value=cue.text;box.rows=2;box.maxLength=500;box.setAttribute('aria-label',`${KIND_NAMES[cue.kind]} ${clockTime(cue.start)} 자막 내용`);
      box.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();commit();}});
      const row=document.createElement('div');row.className='row';
      if(cue.user_edit){const back=document.createElement('button');back.type='button';back.className='link';back.textContent=`원래대로: ${cue.user_edit.original_text.slice(0,40)}`;back.addEventListener('click',()=>change(cue,{restore:true},'분석 결과로 되돌렸습니다.'));row.append(back);}
      const hide=document.createElement('button');hide.type='button';hide.className='link';hide.textContent='이 자막 숨기기';hide.addEventListener('click',()=>change(cue,{deleted:true},'이 자막을 숨겼습니다. 조작 창의 ‘고친 자막 모두 되돌리기’로 다시 보이게 할 수 있습니다.'));row.append(hide);
      li.append(meta,box,row);list.append(li);
    }
    const all=shownCues(),first=cues[0];
    $('[data-act=prev]').disabled=!first||!all.some(c=>c.start<first.start-.01);
    $('[data-act=next]').disabled=!first||!all.some(c=>c.start>first.start+.01);
    $('[data-act=save]').disabled=!cues.length;
    if(!doc)tell('이 영상의 자막을 먼저 만들어 주세요.','error');
  }
  async function change(cue,how,message){
    const {videoId,edits}=state();
    try{await save(upsertEdit(edits,videoId,cue,how));tell(message,'ok');refresh(cues[0]?.start);}catch(e){tell(e.message,'error');}
  }
  // Saves every changed box at once; an emptied box hides that caption.
  async function commit(){
    const {videoId}=state();let {edits}=state(),changed=0;
    try{
      for(const li of panel.querySelectorAll('li')){const cue=cues.find(c=>c.id===li.dataset.id),value=li.querySelector('textarea').value;if(!cue||value.trim()===cue.text)continue;edits=upsertEdit(edits,videoId,cue,{text:value});changed++;}
      if(changed){await save(edits);tell(`${changed}개 자막을 고쳤습니다. 이 PC의 Chrome에만 저장됩니다.`,'ok');refresh(cues[0]?.start);}
      else tell('바뀐 내용이 없습니다.');
      return true;
    }catch(e){tell(e.message,'error');return false;}
  }
  // Re-read the captions after a save so the boxes show the stored text.
  function refresh(at){const {doc,settings}=state();if(!doc||at==null){cues=[];draw();return;}const offset=Number(settings.offset||0);cues=editableCues(doc,at+offset+.001,settings);draw();}
  async function step(direction){
    if(!(await commit()))return;const all=shownCues(),first=cues[0];if(!first)return;
    const target=direction>0?all.find(c=>c.start>first.start+.01):all.filter(c=>c.start<first.start-.01).pop();if(!target)return;
    const {video,settings}=state(),at=target.start+Number(settings.offset||0)+.05;if(video)video.currentTime=Math.max(0,at);refresh(target.start);tell('');
    panel.querySelector('textarea')?.focus();
  }
  function show(time){
    const {doc,settings,video,blocked}=state();if(!doc||blocked||!video)return;
    video.pause();cues=editableCues(doc,time??video.currentTime,settings);tell('');draw();open=true;panel.hidden=false;sync();
    const box=panel.querySelector('textarea');if(box){box.focus();box.setSelectionRange(box.value.length,box.value.length);}
  }
  function close(){open=false;panel.hidden=true;sync();}
  function sync(){const {doc,settings,blocked}=state();if(open&&(!settings.editMode||!doc||blocked))close();pill.hidden=open||!settings.editMode||!doc||blocked;}
  pill.querySelector('button').addEventListener('click',()=>show());
  $('[data-act=close]').addEventListener('click',close);
  $('[data-act=save]').addEventListener('click',commit);
  $('[data-act=prev]').addEventListener('click',()=>step(-1));
  $('[data-act=next]').addEventListener('click',()=>step(1));
  panel.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();}});
  return {show,close,sync,isOpen:()=>open};
}
