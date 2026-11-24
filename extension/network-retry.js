// A dropped connection makes fetch (or a response body read) reject with a TypeError such as
// "Failed to fetch". That raw English text used to reach the panel (2026-11-24); downloads now
// retry it a few times and then say in Korean what could not be received.
export const NETWORK_RETRY_DELAYS=[1000,3000];
export const isNetworkError=e=>e?.name==='TypeError'&&/failed to fetch|networkerror|network error|load failed|err_/i.test(String(e?.message||''));
export function pause(ms,signal){
  return new Promise((resolve,reject)=>{
    if(signal?.aborted)return reject(new DOMException('취소됨','AbortError'));
    const stop=()=>{clearTimeout(timer);reject(new DOMException('취소됨','AbortError'));};
    const timer=setTimeout(()=>{signal?.removeEventListener('abort',stop);resolve();},ms);
    signal?.addEventListener('abort',stop,{once:true});
  });
}
// Runs `task` again after each delay while it fails with a network error; any other error,
// or cancellation through `signal`, ends at once. After the last retry `giveUp()` is thrown.
export async function retryNetwork(task,{signal,delays=NETWORK_RETRY_DELAYS,giveUp,sleep=pause}={}){
  for(let attempt=0;;attempt++){
    try{return await task();}
    catch(e){
      if(signal?.aborted||!isNetworkError(e))throw e;
      if(attempt>=delays.length)throw giveUp?giveUp(e):e;
      await sleep(delays[attempt],signal);
    }
  }
}
// The error a model download ends with after its retries; `network` keeps the GPU->CPU
// fallback from treating it as a device problem.
export function modelDownloadError(){
  const error=new Error('인터넷 연결이 끊겨 AI 모델 파일을 내려받지 못했습니다. 연결을 확인하고 다시 시도해 주세요.');
  error.network=true;return error;
}
