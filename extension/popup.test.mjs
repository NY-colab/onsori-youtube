import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import * as core from './core.js';
import * as captionStyle from './caption-style.js';
const html=await readFile(new URL('./popup.html',import.meta.url),'utf8');
const source=(await readFile(new URL('./controls.js',import.meta.url),'utf8')).replace(/^import \{[^}]+\} from '\.\/core\.js';\n/m,'const {normalizeSettings,parseDocument,subtitleFile}=core;\n').replace(/^import \{([^}]+)\} from '\.\/caption-style\.js';\n/m,'const {$1}=captionStyle;\n').replace(/^export function /gm,'function ')+'\nmountControls(document,{embedded:embeddedTest});';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function harness(config={}){
  const elements=new Map(),messages=[];
  for(const match of html.matchAll(/<([a-z]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)){const [,tag,attrs,id]=match;elements.set(id,{id,tag,type:attrs.match(/type="([^"]+)"/)?.[1]||'',value:attrs.match(/value="([^"]+)"/)?.[1]||'',checked:/\bchecked\b/.test(attrs),hidden:/\bhidden\b/.test(attrs),disabled:false,textContent:'',title:'',style:{setProperty(name,value){this[name]=value;}},dataset:{},attributes:{},setAttribute(name,value){this.attributes[name]=value;},focus(){},listeners:{},addEventListener(type,fn){this.listeners[type]=fn;},click(){return this.listeners.click?.();}});}
  const state={ok:true,videoId:'abcdefghijk',tabId:7,title:'영상 - YouTube',document:null,hasStoredDocument:false,awaitingAnalysis:false,settings:core.DEFAULT_SETTINGS,analysisOptions:{language:'ko',capture_frames:false,music_detail:true},localEnabled:Boolean(config.enabled),cloud:config.cloud||{offered:false,consent:null},operation:{phase:'idle'}};
  let storageListener;const rootListeners={};
  const window={addEventListener(){}};window.parent=config.embedded?{postMessage(){}}:window;
  const chrome={runtime:{async sendMessage(m){messages.push(structuredClone(m));if(m.type==='GET_STATE')return structuredClone(state);if(m.type==='HEALTH')return {ok:true,health:{message:'기기 내 분석'}};if(m.type==='ENABLE_LOCAL')state.localEnabled=true;if(m.type==='SET_CLOUD_CONSENT')state.cloud={...state.cloud,consent:m.choice};return {ok:true};}},storage:{onChanged:{addListener(fn){storageListener=fn;}}}};
  const document={getElementById(id){assert.ok(elements.has(id),'unknown element '+id);return elements.get(id);},addEventListener(type,fn){rootListeners[type]=fn;},documentElement:{dataset:{}},head:{append(){}},fonts:{load:async()=>[]},querySelectorAll:()=>[],createElement:()=>({dataset:{},addEventListener(){}}),body:{getBoundingClientRect:()=>({height:700})},activeElement:null};
  vm.runInNewContext(source,{embeddedTest:Boolean(config.embedded),core,captionStyle,chrome,document,window,location:{search:config.embedded?'?view=panel&parent=https%3A%2F%2Fwww.youtube.com':''},URLSearchParams,URL,Blob,ResizeObserver:class{observe(){}},requestAnimationFrame:()=>1,cancelAnimationFrame(){},setInterval(){},setTimeout(fn){fn();return 1;},clearTimeout(){},Date,Number,Math,console});await tick();await tick();
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
test('embedded controls keep their own keys from YouTube shortcuts and pass the rest through',async()=>{
  const h=await harness({embedded:true}),el=id=>h.elements.get(id);
  const press=(target,key)=>{let stopped=false;for(const type of ['keydown','keypress','keyup'])h.rootListeners[type]({target,key,stopPropagation(){stopped=true;}});return stopped;};
  const tagged=(id,tag)=>({...el(id),tagName:tag});
  for(const key of ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'])assert.equal(press(tagged('positionX','INPUT'),key),true,key);
  assert.equal(press(tagged('positionY','INPUT'),'ArrowDown'),true);
  for(const key of ['k','f','m','5','j'])assert.equal(press(tagged('positionX','INPUT'),key),false,key);
  for(const key of ['1','6','ArrowUp','Backspace','k'])assert.equal(press(tagged('baseSize','INPUT'),key),true,key);
  assert.equal(press(tagged('infoLevel','SELECT'),'ArrowDown'),true);
  assert.equal(press(tagged('showSpeech','INPUT'),' '),true);assert.equal(press(tagged('showSpeech','INPUT'),'ArrowRight'),false);
  assert.equal(press(tagged('capture','BUTTON'),' '),true);assert.equal(press(tagged('capture','BUTTON'),'Enter'),true);assert.equal(press(tagged('capture','BUTTON'),'k'),false);
  assert.equal(press({tagName:'SUMMARY'},' '),true);assert.equal(press({tagName:'DIV'},'ArrowRight'),false);assert.equal(press({tagName:'P'},' '),false);
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
test('design themes fill every appearance field, persist, and report a custom mix',async()=>{
  const h=await harness({enabled:true}),el=id=>h.elements.get(id);
  assert.equal(el('theme-onsori').attributes['aria-pressed'],'true');assert.match(el('themeState').textContent,/온소리 기본/);
  assert.match(el('fontFamily').innerHTML,/<optgroup label="고딕"><option value="Noto Sans KR">/);assert.match(el('fontFamily').innerHTML,/value="__custom"/);
  assert.equal(el('theme-contrast').style['--cap-text'],'#ffff00');
  await h.click('theme-contrast');let request=h.messages.findLast(m=>m.type==='SET_SETTINGS');
  for(const [key,value] of Object.entries(captionStyle.themeSettings('contrast')))assert.equal(request.settings[key],value,key);
  assert.equal(request.settings.positionY,88);assert.equal(el('theme-contrast').attributes['aria-pressed'],'true');assert.equal(el('theme-onsori').attributes['aria-pressed'],'false');
  el('bgOpacity').value='40';await el('bgOpacity').listeners.input();await tick();request=h.messages.findLast(m=>m.type==='SET_SETTINGS');assert.equal(request.settings.bgOpacity,40);assert.equal(el('bgOpacityValue').textContent,'40%');assert.match(el('themeState').textContent,/직접 바꾼/);
  assert.equal(el('previewCaptions').dataset.shape,'box');assert.equal(el('previewCaptions').style['--cap-bg'],'rgba(0,0,0,0.4)');
  await h.click('resetDesign');request=h.messages.findLast(m=>m.type==='SET_SETTINGS');assert.equal(request.settings.textColor,'#ffffff');assert.equal(request.settings.fontFamily,'');assert.equal(request.settings.bgShape,'box');
});
test('fonts persist from the Korean list or a validated Google Fonts name',async()=>{
  const h=await harness({enabled:true}),el=id=>h.elements.get(id),saves=()=>h.messages.filter(m=>m.type==='SET_SETTINGS').length;
  el('fontFamily').value='Jua';await h.change('fontFamily');let request=h.messages.findLast(m=>m.type==='SET_SETTINGS');assert.equal(request.settings.fontFamily,'Jua');assert.match(el('fontStatus').textContent,/Jua/);
  el('fontFamily').value='__custom';await h.change('fontFamily');assert.equal(el('customFontRow').hidden,false);
  const before=saves();el('customFont').value='Roboto";}body{x:1';await h.click('applyFont');assert.equal(saves(),before);assert.match(el('feedback').textContent,/영문·숫자·띄어쓰기/);
  el('textColor').value='#ff8800';await h.change('textColor');request=h.messages.findLast(m=>m.type==='SET_SETTINGS');assert.equal(request.settings.fontFamily,'Jua','unapplied typing keeps the saved font');
  el('customFont').value='  Roboto   Slab ';await h.click('applyFont');request=h.messages.findLast(m=>m.type==='SET_SETTINGS');assert.equal(request.settings.fontFamily,'Roboto Slab');assert.equal(request.settings.textColor,'#ff8800');
  const stored=await harness({enabled:true});stored.state.settings={...core.DEFAULT_SETTINGS,fontFamily:'Roboto Slab'};await stored.click('studio');assert.equal(stored.elements.get('fontFamily').value,'__custom');assert.equal(stored.elements.get('customFont').value,'Roboto Slab');assert.equal(stored.elements.get('customFontRow').hidden,false);
});
test('cloud speech consent appears once, after local setup, only when the server offers real analysis',async()=>{
  const hidden=await harness({enabled:true});assert.equal(hidden.elements.get('cloudConsent').hidden,true);assert.equal(hidden.elements.get('cloudOptionRow').hidden,true);
  const before=await harness({cloud:{offered:true,consent:null,dailyMinutes:20}});assert.equal(before.elements.get('cloudConsent').hidden,true);
  const h=await harness({enabled:true,cloud:{offered:true,consent:null,dailyMinutes:15}});
  assert.equal(h.elements.get('cloudConsent').hidden,false);assert.equal(h.elements.get('cloudDailyMinutes').textContent,'15');
  assert.equal(h.messages.some(m=>m.type==='SET_CLOUD_CONSENT'),false);
  await h.click('cloudAccept');
  assert.equal(h.messages.find(m=>m.type==='SET_CLOUD_CONSENT').choice,'granted');
  assert.equal(h.elements.get('cloudConsent').hidden,true);assert.equal(h.elements.get('cloudSpeech').checked,true);
  h.elements.get('cloudSpeech').checked=false;await h.elements.get('cloudSpeech').listeners.change({target:h.elements.get('cloudSpeech')});await tick();
  assert.equal(h.messages.filter(m=>m.type==='SET_CLOUD_CONSENT').at(-1).choice,'declined');
  const declined=await harness({enabled:true,cloud:{offered:true,consent:null}});await declined.click('cloudDecline');
  assert.equal(declined.messages.find(m=>m.type==='SET_CLOUD_CONSENT').choice,'declined');assert.equal(declined.elements.get('cloudConsent').hidden,true);
  assert.match(html,/DeepInfra/);assert.match(html,/24시간 뒤 지웁니다/);
});
