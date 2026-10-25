// Only model DATA is downloaded. All JavaScript and WASM ship inside the extension.
export const MODEL_CONFIG = Object.freeze({
  sampleRate:16000, maxSeconds:60, maxBytes:100*1024*1024,
  whisper:{id:'onnx-community/whisper-base',revision:'1846881b6b3a3024392c1eea3ad983695bc23925',dtype:'q8',license:'Apache-2.0 (OpenAI upstream)',upstream:'https://huggingface.co/openai/whisper-base'},
  events:{id:'Xenova/ast-finetuned-audioset-10-10-0.4593',revision:'249a1fbf0286b40e7f1ed687a8ae396997bf7dc6',dtype:'q8',license:'BSD-3-Clause (MIT upstream)',upstream:'https://huggingface.co/MIT/ast-finetuned-audioset-10-10-0.4593'},
  ocr:{languages:'kor+eng',revision:'87416418657359cb625c412a48b6e1d6d41c29bd',dataPath:'https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/87416418657359cb625c412a48b6e1d6d41c29bd',license:'Apache-2.0',minConfidence:90,minObservations:3,maxFrames:121,minFrameGap:.45},
  runtime:{transformers:'3.7.6',tesseract:'6.0.1',device:'wasm',threads:1},
});
