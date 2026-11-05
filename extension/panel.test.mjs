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
test('after an extension reload the panel drops its controls and offers a trusted tab reload',()=>{
 const elements=[];let destroyed=0,reloads=0,visibility=0;
 function element(tag){const el={tag,style:{},hidden:false,isConnected:true,innerHTML:'',parts:{},listeners:{},setAttribute(){},addEventListener(type,fn){this.listeners[type]=fn;},attachShadow(){return {append(){}};},prepend(child){child.parentElement=this;},getBoundingClientRect:()=>({width:400,left:600,right:1000}),
  querySelector(selector){if(selector==='main')return null;if(!this.innerHTML)return null;return this.parts[selector]||=element(selector);}};elements.push(el);return el;}
 const watch=element('watch'),secondary=element('secondary');watch.querySelector=s=>s==='#secondary'?secondary:element('primary');secondary.querySelector=()=>secondary;
 globalThis.document={createElement:element,querySelector:()=>watch,title:'Video',fullscreenElement:null};globalThis.getComputedStyle=()=>({display:'block'});
 try{
  const panel=createYouTubePanel(()=>visibility++,()=>({refresh(){},destroy(){destroyed++;throw new Error('Extension context invalidated.');}}));
  panel.disconnect('안내',()=>reloads++);assert.equal(destroyed,0);
  panel.sync('video');panel.disconnect('연결이 끊어졌습니다.',()=>reloads++);
  const body=elements.find(e=>e.tag==='div');
  assert.equal(destroyed,1);assert.equal(body.hidden,false);assert.match(body.innerHTML,/이 탭 새로고침/);
  assert.equal(body.parts['.feedback'].textContent,'연결이 끊어졌습니다.');assert.equal(panel.isExpanded(),true);assert.ok(visibility>0);
  const button=body.parts.button;button.listeners.click({isTrusted:false});assert.equal(reloads,0);
  button.listeners.click({isTrusted:true});assert.equal(reloads,1);
 }finally{delete globalThis.document;delete globalThis.getComputedStyle;}
});
