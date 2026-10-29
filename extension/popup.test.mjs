import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import * as core from './core.js';
const html=await readFile(new URL('./popup.html',import.meta.url),'utf8');
const source=(await readFile(new URL('./controls.js',import.meta.url),'utf8')).replace(/^import[^\n]+\n/,'const {normalizeSettings,parseDocument,subtitleFile}=core;\n').replace('export function mountControls','function mountControls')+'\nmountControls(document,{embedded:embeddedTest});';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function harness(config={}){
  const elements=new Map(),messages=[];
  for(const match of html.matchAll(/<([a-z]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)){const [,tag,attrs,id]=match;elements.set(id,{id,tag,type:attrs.match(/type="([^"]+)"/)?.[1]||'',value:attrs.match(/value="([^"]+)"/)?.[1]||'',checked:/\bchecked\b/.test(attrs),hidden:/\bhidden\b/.test(attrs),disabled:false,textContent:'',title:'',style:{},dataset:{},listeners:{},addEventListener(type,fn){this.listeners[type]=fn;},click(){return this.listeners.click?.();}});}
  const state={ok:true,videoId:'abcdefghijk',tabId:7,title:'영상 - YouTube',document:null,hasStoredDocument:false,awaitingAnalysis:false,settings:core.DEFAULT_SETTINGS,analysisOptions:{language:'ko',capture_frames:false,music_detail:true},localEnabled:Boolean(config.enabled),operation:{phase:'idle'}};
  let storageListener;const rootListeners={};
  const window={addEventListener(){}};window.parent=config.embedded?{postMessage(){}}:window;
  const chrome={runtime:{async sendMessage(m){messages.push(structuredClone(m));if(m.type==='GET_STATE')return structuredClone(state);if(m.type==='HEALTH')return {ok:true,health:{message:'기기 내 분석'}};if(m.type==='ENABLE_LOCAL')state.localEnabled=true;return {ok:true};}},storage:{onChanged:{addListener(fn){storageListener=fn;}}}};
  const document={getElementById(id){assert.ok(elements.has(id),'unknown element '+id);return elements.get(id);},addEventListener(type,fn){rootListeners[type]=fn;},documentElement:{dataset:{}},body:{getBoundingClientRect:()=>({height:700})},activeElement:null};
  vm.runInNewContext(source,{embeddedTest:Boolean(config.embedded),core,chrome,document,window,location:{search:config.embedded?'?view=panel&parent=https%3A%2F%2Fwww.youtube.com':''},URLSearchParams,URL,Blob,ResizeObserver:class{observe(){}},requestAnimationFrame:()=>1,cancelAnimationFrame(){},setInterval(){},setTimeout(){},Date,Number,Math,console});await tick();await tick();
  return {elements,messages,state,rootListeners,async click(id){await elements.get(id).click();await tick();},async progress(op){state.operation=op;storageListener({operation:{newValue:op}},'local');await tick();},async change(id){await elements.get(id).listeners.change?.();await tick();}};
}
test('popup first use shows disclosure and cannot silently enable or start capture',async()=>{
  const h=await harness();assert.equal(h.elements.get('setupHelp').hidden,false);assert.equal(h.elements.get('analysisControls').hidden,true);assert.equal(h.elements.get('capture').disabled,true);assert.equal(h.elements.get('enableLocal').hidden,false);assert.ok(h.messages.some(m=>m.type==='TOOLBAR_OPEN'));assert.equal(h.messages.some(m=>['START_CAPTURE','ENABLE_LOCAL'].includes(m.type)),false);assert.match(html,/외부 서버로 보내지 않고/);assert.match(html,/모델을 인터넷에서/);
});
test('explicit enable carries local analysis options, enables capture and hides consent',async()=>{
  const h=await harness();h.elements.get('language').value='en';h.elements.get('captureFrames').checked=true;await h.click('enableLocal');const request=h.messages.find(m=>m.type==='ENABLE_LOCAL');assert.equal(request.options.language,'en');assert.equal(request.options.capture_frames,true);assert.equal(request.options.music_detail,true);assert.equal(request.options.audio_captioning,undefined);assert.equal(h.elements.get('capture').disabled,false);assert.equal(h.elements.get('setupHelp').hidden,true);assert.equal(h.elements.get('analysisControls').hidden,false);
});
test('embedded panel allows explicit consent without requesting toolbar recording',async()=>{
  const h=await harness({embedded:true});assert.equal(h.elements.get('enableLocal').hidden,false);assert.equal(h.messages.some(m=>m.type==='TOOLBAR_OPEN'),false);await h.click('enableLocal');assert.ok(h.messages.some(m=>m.type==='ENABLE_LOCAL'));assert.equal(h.messages.some(m=>m.type==='START_CAPTURE'),false);
});

test('embedded controls reject synthetic page interactions while accepting real input',async()=>{
  const h=await harness({embedded:true});
  for(const type of ['click','input','change']){
    let prevented=false,stopped=false;
    const event={isTrusted:false,target:h.elements.get('capture'),preventDefault(){prevented=true;},stopImmediatePropagation(){stopped=true;}};
    h.rootListeners[type](event);assert.equal(prevented,true);assert.equal(stopped,true);
    prevented=stopped=false;h.rootListeners[type]({...event,isTrusted:true});assert.equal(prevented,false);assert.equal(stopped,false);
  }
});
test('model progress remains cancellable and completion alone enables export/replay',async()=>{
  const h=await harness({enabled:true});await h.progress({phase:'running',videoId:'abcdefghijk',tabId:7,capture:true,progress:.42,message:'모델 다운로드 42%'});assert.equal(h.elements.get('operationMessage').textContent,'모델 다운로드 42%');assert.equal(h.elements.get('progress').value,.42);assert.equal(h.elements.get('cancel').hidden,false);assert.equal(h.elements.get('capture').disabled,true);assert.equal(h.elements.get('replay').hidden,true);assert.equal(h.elements.get('export').disabled,true);await h.click('cancel');assert.ok(h.messages.some(m=>m.type==='CANCEL'));
  await h.progress({phase:'done',videoId:'abcdefghijk',tabId:7,capture:true,message:'완료'});assert.equal(h.elements.get('replay').hidden,false);assert.equal(h.elements.get('cancel').hidden,true);
});
test('AST and optional screen settings persist and bundled help opens',async()=>{
  const h=await harness({enabled:true});h.elements.get('musicDetail').checked=false;await h.change('musicDetail');assert.equal(h.messages.at(-1).type,'SET_ANALYSIS_OPTIONS');assert.equal(h.messages.at(-1).options.music_detail,false);await h.click('studio');assert.ok(h.messages.some(m=>m.type==='OPEN_HELP'));assert.equal(h.messages.some(m=>m.type==='ANALYZE_URL'),false);
});

test('primary action analyzes the whole video while recording remains an explicit fallback',async()=>{
  const h=await harness({enabled:true});await h.click('capture');assert.ok(h.messages.some(m=>m.type==='ANALYZE_URL'));assert.equal(h.messages.some(m=>m.type==='START_CAPTURE'),false);
  await h.progress({phase:'error',videoId:'abcdefghijk',tabId:7,mode:'full',message:'다시 시도해 주세요.'});assert.equal(h.elements.get('capture').disabled,false);assert.equal(h.messages.some(m=>m.type==='START_CAPTURE'),false);
  await h.click('record');assert.ok(h.messages.some(m=>m.type==='START_CAPTURE'));
  assert.match(html,/<details class="options"><summary>다른 방법/);assert.doesNotMatch(html,/healthDot|healthText|checkHealth|eyebrow/);
});
test('full-video completion offers replay without requiring capture mode',async()=>{
  const h=await harness({enabled:true});await h.progress({phase:'done',mode:'full',capture:false,videoId:'abcdefghijk',tabId:7});assert.equal(h.elements.get('replay').hidden,false);await h.click('replay');assert.ok(h.messages.some(m=>m.type==='REPLAY_CAPTURE'));
});
test('position controls persist immediately and reset to the default center anchor',async()=>{
  const h=await harness({enabled:true});h.elements.get('positionX').value='0';h.elements.get('positionY').value='100';await h.elements.get('positionX').listeners.input();await tick();
  let request=h.messages.findLast(m=>m.type==='SET_SETTINGS');assert.equal(request.settings.positionX,0);assert.equal(request.settings.positionY,100);assert.equal(h.elements.get('positionXValue').textContent,'0%');assert.match(h.elements.get('positionSample').style.left,/clamp/);
  await h.click('resetPosition');request=h.messages.findLast(m=>m.type==='SET_SETTINGS');assert.equal(request.settings.positionX,50);assert.equal(request.settings.positionY,88);
});
