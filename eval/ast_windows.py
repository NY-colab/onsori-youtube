"""Per-window AudioSet (AST) evidence for one or more WAVs on the same timeline.

Evaluation only. Uses the same AST checkpoint family as the extension but the
full-precision Python model (server.pipeline.load_ast), so scores are close to,
not identical with, the browser q8 model. Run from the repository root:

    .venv\\Scripts\\python.exe -X utf8 eval\\ast_windows.py <out.json> original=<wav> accompaniment=<wav> [...]

Each 2-second window (the extension's AST grid) records Speech-family and
music scores plus the top instrument/mood/genre labels from the shared
vocabulary. Nothing is turned into caption text here.
"""
from __future__ import annotations
import json
import os
from pathlib import Path
import sys

APP = Path(__file__).resolve().parents[1]
SPEECH = ('Speech', 'Conversation', 'Narration, monologue')


def main(out, pairs):
    os.environ.setdefault('HF_HOME', str(APP / 'models' / 'huggingface'))
    sys.path.insert(0, str(APP))
    import numpy as np
    import soundfile as sf
    import torch
    from server.pipeline import load_ast
    from server.music import MUSIC_LABELS, INSTRUMENTS, MOODS, GENRES, VOCALS

    extractor, model = load_ast(lambda *_: None)
    labels = model.config.id2label
    detail = set(INSTRUMENTS) | set(MOODS) | set(GENRES) | set(VOCALS)
    result = {'model': f'{model.config.name_or_path} (Python, full precision)', 'window_seconds': 2, 'inputs': {}}
    for name, path in pairs:
        audio, sr = sf.read(path, dtype='float32', always_2d=True)
        mono = audio.mean(1)
        if sr != 16000:
            mono = torch.nn.functional.interpolate(torch.from_numpy(mono)[None, None], size=round(len(mono) * 16000 / sr),
                                                   mode='linear', align_corners=False)[0, 0].numpy()
        rows = []
        for start in range(0, int(np.ceil(len(mono) / 16000)), 2):
            clip = mono[start * 16000:(start + 2) * 16000]
            level = float(20 * np.log10(max(1e-12, np.sqrt(np.mean(clip.astype('float64') ** 2)))))
            if level <= -65:  # same silence gate as the extension; no labels for silence
                rows.append({'start': start, 'end': start + len(clip) / 16000, 'dbfs': round(level, 1), 'silent': True})
                continue
            with torch.inference_mode():
                scores = torch.sigmoid(model(**extractor(clip, sampling_rate=16000, return_tensors='pt')).logits[0]).numpy()
            named = {labels[i]: float(s) for i, s in enumerate(scores)}
            rows.append({'start': start, 'end': start + len(clip) / 16000, 'dbfs': round(level, 1),
                         'speech': round(max(named.get(k, 0) for k in SPEECH), 4),
                         'music': round(max(v for k, v in named.items() if k in MUSIC_LABELS), 4),
                         'detail': [[k, round(v, 4)] for k, v in sorted(((k, v) for k, v in named.items() if k in detail), key=lambda x: -x[1])[:5]]})
        result['inputs'][name] = {'path': str(path), 'windows': rows}
        print(name, len(rows), 'windows', flush=True)
    Path(out).write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding='utf-8')


if __name__ == '__main__':
    if len(sys.argv) < 3:
        raise SystemExit('usage: ast_windows.py <out.json> <name>=<wav> [...]')
    main(sys.argv[1], [arg.split('=', 1) for arg in sys.argv[2:]])
