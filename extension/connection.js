// Reloading or updating the extension leaves page scripts running without Chrome APIs.
// chrome.runtime.sendMessage then throws "Extension context invalidated" synchronously,
// which a promise .catch() never sees, so every call site goes through these guards.
const LOST=/Extension context invalidated/i;

export function extensionConnected(getRuntime=()=>globalThis.chrome?.runtime){
  try{return Boolean(getRuntime()?.id);}catch{return false;}
}

export function contextLost(error,getRuntime){
  return !extensionConnected(getRuntime)||LOST.test(error?.message||String(error||''));
}

// Resolves to the reply, or null when the message could not be delivered.
export function createSafeSend(getRuntime,onLost=()=>{}){
  return payload=>{
    if(!extensionConnected(getRuntime)){onLost();return Promise.resolve(null);}
    try{
      return Promise.resolve(getRuntime().sendMessage(payload)).catch(error=>{if(contextLost(error,getRuntime))onLost();return null;});
    }catch(error){
      if(contextLost(error,getRuntime))onLost();
      return Promise.resolve(null);
    }
  };
}

export function disconnectMessage(wasBusy){
  return (wasBusy?'확장 프로그램이 업데이트되거나 다시 불러와져 진행 중이던 분석이 멈췄습니다. ':'확장 프로그램이 업데이트되거나 다시 불러와져 이 탭과의 연결이 끊어졌습니다. ')
    +'이 탭을 새로고침하면 다시 연결됩니다.'+(wasBusy?' 새로고침한 뒤 분석을 다시 시작해 주세요.':'');
}

export const DISCONNECTED_ERROR='확장 프로그램이 다시 불러와져 연결이 끊어졌습니다. 이 탭을 새로고침해 주세요.';
