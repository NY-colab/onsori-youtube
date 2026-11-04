import {MODEL_CONFIG} from './model-config.js';

// WebGPU needs shader-f16 for the fp16/q4f16 model files in MODEL_CONFIG.gpu.
export async function webgpuReady(gpu=globalThis.navigator?.gpu){
  try{const adapter=await gpu?.requestAdapter({powerPreference:'high-performance'});return Boolean(adapter?.features?.has('shader-f16'));}catch{return false;}
}

// GPU first when available; any GPU failure reruns the whole recording on the
// CPU models so a partial GPU result is never mixed with a CPU one.
export function engineProfiles(gpuReady,requested='auto'){
  const cpu={device:'wasm',whisper:MODEL_CONFIG.whisper,events:MODEL_CONFIG.events,asrWindow:MODEL_CONFIG.asrWindow};
  return gpuReady&&requested!=='wasm'?[{device:'webgpu',whisper:MODEL_CONFIG.gpu.whisper,events:MODEL_CONFIG.gpu.events,asrWindow:MODEL_CONFIG.gpu.asrWindow},cpu]:[cpu];
}

// Whisper never needs more tokens than dense Korean speech in the window plus
// timestamps; the cap also bounds time lost to a decoder loop.
export function maxNewTokens(seconds){return Math.min(440,Math.round(seconds*15)+16);}
