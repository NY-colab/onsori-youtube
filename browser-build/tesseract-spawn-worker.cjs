// Small audited adapter for tesseract.js 6.0.1. Expose the native worker
// immediately so cancellation can terminate model downloads during createWorker.
// The upstream API exposes it only after traineddata initialization completes.
module.exports=({workerPath,onWorkerCreated})=>{
  const worker=new Worker(workerPath);
  onWorkerCreated?.(worker);
  return worker;
};
