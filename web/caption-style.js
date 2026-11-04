// Caption appearance: themes, Google Fonts with Korean glyphs, and the CSS shared by
// the video overlay and the settings preview. Only the chosen font is requested.
// Korean families and weights from fonts.google.com/metadata/fonts (subset "korean"), 2026-10-31.
export const CAPTION_FONTS=Object.freeze([
  ['Noto Sans KR','sans',[100,200,300,400,500,600,700,800,900]],['Nanum Gothic','sans',[400,700,800]],['Gothic A1','sans',[100,200,300,400,500,600,700,800,900]],['IBM Plex Sans KR','sans',[100,200,300,400,500,600,700]],['Asta Sans','sans',[300,400,500,600,700,800]],['Gowun Dodum','sans',[400]],['Sunflower','sans',[300,500,700]],['Nanum Gothic Coding','sans',[400,700]],['Black Han Sans','sans',[400]],['Do Hyeon','sans',[400]],['Jua','sans',[400]],['Dongle','sans',[300,400,700]],['Gasoek One','sans',[400]],['Orbit','sans',[400]],['Stylish','sans',[400]],
  ['Noto Serif KR','serif',[200,300,400,500,600,700,800,900]],['Nanum Myeongjo','serif',[400,700,800]],['Gowun Batang','serif',[400,700]],['Hahmlet','serif',[100,200,300,400,500,600,700,800,900]],['Song Myung','serif',[400]],['Diphylleia','serif',[400]],['Grandiflora One','serif',[400]],
  ['Nanum Pen Script','hand',[400]],['Gaegu','hand',[300,400,700]],['Nanum Brush Script','hand',[400]],['Hi Melody','hand',[400]],['East Sea Dokdo','hand',[400]],['Gamja Flower','hand',[400]],
  ['Bagel Fat One','display',[400]],['Moirai One','display',[400]],['Dokdo','display',[400]],['Gugi','display',[400]],['Poor Story','display',[400]],['Single Day','display',[400]],['Cute Font','display',[400]],['Kirang Haerang','display',[400]],['Yeon Sung','display',[400]],['Black And White Picture','display',[400]]
].map(([family,group,weights])=>Object.freeze({family,group,weights:Object.freeze(weights)})));
export const FONT_GROUPS=Object.freeze({sans:'고딕',serif:'명조',hand:'손글씨',display:'장식'});
export const SYSTEM_FONT_STACK='"Noto Sans KR","Malgun Gothic","Apple SD Gothic Neo",Arial,sans-serif';
const STYLE_KEYS=['fontWeight','textColor','edgeStyle','edgeColor','bgColor','bgOpacity','bgShape','bgRadius','kindAccent'];
// Each theme fixes every appearance value except the font family, which stays the user's choice.
// Opacities are multiples of 5 so the panel slider (step 5) can show them without rounding.
export const CAPTION_THEMES=Object.freeze({
  onsori:{label:'온소리 기본',fontWeight:700,textColor:'#ffffff',edgeStyle:'shadow',edgeColor:'#000000',bgColor:'#090c12',bgOpacity:90,bgShape:'box',bgRadius:7,kindAccent:'bar'},
  broadcast:{label:'방송 자막',fontWeight:500,textColor:'#ffffff',edgeStyle:'none',edgeColor:'#000000',bgColor:'#000000',bgOpacity:75,bgShape:'line',bgRadius:2,kindAccent:'text'},
  contrast:{label:'고대비',fontWeight:800,textColor:'#ffff00',edgeStyle:'none',edgeColor:'#000000',bgColor:'#000000',bgOpacity:100,bgShape:'box',bgRadius:0,kindAccent:'bar'},
  outline:{label:'외곽선',fontWeight:800,textColor:'#ffffff',edgeStyle:'outline',edgeColor:'#000000',bgColor:'#000000',bgOpacity:0,bgShape:'box',bgRadius:0,kindAccent:'text'},
  cinema:{label:'영화관',fontWeight:500,textColor:'#fff6dc',edgeStyle:'shadow',edgeColor:'#000000',bgColor:'#000000',bgOpacity:0,bgShape:'box',bgRadius:0,kindAccent:'text'},
  paper:{label:'밝은 상자',fontWeight:700,textColor:'#14171a',edgeStyle:'none',edgeColor:'#ffffff',bgColor:'#ffffff',bgOpacity:90,bgShape:'box',bgRadius:8,kindAccent:'bar'}
});
for(const theme of Object.values(CAPTION_THEMES))Object.freeze(theme);
export const STYLE_DEFAULTS=Object.freeze({fontFamily:'',...Object.fromEntries(STYLE_KEYS.map(k=>[k,CAPTION_THEMES.onsori[k]]))});
const HEX=/^#[0-9a-f]{6}$/;
export const FONT_NAME=/^[A-Za-z0-9](?:[A-Za-z0-9 ]{0,58}[A-Za-z0-9])?$/;
const choices={fontWeight:[400,500,700,800],edgeStyle:['none','shadow','outline','raised','depressed'],bgShape:['box','line','block'],kindAccent:['bar','text','none']};
export function normalizeCaptionStyle(value={}){
  const s={...STYLE_DEFAULTS};
  const family=typeof value.fontFamily==='string'?value.fontFamily.trim().replace(/\s+/g,' '):'';
  if(FONT_NAME.test(family))s.fontFamily=CAPTION_FONTS.find(f=>f.family.toLowerCase()===family.toLowerCase())?.family||family;
  if(choices.fontWeight.includes(Number(value.fontWeight)))s.fontWeight=Number(value.fontWeight);
  for(const key of ['edgeStyle','bgShape','kindAccent'])if(choices[key].includes(value[key]))s[key]=value[key];
  for(const key of ['textColor','edgeColor','bgColor'])if(typeof value[key]==='string'&&HEX.test(value[key].toLowerCase()))s[key]=value[key].toLowerCase();
  if(value.bgOpacity!=null&&value.bgOpacity!==''&&Number.isFinite(Number(value.bgOpacity)))s.bgOpacity=Math.round(Math.min(100,Math.max(0,Number(value.bgOpacity))));
  if(value.bgRadius!=null&&value.bgRadius!==''&&Number.isFinite(Number(value.bgRadius)))s.bgRadius=Math.round(Math.min(24,Math.max(0,Number(value.bgRadius))));
  return s;
}
export function matchTheme(settings){return Object.keys(CAPTION_THEMES).find(id=>STYLE_KEYS.every(k=>CAPTION_THEMES[id][k]===settings[k]))||null;}
export function themeSettings(id){const theme=CAPTION_THEMES[id];if(!theme)throw new Error('알 수 없는 자막 테마입니다.');return Object.fromEntries(STYLE_KEYS.map(k=>[k,theme[k]]));}
export function fontInfo(family){return CAPTION_FONTS.find(f=>f.family===family)||null;}
// Use the nearest weight the family ships, so the browser never fakes a bold face.
export function effectiveWeight(settings){const weights=fontInfo(settings.fontFamily)?.weights;if(!weights)return settings.fontWeight;return weights.reduce((best,w)=>Math.abs(w-settings.fontWeight)<Math.abs(best-settings.fontWeight)||(Math.abs(w-settings.fontWeight)===Math.abs(best-settings.fontWeight)&&w>best)?w:best,weights[0]);}
export function fontStack(family){return family?`"${family}",${SYSTEM_FONT_STACK}`:SYSTEM_FONT_STACK;}
export function fontRequest(settings){
  const family=settings.fontFamily;if(!family||!FONT_NAME.test(family))return null;
  const known=fontInfo(family),weight=effectiveWeight(settings);
  // Unlisted families are requested without an axis; asking for a missing weight fails the request.
  return {family,weight,known:Boolean(known),url:`https://fonts.googleapis.com/css2?family=${family.replace(/ /g,'+')}${known?`:wght@${weight}`:''}&display=swap`};
}
function rgba(hex,opacity){const n=parseInt(hex.slice(1),16);return `rgba(${n>>16},${n>>8&255},${n&255},${Math.round(opacity)/100})`;}
function luminance(hex){const n=parseInt(hex.slice(1),16);return [n>>16,n>>8&255,n&255].map(v=>{v/=255;return v<=.03928?v/12.92:((v+.055)/1.055)**2.4;}).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);}
const EDGES={none:()=>'none',shadow:e=>`0 .06em .12em ${e},0 0 .3em ${rgba(e,60)}`,outline:e=>[[-1,-1],[0,-1],[1,-1],[-1,0],[1,0],[-1,1],[0,1],[1,1]].map(([x,y])=>`${x*.055}em ${y*.055}em 0 ${e}`).join(',')+`,0 0 .12em ${e}`,raised:e=>`.05em .05em 0 ${e},-.03em -.03em 0 rgba(255,255,255,.35)`,depressed:e=>`-.05em -.05em 0 ${e},.03em .03em 0 rgba(255,255,255,.35)`};
// Sound and music stay distinguishable by color on light and dark text alike.
const KIND_COLORS={light:{speech:'#b9a8ff',sound:'#75e1bd',music:'#e5b6ff',soundText:'#cdffeb',musicText:'#eed3ff'},dark:{speech:'#5b45c9',sound:'#0f8a64',music:'#8a3fbf',soundText:'#0b5e45',musicText:'#5e2286'}};
export function captionStyleVars(settings){
  const s=normalizeCaptionStyle(settings),kind=KIND_COLORS[luminance(s.textColor)>.4?'light':'dark'],bg=rgba(s.bgColor,s.bgOpacity);
  return {'--cap-font':fontStack(s.fontFamily),'--cap-weight':String(effectiveWeight(s)),'--cap-text':s.textColor,'--cap-edge':EDGES[s.edgeStyle](s.edgeColor),'--cap-bg':bg,'--cap-radius':`${s.bgRadius}px`,'--cap-lift':s.bgOpacity>=40&&s.bgShape==='box'?'0 2px 14px rgba(0,0,0,.33)':'none','--cap-speech-bar':kind.speech,'--cap-sound-bar':kind.sound,'--cap-music-bar':kind.music,'--cap-sound-text':kind.soundText,'--cap-music-text':kind.musicText};
}
export function applyCaptionStyle(element,settings){
  for(const [name,value] of Object.entries(captionStyleVars(settings)))element.style.setProperty(name,value);
  const s=normalizeCaptionStyle(settings);element.dataset.shape=s.bgShape;element.dataset.accent=s.kindAccent;
}
// Scoped to .captions; the overlay and the preview add their own positioning.
export const CAPTION_CSS=`.captions{font-family:var(--cap-font);font-weight:var(--cap-weight);color:var(--cap-text);line-height:1.45;text-align:center}.captions[data-shape=block]{background:var(--cap-bg);border-radius:var(--cap-radius);padding:.3em .5em}.cue{max-width:100%;box-sizing:border-box;padding:.23em .55em;white-space:pre-wrap;overflow-wrap:anywhere;text-shadow:var(--cap-edge);--kind-bar:var(--cap-speech-bar)}.cue.sound{--kind-bar:var(--cap-sound-bar)}.cue.music{--kind-bar:var(--cap-music-bar)}.captions[data-shape=box] .cue{background:var(--cap-bg);border-radius:var(--cap-radius);box-shadow:var(--cap-lift)}.captions[data-shape=line] .cue{padding:0}.captions[data-shape=line] .line{background:var(--cap-bg);border-radius:var(--cap-radius);padding:.06em .35em;-webkit-box-decoration-break:clone;box-decoration-break:clone}.captions[data-accent=bar]:not([data-shape=line]) .cue,.captions[data-accent=bar][data-shape=line] .line{border-left:3px solid var(--kind-bar)}.captions:not([data-accent=none]) .cue.sound{color:var(--cap-sound-text)}.captions:not([data-accent=none]) .cue.music{color:var(--cap-music-text)}.label{font-size:.56em;opacity:.78;margin-right:.65em;vertical-align:middle}.review{display:inline-block;font-size:.5em;color:#ffd990;margin-left:.7em;vertical-align:middle}`;
const loads=new WeakMap();
// Adds the Google Fonts stylesheet to the page that shows the caption. The request carries
// no page referrer; a failed or unknown family falls back to the system font stack.
export function ensureCaptionFont(doc,settings){
  const request=fontRequest(normalizeCaptionStyle(settings));
  for(const link of doc.querySelectorAll('link[data-onsori-font]'))if(link.href!==request?.url)link.remove();
  if(!request)return Promise.resolve({ok:true,system:true});
  let link=[...doc.querySelectorAll('link[data-onsori-font]')].find(l=>l.href===request.url);
  if(!link){
    link=doc.createElement('link');link.rel='stylesheet';link.referrerPolicy='no-referrer';link.dataset.onsoriFont=request.family;link.href=request.url;
    loads.set(link,new Promise(resolve=>{link.addEventListener('load',()=>resolve(true),{once:true});link.addEventListener('error',()=>resolve(false),{once:true});}));
    (doc.head||doc.documentElement).append(link);
  }
  // A link left by an earlier copy of this script has already loaded or failed.
  return (loads.get(link)||Promise.resolve(true)).then(async ok=>{
    if(!ok)return {...request,ok:false};
    try{const faces=await doc.fonts.load(`${request.weight} 16px "${request.family}"`,'가나A');return {...request,ok:faces.length>0};}catch{return {...request,ok:false};}
  });
}
