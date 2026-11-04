"""One-process SQLite gateway. Never imports or downloads an ASR model.

Run with one Uvicorn worker behind a TLS reverse proxy. Paid inference requires
both provider=deepinfra and allow_paid=true; the default cannot send audio out.
"""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import hmac
import io
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import struct
import time
from typing import Any, Callable
import uuid
import wave

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, PlainTextResponse
from starlette.datastructures import UploadFile
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.formparsers import MultiPartException

MAX_AUDIO_BYTES = 40 * 1024 * 1024
MAX_AUDIO_SECONDS = 20 * 60
MAX_PROVIDER_BYTES = 8 * 1024 * 1024
MODEL = "nvidia/NVIDIA-Nemotron-3.5-Transcribe-30B-A4B"
PROVIDER_URL = "https://api.deepinfra.com/v1/inference/" + MODEL
TERMINAL = ("done", "error", "cancelled")
BUCKETS = (1, 5, 15, 30, 60, 180, 600, 1800)


@dataclass(frozen=True)
class Settings:
    api_token: str = ""
    metrics_token: str = ""
    provider: str = "disabled"
    allow_paid: bool = False
    deepinfra_api_key: str = ""
    data_dir: Path = Path("cloud_gateway/data")
    max_queue: int = 4
    daily_audio_minutes: float = 60
    result_ttl_seconds: float = 86400
    sweep_interval_seconds: float = 60
    provider_timeout_seconds: float = 180

    @classmethod
    def from_env(cls) -> "Settings":
        paid = os.getenv("ONSORI_ALLOW_PAID", "false").lower()
        if paid not in ("true", "false"):
            raise ValueError("ONSORI_ALLOW_PAID must be true or false")
        return cls(
            api_token=os.getenv("ONSORI_API_TOKEN", ""),
            metrics_token=os.getenv("ONSORI_METRICS_TOKEN", ""),
            provider=os.getenv("ONSORI_PROVIDER", "disabled"),
            allow_paid=paid == "true",
            deepinfra_api_key=os.getenv("DEEPINFRA_API_KEY", ""),
            data_dir=Path(os.getenv("ONSORI_DATA_DIR", "cloud_gateway/data")),
            max_queue=int(os.getenv("ONSORI_MAX_QUEUE", "4")),
            daily_audio_minutes=float(os.getenv("ONSORI_DAILY_AUDIO_MINUTES", "60")),
            result_ttl_seconds=float(os.getenv("ONSORI_RESULT_TTL_SECONDS", "86400")),
            sweep_interval_seconds=float(os.getenv("ONSORI_SWEEP_INTERVAL_SECONDS", "60")),
            provider_timeout_seconds=float(os.getenv("ONSORI_PROVIDER_TIMEOUT_SECONDS", "180")),
        )

    def validate(self) -> None:
        for token in (self.api_token, self.metrics_token):
            if len(token) < 32 or not token.isascii() or any(c.isspace() for c in token):
                raise ValueError("API and metrics tokens must be independent ASCII secrets of at least 32 characters")
        if hmac.compare_digest(self.api_token, self.metrics_token):
            raise ValueError("API and metrics tokens must differ")
        if self.provider not in ("disabled", "mock", "deepinfra"):
            raise ValueError("Unsupported ONSORI_PROVIDER")
        if self.provider == "deepinfra" and self.allow_paid and not self.deepinfra_api_key:
            raise ValueError("DEEPINFRA_API_KEY is required for paid inference")
        if not 1 <= self.max_queue <= 32:
            raise ValueError("ONSORI_MAX_QUEUE must be 1..32")
        for value in (self.daily_audio_minutes, self.result_ttl_seconds,
                      self.sweep_interval_seconds, self.provider_timeout_seconds):
            if not math.isfinite(value) or value <= 0:
                raise ValueError("Gateway time and budget limits must be finite and positive")

    @property
    def enabled(self) -> bool:
        return self.provider == "mock" or (self.provider == "deepinfra" and self.allow_paid)


class ProviderFailure(Exception):
    """Only controlled error codes are safe to persist or return."""


class BodyTooLarge(MultiPartException):
    # Starlette closes spooled upload files on MultiPartException. A generic
    # receive exception can otherwise leave temporary files until collection.
    def __init__(self):
        super().__init__("upload_too_large")


class UploadLimitMiddleware:
    """Bound the entire multipart request, including chunked requests.

    Reverse proxy limits/timeouts remain required to bound slow clients and the
    total number of simultaneous HTTP connections.
    """
    def __init__(self, app: Any):
        self.app = app

    async def __call__(self, scope: dict, receive: Callable, send: Callable) -> None:
        if scope["type"] != "http" or scope.get("path") != "/v1/jobs" or scope.get("method") != "POST":
            await self.app(scope, receive, send)
            return
        limit = MAX_AUDIO_BYTES + 65536
        headers = dict(scope.get("headers", []))
        try:
            length = int(headers.get(b"content-length", b"0"))
            if length < 0 or length > limit:
                raise BodyTooLarge
        except (ValueError, BodyTooLarge):
            await JSONResponse({"detail": "upload_too_large"}, status_code=413)(scope, receive, send)
            return
        count = 0

        async def limited_receive() -> dict:
            nonlocal count
            message = await receive()
            if message["type"] == "http.request":
                count += len(message.get("body", b""))
                if count > limit:
                    raise BodyTooLarge
            return message

        try:
            await self.app(scope, limited_receive, send)
        except BodyTooLarge:
            await JSONResponse({"detail": "upload_too_large"}, status_code=413)(scope, receive, send)


def wav_duration(payload: bytes) -> float:
    if not payload or len(payload) > MAX_AUDIO_BYTES:
        raise HTTPException(413, "upload_too_large")
    try:
        with wave.open(io.BytesIO(payload), "rb") as audio:
            if (audio.getnchannels(), audio.getsampwidth(), audio.getframerate(), audio.getcomptype()) != (1, 2, 16000, "NONE"):
                raise HTTPException(422, "requires_pcm16_mono_16000hz_wav")
            frames = audio.getnframes()
            if frames <= 0 or frames > MAX_AUDIO_SECONDS * 16000:
                raise HTTPException(422, "audio_duration_out_of_range")
            if len(audio.readframes(frames + 1)) != frames * 2:
                raise HTTPException(422, "truncated_wav")
            return frames / 16000
    except (wave.Error, EOFError, ValueError, OverflowError, struct.error):
        raise HTTPException(422, "invalid_wav") from None


def document_from_segments(job: sqlite3.Row, response: Any, provider: str) -> dict:
    if not isinstance(response, dict):
        raise ProviderFailure("invalid_provider_response")
    segments = response.get("segments")
    if not isinstance(segments, list) or len(segments) > 10000:
        raise ProviderFailure("missing_or_invalid_timestamps")
    if not segments and response.get("text"):
        raise ProviderFailure("missing_or_invalid_timestamps")
    if response.get("duration") is not None:
        value = response["duration"]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
            raise ProviderFailure("invalid_provider_duration")
        # Some providers return zero when duration is unavailable. The uploaded
        # PCM frame count is always authoritative; never synthesize cue times.
        if value > 0 and abs(value - job["duration"]) > max(1, job["duration"] * .01):
            raise ProviderFailure("provider_duration_mismatch")
    cues = []
    previous_start = -1.0
    source = "mock-synthetic" if provider == "mock" else "deepinfra-nemotron-3.5"
    for i, segment in enumerate(segments):
        if not isinstance(segment, dict):
            raise ProviderFailure("invalid_provider_segment")
        start, end, text = segment.get("start"), segment.get("end"), segment.get("text")
        if (isinstance(start, bool) or isinstance(end, bool)
                or not isinstance(start, (int, float)) or not isinstance(end, (int, float))
                or not math.isfinite(start) or not math.isfinite(end)
                or start < 0 or end <= start or end > job["duration"] + .05 or start < previous_start):
            raise ProviderFailure("invalid_provider_timestamps")
        if not isinstance(text, str) or not text.strip() or len(text) > 2000 or "\x00" in text:
            raise ProviderFailure("invalid_provider_text")
        previous_start = start
        cues.append({"id": f"speech-{i + 1}", "start": start, "end": end, "text": text.strip(),
                     "kind": "speech", "dbfs": None, "relative_db": None, "scale": 1,
                     "confidence": None, "source": source, "review_required": True})
    warnings = ["Speech transcription only; sound, music, OCR correction and measured loudness are not analyzed. Human review is required."]
    if provider == "mock":
        warnings.insert(0, "SYNTHETIC MOCK: this text and its timing are test data, not recognition of the uploaded audio.")
    return {"schema_version": "1.0", "video_id": job["video_id"], "title": job["title"],
            "duration": job["duration"], "cues": cues, "warnings": warnings,
            "metadata": {"analysis_scope": "speech-only", "provider": provider, "source": source,
                         "synthetic": provider == "mock", "review_required": True,
                         "timing_source": "synthetic-test" if provider == "mock" else "provider-segments",
                         "loudness_measured": False, "model": None if provider == "mock" else MODEL}}


class InstanceLock:
    """Fail closed if multiple gateway processes share one data directory."""
    def __init__(self, directory: Path):
        self.handle = (directory / ".instance.lock").open("a+b")
        self.handle.seek(0)
        self.handle.write(b"0")
        self.handle.flush()
        self.handle.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(self.handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.handle.close()
            raise RuntimeError("Gateway data directory is already in use; run exactly one process") from None

    def close(self) -> None:
        if os.name == "nt":
            import msvcrt
            self.handle.seek(0)
            msvcrt.locking(self.handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            fcntl.flock(self.handle.fileno(), fcntl.LOCK_UN)
        self.handle.close()


class Gateway:
    def __init__(self, settings: Settings, transport: httpx.AsyncBaseTransport | None = None):
        self.settings = settings
        self.transport = transport  # Only dependency injection in tests; endpoint is fixed.
        self.directory = settings.data_dir.resolve()
        self.queue: asyncio.Queue[str] = asyncio.Queue(maxsize=settings.max_queue)
        self.submit_lock = asyncio.Lock()
        self.active_id: str | None = None
        self.active_call: asyncio.Task | None = None
        self.worker_task: asyncio.Task | None = None
        self.sweeper_task: asyncio.Task | None = None

    async def start(self) -> None:
        self.settings.validate()
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.lock = InstanceLock(self.directory)
        try:
            self.db = sqlite3.connect(self.directory / "gateway.sqlite3")
            self.db.row_factory = sqlite3.Row
            self.db.execute("PRAGMA journal_mode=WAL")
            self.db.execute("PRAGMA synchronous=FULL")
            self.db.execute("PRAGMA secure_delete=ON")
            self.db.executescript("""
                CREATE TABLE IF NOT EXISTS jobs (
                  id TEXT PRIMARY KEY, key_hash TEXT UNIQUE NOT NULL, request_hash TEXT NOT NULL,
                  status TEXT NOT NULL, created_at REAL NOT NULL, updated_at REAL NOT NULL,
                  started_at REAL, finished_at REAL, elapsed_seconds REAL,
                  duration REAL NOT NULL, audio_path TEXT, video_id TEXT, title TEXT NOT NULL,
                  language TEXT NOT NULL, result_json TEXT, error TEXT,
                  result_expired INTEGER NOT NULL DEFAULT 0,
                  reserved_seconds REAL NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS usage (day TEXT PRIMARY KEY, audio_seconds REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value REAL NOT NULL);
            """)
            self.db.commit()
            with suppress(OSError):
                os.chmod(self.directory / "gateway.sqlite3", 0o600)
            # Restart does not resubmit anything. A reservation may represent an
            # accepted remote request whose reply was lost, so it is never refunded.
            for row in self.db.execute("SELECT * FROM jobs WHERE status IN ('queued','running')").fetchall():
                self.finish(row["id"], "error", error="interrupted_no_automatic_retry")
            for path in self.directory.glob("*.wav"):
                path.unlink(missing_ok=True)
            self.sweep()
            self.worker_task = asyncio.create_task(self.worker())
            self.sweeper_task = asyncio.create_task(self.sweeper())
        except BaseException:
            if hasattr(self, "db"):
                self.db.close()
            self.lock.close()
            raise

    async def stop(self) -> None:
        for task in (self.sweeper_task, self.worker_task):
            if task:
                task.cancel()
                with suppress(asyncio.CancelledError):
                    await task
        for row in self.db.execute("SELECT * FROM jobs WHERE status IN ('queued','running')").fetchall():
            self.finish(row["id"], "error", error="interrupted_no_automatic_retry")
        self.db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        self.db.close()
        self.lock.close()

    def row(self, job_id: str) -> sqlite3.Row:
        row = self.db.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "job_not_found")
        return row

    def view(self, row: sqlite3.Row) -> dict:
        return {"id": row["id"], "status": row["status"],
                "progress": 1 if row["status"] in TERMINAL else 0,
                "result": json.loads(row["result_json"]) if row["result_json"] else None,
                "error": row["error"], "result_expired": bool(row["result_expired"]),
                "duration": row["duration"], "created_at": row["created_at"],
                "updated_at": row["updated_at"],
                "message": {"queued": "Waiting for the single inference slot", "running": "Processing speech",
                            "done": "Review required", "error": "Failed; no automatic retry",
                            "cancelled": "Cancelled locally; a remote request may still be billed"}[row["status"]]}

    def count(self, name: str, amount: float = 1) -> None:
        self.db.execute("INSERT INTO counters(name,value) VALUES (?,?) ON CONFLICT(name) DO UPDATE SET value=value+excluded.value", (name, amount))

    def finish(self, job_id: str, status: str, *, result: dict | None = None, error: str | None = None) -> None:
        row = self.row(job_id)
        if row["status"] in TERMINAL:
            return
        now = time.time()
        elapsed = max(0, now - (row["started_at"] or row["created_at"]))
        with self.db:
            self.db.execute("UPDATE jobs SET status=?,updated_at=?,finished_at=?,elapsed_seconds=?,audio_path=NULL,result_json=?,error=? WHERE id=?",
                            (status, now, now, elapsed, json.dumps(result, ensure_ascii=False) if result else None, error, job_id))
            self.count("jobs_" + status)
            self.count("duration_count")
            self.count("duration_sum", elapsed)
            for upper in BUCKETS:
                if elapsed <= upper:
                    self.count("duration_bucket_" + str(upper))
        if row["audio_path"]:
            # Windows cannot unlink while the provider task still owns the file;
            # worker.finally retries immediately after cancellation is delivered.
            with suppress(PermissionError):
                (self.directory / row["audio_path"]).unlink(missing_ok=True)

    async def submit(self, payload: bytes, fields: dict, key: str) -> tuple[dict, bool]:
        duration = wav_duration(payload)
        key_hash = hashlib.sha256(key.encode()).hexdigest()
        digest = hashlib.sha256(json.dumps(fields, sort_keys=True, ensure_ascii=False).encode() + b"\x00" + payload).hexdigest()
        async with self.submit_lock:
            self.sweep()
            existing = self.db.execute("SELECT * FROM jobs WHERE key_hash=?", (key_hash,)).fetchone()
            if existing:
                if not hmac.compare_digest(existing["request_hash"], digest):
                    raise HTTPException(409, "idempotency_key_conflict")
                if existing["result_expired"]:
                    raise HTTPException(410, "result_expired_key_preserved")
                return self.view(existing), False
            if not self.settings.enabled:
                raise HTTPException(503, "provider_disabled")
            if self.queue.full():
                raise HTTPException(429, "queue_full", headers={"Retry-After": "10"})
            job_id = uuid.uuid4().hex
            path = self.directory / (job_id + ".wav")
            now = time.time()
            try:
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, "wb") as stream:
                    stream.write(payload)
                    stream.flush()
                    os.fsync(stream.fileno())
                with self.db:
                    self.db.execute("INSERT INTO jobs(id,key_hash,request_hash,status,created_at,updated_at,duration,audio_path,video_id,title,language) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                                    (job_id, key_hash, digest, "queued", now, now, duration, path.name,
                                     fields["video_id"], fields["title"], fields["language"]))
                self.queue.put_nowait(job_id)
            except BaseException:
                path.unlink(missing_ok=True)
                raise
            return self.view(self.row(job_id)), True

    def reserve(self, job: sqlite3.Row) -> None:
        day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        with self.db:
            used = self.db.execute("SELECT audio_seconds FROM usage WHERE day=?", (day,)).fetchone()
            seconds = used[0] if used else 0
            if seconds + job["duration"] > self.settings.daily_audio_minutes * 60 + 1e-9:
                raise ProviderFailure("daily_audio_limit")
            self.db.execute("INSERT INTO usage(day,audio_seconds) VALUES (?,?) ON CONFLICT(day) DO UPDATE SET audio_seconds=audio_seconds+excluded.audio_seconds", (day, job["duration"]))
            self.db.execute("UPDATE jobs SET reserved_seconds=? WHERE id=?", (job["duration"], job["id"]))
            self.count("provider_audio_seconds", job["duration"])

    async def infer(self, job: sqlite3.Row) -> dict:
        if self.settings.provider == "mock":
            await asyncio.sleep(.01)
            return {"segments": [{"start": 0, "end": min(job["duration"], 1), "text": "[SYNTHETIC MOCK — not an audio transcript]"}]}
        if self.settings.provider != "deepinfra" or not self.settings.allow_paid:
            raise ProviderFailure("provider_disabled")
        self.reserve(job)  # Durable before the first possible external request.
        try:
            timeout = httpx.Timeout(self.settings.provider_timeout_seconds, connect=10)
            async with httpx.AsyncClient(timeout=timeout, follow_redirects=False, trust_env=False, transport=self.transport) as client:
                with (self.directory / job["audio_path"]).open("rb") as audio:
                    async with client.stream("POST", PROVIDER_URL,
                                             headers={"Authorization": "Bearer " + self.settings.deepinfra_api_key},
                                             files={"audio": ("audio.wav", audio, "audio/wav")},
                                             data={"language": job["language"]}) as response:
                        if response.status_code != 200:
                            raise ProviderFailure("provider_http_error")
                        chunks = bytearray()
                        async for chunk in response.aiter_bytes():
                            if len(chunks) + len(chunk) > MAX_PROVIDER_BYTES:
                                raise ProviderFailure("provider_response_too_large")
                            chunks.extend(chunk)
                        try:
                            return json.loads(chunks)
                        except (ValueError, UnicodeError):
                            raise ProviderFailure("invalid_provider_json") from None
        except httpx.TimeoutException:
            raise ProviderFailure("provider_timeout_billing_uncertain_no_retry") from None
        except httpx.HTTPError:
            raise ProviderFailure("provider_network_error_no_retry") from None

    async def worker(self) -> None:
        while True:
            job_id = await self.queue.get()
            try:
                job = self.row(job_id)
                if job["status"] != "queued":
                    continue
                self.active_id = job_id
                now = time.time()
                with self.db:
                    self.db.execute("UPDATE jobs SET status='running',started_at=?,updated_at=? WHERE id=?", (now, now, job_id))
                job = self.row(job_id)
                self.active_call = asyncio.create_task(self.infer(job))
                try:
                    response = await asyncio.wait_for(self.active_call, timeout=self.settings.provider_timeout_seconds)
                    result = document_from_segments(job, response, self.settings.provider)
                    self.finish(job_id, "done", result=result)
                except asyncio.CancelledError:
                    if self.row(job_id)["status"] == "cancelled":
                        continue
                    raise
                except TimeoutError:
                    self.finish(job_id, "error", error="provider_timeout_billing_uncertain_no_retry")
                except ProviderFailure as exc:
                    self.finish(job_id, "error", error=str(exc))
                except Exception:
                    # Exception text may contain secrets, provider content or raw
                    # transcript fragments. Never persist or log it.
                    self.finish(job_id, "error", error="processing_failed_no_retry")
            finally:
                with suppress(PermissionError):
                    (self.directory / (job_id + ".wav")).unlink(missing_ok=True)
                self.active_id = None
                self.active_call = None
                self.queue.task_done()

    def cancel(self, job_id: str) -> dict:
        row = self.row(job_id)
        if row["status"] not in TERMINAL:
            if self.active_id == job_id and self.active_call:
                self.active_call.cancel()
            self.finish(job_id, "cancelled", error="cancelled_remote_billing_may_continue")
        return self.view(self.row(job_id))

    def sweep(self) -> None:
        cutoff = time.time() - self.settings.result_ttl_seconds
        with self.db:
            self.db.execute("UPDATE jobs SET result_json=NULL,title='',video_id=NULL,result_expired=1 WHERE status IN ('done','error','cancelled') AND finished_at<? AND result_expired=0", (cutoff,))
        # Passive checkpoint permits expired transcript pages to leave the WAL.
        # SQLite deletion is logical retention, not a forensic secure-erasure claim.
        self.db.execute("PRAGMA wal_checkpoint(PASSIVE)")
        for path in self.directory.glob("*.wav"):
            row = self.db.execute("SELECT status FROM jobs WHERE id=?", (path.stem,)).fetchone()
            if row is None or row[0] in TERMINAL:
                with suppress(PermissionError):
                    path.unlink(missing_ok=True)

    async def sweeper(self) -> None:
        while True:
            await asyncio.sleep(self.settings.sweep_interval_seconds)
            self.sweep()

    def metrics(self) -> str:
        counters = {r["name"]: r["value"] for r in self.db.execute("SELECT * FROM counters")}
        active = self.db.execute("SELECT COUNT(*) FROM jobs WHERE status IN ('queued','running')").fetchone()[0]
        storage = sum(p.stat().st_size for p in self.directory.iterdir() if p.is_file())
        lines = ["# TYPE onsori_jobs_total counter"]
        lines += [f'onsori_jobs_total{{status="{status}"}} {counters.get("jobs_" + status, 0):g}' for status in TERMINAL]
        lines += ["# TYPE onsori_jobs_active gauge", f"onsori_jobs_active {active}",
                  "# TYPE onsori_job_duration_seconds histogram"]
        lines += [f'onsori_job_duration_seconds_bucket{{le="{upper}"}} {counters.get("duration_bucket_" + str(upper), 0):g}' for upper in BUCKETS]
        lines += [f'onsori_job_duration_seconds_bucket{{le="+Inf"}} {counters.get("duration_count", 0):g}',
                  f'onsori_job_duration_seconds_sum {counters.get("duration_sum", 0):g}',
                  f'onsori_job_duration_seconds_count {counters.get("duration_count", 0):g}',
                  "# TYPE onsori_provider_audio_seconds_total counter",
                  f'onsori_provider_audio_seconds_total {counters.get("provider_audio_seconds", 0):g}',
                  "# TYPE onsori_storage_bytes gauge", f"onsori_storage_bytes {storage}"]
        return "\n".join(lines) + "\n"


def create_app(settings: Settings | None = None, *, transport: httpx.AsyncBaseTransport | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        gateway = Gateway(settings or Settings.from_env(), transport)
        await gateway.start()
        app.state.gateway = gateway
        try:
            yield
        finally:
            await gateway.stop()

    app = FastAPI(title="OnSori cloud pilot", version="0.1.0", lifespan=lifespan,
                  docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(UploadLimitMiddleware)

    def authenticate(request: Request, *, metrics: bool = False) -> Gateway:
        gateway = request.app.state.gateway
        expected = gateway.settings.metrics_token if metrics else gateway.settings.api_token
        header = request.headers.get("authorization", "")
        scheme, _, token = header.partition(" ")
        if scheme.lower() != "bearer" or not token.isascii() or not hmac.compare_digest(token, expected):
            raise HTTPException(401, "unauthorized", headers={"WWW-Authenticate": "Bearer"})
        return gateway

    @app.get("/healthz")
    async def healthz(request: Request):
        if request.app.state.gateway.worker_task.done():
            return JSONResponse({"status": "unavailable"}, status_code=503)
        return {"status": "ok"}

    @app.get("/v1/status")
    async def status(request: Request):
        gateway = authenticate(request)
        counts = {r[0]: r[1] for r in gateway.db.execute("SELECT status,COUNT(*) FROM jobs GROUP BY status")}
        return {"provider": gateway.settings.provider, "enabled": gateway.settings.enabled,
                "scope": "speech-only", "synthetic": gateway.settings.provider == "mock",
                "counts": counts, "queue_capacity": gateway.settings.max_queue,
                "daily_audio_minutes": gateway.settings.daily_audio_minutes}

    @app.get("/metrics")
    async def metrics(request: Request):
        gateway = authenticate(request, metrics=True)
        return PlainTextResponse(gateway.metrics(), media_type="text/plain; version=0.0.4")

    @app.post("/v1/jobs")
    async def submit(request: Request):
        gateway = authenticate(request)  # Authenticate before multipart parsing.
        key = request.headers.get("idempotency-key", "")
        if not re.fullmatch(r"[A-Za-z0-9._:-]{8,128}", key):
            raise HTTPException(422, "idempotency_key_required_8_to_128_ascii")
        try:
            async with request.form(max_files=1, max_fields=5, max_part_size=4096) as form:
                allowed = {"file", "consent", "language", "video_id", "title"}
                if set(form) - allowed or any(len(form.getlist(name)) != 1 for name in form):
                    raise HTTPException(422, "unknown_or_duplicate_form_fields")
                file = form.get("file")
                if not isinstance(file, UploadFile):
                    raise HTTPException(422, "wav_file_required")
                if form.get("consent") != "true":
                    raise HTTPException(422, "explicit_consent_required")
                language, video_id, title = form.get("language", "ko"), form.get("video_id") or None, form.get("title", "Untitled speech captions")
                if language != "ko":
                    raise HTTPException(422, "pilot_language_must_be_ko")
                if video_id is not None and (not isinstance(video_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id)):
                    raise HTTPException(422, "invalid_video_id")
                if not isinstance(title, str) or len(title) > 300 or "\x00" in title:
                    raise HTTPException(422, "invalid_title")
                payload = await file.read(MAX_AUDIO_BYTES + 1)
                if len(payload) > MAX_AUDIO_BYTES:
                    raise HTTPException(413, "upload_too_large")
                fields = {"video_id": video_id, "title": title, "language": language, "consent": True}
                result, created = await gateway.submit(payload, fields, key)
                return JSONResponse(result, status_code=202 if created else 200)
        except StarletteHTTPException as exc:
            if exc.detail == "upload_too_large":
                raise HTTPException(413, "upload_too_large") from None
            raise
        except BodyTooLarge:
            raise
        except (ValueError, UnicodeError):
            raise HTTPException(400, "invalid_multipart") from None

    @app.get("/v1/jobs/{job_id}")
    async def get_job(job_id: str, request: Request):
        gateway = authenticate(request)
        gateway.sweep()
        row = gateway.row(job_id)
        if row["result_expired"]:
            raise HTTPException(410, "result_expired_key_preserved")
        return gateway.view(row)

    @app.delete("/v1/jobs/{job_id}")
    async def delete_job(job_id: str, request: Request):
        return authenticate(request).cancel(job_id)

    return app


app = create_app()
