"""Gateway contract tests: all provider traffic is replaced by HTTPX MockTransport."""
import asyncio
from dataclasses import replace
import io
import json
from pathlib import Path
import sqlite3
import threading
import time
import wave

import httpx
import pytest
from fastapi.testclient import TestClient

from cloud_gateway import app as module


API = "a" * 40
METRICS = "b" * 40
AUTH = {"Authorization": "Bearer " + API}


def wav(seconds=1, *, rate=16000, channels=1, width=2):
    output = io.BytesIO()
    with wave.open(output, "wb") as stream:
        stream.setnchannels(channels)
        stream.setsampwidth(width)
        stream.setframerate(rate)
        stream.writeframes(b"\x00" * int(seconds * rate * channels * width))
    return output.getvalue()


@pytest.fixture
def settings(tmp_path):
    return module.Settings(api_token=API, metrics_token=METRICS, provider="mock", data_dir=tmp_path)


def post(client, payload=None, key="test-job-0001", **fields):
    return client.post("/v1/jobs", headers={**AUTH, "Idempotency-Key": key},
                       files={"file": ("input.wav", wav() if payload is None else payload, "audio/wav")},
                       data={"consent": "true", "language": "ko", **fields})


def final(client, job_id):
    deadline = time.monotonic() + 4
    while time.monotonic() < deadline:
        response = client.get("/v1/jobs/" + job_id, headers=AUTH)
        assert response.status_code == 200, response.text
        value = response.json()
        if value["status"] in module.TERMINAL:
            return value
        time.sleep(.01)
    pytest.fail("job did not finish")


def paid(settings, **options):
    return replace(settings, provider="deepinfra", allow_paid=True, deepinfra_api_key="test-provider-secret", **options)


def success(request):
    assert str(request.url) == module.PROVIDER_URL
    assert request.headers["authorization"] == "Bearer test-provider-secret"
    assert b'name="audio"' in request.content
    assert b"RIFF" in request.content
    return httpx.Response(200, json={"duration": 1, "segments": [{"start": 0, "end": .8, "text": "실제 제공자 형식"}]})


def test_settings_fail_closed(settings):
    for invalid in (replace(settings, api_token="short"), replace(settings, metrics_token=API),
                    replace(settings, provider="anything"), replace(settings, max_queue=0),
                    replace(settings, daily_audio_minutes=float("nan")),
                    replace(settings, provider="deepinfra", allow_paid=True)):
        with pytest.raises(ValueError):
            invalid.validate()


def test_auth_is_separate_and_health_is_minimal(settings):
    with TestClient(module.create_app(settings)) as client:
        assert client.get("/healthz").json() == {"status": "ok"}
        for path in ("/v1/status", "/v1/jobs/no-such-job", "/metrics"):
            assert client.get(path).status_code == 401
        assert client.get("/metrics", headers=AUTH).status_code == 401
        assert client.get("/v1/status", headers={"Authorization": "Bearer " + METRICS}).status_code == 401
        assert client.post("/v1/jobs", content=b"not even multipart").status_code == 401
        assert client.get("/v1/status", headers=AUTH).json()["synthetic"] is True
        assert client.get("/openapi.json").status_code == 404


@pytest.mark.parametrize("provider,allow_paid", [("disabled", False), ("deepinfra", False)])
def test_disabled_never_calls_provider(settings, provider, allow_paid):
    calls = []
    transport = httpx.MockTransport(lambda request: calls.append(request))
    with TestClient(module.create_app(replace(settings, provider=provider, allow_paid=allow_paid), transport=transport)) as client:
        assert post(client).status_code == 503
    assert not calls
    assert not list(settings.data_dir.glob("*.wav"))


def test_mock_completion_matches_extension_contract(settings):
    with TestClient(module.create_app(settings)) as client:
        response = post(client, video_id="abcdefghijk", title="시험")
        assert response.status_code == 202
        job = final(client, response.json()["id"])
        assert job["status"] == "done"
        document = job["result"]
        assert document["schema_version"] == "1.0" and document["video_id"] == "abcdefghijk"
        assert document["duration"] == 1 and document["metadata"]["synthetic"] is True
        assert document["metadata"]["analysis_scope"] == "speech-only"
        assert "SYNTHETIC MOCK" in document["warnings"][0]
        cue = document["cues"][0]
        assert cue["scale"] == 1 and cue["dbfs"] is None and cue["confidence"] is None
        assert cue["review_required"] is True and cue["source"] == "mock-synthetic"
        assert not list(settings.data_dir.glob("*.wav"))
        metrics = client.get("/metrics", headers={"Authorization": "Bearer " + METRICS}).text
        assert 'onsori_jobs_total{status="done"} 1' in metrics
        assert "onsori_provider_audio_seconds_total 0" in metrics
        assert 'onsori_job_duration_seconds_bucket{le="+Inf"} 1' in metrics
        assert "onsori_storage_bytes " in metrics


def test_idempotency_reuses_same_body_and_rejects_changed_body(settings):
    with TestClient(module.create_app(settings)) as client:
        first = post(client).json()
        duplicate = post(client)
        assert duplicate.status_code == 200 and duplicate.json()["id"] == first["id"]
        assert post(client, title="different").status_code == 409
        assert post(client, payload=wav(.5)).status_code == 409
        assert client.post("/v1/jobs", headers=AUTH).status_code == 422


@pytest.mark.parametrize("payload", [b"not wav", wav(0), wav(rate=8000), wav(channels=2), wav(width=1), wav()[:-100]],
                         ids=["not-wav", "empty", "8khz", "stereo", "8bit", "truncated"])
def test_invalid_audio_rejected_without_job(settings, payload):
    with TestClient(module.create_app(settings)) as client:
        assert post(client, payload).status_code == 422
        assert client.get("/v1/status", headers=AUTH).json()["counts"] == {}


def test_parsed_duration_limit_and_upload_limit(settings, monkeypatch):
    monkeypatch.setattr(module, "MAX_AUDIO_SECONDS", .5)
    with TestClient(module.create_app(settings)) as client:
        assert post(client).status_code == 422
    monkeypatch.setattr(module, "MAX_AUDIO_SECONDS", 1200)
    monkeypatch.setattr(module, "MAX_AUDIO_BYTES", 1000)
    with TestClient(module.create_app(settings)) as client:
        assert post(client).status_code == 413
        assert client.post("/v1/jobs", headers={**AUTH, "Content-Length": "99999999"}, content=b"x").status_code == 413
        # No Content-Length: the middleware also caps streamed/chunked bodies.
        assert client.post("/v1/jobs", headers={**AUTH, "Idempotency-Key": "test-stream-001", "Content-Type": "multipart/form-data; boundary=x"},
                           content=iter([b"x" * 70000])).status_code == 413


@pytest.mark.parametrize("fields", [{"consent": "false"}, {"consent": "yes"}, {"language": "en"},
                                     {"video_id": "bad"}, {"title": "a" * 301}, {"url": "http://127.0.0.1/private"}])
def test_consent_and_field_boundary(settings, fields):
    with TestClient(module.create_app(settings)) as client:
        assert post(client, **fields).status_code == 422


def test_paid_provider_has_fixed_endpoint_and_no_fake_loudness(settings):
    calls = []
    def handler(request):
        calls.append(request)
        return success(request)
    with TestClient(module.create_app(paid(settings), transport=httpx.MockTransport(handler))) as client:
        job = final(client, post(client).json()["id"])
        assert job["status"] == "done"
        assert job["result"]["cues"][0]["text"] == "실제 제공자 형식"
        assert job["result"]["metadata"]["synthetic"] is False
        assert job["result"]["metadata"]["loudness_measured"] is False
        assert client.get("/metrics", headers={"Authorization": "Bearer " + METRICS}).text.count("onsori_provider_audio_seconds_total 1\n") == 1
    assert len(calls) == 1


@pytest.mark.parametrize("response", [
    {"text": "no timings"}, {"text": "no timings", "segments": []},
    {"segments": [{"start": 0, "end": 2, "text": "bad"}]},
    {"segments": [{"start": .5, "end": .4, "text": "bad"}]},
    {"segments": [{"start": float("nan"), "end": 1, "text": "bad"}]},
    {"segments": [{"start": True, "end": 1, "text": "bad"}]},
    {"segments": [{"start": 0, "end": 1, "text": ""}]},
    {"duration": 100, "segments": []},
])
def test_invalid_provider_segments_never_synthesize_timestamps(settings, response):
    transport = httpx.MockTransport(lambda request: httpx.Response(200, content=json.dumps(response).encode()))
    with TestClient(module.create_app(paid(settings), transport=transport)) as client:
        job = final(client, post(client).json()["id"])
        assert job["status"] == "error" and job["result"] is None
        assert "provider" in job["error"] or "timestamps" in job["error"]
        assert not list(settings.data_dir.glob("*.wav"))


@pytest.mark.parametrize("failure", ["timeout", "http", "redirect", "oversize"])
def test_provider_error_has_no_retry_and_no_sensitive_error(settings, failure, monkeypatch):
    calls = []
    monkeypatch.setattr(module, "MAX_PROVIDER_BYTES", 1024)
    def handler(request):
        calls.append(request)
        if failure == "timeout":
            raise httpx.ReadTimeout("SECRET raw transcript", request=request)
        if failure == "oversize":
            return httpx.Response(200, content=b"x" * 1025)
        return httpx.Response(302 if failure == "redirect" else 500, content=b"SECRET raw transcript", headers={"Location": "http://127.0.0.1/private"})
    with TestClient(module.create_app(paid(settings), transport=httpx.MockTransport(handler))) as client:
        job = final(client, post(client).json()["id"])
        assert job["status"] == "error" and job["result"] is None
        assert "SECRET" not in json.dumps(job)
        assert post(client).json()["id"] == job["id"]
    assert len(calls) == 1


def test_daily_budget_reservation_survives_restart_and_failed_call(settings):
    calls = []
    def handler(request):
        calls.append(request)
        raise httpx.ReadTimeout("uncertain", request=request)
    config = paid(settings, daily_audio_minutes=1 / 60)
    with TestClient(module.create_app(config, transport=httpx.MockTransport(handler))) as client:
        assert final(client, post(client).json()["id"])["status"] == "error"
    with TestClient(module.create_app(config, transport=httpx.MockTransport(handler))) as client:
        job = final(client, post(client, key="second-job-0002").json()["id"])
        assert job["status"] == "error" and job["error"] == "daily_audio_limit"
    assert len(calls) == 1


def test_queue_bound_cancellation_and_single_remote_call(settings):
    entered = threading.Event()
    calls = []
    async def handler(request):
        calls.append(request)
        entered.set()
        if len(calls) > 1:
            return success(request)
        await asyncio.sleep(10)
        return success(request)
    app = module.create_app(paid(settings, max_queue=1), transport=httpx.MockTransport(handler))
    with TestClient(app) as client:
        first = post(client).json()
        assert entered.wait(2)
        second = post(client, key="second-job-0002").json()
        assert post(client, key="third-job-0003").status_code == 429
        assert client.delete("/v1/jobs/" + second["id"], headers=AUTH).json()["status"] == "cancelled"
        assert client.delete("/v1/jobs/" + first["id"], headers=AUTH).json()["status"] == "cancelled"
        time.sleep(.05)
        assert not list(settings.data_dir.glob("*.wav"))
        assert client.get("/v1/jobs/" + first["id"], headers=AUTH).json()["status"] == "cancelled"
        # Cancelling a provider task must not accidentally kill the queue worker.
        third = post(client, key="fourth-job-0004").json()
        assert third["id"] and not app.state.gateway.worker_task.done()
        assert final(client, third["id"])["status"] == "done"
    assert len(calls) == 2  # Queued/cancelled second job never reached the provider.


def test_restart_marks_interrupted_and_never_requeues(settings):
    with TestClient(module.create_app(settings)) as client:
        done = final(client, post(client).json()["id"])
    db_path = settings.data_dir / "gateway.sqlite3"
    connection = sqlite3.connect(db_path)
    with connection:
        connection.execute("UPDATE jobs SET status='running',result_json=NULL,audio_path=id||'.wav' WHERE id=?", (done["id"],))
    connection.close()
    (settings.data_dir / (done["id"] + ".wav")).write_bytes(wav())
    with TestClient(module.create_app(settings)) as client:
        job = client.get("/v1/jobs/" + done["id"], headers=AUTH).json()
        assert job["status"] == "error" and job["error"] == "interrupted_no_automatic_retry"
        assert post(client).json()["id"] == done["id"]
        assert not list(settings.data_dir.glob("*.wav"))


def test_ttl_expires_transcript_but_preserves_idempotency(settings):
    config = replace(settings, result_ttl_seconds=.03, sweep_interval_seconds=.01)
    with TestClient(module.create_app(config)) as client:
        first = post(client).json()
        final(client, first["id"])
        time.sleep(.08)
        assert client.get("/v1/jobs/" + first["id"], headers=AUTH).status_code == 410
        assert post(client).status_code == 410
        with sqlite3.connect(settings.data_dir / "gateway.sqlite3") as db:
            row = db.execute("SELECT result_json,title,video_id FROM jobs WHERE id=?", (first["id"],)).fetchone()
        assert row == (None, "", None)


def test_process_lock_rejects_second_process(settings):
    with TestClient(module.create_app(settings)):
        with pytest.raises(RuntimeError, match="already in use"):
            with TestClient(module.create_app(settings)):
                pass
