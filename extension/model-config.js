// Only model DATA is downloaded. All JavaScript and WASM ship inside the extension.
export const MODEL_CONFIG = Object.freeze({
  sampleRate:16000, maxSeconds:60, maxFullSeconds:1200, maxBytes:100*1024*1024,
  // Independent ASR windows. Short CPU windows keep base-model endpoints local.
  // On GPU, AST runs first and Whisper hears only AST speech regions in windows
  // of at most 14 s; longer turbo windows skipped whole lines (eval 2026-11-04).
  asrWindow:{seconds:8,step:5},
  whisper:{id:'onnx-community/whisper-base',revision:'1846881b6b3a3024392c1eea3ad983695bc23925',dtype:'q8',license:'Apache-2.0 (OpenAI upstream)',upstream:'https://huggingface.co/openai/whisper-base'},
  events:{id:'Xenova/ast-finetuned-audioset-10-10-0.4593',revision:'249a1fbf0286b40e7f1ed687a8ae396997bf7dc6',dtype:'q8',license:'BSD-3-Clause (MIT upstream)',upstream:'https://huggingface.co/MIT/ast-finetuned-audioset-10-10-0.4593'},
  // Used only when a WebGPU adapter exposes shader-f16; otherwise the CPU models
  // above run. Any GPU failure reruns the whole recording on the CPU models.
  gpu:{
    whisper:{id:'onnx-community/whisper-large-v3-turbo',revision:'360ebcde2559d60bb474678be3c1de9ef347d01a',dtype:{encoder_model:'q4f16',decoder_model_merged:'q4f16'},license:'MIT (OpenAI upstream)',upstream:'https://huggingface.co/openai/whisper-large-v3-turbo'},
    events:{id:'Xenova/ast-finetuned-audioset-10-10-0.4593',revision:'249a1fbf0286b40e7f1ed687a8ae396997bf7dc6',dtype:'fp16',license:'BSD-3-Clause (MIT upstream)',upstream:'https://huggingface.co/MIT/ast-finetuned-audioset-10-10-0.4593'},
    asrWindow:{seconds:14,step:11,gate:'speech'},
    downloadMB:740,
  },
  ocr:{languages:'kor+eng',revision:'87416418657359cb625c412a48b6e1d6d41c29bd',dataPath:'https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/87416418657359cb625c412a48b6e1d6d41c29bd',license:'Apache-2.0',minConfidence:90,minObservations:3,maxFrames:121,minFrameGap:.45},
  runtime:{transformers:'3.7.6',tesseract:'6.0.1',devices:['webgpu','wasm'],threads:1},
});
