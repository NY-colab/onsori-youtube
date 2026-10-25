# Browser-only inference

`extension/browser-engine.js` exports `analyzeRecording({blob, videoId, title,
startTime, options, references, frames, onProgress, signal})`. It resolves one
`core.validateDocument`-validated schema 1.0 document. Progress callbacks receive
`{progress, message}`. Required ASR or event inference failure rejects the operation;
there is no demo or transcript-only fallback disguised as analyzed audio.

Audio is decoded and downmixed in a local AudioContext, resampled to 16 kHz,
then transferred to a dedicated module worker. Whisper and AST run sequentially,
disposing the first session before loading the second. WASM is deliberately
single-threaded because MV3 pages do not provide cross-origin isolation.
Whisper is called independently on eight-second audio windows with three seconds
of overlap, reusing one model instance. Automatic long-audio stride merging is
disabled. Missing endpoints stop at their own audio window, and local timestamps
are shifted once. Overlap duplicates need both time and lexical/jamo agreement;
center ownership selects the retained observation, while a substantially fuller
utterance takes precedence over a short boundary fragment. There are no invented
word timings. High-rate periodic decoder loops are excluded with original text
and a reason retained in ASR diagnostics. A candidate needs over 80 characters,
over 18 characters per second and a periodic substring repeated at least eight
times covering at least 70% of the text. Segment timestamps remain estimates.
Browser recording analysis is limited to 0.2–60 seconds and 100 MB per interval.
Times are shifted to the original video timeline exactly once.

## Reproducible runtime build

```powershell
npm ci --prefix browser-build --ignore-scripts --no-audit --no-fund
node scripts/build_browser.mjs
node --test extension/browser-engine.test.mjs
```

`browser-build/package-lock.json` pins the complete npm dependency tree.
`extension/vendor/build-manifest.json` records code/WASM hashes and the lockfile
hash. `THIRD-PARTY-NOTICES.txt` contains dependency licenses. No Node, npm,
Python, EXE, external inference API, or localhost service is used by the installed
extension. Build dependencies do not ship in the Web Store package.

The small `tesseract-spawn-worker.cjs` adapter exposes the native OCR worker at
construction, before model download completes, so AbortSignal can terminate it
immediately. The adapter has no CDN or Blob worker fallback. Its source hash is
included in the vendor manifest. The upstream worker and core remain pinned.

All executable JavaScript and WASM are packaged locally. CSP needs
`script-src 'self' 'wasm-unsafe-eval'`, `worker-src 'self'`, and the pinned model
hosts in `connect-src`. `unsafe-eval` and remote script origins are unnecessary.
Only model data is fetched from Hugging Face and GitHub raw content. Hugging Face
may redirect large ONNX downloads to `*.hf.co`. First use requires network and
downloads hundreds of MB; subsequent model reads use the browser Cache API or
IndexedDB. Cached weights can be evicted by Chrome, and browser storage or network
failure is reported explicitly. Download requests reveal normal network metadata
such as IP address to those hosting services; recording audio, video frames and
recognized content are not uploaded by the engine.

## Models and licenses

| Purpose | Pinned model data | License of upstream model |
| --- | --- | --- |
| Korean multilingual timestamped ASR | `onnx-community/whisper-base@1846881b6b3a3024392c1eea3ad983695bc23925`, q8 | Apache-2.0 per [OpenAI model card](https://huggingface.co/openai/whisper-base) |
| Music and sound classification | `Xenova/ast-finetuned-audioset-10-10-0.4593@249a1fbf0286b40e7f1ed687a8ae396997bf7dc6`, q8 | BSD-3-Clause per [MIT model card](https://huggingface.co/MIT/ast-finetuned-audioset-10-10-0.4593) |
| Korean/English screen text | `tesseract-ocr/tessdata_fast@87416418657359cb625c412a48b6e1d6d41c29bd`, kor+eng | Apache-2.0, [upstream](https://github.com/tesseract-ocr/tessdata_fast) |

Runtime versions: Transformers.js 3.7.6, its pinned ONNX Runtime Web,
Tesseract.js 6.0.1 and lockfile-pinned Tesseract core. These are open source
models and local model execution, not browser speech recognition services.

AST uses independent sigmoid on model logits because AudioSet is multi-label.
The generic Transformers.js 3.x audio classification pipeline's softmax would
incorrectly force competing probabilities between simultaneous speech, music
and effects. Windows are at most two seconds; mixed-waveform RMS refines transient
bounds. This is approximate event timing, not source separation or frame-accurate
sound event detection. Only reviewed AudioSet labels are translated. Instruments,
genres and moods require their own score and margin gates; unsupported values
are empty/null. BPM, music identity and rhythm are not invented. Scores are
heuristic model gates, not calibrated probabilities.

Whisper may invent speech over music or body sounds. When AST is enabled, a
candidate is suppressed only if every overlapping classified window has
Speech/Conversation/Narration scores below 0.05 and supported music/sound scores
at least 0.65. Rejected ASR and numeric evidence remain in metadata. Mixed or
uncertain evidence preserves the speech candidate. This conservative heuristic
can still miss hallucinations or reject quiet speech and requires review.
Standalone bracketed ASR annotations are also excluded when all overlapping AST
windows have speech scores below 0.05; annotations with speech evidence survive.
In addition, a standalone balanced bracket tag of one to three letters without
spaces or sentence punctuation is treated as ASR metadata, with common Korean
sentence endings exempt. Original text/time/source are retained in diagnostics.
Normal sentences, inline parentheses and source-corrected dialogue are preserved.

## Volume and source-backed correction

Caption size uses RMS over the entire cue, relative to one active-frame median
reference for the recording. This scale remains fixed while the cue is visible.
100 ms attack/release profiles are retained only as diagnostics. Merged dialogue
cues use a duration-weighted energy average, not an average of dB values.

Native caption references require same-video binding, narrow time alignment,
substantial lexical agreement and full-interval coverage. Human authorship of
observed native captions is not assumed. Screen references use only explicit
lower-video frame captures. No page screenshot, cookie, download of the original
YouTube video, or remote OCR service is used. Capture failure is not bypassed.

For ordinary white video captions, OCR derives a high contrast bitmap, separates
distant background glyph groups, and preserves the exact recognized line spacing.
The original capture remains unchanged. Colored or stylized captions may be
unreadable. OCR is sampled at no more than roughly two frames per second, bounded
to 121 frames and restricted to nearby uncorrected ASR intervals.

Tesseract confidence is **not** PaddleOCR confidence. Real Korean frame diagnosis
showed correct Tesseract words often scoring 90–93/100. This browser engine therefore
requires a word-length-weighted group confidence of at least 90/100 and at least
three identical normalized observations at distinct times spanning at least 0.8s,
with no observation gap over 1.1s. It also requires same-video binding, timestamp
overlap, full-sentence length coverage, both sentence edges, character agreement
and decomposed Hangul jamo agreement. Near-homophone block substitutions need
at least 2/3 character agreement and 0.88 jamo agreement. There is no phrase-specific
substitution dictionary or generated grammar correction.

The exact accepted source text and original ASR are retained in
`speech_correction`. Original word timings are retained as provenance and cleared
from displayed corrected words. Low-quality, short, inconsistent, unbound or
unseen text is rejected rather than deleting unseen speech. Results remain marked
for review. OCR failure does not claim that ASR is correct.

## Isolated verification

`browser-build/qa-inference.mjs`, `qa-ocr.mjs` and `qa-regression.mjs` create an
unsigned MV3 fixture under the project's `work/onsori/browser-store/engine-qa/`,
using a separate headless Chromium profile. They never connect to the user's
signed-in browser. Model execution is tested under the extension CSP, and the
network log checks that no remote JS/MJS/WASM or inference POST is requested.
Fixtures use existing project sample media and are not included in the extension.
The final inference run copies the full production extension and unchanged
manifest into the fixture, with its actual permissions and no unlimitedStorage.
`ONSORI_CHROMIUM_PATH` optionally selects an installed test Chromium executable;
otherwise Playwright's `chromium.executablePath()` is used.

On the real seven-second Korean excerpt, repeated pixel observations corrected
Whisper's `이것은 5시오 이불이요?` to `이것은 옷이오, 이불이오?`. The final
document records original text and OCR source. This single verified case does
not establish general transcription or OCR accuracy. Actual results, timings,
network requests and cancellation checks are in the JSON QA reports.

The actual trumpet recording produced `트럼펫 연주` (AST score approximately 0.80).
The ESC-50 sneezing sample was classified as throat clearing (approximately 0.73),
so this model does not reliably distinguish every effect subtype. Both produced
short Whisper hallucinations which the above evidence filter removed. These are
sample-specific regression observations, not an accuracy benchmark. Actual ASR
and OCR initialization cancellation returned AbortError within approximately
21 ms after the test cancellation signal.

The final 60-second file-fed run completed in 172.6 seconds with cached models.
Independent calls restored the first dialogue to 5–8.4 seconds and the next to
9–11.6 seconds instead of allowing automatic stride merging to stretch segments
across the recording. A decoder loop and duplicate boundary clauses were removed.
Spelling errors and coarse segment timing remain; this is not a general accuracy
benchmark or an actual tabCapture UI test.

`qa-postprocess.mjs` separately replays the saved real 60-second result through
the final tag filter. It removes the two standalone bracket tags while preserving
the six ordinary dialogue segments and every other cue byte-for-byte. The
original `actual-inference-60.json` remains unchanged; `postprocess-60.json`
explicitly records `inference_repeated: false`. This replay is not represented
as another model inference run.
