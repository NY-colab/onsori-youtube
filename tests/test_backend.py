import json
import threading
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient
from pydantic import ValidationError

from server.app import app
from server.audio import SAMPLE_RATE, decode_audio, reference_level, volume_style
from server.pipeline import Cancelled, analyze, youtube_id
from server.schema import AnalysisOptions, Cue, Document, subtitle_text

client = TestClient(app)
HEADERS = {"X-OnSori-Client": "onsori-local-v1"}


def doc():
    return Document(duration=10, cues=[Cue(id="speech", start=1, end=5, text="안녕 <친구>", kind="speech"),
                                      Cue(id="effect", start=2, end=3, text="[쾅!]", kind="sound")])


@pytest.mark.parametrize("url,expected", [("https://youtu.be/jNQXAC9IVRw", "jNQXAC9IVRw"),
    ("https://www.youtube.com/watch?v=jNQXAC9IVRw&list=ignored", "jNQXAC9IVRw"),
    ("https://www.youtube.com/shorts/jNQXAC9IVRw", "jNQXAC9IVRw")])
def test_youtube_url(url, expected):
    assert youtube_id(url) == expected


@pytest.mark.parametrize("url", ["http://127.0.0.1:22", "https://youtube.com.evil.test/watch?v=jNQXAC9IVRw", "https://user:pass@youtube.com/watch?v=jNQXAC9IVRw", "file:///etc/passwd", "https://www.youtube.com/playlist?list=x"])
def test_youtube_ssrf(url):
    with pytest.raises(ValueError):
        youtube_id(url)


def test_volume_retains_quiet_loud_difference():
    sine = np.sin(2*np.pi*440*np.arange(SAMPLE_RATE)/SAMPLE_RATE).astype(np.float32)
    audio = np.concatenate([sine*.03, sine*.6])
    ref = reference_level(audio)
    quiet, loud = volume_style(audio, 0, 1, ref), volume_style(audio, 1, 2, ref)
    assert loud["dbfs"] - quiet["dbfs"] == pytest.approx(26.02, abs=.1)
    assert quiet["scale"] < .9 and loud["scale"] > 1.2


def test_silence_and_missing_interval():
    audio = np.zeros(SAMPLE_RATE, dtype=np.float32)
    style = volume_style(audio, 0, 1, reference_level(audio))
    assert style["dbfs"] == -120 and style["scale"] == .75


def test_decode_and_pipeline_offset_without_models(tmp_path):
    path = tmp_path / "test.wav"
    sf.write(path, np.sin(2*np.pi*200*np.arange(SAMPLE_RATE*2)/SAMPLE_RATE)*.1, SAMPLE_RATE)
    assert len(decode_audio(path)) == SAMPLE_RATE*2
    options = AnalysisOptions(start_time=17, event_detection=False, transcribe=False)
    result = analyze(path, options, tmp_path, lambda *_: None, threading.Event(),
                     transcript=[{"start": .25, "end": 1.25, "text": "실제 입력 자막"}])
    assert result.cues[0].start == 17.25
    assert result.duration == 19
    assert result.cues[0].dbfs is not None


def test_cancel_before_models(tmp_path):
    path = tmp_path / "test.wav"
    sf.write(path, np.zeros(16000), 16000)
    flag = threading.Event(); flag.set()
    with pytest.raises(Cancelled):
        analyze(path, AnalysisOptions(), tmp_path, lambda *_: None, flag)


def test_overlapping_export_preserves_both_lanes():
    srt = subtitle_text(doc(), "srt")
    assert "00:00:02,000 --> 00:00:03,000\n안녕 ‹친구›\n[쾅!]" in srt
    assert srt.count("-->") == 3
    assert subtitle_text(doc(), "vtt").startswith("WEBVTT")


@pytest.mark.parametrize("change", [{"end": -1}, {"end": float('nan')}, {"start": 6}, {"scale": 10}, {"kind": "html"}])
def test_reject_invalid_cues(change):
    data = doc().model_dump()
    data["cues"][0].update(change)
    with pytest.raises(ValidationError):
        Document.model_validate(data)


def test_reject_duplicate_ids_and_overflow():
    data = doc().model_dump(); data["cues"][1]["id"] = "speech"
    with pytest.raises(ValidationError):
        Document.model_validate(data)
    data = doc().model_dump(); data["duration"] = 2
    with pytest.raises(ValidationError):
        Document.model_validate(data)


def test_local_api_guard_and_origin():
    assert client.get("/api/health").status_code == 403
    assert client.get("/api/health", headers=HEADERS).status_code == 200
    assert client.get("/api/health", headers={**HEADERS, "Origin": "https://evil.example"}).status_code == 403
    assert client.get("/api/health", headers={**HEADERS, "Host": "attacker.invalid"}).status_code == 400


def test_demo_label_and_exports():
    result = client.get("/api/demo", headers=HEADERS)
    assert result.status_code == 200 and result.json()["metadata"]["demo"] is True
    assert client.post("/api/export/vtt", headers=HEADERS, json=doc().model_dump()).text.startswith("WEBVTT")
    assert client.post("/api/validate", headers=HEADERS, json=doc().model_dump()).status_code == 200


def test_empty_upload_and_unknown_job():
    assert client.post("/api/jobs/upload", headers=HEADERS, files={"file": ("x.wav", b"", "audio/wav")}).status_code == 422
    assert client.post("/api/jobs/upload", headers=HEADERS, files={"file": ("x.exe", b"abc")}).status_code == 415
    assert client.get("/api/jobs/nope", headers=HEADERS).status_code == 404


def test_bad_youtube_returns_before_network():
    assert client.post("/api/jobs/youtube", headers=HEADERS, json={"url": "https://example.org/audio.mp3"}).status_code == 422
