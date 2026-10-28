# 0.3.0: 전체 영상 분석과 간결한 패널

기본 경로는 `page-source.js`(MAIN) → `source-bridge.js`(ISOLATED) → worker의 `ANALYZE_URL` → offscreen의 `FULL_ANALYZE`입니다. 현재 영상 ID를 확인한 뒤 YouTube가 제공한 직접 audio/mp4 또는 audio/webm 주소만 선택합니다. googlevideo.com의 HTTPS /videoplayback만 허용하며 자격 증명·외부 리디렉션·원격 코드 실행·서명 해독은 사용하지 않습니다. 전체 오디오를 100MB 이하로 스트리밍 수신하고, 20분 이하 길이와 영상 길이 일치를 검증합니다. 기존 Whisper의 겹치는 8초 창과 AST의 2초 창으로 전체 PCM을 분석하며, 영상 전체의 같은 RMS 기준으로 cue 크기를 산정합니다. 모델 세션은 대사/음향 단계별 한 번만 생성합니다.

현재 영상에 제공되는 json3 원래 자막을 읽을 수 있으면 같은 시각의 대사를 대조합니다. 화면 이미지 OCR은 선택한 탭 녹음에만 적용됩니다. 전체 오디오나 원래 자막을 얻을 수 없는 경우가 있으며, 특히 원래 자막이 없는 영상은 대사 교정을 보장할 수 없습니다. 전체 오디오 오류는 명시하며 구간 녹음으로 자동 전환하지 않습니다. 새 영상 자동 시도는 한 번이고 취소/실패 후에는 수동 재시도합니다. 기존 60초 탭 녹음은 보조 경로로 유지합니다.

자막은 완료 결과를 한 번에 게시합니다. X/Y는 영상 안 자막 상자의 중심 백분율(기본 50/88)이며, 실제 상자 크기를 측정하여 영상 경계 안에 둡니다. 한 cue의 글자 크기는 기존처럼 고정합니다.

검증: 자동 테스트와 격리 UI 렌더. 사용자의 Chrome은 다른 확장 UI로 자동 조작이 차단되어 v0.3.0의 실제 YouTube 전체 다운로드 → AI → 자막 연속 검증은 미완료입니다. 아래는 이전 버전의 검증 이력입니다.

---

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
