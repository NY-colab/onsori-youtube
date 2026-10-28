// ISOLATED world: only an extension request can initiate source collection.
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  if(message.type!=='GET_FULL_SOURCE'||sender.id!==chrome.runtime.id)return;
  const nonce=crypto.randomUUID(),origin=location.origin;
  const finish=value=>{clearTimeout(timer);window.removeEventListener('message',listener);reply(value);};
  const listener=event=>{const m=event.data;if(event.source===window&&event.origin===origin&&m?.type==='ONSORI_SOURCE_RESPONSE'&&m.nonce===nonce&&m.videoId===message.videoId)finish(m.data);};
  const timer=setTimeout(()=>finish(null),5000);window.addEventListener('message',listener);
  window.postMessage({type:'ONSORI_SOURCE_REQUEST',nonce,videoId:message.videoId},origin);return true;
});
