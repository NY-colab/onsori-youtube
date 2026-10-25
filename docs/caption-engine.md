# Optional CoNeTTE audio captions

OnSori can run **real local audio captioning** using the author's
[`Labbeti/conette`](https://huggingface.co/Labbeti/conette) model. This is optional;
it runs in `.venv-caption`, separate from the main FastAPI/Whisper/AST environment.
The worker generates raw **English**. The main server optionally translates it
locally with OPUS-MT and fills `cue.details`; the English original remains in
`metadata.captioning`. Both descriptions and translations require human review.
See [OPEN_SOURCE.md](OPEN_SOURCE.md) for the pinned translation model and
vocabulary correction. Translation failures preserve the English description.

## Install on Windows

From this `onsori` directory, with `uv` available:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install_caption.ps1
```

The installer creates Python **3.10** and installs `conette==0.4.0`,
`torch==1.13.1+cpu`, `torchaudio==0.13.1+cpu`, `transformers==4.30.2`,
`numpy==1.26.4`, and the requirements in `requirements-caption.txt`.
It also installs the official spaCy `en_core_web_sm==3.7.1` wheel and prepares
NLTK stopwords, AudioSet class metadata, and the caption checkpoint. The CPU
PyTorch wheels avoid installing CUDA packages. Python 3.11+ cannot install this
CoNeTTE release; do not install it into the main server environment.

`-SkipModelDownload` installs packages only; inference will then report missing
resources until `python server/caption_worker.py --prepare` is run in this venv.
Preparation can download official resources. During analysis CoNeTTE's
`offline=True` suppresses its automatic runtime spaCy/pip setup; weights can be
fetched from Hugging Face on first load if not already cached. After preparation,
the caption CLI also works with `HF_HUB_OFFLINE=1`.

The pinned author checkpoint revision is
`f7c6d0338832ee22df1e7c9d579cf5911a1a115d`; its 202,634,582-byte
`pytorch_model.bin` SHA-256 is
`271b9f4409ebbceaa0d5fe5319069a3a56e269ab0b868616d7e23f5145cc0ce2`.
The worker uses the installed `CoNeTTEConfig` / `CoNeTTEModel` API, never
`trust_remote_code`, `torch.hub.load`, or downloaded Python modules.

Default data paths are `models/huggingface`, `models/torch`,
`models/nltk_data`, and `models/audioset`. The worker honors an inherited
`HF_HOME`, `TORCH_HOME`, or `NLTK_DATA` to share a parent cache; the parent should
keep these paths inside this project's `models` directory. CoNeTTE's otherwise
hard-coded AudioSet user-cache default is redirected to `models/audioset`.
There is no audio upload or paid API call.

## CLI contract

```powershell
.venv-caption/Scripts/python.exe -X utf8 server/caption_worker.py --manifest INPUT.json --output OUTPUT.json
```

Manifest example:

```json
{"device":"cpu","segments":[{"id":"sound-1","start":12.0,"end":17.0,"path":"clips/sound-1.wav"}]}
```

Paths are absolute or relative to the manifest. Each WAV already contains its
requested interval: `start` / `end` are absolute timeline metadata, and the worker
does **not** cut the audio a second time. Input must be uncompressed PCM WAV,
mono/stereo, at most 192 kHz, 0.1–30 seconds and at most 100 MiB per file.
Prefer 1–30-second clips, the model's training range; especially short clips may
not provide enough context. The model internally resamples to 32 kHz. A manifest
is at most 1 MiB and contains at most 100 uniquely identified segments.

Success writes atomically as UTF-8:

```json
{"model":"Labbeti/conette","captions":[{"id":"sound-1","text":"birds are chirping and singing in the background"}],"warnings":[]}
```

One model is loaded lazily per process and reused across segments. CPU inference
uses evaluation mode, disabled gradients, seed 0, deterministic algorithms, and
at most four torch threads. An empty manifest does not import ML packages or load
weights. Successful segments are preserved when an individual inference fails;
failed segments appear only in `warnings`, never as fabricated descriptions.
If every caption fails, or input/setup is invalid, the CLI exits 1 and prints
one bounded JSON error object to stderr. It does not write a new success result.
Callers must check the exit code before reading output; use a fresh output path
per job and apply their own subprocess timeout/cancellation.

## Verified local result (2026-10-24)

Windows, Python 3.10.20, CPU PyTorch 1.13.1+cpu. Exact package versions are saved
in `../../work/onsori/caption-qa/dependencies.json` relative to the `onsori` root.
Public source recordings were downloaded from the official librosa example audio
host, converted with libsndfile to PCM16 WAV, and left in the project QA folder.
No application/proposal documents or personal recordings were used.

| Clip | Attribution and license | Measured caption |
| --- | --- | --- |
| `trumpet.wav`, 5.333 s | Mihai Sorohan, [Jazz Trumpet Loops Pack in F 90 bpm](https://freesound.org/s/77711/), [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/); [official librosa source](https://librosa.org/data/audio/sorohanro_-_solo-trumpet-06.ogg), [license text](https://librosa.org/data/audio/sorohanro_-_solo-trumpet-06.txt) | `a musical instrument is playing a song with varying volumes and pitches` |
| `robin.wav`, 2.699 s | InspectorJ, [Bird Whistling, Robin, Single, 13.wav](https://freesound.org/people/InspectorJ/sounds/456440/), [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/); [official librosa source](https://librosa.org/data/audio/456440__inspectorj__bird-whistling-robin-single-13.ogg), [license text](https://librosa.org/data/audio/456440__inspectorj__bird-whistling-robin-single-13.txt) | `birds are chirping and singing in the background` |

The actual final worker CLI processed both clips in **11.297 seconds**, including
Python imports and cached model loading; exit 0, two captions, no warnings.
The installer was also rerun successfully, followed by a second CLI run with
`HF_HUB_OFFLINE=1`; both generated captions were byte-for-byte identical.
An earlier direct model call measured 0.553 seconds for trumpet inference alone,
after model loading. These are one-machine observations, not a latency guarantee.
Captions identify broad content correctly but the trumpet result omits the exact
instrument name; this small check is not a general accuracy evaluation.

QA evidence: `../../work/onsori/caption-qa/manifest.json`, `result.json`,
`timing.json`, source OGGs, WAVs, and source license text.
The result can be reproduced from the `onsori` root:

```powershell
$env:HF_HUB_OFFLINE = '1'
.venv-caption/Scripts/python.exe -X utf8 server/caption_worker.py --manifest ../../work/onsori/caption-qa/manifest.json --output ../../work/onsori/caption-qa/result-repeat.json
.venv-caption/Scripts/python.exe -X utf8 -m pytest tests/test_caption_worker.py -q --basetemp=../../work/onsori/caption-qa/pytest -o cache_dir=../../work/onsori/caption-qa/pytest-cache
```

`pytest` is a development-only dependency (`uv pip install --python
.venv-caption/Scripts/python.exe pytest==8.4.2`). All **14 protocol tests** passed,
including Unicode/BOM paths, absolute timeline preservation, finite time bounds,
device restriction, no loading for empty input, partial failures, bounded JSON
errors, and atomic output. Real checkpoint inference was verified separately.

An initial parent integration run reported a generic Transformers checkpoint-load
error on the JFK recording. The checkpoint SHA-256 remained correct. The exact
manifest then succeeded unchanged, including when launched from main `.venv`
with PyTorch 2.8 and the AST model resident; separate `result-repair*.json`
evidence preserves the original failure log. The worker now includes bounded
exception-chain details so an underlying allocation/deserialization error will
remain visible if this occurs again. The original transient cause was not
established; successful reruns alone do not prove that it has been fixed.

## Sources and licenses

The [official repository](https://github.com/Labbeti/conette-audio-captioning)
and [Hugging Face model card](https://huggingface.co/Labbeti/conette) state MIT.
Preserve their license notices when distributing model/code copies. The two
test recordings have their own CC BY 3.0 attribution requirements as listed above.
The [PyPI 0.4.0 metadata](https://pypi.org/project/conette/0.4.0/)
requires Python `>=3.10,<3.11` and pins the legacy torch/torchaudio/transformers
versions; this is why the optional worker is isolated.
