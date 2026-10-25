"""Optional isolated CoNeTTE worker. Run with .venv-caption, never main .venv."""
from __future__ import annotations

import argparse
import contextlib
import io
import json
import math
import os
from pathlib import Path
import sys
import tempfile
import urllib.request
import wave

ROOT = Path(__file__).resolve().parents[1]
MODEL_ID = "Labbeti/conette"
MODEL_REVISION = "f7c6d0338832ee22df1e7c9d579cf5911a1a115d"
MAX_SEGMENTS = 100
MAX_MANIFEST_BYTES = 1024 * 1024
MAX_WAV_BYTES = 100 * 1024 * 1024
MAX_SECONDS = 30.0


class WorkerError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def exception_detail(exc: Exception, limit: int = 1000) -> str:
    """Expose a bounded underlying cause hidden by Transformers checkpoint errors."""
    parts, seen = [], set()
    current = exc
    while current is not None and id(current) not in seen and len(parts) < 5:
        seen.add(id(current))
        parts.append(f"{type(current).__name__}: {' '.join(str(current).split())[:350]}")
        current = current.__cause__ or current.__context__
    return " <- ".join(parts)[:limit]


def configure_cache() -> Path:
    """The parent can share its HF_HOME; otherwise every cache stays in models/."""
    models = ROOT / "models"
    defaults = {"HF_HOME": models / "huggingface", "TORCH_HOME": models / "torch",
                "NLTK_DATA": models / "nltk_data"}
    for key, value in defaults.items():
        os.environ.setdefault(key, str(value))
        Path(os.environ[key]).mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
    os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    return models


def read_manifest(path: Path) -> list[dict]:
    if path.stat().st_size > MAX_MANIFEST_BYTES:
        raise WorkerError("invalid_manifest", "Manifest exceeds 1 MiB.")
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except (ValueError, UnicodeError) as exc:
        raise WorkerError("invalid_manifest", "Manifest must be UTF-8 JSON.") from exc
    if not isinstance(data, dict) or data.get("device", "cpu") != "cpu":
        raise WorkerError("invalid_manifest", "Only device='cpu' is supported.")
    segments = data.get("segments")
    if not isinstance(segments, list) or len(segments) > MAX_SEGMENTS:
        raise WorkerError("invalid_manifest", "segments must be a list with at most 100 items.")
    normalized, ids = [], set()
    for segment in segments:
        if not isinstance(segment, dict):
            raise WorkerError("invalid_manifest", "Every segment must be an object.")
        sid = segment.get("id")
        if not isinstance(sid, str) or not sid or len(sid) > 200 or sid in ids:
            raise WorkerError("invalid_manifest", "Segment ids must be unique nonempty strings (max 200 chars).")
        ids.add(sid)
        start, end = segment.get("start"), segment.get("end")
        if any(isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x)
               for x in (start, end)) or start < 0 or end <= start or end - start > MAX_SECONDS + .01:
            raise WorkerError("invalid_manifest", "Segment times must be finite, ordered, and at most 30 seconds apart.")
        filename = segment.get("path")
        if not isinstance(filename, str) or not filename or len(filename) > 32767:
            raise WorkerError("invalid_manifest", "Each segment needs a WAV path.")
        audio = Path(filename)
        if not audio.is_absolute():
            audio = path.parent / audio
        audio = audio.resolve()
        if audio.suffix.lower() != ".wav" or not audio.is_file() or audio.stat().st_size > MAX_WAV_BYTES:
            raise WorkerError("invalid_audio", "Expected an existing WAV smaller than 100 MiB.")
        # Standard PCM WAV from the parent ffmpeg pipeline: check before loading tensors.
        try:
            with wave.open(str(audio), "rb") as wav:
                duration = wav.getnframes() / wav.getframerate()
                if wav.getnchannels() not in (1, 2) or wav.getframerate() > 192000 or not .1 <= duration <= MAX_SECONDS + .01:
                    raise WorkerError("invalid_audio", "WAV must be mono/stereo PCM and 0.1–30 seconds long.")
        except (wave.Error, EOFError, ZeroDivisionError) as exc:
            raise WorkerError("invalid_audio", "WAV must be readable uncompressed PCM.") from exc
        normalized.append({"id": sid, "path": str(audio), "start": start, "end": end})
    return normalized


def prepare_resources() -> None:
    """Explicit install-time setup, separate from inference (no runtime pip)."""
    models = configure_cache()
    import nltk
    mapping = models / "audioset" / "class_labels_indices.csv"
    mapping.parent.mkdir(parents=True, exist_ok=True)
    if not mapping.is_file():
        url = "https://storage.googleapis.com/us_audioset/youtube_corpus/v1/csv/class_labels_indices.csv"
        with urllib.request.urlopen(url, timeout=60) as response:
            mapping.write_bytes(response.read(1024 * 1024))
    if not nltk.download("stopwords", download_dir=os.environ["NLTK_DATA"], quiet=True):
        raise WorkerError("setup_failed", "NLTK stopwords download failed.")


class CaptionEngine:
    """One lazily loaded model reused for every segment in this process."""
    def __init__(self):
        self.model = None
        self.torch = None

    def load(self) -> None:
        if self.model is not None:
            return
        models = configure_cache()
        import torch
        from conette import CoNeTTEConfig, CoNeTTEModel
        import conette.transforms.audioset_mapping as audioset_mapping
        # CoNeTTE 0.4.0 hard-codes this library-level default to user .cache.
        # Redirect only this known data cache; no repository code is downloaded/executed.
        audioset_mapping._DEFAULT_CACHE_PATH = models / "audioset"
        torch.set_num_threads(max(1, min(4, os.cpu_count() or 1)))
        torch.manual_seed(0)
        torch.use_deterministic_algorithms(True)
        cache = str(Path(os.environ["HF_HOME"]) / "hub")
        config = CoNeTTEConfig.from_pretrained(MODEL_ID, revision=MODEL_REVISION, cache_dir=cache)
        self.model = CoNeTTEModel.from_pretrained(
            MODEL_ID, config=config, revision=MODEL_REVISION, cache_dir=cache,
            device="cpu", inference=True, offline=True,
        )
        self.model.eval()
        self.torch = torch

    def caption(self, path: str) -> str:
        self.load()
        with self.torch.inference_mode():
            output = self.model(path, task="clotho")
        text = output["cands"][0]
        if not isinstance(text, str) or not text.strip():
            raise WorkerError("inference_failed", "Model returned an empty caption.")
        return text.strip()[:2000]


def run(segments: list[dict], engine=None) -> dict:
    engine = engine or CaptionEngine()
    captions, warnings = [], []
    for segment in segments:
        try:
            text = engine.caption(segment["path"])
            captions.append({"id": segment["id"], "text": text})
        except Exception as exc:
            # Preserve completed segments, but never generate replacement descriptions.
            warnings.append(f"Caption failed for {segment['id']}: {exception_detail(exc, 1000)}")
    if segments and not captions:
        raise WorkerError("inference_failed", warnings[0])
    return {"model": MODEL_ID, "captions": captions, "warnings": warnings}


def write_result(path: Path, result: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_name = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", suffix=".tmp",
                                         dir=path.parent, delete=False) as stream:
            temp_name = stream.name
            json.dump(result, stream, ensure_ascii=False, indent=2, allow_nan=False)
            stream.write("\n")
        os.replace(temp_name, path)
    finally:
        if temp_name and Path(temp_name).exists():
            Path(temp_name).unlink()


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--prepare", action="store_true", help="Download setup resources and model only.")
    args = parser.parse_args(argv)
    # Third-party warnings/logs can be huge. Keep CLI stderr machine-readable and bounded.
    captured = io.StringIO()
    try:
        with contextlib.redirect_stderr(captured), contextlib.redirect_stdout(captured):
            if args.prepare:
                prepare_resources()
                CaptionEngine().load()
            else:
                if args.manifest is None or args.output is None:
                    raise WorkerError("invalid_arguments", "--manifest and --output are required.")
                segments = read_manifest(args.manifest.resolve())
                result = run(segments)
                write_result(args.output.resolve(), result)
        return 0
    except Exception as exc:
        message = " ".join(str(exc).split())[:1000]
        error = {"error": {"code": getattr(exc, "code", "caption_worker_failed"),
                           "type": type(exc).__name__, "message": message}}
        print(json.dumps(error, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
