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
import secrets
import sqlite3
import struct
import time
from typing import Any, Callable
import uuid
import wave

import anthropic
import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, PlainTextResponse
from starlette.middleware.cors import CORSMiddleware
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
INSTALL_KEY = re.compile(r"osi_[A-Za-z0-9_-]{43}")
# Any unpacked or store-installed Chrome extension may call the user routes;
# install keys, not CORS, are the access control.
EXTENSION_ORIGIN = r"chrome-extension://[a-p]{32}"

# Caption typo correction (2026-11-13): recognized caption TEXT only, never audio. The
# operator's provider key (DeepInfra or Anthropic) stays on this server; installs reach it
# with their own install keys. Prompt and schema are kept identical to extension/ai-config.js
# (a test compares them).
ANTHROPIC_CORRECTION_MODEL = "claude-haiku-5-5"
# DeepInfra's OpenAI-compatible endpoint (docs.deepinfra.com/chat/overview, checked 2026-11-13).
# DeepInfra keeps request content in memory only and does not train on it (account/data-privacy).
DEEPINFRA_CHAT_URL = "https://api.deepinfra.com/v1/openai/chat/completions"
DEEPINFRA_CORRECTION_MODEL = "deepseek-ai/DeepSeek-V4-Flash-0731"
CORRECTION_REASONING = ("none", "minimal", "low", "medium", "high", "default")
MAX_CORRECTION_LINES = 80
MAX_CORRECTION_BODY = 64 * 1024
MAX_CORRECTION_REPLY = 1024 * 1024
CORRECTION_TIMEOUT_SECONDS = 60
CORRECTION_SYSTEM = """당신은 한국어 유튜브 자막 교정자입니다.
입력은 음성 인식(Whisper)이 만든 자막 줄입니다. 인식 오류로 생긴 오타만 고칩니다.

고칠 것:
- 철자·맞춤법 오류, 잘못 붙거나 띄운 띄어쓰기
- 발음이 비슷해 잘못 인식한 낱말 중 앞뒤 문맥과 영상 제목으로 볼 때 명백히 틀린 것 (예: 고유명사, 전문 용어)
- 문장 끝의 명백히 잘못된 문장부호

지킬 것:
- 말한 내용을 바꾸거나 다듬지 않습니다. 요약·의역·번역·문체 변경·존댓말 변경을 하지 않습니다.
- 사투리, 구어체, 줄임말, 감탄사, 말 더듬기, 비속어는 그대로 둡니다.
- 줄을 합치거나 나누지 않고, 없는 말을 보태지 않습니다.
- 확실하지 않으면 고치지 않습니다.
- context는 바로 앞 자막으로, 문맥 참고용입니다. context는 고치지 않습니다.

고친 줄만 corrections에 {"id", "text"}로 돌려줍니다. text는 고친 뒤의 줄 전체입니다. 고칠 줄이 없으면 빈 배열을 돌려줍니다."""
CORRECTION_SCHEMA = {"type": "object", "additionalProperties": False, "required": ["corrections"],
                     "properties": {"corrections": {"type": "array", "items": {
                         "type": "object", "additionalProperties": False, "required": ["id", "text"],
                         "properties": {"id": {"type": "string"}, "text": {"type": "string"}}}}}}


def correction_payload(value: Any) -> dict:
    """The only accepted input: caption lines, the video title and up to four context lines."""
    if not isinstance(value, dict):
        raise HTTPException(422, "invalid_correction_payload")
    lines = value.get("lines")
    if not isinstance(lines, list) or len(lines) > MAX_CORRECTION_LINES:
        raise HTTPException(422, "invalid_correction_lines")
    clean = []
    for line in lines:
        if (not isinstance(line, dict) or not isinstance(line.get("id"), str) or not 0 < len(line["id"]) <= 100
                or not isinstance(line.get("text"), str) or len(line["text"]) > 2000 or "\x00" in line["text"]):
            raise HTTPException(422, "invalid_correction_lines")
        clean.append({"id": line["id"], "text": line["text"]})
    title = value.get("title", "")
    context = value.get("context", [])
    if not isinstance(title, str) or len(title) > 300 or not isinstance(context, list) or len(context) > 4 \
            or any(not isinstance(c, str) or len(c) > 500 for c in context):
        raise HTTPException(422, "invalid_correction_payload")
    return {"title": title, "context": context, "lines": clean}


def utc_day(now: float | None = None) -> str:
    return datetime.fromtimestamp(time.time() if now is None else now, timezone.utc).strftime("%Y-%m-%d")


def utc_day_start(now: float | None = None) -> float:
    moment = datetime.fromtimestamp(time.time() if now is None else now, timezone.utc)
    return moment.replace(hour=0, minute=0, second=0, microsecond=0).timestamp()


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
    install_daily_audio_minutes: float = 20
    installs_per_ip_day: int = 3
    result_ttl_seconds: float = 86400
    sweep_interval_seconds: float = 60
    provider_timeout_seconds: float = 180
    correction: str = "disabled"
    anthropic_api_key: str = ""
    correction_model: str = ""  # DeepInfra model; empty means DEEPINFRA_CORRECTION_MODEL.
    correction_reasoning: str = "none"  # DeepInfra reasoning_effort; "default" omits it.
    daily_correction_lines: int = 20000
    install_daily_correction_lines: int = 3000

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
            install_daily_audio_minutes=float(os.getenv("ONSORI_INSTALL_DAILY_AUDIO_MINUTES", "20")),
            installs_per_ip_day=int(os.getenv("ONSORI_INSTALLS_PER_IP_DAY", "3")),
            result_ttl_seconds=float(os.getenv("ONSORI_RESULT_TTL_SECONDS", "86400")),
            sweep_interval_seconds=float(os.getenv("ONSORI_SWEEP_INTERVAL_SECONDS", "60")),
            provider_timeout_seconds=float(os.getenv("ONSORI_PROVIDER_TIMEOUT_SECONDS", "180")),
            correction=os.getenv("ONSORI_CORRECTION", "disabled"),
            anthropic_api_key=os.getenv("ANTHROPIC_API_KEY", ""),
            correction_model=os.getenv("ONSORI_CORRECTION_MODEL", ""),
            correction_reasoning=os.getenv("ONSORI_CORRECTION_REASONING", "none"),
            daily_correction_lines=int(os.getenv("ONSORI_DAILY_CORRECTION_LINES", "20000")),
            install_daily_correction_lines=int(os.getenv("ONSORI_INSTALL_DAILY_CORRECTION_LINES", "3000")),
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
        if self.correction not in ("disabled", "mock", "anthropic", "deepinfra"):
            raise ValueError("Unsupported ONSORI_CORRECTION")
        if self.correction == "anthropic" and not re.fullmatch(r"sk-ant-[A-Za-z0-9_-]{20,300}", self.anthropic_api_key):
            raise ValueError("ANTHROPIC_API_KEY is required for caption correction")
        if self.correction == "deepinfra":
            # The same DEEPINFRA_API_KEY serves speech (ONSORI_PROVIDER) and correction.
            if not re.fullmatch(r"[\x21-\x7e]{16,512}", self.deepinfra_api_key):
                raise ValueError("DEEPINFRA_API_KEY is required for caption correction")
            if not re.fullmatch(r"[A-Za-z0-9._-]{1,100}/[A-Za-z0-9._-]{1,100}", self.correction_model_name):
                raise ValueError("ONSORI_CORRECTION_MODEL must be a DeepInfra model id such as owner/name")
            if self.correction_reasoning not in CORRECTION_REASONING:
                raise ValueError("ONSORI_CORRECTION_REASONING must be one of " + ", ".join(CORRECTION_REASONING))
        if not 1 <= self.install_daily_correction_lines <= self.daily_correction_lines <= 1_000_000:
            raise ValueError("Correction line limits must satisfy 1 <= install <= server <= 1000000")
        if not 1 <= self.installs_per_ip_day <= 100:
            raise ValueError("ONSORI_INSTALLS_PER_IP_DAY must be 1..100")
        for value in (self.daily_audio_minutes, self.install_daily_audio_minutes, self.result_ttl_seconds,
                      self.sweep_interval_seconds, self.provider_timeout_seconds):
            if not math.isfinite(value) or value <= 0:
                raise ValueError("Gateway time and budget limits must be finite and positive")

    @property
    def enabled(self) -> bool:
        return self.provider == "mock" or (self.provider == "deepinfra" and self.allow_paid)

    @property
    def correction_enabled(self) -> bool:
        return (self.correction == "mock" or (self.correction == "anthropic" and bool(self.anthropic_api_key))
                or (self.correction == "deepinfra" and bool(self.deepinfra_api_key)))

    @property
    def correction_model_name(self) -> str | None:
        """The model named to installs in /v1/availability and used for the request."""
        return {"anthropic": ANTHROPIC_CORRECTION_MODEL, "deepinfra": self.correction_model or DEEPINFRA_CORRECTION_MODEL,
                "mock": "mock"}.get(self.correction)


class ProviderFailure(Exception):
    """Only controlled error codes are safe to persist or return."""


class CorrectionFailure(Exception):
    """A correction provider call failed; carries only a fixed HTTP status and code."""

    def __init__(self, status: int, code: str):
        super().__init__(code)
        self.status, self.code = status, code


@dataclass(frozen=True)
class CorrectionReply:
    """One provider answer, normalized: stop is 'end', 'refusal' or 'truncated'."""
    stop: str
    text: str
    model: str
    input_tokens: int
    output_tokens: int


# HTTP status from DeepInfra -> fixed gateway status and code (response bodies are never read).
DEEPINFRA_FAILURES = {400: (502, "correction_bad_request"), 401: (503, "correction_provider_auth"),
                      402: (503, "correction_provider_billing"), 403: (503, "correction_provider_auth"),
                      404: (503, "correction_model_unavailable"), 422: (502, "correction_bad_request"),
                      429: (429, "correction_rate_limited")}


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
    def __init__(self, settings: Settings, transport: httpx.AsyncBaseTransport | None = None,
                 correction_client: Any = None):
        self.settings = settings
        self.transport = transport  # Only dependency injection in tests; endpoints are fixed.
        # Tests inject a fake Anthropic client; DeepInfra tests inject `transport` instead.
        self.correction_client = correction_client
        self.correction_slots = asyncio.Semaphore(4)
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
                CREATE TABLE IF NOT EXISTS installs (
                  id TEXT PRIMARY KEY, key_hash TEXT UNIQUE NOT NULL, created_at REAL NOT NULL,
                  day TEXT NOT NULL, ip_hash TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS correction_usage (
                  day TEXT NOT NULL, install_id TEXT NOT NULL, lines INTEGER NOT NULL,
                  PRIMARY KEY (day, install_id)
                );
            """)
            # Databases from before install keys gain the owner column in place.
            if "install_id" not in {r[1] for r in self.db.execute("PRAGMA table_info(jobs)")}:
                self.db.execute("ALTER TABLE jobs ADD COLUMN install_id TEXT")
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
            if self.settings.correction == "anthropic" and self.correction_client is None:
                self.correction_client = anthropic.AsyncAnthropic(api_key=self.settings.anthropic_api_key,
                                                                  max_retries=2, timeout=CORRECTION_TIMEOUT_SECONDS)
            if self.settings.correction == "deepinfra" and self.correction_client is None:
                # No automatic retries: a repeated request could be billed twice.
                self.correction_client = httpx.AsyncClient(
                    timeout=httpx.Timeout(CORRECTION_TIMEOUT_SECONDS, connect=10), follow_redirects=False,
                    trust_env=False, transport=self.transport)
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
        close = getattr(self.correction_client, "aclose", None) or getattr(self.correction_client, "close", None)
        if close is not None:
            with suppress(Exception):
                await close()

    def row(self, job_id: str, install_id: str | None = None) -> sqlite3.Row:
        row = self.db.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        # An install sees only its own jobs; another install's job is not found.
        if row is None or (install_id is not None and row["install_id"] != install_id):
            raise HTTPException(404, "job_not_found")
        return row

    def issue_install(self, client: str) -> dict:
        day = utc_day()
        # Keyed hash: the database never stores raw client addresses.
        ip_hash = hmac.new(self.settings.api_token.encode(), client.encode(), hashlib.sha256).hexdigest()
        with self.db:
            issued = self.db.execute("SELECT COUNT(*) FROM installs WHERE ip_hash=? AND day=?", (ip_hash, day)).fetchall()[0][0]
            if issued >= self.settings.installs_per_ip_day:
                self.count("limit_rejections")
                raise HTTPException(429, "install_issue_limit", headers={"Retry-After": "3600"})
            key = "osi_" + secrets.token_urlsafe(32)
            self.db.execute("INSERT INTO installs(id,key_hash,created_at,day,ip_hash) VALUES (?,?,?,?,?)",
                            (uuid.uuid4().hex, hashlib.sha256(key.encode()).hexdigest(), time.time(), day, ip_hash))
            self.count("installs_issued")
        return {"install_key": key, "daily_audio_minutes": self.settings.install_daily_audio_minutes}

    def install_id(self, token: str) -> str | None:
        if not INSTALL_KEY.fullmatch(token):
            return None
        row = self.db.execute("SELECT id FROM installs WHERE key_hash=?",
                              (hashlib.sha256(token.encode()).hexdigest(),)).fetchone()
        return row["id"] if row else None

    def check_daily_limits(self, install_id: str | None, duration: float) -> None:
        # Fail before the upload is queued. reserve() re-checks the server limit
        # durably right before a paid request.
        used = self.db.execute("SELECT COALESCE(SUM(audio_seconds),0) FROM usage WHERE day=?", (utc_day(),)).fetchall()[0][0]
        refused = None
        if used + duration > self.settings.daily_audio_minutes * 60 + 1e-9:
            refused = "daily_audio_limit"
        elif install_id is not None:
            mine = self.db.execute(
                "SELECT COALESCE(SUM(duration),0) FROM jobs WHERE install_id=? AND created_at>=? "
                "AND (reserved_seconds>0 OR status IN ('queued','running','done'))",
                (install_id, utc_day_start())).fetchall()[0][0]
            if mine + duration > self.settings.install_daily_audio_minutes * 60 + 1e-9:
                refused = "install_daily_limit"
        if refused:
            with self.db:
                self.count("limit_rejections")
            raise HTTPException(429, refused)

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

    async def submit(self, payload: bytes, fields: dict, key: str, install_id: str | None = None) -> tuple[dict, bool]:
        duration = wav_duration(payload)
        # Idempotency keys are scoped per install so installs cannot collide or probe each other.
        key_hash = hashlib.sha256((key if install_id is None else install_id + ":" + key).encode()).hexdigest()
        digest = hashlib.sha256(json.dumps(fields, sort_keys=True, ensure_ascii=False).encode() + b"\x00" + payload).hexdigest()
        async with self.submit_lock:
            self.sweep()
            existing = self.db.execute("SELECT * FROM jobs WHERE key_hash=?", (key_hash,)).fetchone()
            if existing and existing["install_id"] != install_id:
                raise HTTPException(409, "idempotency_key_conflict")
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
            self.check_daily_limits(install_id, duration)
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
                    self.db.execute("INSERT INTO jobs(id,key_hash,request_hash,status,created_at,updated_at,duration,audio_path,video_id,title,language,install_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                                    (job_id, key_hash, digest, "queued", now, now, duration, path.name,
                                     fields["video_id"], fields["title"], fields["language"], install_id))
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

    def reserve_correction(self, install_id: str | None, lines: int) -> None:
        """Durable before the external request; a reservation is not refunded on failure."""
        day = utc_day()
        owner = install_id or ""
        with self.db:
            used = self.db.execute("SELECT COALESCE(SUM(lines),0) FROM correction_usage WHERE day=?", (day,)).fetchall()[0][0]
            mine = self.db.execute("SELECT COALESCE(SUM(lines),0) FROM correction_usage WHERE day=? AND install_id=?",
                                   (day, owner)).fetchall()[0][0]
            refused = None
            if used + lines > self.settings.daily_correction_lines:
                refused = "daily_correction_limit"
            elif install_id is not None and mine + lines > self.settings.install_daily_correction_lines:
                refused = "install_daily_correction_limit"
            if refused:
                self.count("limit_rejections")
                raise HTTPException(429, refused)
            self.db.execute("INSERT INTO correction_usage(day,install_id,lines) VALUES (?,?,?) ON CONFLICT(day,install_id) "
                            "DO UPDATE SET lines=lines+excluded.lines", (day, owner, lines))
            self.count("correction_lines", lines)

    async def correct(self, value: Any, install_id: str | None) -> dict:
        if not self.settings.correction_enabled:
            raise HTTPException(503, "correction_disabled")
        payload = correction_payload(value)
        if not payload["lines"]:
            return {"corrections": [], "model": None, "usage": None}
        self.reserve_correction(install_id, len(payload["lines"]))
        if self.settings.correction == "mock":
            with self.db:
                self.count("correction_requests")
            return {"corrections": [], "model": "mock", "usage": None, "synthetic": True}
        call = self.correct_with_deepinfra if self.settings.correction == "deepinfra" else self.correct_with_anthropic
        async with self.correction_slots:
            try:
                reply = await call(payload)
            except CorrectionFailure as failure:
                # Error text may echo caption content or credentials: only fixed codes leave here.
                with self.db:
                    self.count("correction_failures")
                raise HTTPException(failure.status, failure.code) from None
        if reply.stop == "refusal":
            raise HTTPException(422, "correction_refused")
        if reply.stop == "truncated":
            raise HTTPException(502, "correction_truncated")
        try:
            data = json.loads(reply.text)
        except (ValueError, TypeError):
            raise HTTPException(502, "correction_invalid_output") from None
        if not isinstance(data, dict) or not isinstance(data.get("corrections", []), list):
            raise HTTPException(502, "correction_invalid_output")
        ids = {line["id"] for line in payload["lines"]}
        corrections = [{"id": c["id"], "text": c["text"][:2000]} for c in data.get("corrections", [])
                       if isinstance(c, dict) and c.get("id") in ids and isinstance(c.get("text"), str)]
        usage = {"input_tokens": reply.input_tokens, "output_tokens": reply.output_tokens}
        with self.db:
            self.count("correction_requests")
            self.count("correction_input_tokens", usage["input_tokens"])
            self.count("correction_output_tokens", usage["output_tokens"])
        return {"corrections": corrections, "model": reply.model, "usage": usage}

    async def correct_with_anthropic(self, payload: dict) -> CorrectionReply:
        try:
            response = await self.correction_client.messages.create(
                model=ANTHROPIC_CORRECTION_MODEL, max_tokens=16000, system=CORRECTION_SYSTEM,
                output_config={"effort": "low", "format": {"type": "json_schema", "schema": CORRECTION_SCHEMA}},
                messages=[{"role": "user", "content": json.dumps(payload, ensure_ascii=False)}])
        except anthropic.RateLimitError:
            raise CorrectionFailure(429, "correction_rate_limited") from None
        except (anthropic.AuthenticationError, anthropic.PermissionDeniedError):
            raise CorrectionFailure(503, "correction_provider_auth") from None
        except anthropic.NotFoundError:
            raise CorrectionFailure(503, "correction_model_unavailable") from None
        except anthropic.BadRequestError:
            raise CorrectionFailure(502, "correction_bad_request") from None
        except anthropic.APITimeoutError:
            raise CorrectionFailure(504, "correction_timeout") from None
        except anthropic.APIStatusError:
            raise CorrectionFailure(502, "correction_provider_error") from None
        except anthropic.APIConnectionError:
            raise CorrectionFailure(502, "correction_network_error") from None
        try:
            text = "".join(block.text for block in response.content if block.type == "text")
        except (AttributeError, TypeError):
            text = ""
        return CorrectionReply(stop={"refusal": "refusal", "max_tokens": "truncated"}.get(response.stop_reason, "end"),
                               text=text, model=response.model,
                               input_tokens=getattr(response.usage, "input_tokens", 0) or 0,
                               output_tokens=getattr(response.usage, "output_tokens", 0) or 0)

    async def correct_with_deepinfra(self, payload: dict) -> CorrectionReply:
        model = self.settings.correction_model_name
        body = {"model": model, "temperature": 0, "max_tokens": 16000,
                "messages": [{"role": "system", "content": CORRECTION_SYSTEM},
                             {"role": "user", "content": json.dumps(payload, ensure_ascii=False)}],
                "response_format": {"type": "json_schema", "json_schema": {
                    "name": "caption_corrections", "strict": True, "schema": CORRECTION_SCHEMA}}}
        if self.settings.correction_reasoning != "default":
            body["reasoning_effort"] = self.settings.correction_reasoning
        raw = bytearray()
        try:
            async with self.correction_client.stream(
                    "POST", DEEPINFRA_CHAT_URL, json=body,
                    headers={"Authorization": "Bearer " + self.settings.deepinfra_api_key}) as response:
                if response.status_code != 200:
                    # The body is not read: it may echo the request (caption text).
                    raise CorrectionFailure(*DEEPINFRA_FAILURES.get(response.status_code, (502, "correction_provider_error")))
                async for chunk in response.aiter_bytes():
                    if len(raw) + len(chunk) > MAX_CORRECTION_REPLY:
                        raise CorrectionFailure(502, "correction_provider_error")
                    raw.extend(chunk)
        except httpx.TimeoutException:
            raise CorrectionFailure(504, "correction_timeout") from None
        except httpx.HTTPError:
            raise CorrectionFailure(502, "correction_network_error") from None
        try:
            reply = json.loads(raw)
            choice = reply["choices"][0]
            finish, text = choice.get("finish_reason"), choice["message"].get("content")
        except (ValueError, UnicodeError, KeyError, IndexError, TypeError, AttributeError):
            raise CorrectionFailure(502, "correction_invalid_output") from None
        usage = reply.get("usage") if isinstance(reply.get("usage"), dict) else {}
        tokens = [usage.get(name) for name in ("prompt_tokens", "completion_tokens")]
        tokens = [t if isinstance(t, int) and t >= 0 else 0 for t in tokens]
        return CorrectionReply(stop={"length": "truncated", "content_filter": "refusal"}.get(finish, "end"),
                               text=text if isinstance(text, str) else "",
                               # Named to installs and recorded in captions: only a plain model id.
                               model=reply["model"] if isinstance(reply.get("model"), str)
                               and re.fullmatch(r"[A-Za-z0-9._/-]{1,100}", reply["model"]) else model,
                               input_tokens=tokens[0], output_tokens=tokens[1])

    def cancel(self, job_id: str, install_id: str | None = None) -> dict:
        row = self.row(job_id, install_id)
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
                  "# TYPE onsori_storage_bytes gauge", f"onsori_storage_bytes {storage}",
                  "# TYPE onsori_installs_issued_total counter",
                  f'onsori_installs_issued_total {counters.get("installs_issued", 0):g}',
                  "# TYPE onsori_limit_rejections_total counter",
                  f'onsori_limit_rejections_total {counters.get("limit_rejections", 0):g}',
                  "# TYPE onsori_correction_requests_total counter",
                  f'onsori_correction_requests_total {counters.get("correction_requests", 0):g}',
                  "# TYPE onsori_correction_failures_total counter",
                  f'onsori_correction_failures_total {counters.get("correction_failures", 0):g}',
                  "# TYPE onsori_correction_lines_total counter",
                  f'onsori_correction_lines_total {counters.get("correction_lines", 0):g}',
                  "# TYPE onsori_correction_tokens_total counter",
                  f'onsori_correction_tokens_total{{direction="input"}} {counters.get("correction_input_tokens", 0):g}',
                  f'onsori_correction_tokens_total{{direction="output"}} {counters.get("correction_output_tokens", 0):g}']
        return "\n".join(lines) + "\n"


def create_app(settings: Settings | None = None, *, transport: httpx.AsyncBaseTransport | None = None,
               correction_client: Any = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        gateway = Gateway(settings or Settings.from_env(), transport, correction_client)
        await gateway.start()
        app.state.gateway = gateway
        try:
            yield
        finally:
            await gateway.stop()

    app = FastAPI(title="OnSori cloud pilot", version="0.1.0", lifespan=lifespan,
                  docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(UploadLimitMiddleware)
    app.add_middleware(CORSMiddleware, allow_origin_regex=EXTENSION_ORIGIN, allow_methods=["GET", "POST", "DELETE"],
                       allow_headers=["Authorization", "Idempotency-Key"], max_age=600)

    def authenticate(request: Request, *, metrics: bool = False) -> Gateway:
        gateway = request.app.state.gateway
        expected = gateway.settings.metrics_token if metrics else gateway.settings.api_token
        header = request.headers.get("authorization", "")
        scheme, _, token = header.partition(" ")
        if scheme.lower() != "bearer" or not token.isascii() or not hmac.compare_digest(token, expected):
            raise HTTPException(401, "unauthorized", headers={"WWW-Authenticate": "Bearer"})
        return gateway

    def caller(request: Request) -> tuple[Gateway, str | None]:
        """Operator token (all jobs) or an issued install key (own jobs only)."""
        gateway = request.app.state.gateway
        scheme, _, token = request.headers.get("authorization", "").partition(" ")
        if scheme.lower() == "bearer" and token.isascii():
            if hmac.compare_digest(token, gateway.settings.api_token):
                return gateway, None
            install = gateway.install_id(token)
            if install:
                return gateway, install
        raise HTTPException(401, "unauthorized", headers={"WWW-Authenticate": "Bearer"})

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

    @app.get("/v1/availability")
    async def availability(request: Request):
        # Public: lets the extension decide whether to offer cloud speech analysis.
        settings = request.app.state.gateway.settings
        return {"available": settings.enabled, "synthetic": settings.provider == "mock", "scope": "speech-only",
                "install_daily_audio_minutes": settings.install_daily_audio_minutes,
                "corrections": settings.correction_enabled, "corrections_synthetic": settings.correction == "mock",
                "correction_provider": settings.correction if settings.correction_enabled else None,
                "correction_model": settings.correction_model_name if settings.correction_enabled else None}

    @app.post("/v1/installs")
    async def issue(request: Request):
        # nginx overwrites X-Real-IP; the gateway port is bound to host loopback only.
        client = request.headers.get("x-real-ip") or (request.client.host if request.client else "unknown")
        return JSONResponse(request.app.state.gateway.issue_install(client), status_code=201)

    @app.get("/metrics")
    async def metrics(request: Request):
        gateway = authenticate(request, metrics=True)
        return PlainTextResponse(gateway.metrics(), media_type="text/plain; version=0.0.4")

    @app.post("/v1/jobs")
    async def submit(request: Request):
        gateway, install = caller(request)  # Authenticate before multipart parsing.
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
                result, created = await gateway.submit(payload, fields, key, install)
                return JSONResponse(result, status_code=202 if created else 200)
        except StarletteHTTPException as exc:
            if exc.detail == "upload_too_large":
                raise HTTPException(413, "upload_too_large") from None
            raise
        except BodyTooLarge:
            raise
        except (ValueError, UnicodeError):
            raise HTTPException(400, "invalid_multipart") from None

    @app.post("/v1/corrections")
    async def correct(request: Request):
        gateway, install = caller(request)  # Authenticate before reading the body.
        length = request.headers.get("content-length", "")
        if not length.isdigit() or int(length) > MAX_CORRECTION_BODY:
            raise HTTPException(413, "correction_too_large")
        body = await request.body()
        if len(body) > MAX_CORRECTION_BODY:
            raise HTTPException(413, "correction_too_large")
        try:
            value = json.loads(body)
        except (ValueError, UnicodeError):
            raise HTTPException(400, "invalid_json") from None
        return await gateway.correct(value, install)

    @app.get("/v1/jobs/{job_id}")
    async def get_job(job_id: str, request: Request):
        gateway, install = caller(request)
        gateway.sweep()
        row = gateway.row(job_id, install)
        if row["result_expired"]:
            raise HTTPException(410, "result_expired_key_preserved")
        return gateway.view(row)

    @app.delete("/v1/jobs/{job_id}")
    async def delete_job(job_id: str, request: Request):
        gateway, install = caller(request)
        return gateway.cancel(job_id, install)

    return app


app = create_app()
