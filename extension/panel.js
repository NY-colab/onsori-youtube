// A page-embedded extension frame keeps controls isolated from YouTube's styles.
export function createYouTubePanel(onVisibilityChange=()=>{}) {
  let host, frame, expand, collapsed=false, contextKey=null, ready=false;
  let blankFrameRepairs=0;
  const extensionOrigin=chrome.runtime.getURL('').replace(/\/$/, '');
  const visible=element=>element&&element.getBoundingClientRect().width>0&&getComputedStyle(element).display!=='none';
  function refresh() {
    if(ready)frame.contentWindow?.postMessage({type:'ONSORI_PANEL_CONTEXT'},extensionOrigin);
  }
  function restoreFrameSource() {
    // An empty srcdoc takes precedence over src and replaces the extension UI
    // with about:srcdoc. Only repair our own frame, with a bounded retry count.
    if(frame?.hasAttribute('srcdoc')&&frame.getAttribute('srcdoc')===''&&blankFrameRepairs<2){
      blankFrameRepairs++;ready=false;frame.removeAttribute('srcdoc');return true;
    }
  }
  function collapse(value) {
    collapsed=value;frame.hidden=value;expand.hidden=!value;
    if(!value)refresh();
    onVisibilityChange();
  }
  function create() {
    host=document.createElement('onsori-panel');
    host.setAttribute('aria-label','온소리 자막 패널');
    const shadow=host.attachShadow({mode:'open'}),style=document.createElement('style');
    style.textContent=`:host{display:block;width:100%;min-width:0;margin:0 0 16px;box-sizing:border-box}:host([hidden]){display:none!important}iframe{display:block;width:100%;height:480px;border:1px solid #494056;border-radius:16px;background:#15131e;box-sizing:border-box;color-scheme:dark}[hidden]{display:none!important}button{width:100%;display:flex;align-items:center;justify-content:space-between;border:1px solid #494056;border-radius:12px;padding:16px 18px;cursor:pointer;background:#211e2d;color:#a2efcd;font:700 14px/1.5 "Malgun Gothic",sans-serif}button span{font-size:12px;color:#c6b4ef;font-weight:400}button:focus-visible{outline:2px solid #a2efcd;outline-offset:3px}`;
    frame=document.createElement('iframe');frame.title='온소리 자막 · 분석과 설정';
    frame.src=chrome.runtime.getURL('popup.html')+'?view=panel&parent='+encodeURIComponent(location.origin);
    expand=document.createElement('button');expand.type='button';expand.hidden=true;
    expand.innerHTML='온소리 자막 <span>펼치기 ▾</span>';
    expand.setAttribute('aria-label','온소리 자막 패널 펼치기');
    expand.addEventListener('click',()=>collapse(false));
    frame.addEventListener('load',()=>{if(restoreFrameSource())return;ready=true;refresh();});
    shadow.append(style,frame,expand);
  }
  window.addEventListener('message',event=>{
    if(!frame||event.source!==frame.contentWindow||event.origin!==extensionOrigin)return;
    if(event.data?.type==='ONSORI_PANEL_SIZE'&&Number.isFinite(event.data.height)){
      const height=Math.min(800,Math.max(220,Math.ceil(event.data.height)));
      if(frame.style.height!==`${height}px`)frame.style.height=`${height}px`;
    }else if(event.data?.type==='ONSORI_PANEL_COLLAPSE')collapse(true);
  });
  return {
    sync(id) {
      const watch=document.querySelector('ytd-watch-flexy');
      // Shorts and alternative player pages retain the in-player status controls.
      if(!id||!visible(watch)||document.fullscreenElement){if(host)host.hidden=true;return;}
      const secondary=watch.querySelector('#secondary');
      const primary=watch.querySelector('#primary'),primaryBox=primary?.getBoundingClientRect();
      const beside=visible(secondary)&&primaryBox&&secondary.getBoundingClientRect().left>=primaryBox.right-16;
      const target=beside?secondary.querySelector('#secondary-inner')||secondary:watch.querySelector('#below')||watch.querySelector('#primary-inner');
      if(!target){if(host)host.hidden=true;return;}
      if(!host)create();
      restoreFrameSource();
      host.hidden=false;
      if(host.parentElement!==target){ready=false;target.prepend(host);}
      const nextKey=id+'\n'+document.title;
      if(nextKey!==contextKey){contextKey=nextKey;refresh();}
    },
    isExpanded(){return Boolean(host?.isConnected&&!host.hidden&&!collapsed);}
  };
}
