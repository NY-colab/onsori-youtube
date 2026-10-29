import {mountControls} from './controls.js';
import {panelHTML,panelCSS} from './panel-template.js';

// Render directly in an isolated style tree, without a separate extension frame.
export function createYouTubePanel(onVisibilityChange=()=>{},mount=mountControls) {
  let host,body,expand,controls,collapsed=false,contextKey=null;
  const visible=element=>element&&element.getBoundingClientRect().width>0&&getComputedStyle(element).display!=='none';
  function collapse(value){
    collapsed=value;body.hidden=value;expand.hidden=!value;
    if(!value)controls.refresh();
    onVisibilityChange();
  }
  function create(){
    host=document.createElement('onsori-panel');
    host.setAttribute('aria-label','온소리 자막 패널');
    const shadow=host.attachShadow({mode:'open'}),style=document.createElement('style');
    style.textContent=panelCSS+'\n:host{display:block;width:100%;min-width:0;margin:0 0 16px;box-sizing:border-box}:host([hidden]){display:none!important}.expand{width:100%;padding:14px;background:var(--bg);color:var(--mint);border:1px solid var(--line);border-radius:12px}';
    body=document.createElement('div');body.className='panel-body';body.innerHTML=panelHTML;
    expand=document.createElement('button');expand.type='button';expand.hidden=true;expand.className='expand';
    expand.textContent='온소리 자막 펼치기 ▾';expand.setAttribute('aria-label','온소리 자막 패널 펼치기');
    expand.addEventListener('click',event=>{if(event.isTrusted)collapse(false);});
    shadow.append(style,body,expand);
    controls=mount(shadow,{embedded:true,onCollapse:()=>collapse(true)});
  }
  return {
    sync(id){
      const watch=document.querySelector('ytd-watch-flexy');
      if(!id||!visible(watch)||document.fullscreenElement){if(host)host.hidden=true;return;}
      const secondary=watch.querySelector('#secondary');
      const primary=watch.querySelector('#primary'),primaryBox=primary?.getBoundingClientRect();
      const beside=visible(secondary)&&primaryBox&&secondary.getBoundingClientRect().left>=primaryBox.right-16;
      const target=beside?secondary.querySelector('#secondary-inner')||secondary:watch.querySelector('#below')||watch.querySelector('#primary-inner');
      if(!target){if(host)host.hidden=true;return;}
      if(!host)create();
      host.hidden=false;
      if(host.parentElement!==target)target.prepend(host);
      const nextKey=id+'\n'+document.title;
      if(nextKey!==contextKey){contextKey=nextKey;controls.refresh();}
    },
    isExpanded(){return Boolean(host?.isConnected&&!host.hidden&&!collapsed);}
  };
}
