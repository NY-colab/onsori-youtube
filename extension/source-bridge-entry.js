import {lookupAudio} from './direct-audio.js';
let audioLookup;
const currentId=()=>new URL(location.href).searchParams.get('v')||location.pathname.match(/^\/shorts\/([\w-]{11})/)?.[1];
// Same-origin anonymous lookup avoids the player endpoint rejecting an
// extension Origin. Only our background worker can request this operation.
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  if(sender.id!==chrome.runtime.id)return;
  if(message.type==='CANCEL_AUDIO_LOOKUP'){
    if(message.captureId===audioLookup?.id)audioLookup.controller.abort();return;
  }
  if(message.type!=='LOOKUP_FULL_AUDIO')return;
  if(message.source?.videoId!==currentId()||typeof message.captureId!=='string'){reply({ok:false,error:'현재 영상의 오디오만 조회할 수 있습니다.'});return;}
  audioLookup?.controller.abort();
  const task={id:message.captureId,controller:new AbortController()};audioLookup=task;
  lookupAudio(message.source,{signal:task.controller.signal,language:message.language,origin:location.origin}).then(source=>{
    if(task.controller.signal.aborted||source.videoId!==currentId())throw new Error('영상이 바뀌어 오디오 조회를 중지했습니다.');
    reply({ok:true,source});
  }).catch(e=>reply({ok:false,error:e.message})).finally(()=>{if(audioLookup===task)audioLookup=null;});
  return true;
});
// ISOLATED world: only an extension request can initiate source collection.
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  if(message.type!=='GET_FULL_SOURCE'||sender.id!==chrome.runtime.id)return;
  const nonce=crypto.randomUUID(),origin=location.origin;
  const finish=value=>{clearTimeout(timer);window.removeEventListener('message',listener);reply(value);};
  const listener=event=>{const m=event.data;if(event.source===window&&event.origin===origin&&m?.type==='ONSORI_SOURCE_RESPONSE'&&m.nonce===nonce&&m.videoId===message.videoId)finish(m.data);};
  const timer=setTimeout(()=>finish(null),5000);window.addEventListener('message',listener);
  window.postMessage({type:'ONSORI_SOURCE_REQUEST',nonce,videoId:message.videoId},origin);return true;
});
