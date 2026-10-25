"""Protocol/security tests run without loading the 203 MB neural checkpoint."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import wave

import pytest

spec = importlib.util.spec_from_file_location("caption_worker", Path(__file__).parents[1] / "server" / "caption_worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


def make_manifest(tmp_path, **overrides):
    wav = tmp_path / "한글 소리.wav"
    with wave.open(str(wav), "wb") as stream:
        stream.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        stream.writeframes(b"\0\0" * 16000)
    data = {"segments": [{"id": "sound-1", "start": 10, "end": 11, "path": wav.name}], "device": "cpu"}
    data.update(overrides)
    path = tmp_path / "manifest.json"
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8-sig")
    return path


def test_unicode_pcm_wav_and_absolute_timeline(tmp_path):
    segments = worker.read_manifest(make_manifest(tmp_path))
    assert segments[0]["start"] == 10
    assert Path(segments[0]["path"]).is_absolute()


@pytest.mark.parametrize("device", ["cuda", None, 1])
def test_rejects_non_cpu(tmp_path, device):
    with pytest.raises(worker.WorkerError):
        worker.read_manifest(make_manifest(tmp_path, device=device))


@pytest.mark.parametrize("start,end", [(0, float("nan")), (True, 1), (2, 1), (0, 31)])
def test_rejects_unbounded_times(tmp_path, start, end):
    path = make_manifest(tmp_path)
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    data["segments"][0].update(start=start, end=end)
    path.write_text(json.dumps(data), encoding="utf-8")
    with pytest.raises(worker.WorkerError):
        worker.read_manifest(path)


def test_empty_does_not_load_model():
    class NeverLoad:
        def caption(self, _):
            raise AssertionError("empty input should not load ML dependencies")
    assert worker.run([], NeverLoad())["captions"] == []


def test_preserves_ids_and_partial_failure_without_fake_caption():
    class Fake:
        def caption(self, path):
            if path == "bad":
                raise RuntimeError("broken " * 1000)
            return "a trumpet is playing"
    result = worker.run([{"id": "ok", "path": "good"}, {"id": "no", "path": "bad"}], Fake())
    assert result["captions"] == [{"id": "ok", "text": "a trumpet is playing"}]
    assert len(result["warnings"][0]) < 600


def test_all_failure_is_error():
    class Fake:
        def caption(self, _):
            raise RuntimeError("unavailable model")
    with pytest.raises(worker.WorkerError, match="unavailable model"):
        worker.run([{"id": "x", "path": "bad"}], Fake())


def test_checkpoint_wrapper_reports_underlying_cause_bounded():
    try:
        try:
            raise RuntimeError("allocation failure: not enough memory " + "x" * 5000)
        except RuntimeError as original:
            raise OSError("Unable to load weights from pytorch checkpoint") from original
    except OSError as error:
        detail = worker.exception_detail(error)
    assert "allocation failure: not enough memory" in detail
    assert len(detail) <= 1000


def test_cli_json_error_and_no_output(tmp_path):
    output = tmp_path / "result.json"
    result = subprocess.run([sys.executable, "-X", "utf8", str(Path(worker.__file__)), "--manifest", str(tmp_path / "missing.json"), "--output", str(output)], capture_output=True, text=True, encoding="utf-8")
    assert result.returncode == 1
    assert len(result.stderr) < 2000
    assert json.loads(result.stderr)["error"]["type"] == "FileNotFoundError"
    assert not output.exists()


def test_cli_empty_result_atomic_write(tmp_path):
    path = make_manifest(tmp_path, segments=[])
    output = tmp_path / "result.json"
    assert worker.main(["--manifest", str(path), "--output", str(output)]) == 0
    assert json.loads(output.read_text(encoding="utf-8")) == {"model": worker.MODEL_ID, "captions": [], "warnings": []}
    assert not list(tmp_path.glob("*.tmp"))
