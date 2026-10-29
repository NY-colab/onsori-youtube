import test from 'node:test';
import assert from 'node:assert/strict';
import {createYouTubePanel} from './panel.js';
test('panel mounts once without iframe and survives collapse, SPA and layout moves',()=>{
 const elements=[];let options,mounts=0,refreshes=0;
 function element(tag){const el={tag,style:{},hidden:false,isConnected:true,children:[],listeners:{},setAttribute(){},addEventListener(type,fn){this.listeners[type]=fn;},attachShadow(){return {append(...children){el.children=children;}};},prepend(child){child.parentElement=this;},getBoundingClientRect:()=>({width:400,left:600,right:1000})};elements.push(el);return el;}
 const secondary=element('secondary'),primary=element('primary'),watch=element('watch');primary.getBoundingClientRect=()=>({width:600,right:600});secondary.querySelector=()=>secondary;watch.querySelector=s=>s==='#secondary'?secondary:primary;
 globalThis.document={createElement:element,querySelector:()=>watch,title:'Video',fullscreenElement:null};globalThis.getComputedStyle=()=>({display:'block'});
 try{
  const panel=createYouTubePanel(()=>{},(_,opts)=>{mounts++;options=opts;return {refresh(){refreshes++;}};});panel.sync('video');
  assert.equal(elements.some(e=>e.tag==='iframe'),false);assert.equal(mounts,1);assert.equal(panel.isExpanded(),true);assert.equal(options.embedded,true);
  options.onCollapse();assert.equal(panel.isExpanded(),false);const expand=elements.find(e=>e.tag==='button');expand.listeners.click({isTrusted:true});assert.equal(panel.isExpanded(),true);
  panel.sync('next-video');assert.equal(mounts,1);assert.equal(refreshes,3);
  secondary.getBoundingClientRect=()=>({width:400,left:0,right:400});panel.sync('next-video');assert.equal(elements.find(e=>e.tag==='onsori-panel').parentElement,primary);
  document.fullscreenElement={};panel.sync('next-video');assert.equal(panel.isExpanded(),false);
 }finally{delete globalThis.document;delete globalThis.getComputedStyle;}
});
