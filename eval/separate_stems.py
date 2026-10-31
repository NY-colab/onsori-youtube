"""Split one evaluation WAV into HT-Demucs vocals / accompaniment stems.

Evaluation tooling only: the extension never runs this. Run from the repository
root with the local analysis venv (torch + demucs 4.1.0):

    .venv\\Scripts\\python.exe -X utf8 eval\\separate_stems.py <original.wav> <out_dir>

Stems keep the input sample rate, channel count and sample length so the
browser engine decodes every condition the same way and cue times stay
comparable. Pinned weights are the same revision as the 2026-10-25 8-second
experiment (work/onsori/music-dynamics/separation).
"""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
import sys
import time

REPO = 'adefossez/HTDemucs'
REV = 'cbc8a9b1a87023b7fd74e7b3412e6321c0eab003'
APP = Path(__file__).resolve().parents[1]


def sha256(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1 << 20), b''):
            digest.update(block)
    return digest.hexdigest()


def main(source, out_dir):
    os.environ.setdefault('HF_HOME', str(APP / 'models' / 'huggingface'))
    os.environ.setdefault('HF_HUB_DISABLE_SYMLINKS_WARNING', '1')
    import numpy as np
    import soundfile as sf
    import torch
    import yaml
    from huggingface_hub import hf_hub_download
    from safetensors import safe_open
    from demucs.apply import apply_model
    from demucs.audio import convert_audio
    from demucs.hf import load_safetensors_model

    source, out = Path(source), Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    audio, sr = sf.read(source, dtype='float32', always_2d=True)  # (frames, channels)
    bag = yaml.safe_load(Path(hf_hub_download(REPO, 'htdemucs.yaml', revision=REV)).read_text())
    assert len(bag['models']) == 1, bag
    weight = Path(hf_hub_download(REPO, f"{bag['models'][0]}.safetensors", revision=REV))
    with safe_open(str(weight), framework='pt') as f:
        assert f.metadata()['klass'] == 'demucs.htdemucs.HTDemucs'
    model = load_safetensors_model(weight).eval()
    torch.set_num_threads(min(8, os.cpu_count() or 1))
    loaded = time.perf_counter()

    wav = convert_audio(torch.from_numpy(audio.T.copy()), sr, model.samplerate, model.audio_channels)
    ref = wav.mean(0)
    mean, std = ref.mean(), ref.std() + 1e-8
    with torch.inference_mode():
        stems = apply_model(model, ((wav - mean) / std)[None], segment=7, shifts=0, split=True,
                            overlap=.25, device='cpu', num_workers=0, progress=False)[0]
    stems = stems * std + mean  # Demucs separate_tensor scaling; no extra normalisation
    separated = time.perf_counter()

    def restore(stem):
        # Back to the input rate/channels and exact length so timestamps line up.
        x = convert_audio(stem, model.samplerate, sr, audio.shape[1]).numpy().T[:len(audio)]
        if len(x) < len(audio):
            x = np.pad(x, ((0, len(audio) - len(x)), (0, 0)))
        return x

    vocals = restore(stems[model.sources.index('vocals')])
    accompaniment = restore(stems[[model.sources.index(s) for s in ('drums', 'bass', 'other')]].sum(0))
    files = {}
    for name, x in (('vocals', vocals), ('accompaniment', accompaniment)):
        path = out / f'{name}.wav'
        clipped = int(np.count_nonzero(np.abs(x) > 1))
        # PCM16 keeps a 6-minute stereo stem under the extension's 100MB input limit.
        sf.write(path, np.clip(x, -1, 1), sr, subtype='PCM_16')
        files[name] = {'path': path.name, 'sha256': sha256(path), 'frames': len(x), 'peak': float(np.abs(x).max()),
                       'clipped_samples': clipped,
                       'rms_dbfs': float(20 * np.log10(max(1e-12, np.sqrt(np.mean(x.astype('float64') ** 2)))))}
    residual = audio - vocals - accompaniment
    report = {
        'source': str(source), 'source_sha256': sha256(source), 'sample_rate': sr, 'channels': audio.shape[1],
        'frames': len(audio), 'seconds': len(audio) / sr,
        'model': {'repo': REPO, 'revision': REV, 'weight_sha256': sha256(weight), 'code': 'demucs==4.1.0 (MIT)',
                  'weight_license': 'not stated in pinned model card; evaluation use only'},
        'config': {'segment': 7, 'shifts': 0, 'overlap': .25, 'device': 'cpu'},
        'stems': files,
        # Sanity check only: how much of the input the two stems fail to reconstruct.
        'reconstruction_snr_db': float(10 * np.log10(np.sum(audio.astype('float64') ** 2) /
                                                     max(1e-12, np.sum(residual.astype('float64') ** 2)))),
        'timings': {'load_seconds': loaded - started, 'separation_seconds': separated - loaded},
    }
    (out / 'stems.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False))


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('usage: separate_stems.py <original.wav> <out_dir>')
    main(sys.argv[1], sys.argv[2])
