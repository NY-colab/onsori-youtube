import test from 'node:test';
import assert from 'node:assert/strict';
import {createYouTubePanel} from './panel.js';

test('a blank srcdoc cannot permanently replace the panel source',()=>{
  const elements=[];
  function element(tag){
    const attrs=new Map();
    const el={tag,style:{},hidden:false,isConnected:true,children:[],listeners:{},
      setAttribute:(key,value)=>attrs.set(key,value),getAttribute:key=>attrs.get(key),hasAttribute:key=>attrs.has(key),removeAttribute:key=>attrs.delete(key),
      addEventListener(type,fn){this.listeners[type]=fn;},
      attachShadow(){return {append(...children){el.children=children;}};},
      prepend(child){child.parentElement=this;},
      getBoundingClientRect:()=>({width:400,left:600,right:1000}),
      contentWindow:{postMessage(){}},
    };elements.push(el);return el;
  }
  const secondary=element('secondary'),primary=element('primary'),watch=element('watch');
  primary.getBoundingClientRect=()=>({width:600,right:600});
  secondary.querySelector=()=>secondary;
  watch.querySelector=selector=>selector==='#secondary'?secondary:primary;
  globalThis.document={createElement:element,querySelector:()=>watch,title:'Video',fullscreenElement:null};
  globalThis.chrome={runtime:{getURL:path=>'chrome-extension://test/'+path}};
  globalThis.window={addEventListener(){}};
  globalThis.location={origin:'https://www.youtube.com'};
  globalThis.getComputedStyle=()=>({display:'block'});
  try {
    const panel=createYouTubePanel();panel.sync('video');
    const frame=elements.find(el=>el.tag==='iframe');
    const source=frame.src;
    frame.setAttribute('srcdoc','');panel.sync('video');
    assert.equal(frame.hasAttribute('srcdoc'),false);
    assert.equal(frame.src,source);
    assert.equal(panel.isExpanded(),true);
    frame.setAttribute('srcdoc','');frame.listeners.load();
    assert.equal(frame.hasAttribute('srcdoc'),false);
    frame.setAttribute('srcdoc','');panel.sync('video');
    assert.equal(frame.hasAttribute('srcdoc'),true,'repair loop must be bounded');
  } finally {
    for(const key of ['document','chrome','window','location','getComputedStyle'])delete globalThis[key];
  }
});
