import test from 'node:test';
import assert from 'node:assert/strict';
import {CAPTION_FONTS,CAPTION_THEMES,STYLE_DEFAULTS,normalizeCaptionStyle,matchTheme,themeSettings,effectiveWeight,fontRequest,fontStack,captionStyleVars,applyCaptionStyle,ensureCaptionFont,CAPTION_CSS} from './caption-style.js';
import {normalizeSettings,DEFAULT_SETTINGS} from './core.js';

test('existing users keep the 0.3.4 look: defaults are the OnSori theme with the system font',()=>{
  const legacy=normalizeSettings({typographyVersion:2,baseSize:16,positionX:40});
  assert.equal(matchTheme(legacy),'onsori');assert.equal(legacy.fontFamily,'');assert.equal(legacy.baseSize,16);assert.equal(legacy.positionX,40);
  for(const key of Object.keys(STYLE_DEFAULTS))assert.equal(DEFAULT_SETTINGS[key],STYLE_DEFAULTS[key],key);
  const vars=captionStyleVars(legacy);assert.equal(vars['--cap-bg'],'rgba(9,12,18,0.9)');assert.equal(vars['--cap-radius'],'7px');assert.equal(vars['--cap-font'],fontStack(''));
});
test('style values are bounded and font names cannot inject CSS or URLs',()=>{
  const s=normalizeCaptionStyle({fontFamily:'Roboto";}body{color:red',fontWeight:650,textColor:'red',edgeStyle:'glow',bgColor:'#ABCDEF',bgOpacity:140,bgRadius:-3,bgShape:'pill',kindAccent:'bar'});
  assert.equal(s.fontFamily,'');assert.equal(s.fontWeight,700);assert.equal(s.textColor,'#ffffff');assert.equal(s.edgeStyle,'shadow');assert.equal(s.bgColor,'#abcdef');assert.equal(s.bgOpacity,100);assert.equal(s.bgRadius,0);assert.equal(s.bgShape,'box');
  for(const bad of ['../x','a/b','Font?x=1','Noto Sans KR&family=Evil',' ','x'.repeat(61)])assert.equal(normalizeCaptionStyle({fontFamily:bad}).fontFamily,'',bad);
  assert.equal(normalizeCaptionStyle({fontFamily:'  noto   sans kr '}).fontFamily,'Noto Sans KR','listed names are canonicalized');
  assert.equal(normalizeCaptionStyle({fontFamily:'Roboto Slab'}).fontFamily,'Roboto Slab');
});
test('Korean font list is unique and requests only the nearest shipped weight',()=>{
  assert.equal(CAPTION_FONTS.length,38);assert.equal(new Set(CAPTION_FONTS.map(f=>f.family)).size,38);
  assert.equal(effectiveWeight({fontFamily:'Jua',fontWeight:800}),400);
  assert.equal(effectiveWeight({fontFamily:'Sunflower',fontWeight:400}),500,'ties go to the heavier face');
  assert.equal(effectiveWeight({fontFamily:'Nanum Gothic',fontWeight:500}),400);
  assert.equal(effectiveWeight({fontFamily:'',fontWeight:800}),800);
  assert.equal(fontRequest({fontFamily:'Noto Sans KR',fontWeight:700}).url,'https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@700&display=swap');
  assert.equal(fontRequest({fontFamily:'Roboto Slab',fontWeight:700}).url,'https://fonts.googleapis.com/css2?family=Roboto+Slab&display=swap');
  assert.equal(fontRequest({fontFamily:'',fontWeight:700}),null);
});
test('themes are complete, distinct and keep kinds distinguishable on dark text',()=>{
  const ids=Object.keys(CAPTION_THEMES);assert.equal(new Set(ids.map(id=>JSON.stringify(themeSettings(id)))).size,ids.length);
  for(const id of ids){assert.equal(matchTheme({...STYLE_DEFAULTS,...themeSettings(id)}),id);assert.equal(CAPTION_THEMES[id].bgOpacity%5,0,`${id} fits the step-5 slider`);}
  assert.equal(matchTheme({...STYLE_DEFAULTS,bgOpacity:55}),null);
  const light=captionStyleVars({...STYLE_DEFAULTS,...themeSettings('onsori')}),dark=captionStyleVars({...STYLE_DEFAULTS,...themeSettings('paper')});
  assert.equal(light['--cap-sound-text'],'#cdffeb');assert.notEqual(dark['--cap-sound-text'],light['--cap-sound-text']);assert.notEqual(dark['--cap-sound-text'],dark['--cap-music-text']);
  assert.equal(captionStyleVars({...STYLE_DEFAULTS,bgOpacity:0})['--cap-lift'],'none');
  assert.match(captionStyleVars({...STYLE_DEFAULTS,edgeStyle:'outline'})['--cap-edge'],/-0\.055em -0\.055em 0 #000000/);
  const el={style:{setProperty(k,v){this[k]=v;}},dataset:{}};applyCaptionStyle(el,{...STYLE_DEFAULTS,bgShape:'line',kindAccent:'none'});assert.equal(el.dataset.shape,'line');assert.equal(el.dataset.accent,'none');assert.equal(el.style['--cap-text'],'#ffffff');
  assert.match(CAPTION_CSS,/box-decoration-break:clone/);
});
function fakeDocument(){
  const links=[];
  return {links,fonts:{async load(spec){return spec.includes('Missing')?[]:[{}];}},head:{append(link){link.isConnected=true;links.push(link);}},
    querySelectorAll:()=>links.filter(l=>l.isConnected),
    createElement:()=>{const listeners={};return {dataset:{},listeners,isConnected:false,addEventListener(type,fn){listeners[type]=fn;},remove(){this.isConnected=false;}};}};
}
test('font loader adds one no-referrer stylesheet, drops stale ones and reports failures',async()=>{
  const doc=fakeDocument();
  assert.deepEqual(await ensureCaptionFont(doc,{...STYLE_DEFAULTS}),{ok:true,system:true});assert.equal(doc.links.length,0);
  const pending=ensureCaptionFont(doc,{...STYLE_DEFAULTS,fontFamily:'Jua'});const link=doc.links[0];
  assert.equal(link.rel,'stylesheet');assert.equal(link.referrerPolicy,'no-referrer');assert.equal(link.href,'https://fonts.googleapis.com/css2?family=Jua:wght@400&display=swap');
  ensureCaptionFont(doc,{...STYLE_DEFAULTS,fontFamily:'Jua'});assert.equal(doc.querySelectorAll().length,1,'same request reuses the link');
  link.listeners.load();const result=await pending;assert.equal(result.ok,true);assert.equal(result.weight,400);
  const failed=ensureCaptionFont(doc,{...STYLE_DEFAULTS,fontFamily:'Missing Font'});assert.equal(link.isConnected,false);assert.equal(doc.querySelectorAll().length,1);
  doc.querySelectorAll()[0].listeners.error();assert.equal((await failed).ok,false);
  await ensureCaptionFont(doc,{...STYLE_DEFAULTS});assert.equal(doc.querySelectorAll().length,0,'system font removes web font links');
});
