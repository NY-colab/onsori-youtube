// Reproducible vendor build. Run npm ci --prefix browser-build --ignore-scripts first.
// Executable code is copied from the lockfile-pinned npm packages; never a CDN.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {build} from '../browser-build/node_modules/esbuild/lib/main.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const modules=path.join(root,'browser-build/node_modules'),vendor=path.join(root,'extension/vendor');
const entries=[
  ['@huggingface/transformers/dist/transformers.min.js','transformers/transformers.min.js'],
  ['@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.mjs','transformers/ort-wasm-simd-threaded.jsep.mjs'],
  ['@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.wasm','transformers/ort-wasm-simd-threaded.jsep.wasm'],
  ['tesseract.js/dist/tesseract.esm.min.js','tesseract/tesseract.esm.min.js'],
  ['tesseract.js/dist/worker.min.js','tesseract/worker.min.js'],
  ['tesseract.js-core/tesseract-core-lstm.wasm.js','tesseract/tesseract-core-lstm.wasm.js'],
  ['tesseract.js-core/tesseract-core-simd-lstm.wasm.js','tesseract/tesseract-core-simd-lstm.wasm.js'],
];
for(const [source,destination] of entries){await fs.mkdir(path.dirname(path.join(vendor,destination)),{recursive:true});await fs.copyFile(path.join(modules,source),path.join(vendor,destination));}
await build({entryPoints:[path.join(modules,'tesseract.js/src/index.js')],outfile:path.join(vendor,'tesseract/tesseract.esm.min.js'),bundle:true,platform:'browser',format:'esm',minify:true,legalComments:'inline',plugins:[{name:'immediate-cancellation',setup(builder){builder.onLoad({filter:/tesseract\.js[\\/]src[\\/]worker[\\/]browser[\\/]spawnWorker\.js$/},async()=>({contents:await fs.readFile(path.join(root,'browser-build/tesseract-spawn-worker.cjs'),'utf8'),loader:'js'}));}}]});
// Include licenses of every installed production package in the pinned tree.
// Some build-only platform packages are intentionally included as an overinclusive notice.
const notices=['OnSori bundled browser runtimes\n\nJavaScript and WebAssembly run from the extension package. Only pinned model data is downloaded.\n'];
async function walk(dir){for(const entry of await fs.readdir(dir,{withFileTypes:true})){if(!entry.isDirectory()||entry.name.startsWith('.'))continue;const folder=path.join(dir,entry.name);if(entry.name.startsWith('@')){await walk(folder);continue;}let pkg;try{pkg=JSON.parse(await fs.readFile(path.join(folder,'package.json'),'utf8'));}catch{continue;}
  const licenses=(await fs.readdir(folder)).filter(name=>/^(license|licence|notice|copying)(\.|$)/i.test(name));
  notices.push(`\n===== ${pkg.name}@${pkg.version} · ${pkg.license||'see notice'} =====\n`);
  for(const file of licenses){try{const value=await fs.readFile(path.join(folder,file),'utf8');notices.push(`\n${file}\n${value}\n`);}catch{}}
  try{await walk(path.join(folder,'node_modules'));}catch{}
}}
await walk(modules);
notices.push('\nMODEL DATA (not bundled):\nWhisper base: onnx-community/whisper-base@1846881b6b3a3024392c1eea3ad983695bc23925; upstream OpenAI whisper-base model card Apache-2.0, https://huggingface.co/openai/whisper-base\nAST: Xenova/ast-finetuned-audioset-10-10-0.4593@249a1fbf0286b40e7f1ed687a8ae396997bf7dc6; upstream MIT/ast-finetuned-audioset-10-10-0.4593 model card BSD-3-Clause, https://huggingface.co/MIT/ast-finetuned-audioset-10-10-0.4593\nTesseract tessdata_fast kor+eng@87416418657359cb625c412a48b6e1d6d41c29bd, Apache-2.0; https://github.com/tesseract-ocr/tessdata_fast\n');
await fs.writeFile(path.join(vendor,'THIRD-PARTY-NOTICES.txt'),notices.join(''),'utf8');
const manifest={generated_by:'node scripts/build_browser.mjs',lockfile_sha256:createHash('sha256').update(await fs.readFile(path.join(root,'browser-build/package-lock.json'))).digest('hex'),files:[]};
manifest.tesseract_adapter_sha256=createHash('sha256').update(await fs.readFile(path.join(root,'browser-build/tesseract-spawn-worker.cjs'))).digest('hex');
for(const [,relative] of entries){const bytes=await fs.readFile(path.join(vendor,relative));manifest.files.push({path:relative,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}
await fs.writeFile(path.join(vendor,'build-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(`Bundled ${entries.length} browser runtime assets, ${manifest.files.reduce((s,x)=>s+x.size,0)} bytes. No remote executable code.`);
