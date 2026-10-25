from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
import json
import logging
from pathlib import Path
import re
import threading
from uuid import uuid4

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import ValidationError

from . import pipeline
from .schema import AnalysisOptions, Cue, Document, YoutubeOptions, subtitle_text
from .speech_reference import apply_speech_references, fetch_human_references, native_references
from .visual_reference import correct_from_screen

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "runtime/jobs"
DATA.mkdir(parents=True, exist_ok=True)
log = logging.getLogger("onsori")
executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="onsori")
lock = threading.Lock()
MAX_UPLOAD = 100 * 1024 * 1024


@dataclass
class Job:
    id: str = field(default_factory=lambda: uuid4().hex)
    status: str = "queued"
    progress: float = 0.0
    message: str = "분석 대기 중"
    result: dict | None = None
    error: str | None = None
    cancel: threading.Event = field(default_factory=threading.Event)

    def snapshot(self):
        return {k: getattr(self, k) for k in ("id", "status", "progress", "message", "result", "error")}

    def update(self, progress, message):
        self.progress, self.message = progress, message


jobs: dict[str, Job] = {}
app = FastAPI(title="온소리 자막 · 로컬 분석", version="0.1.0", docs_url=None, redoc_url=None)


class BodyLimit:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        limit = MAX_UPLOAD + 1024*1024 if scope.get("path") == "/api/jobs/upload" else 8*1024*1024
        consumed = 0
        headers = dict(scope.get("headers", []))
        if headers.get(b"content-length", b"0").isdigit() and int(headers.get(b"content-length", b"0")) > limit:
            return await JSONResponse({"detail": "파일 또는 요청이 너무 큽니다. 최대 100MB입니다."}, status_code=413)(scope, receive, send)
        async def bounded_receive():
            nonlocal consumed
            message = await receive()
            if message["type"] == "http.request":
                consumed += len(message.get("body", b""))
                if consumed > limit:
                    raise HTTPException(413, "요청 크기 제한을 초과했습니다.")
            return message
        await self.app(scope, bounded_receive, send)


app.add_middleware(BodyLimit)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost", "testserver"])
app.add_middleware(CORSMiddleware, allow_origins=["http://127.0.0.1:8765", "http://localhost:8765"],
                   allow_origin_regex=r"chrome-extension://[a-p]{32}", allow_credentials=False,
                   allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
                   allow_headers=["Content-Type", "X-OnSori-Client"])


@app.middleware("http")
async def local_guard(request, call_next):
    if request.url.path.startswith("/api/") and request.method != "OPTIONS":
        origin = request.headers.get("origin")
        allowed = origin is None or origin in ("http://127.0.0.1:8765", "http://localhost:8765") or re.fullmatch(r"chrome-extension://[a-p]{32}", origin)
        if not allowed or request.headers.get("X-OnSori-Client") != "onsori-local-v1":
            return JSONResponse({"detail": "온소리 앱 또는 확장 프로그램에서 요청하세요."}, status_code=403)
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Cache-Control"] = "no-store"
    if not request.url.path.startswith("/api/"):
        response.headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'"
    return response


def new_job():
    with lock:
        if sum(j.status in ("queued", "running") for j in jobs.values()) >= 2:
            raise HTTPException(429, "이미 분석이 진행 중입니다. 완료 후 다시 시작하세요.")
        if len(jobs) >= 50:
            # Completed records are persisted on disk; only evict memory entries.
            old = next((key for key, j in jobs.items() if j.status not in ("queued", "running")), None)
            if old:
                del jobs[old]
        job = Job()
        jobs[job.id] = job
    (DATA / job.id).mkdir(exist_ok=True)
    return job


def execute(job, options, path=None, video_id=None):
    folder = DATA / job.id
    job.status = "running"
    try:
        pipeline.check_cancel(job.cancel)
        transcript, warnings = None, []
        if video_id:
            job.update(.02, "유튜브 스크립트 추출 중")
            try:
                transcript, _ = pipeline.fetch_transcript(video_id, options.language)
            except Exception as exc:
                warnings.append("유튜브 스크립트를 가져오지 못해 Whisper로 대사를 인식합니다. (" + type(exc).__name__ + ")")
            pipeline.check_cancel(job.cancel)
            job.update(.08, "유튜브 오디오 가져오는 중")
            try:
                path, title = pipeline.download_youtube(video_id, folder, job.cancel)
                options = options.model_copy(update={"title": title, "video_id": video_id, "start_time": 0})
            except pipeline.Cancelled:
                raise
            except Exception:
                if transcript:
                    # Preserve real transcripts, visibly disclose absent sound/volume analysis.
                    cues = [Cue(id=f"yt-{i}", start=max(0,x["start"]), end=x["end"], text=x["text"], kind="speech",
                                source="youtube-transcript-api", scale=1) for i,x in enumerate(transcript) if x["end"] > x["start"] and x["text"].strip()]
                    doc = Document(video_id=video_id, title=video_id, duration=max(c.end for c in cues), cues=cues,
                                   warnings=["대사 스크립트만 추출했습니다. 유튜브 오디오 접근이 제한되어 효과음·음량 분석은 미실행입니다. 탭 구간 녹음이나 파일 업로드를 사용하세요."],
                                   metadata={"partial": True, "audio_analyzed": False})
                    finish(job, doc, folder)
                    return
                raise ValueError("유튜브가 오디오·자막 접근을 제한했습니다. 확장 프로그램의 탭 구간 녹음 또는 파일 업로드를 사용하세요.")
        doc = pipeline.analyze(path, options, folder, job.update, job.cancel, transcript, warnings)
        if options.transcribe and options.use_caption_references and options.video_id and transcript is None:
            pipeline.check_cancel(job.cancel)
            job.update(.96, "원본 자막과 대사 대조 중")
            references = native_references(options.caption_references)
            try:
                references = fetch_human_references(options.video_id, options.language,
                    options.start_time, doc.duration) + references
            except Exception as exc:
                doc.warnings.append("원본 제작 자막을 가져오지 못했습니다. 검증 가능한 참조만 대조하며 나머지 대사는 음성 인식 원문을 유지합니다. (" + type(exc).__name__ + ")")
            apply_speech_references(doc, references)
            if doc.metadata["speech_reference"]["corrected"]:
                doc.warnings.append("일부 음성 인식 대사를 시간과 내용이 일치하는 원본 자막으로 교정했습니다. 교정 전 원문은 JSON에 보존하며 변경된 단어별 시각은 재사용하지 않습니다.")
            try:
                correct_from_screen(doc, options, path, folder, job.update, job.cancel)
            except pipeline.Cancelled:
                raise
            except Exception as exc:
                log.warning('Screen reference unavailable: %s', exc)
                doc.metadata['screen_correction']={'available':0,'corrected':0,'status':'unavailable','error':type(exc).__name__}
            # Revalidate merged cue timing and volume before making anything visible.
            doc = Document.model_validate(doc.model_dump())
        finish(job, doc, folder)
    except pipeline.Cancelled:
        job.status, job.message = "cancelled", "분석을 취소했습니다."
    except Exception as exc:
        log.exception("Analysis failed: %s", job.id)
        job.status, job.error, job.message = "error", str(exc)[:1500], "분석을 완료하지 못했습니다."
    finally:
        (folder / "job.json").write_text(json.dumps(job.snapshot(), ensure_ascii=False, indent=2), encoding="utf-8")


def finish(job, doc, folder):
    pipeline.check_cancel(job.cancel)
    job.result = doc.model_dump()
    job.status, job.progress, job.message = "done", 1.0, f"분석 완료 · 자막 {len(doc.cues)}개 · 내용을 검수해 주세요"
    (folder / "result.json").write_text(doc.model_dump_json(indent=2), encoding="utf-8")


@app.get("/api/health")
def health():
    return {"status": "ok", "version": "0.1.0", "models": pipeline.dependencies(),
            "message": "로컬 분석 서버 연결됨 · 모델은 첫 분석에서 준비합니다"}


@app.post("/api/jobs/youtube", status_code=202)
def youtube(options: YoutubeOptions):
    try:
        video_id = pipeline.youtube_id(options.url)
    except (ValueError, IndexError) as exc:
        raise HTTPException(422, str(exc))
    if options.video_id and options.video_id != video_id:
        raise HTTPException(422, "주소와 참조 자막의 영상 ID가 일치해야 합니다.")
    job = new_job()
    executor.submit(execute, job, options, video_id=video_id)
    return job.snapshot()


@app.post("/api/jobs/upload", status_code=202)
async def upload(file: UploadFile = File(...), options: str = Form("{}")):
    try:
        settings = AnalysisOptions.model_validate_json(options)
    except (ValueError, ValidationError) as exc:
        raise HTTPException(422, "분석 설정이 올바르지 않습니다.") from exc
    suffix = Path(file.filename or "audio.webm").suffix.lower()
    if suffix not in (".wav", ".mp3", ".m4a", ".mp4", ".webm", ".ogg", ".flac", ".aac", ".mov"):
        raise HTTPException(415, "WAV, MP3, M4A, MP4, WebM, OGG, FLAC, AAC, MOV를 지원합니다.")
    job = new_job()
    path = DATA / job.id / ("source" + suffix)
    total = 0
    try:
        with path.open("wb") as target:
            while chunk := await file.read(1024*1024):
                total += len(chunk)
                if total > MAX_UPLOAD:
                    raise HTTPException(413, "100MB 이하 파일을 선택하세요.")
                target.write(chunk)
        if total == 0:
            raise HTTPException(422, "빈 파일입니다.")
    except Exception:
        job.status, job.error = "error", "업로드를 완료하지 못했습니다."
        path.unlink(missing_ok=True)
        raise
    finally:
        await file.close()
    executor.submit(execute, job, settings, path=path)
    return job.snapshot()


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    if job_id in jobs:
        return jobs[job_id].snapshot()
    if re.fullmatch(r"[0-9a-f]{32}", job_id):
        saved = DATA / job_id / "job.json"
        if saved.is_file():
            return json.loads(saved.read_text(encoding="utf-8"))
    raise HTTPException(404, "분석 작업을 찾지 못했습니다.")


@app.delete("/api/jobs/{job_id}")
def cancel_job(job_id: str):
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "분석 작업을 찾지 못했습니다.")
    if job.status in ("queued", "running"):
        job.cancel.set()
        job.message = "취소 요청됨 · 현재 모델 호출이 끝나면 중단합니다"
    return job.snapshot()


@app.post("/api/validate")
def validate(document: Document):
    return document


@app.post("/api/export/{fmt}")
def export(fmt: str, document: Document):
    if fmt not in ("json", "srt", "vtt"):
        raise HTTPException(404, "지원하지 않는 자막 형식입니다.")
    body = document.model_dump_json(indent=2) if fmt == "json" else subtitle_text(document, fmt)
    return Response(body.encode("utf-8"), media_type="application/json" if fmt == "json" else "text/plain; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="onsori-captions.{fmt}"'})


@app.get("/api/demo")
def demo():
    return Document(title="온소리 표현 체험 · 수동 작성 데모", duration=24, warnings=["이 자막은 표현 방식을 보여 주는 수동 작성 데모입니다. AI 분석 결과가 아닙니다."],
                    metadata={"demo": True}, cues=[
        Cue(id="demo-1", start=0, end=4.5, text="소리가 글자가 되는 순간을 만나 보세요.", kind="speech", scale=1, source="manual-demo", review_required=False),
        Cue(id="demo-2", start=4.8, end=7.2, text="[쾅!(문 닫는 소리)]", kind="sound", dbfs=-12, relative_db=16, scale=1.4, source="manual-demo", review_required=False),
        Cue(id="demo-3", start=7.5, end=11, text="여기는 조금 조용히 이야기할게요.", kind="speech", dbfs=-40, relative_db=-12, scale=.75, source="manual-demo", review_required=False),
        Cue(id="demo-4", start=11, end=13.3, text="[에취!(재채기 소리)]", kind="sound", dbfs=-18, relative_db=10, scale=1.25, source="manual-demo", review_required=False),
        Cue(id="demo-5", start=13.5, end=19, text="♪ 피아노 선율이 흐른다", kind="music", dbfs=-30, relative_db=-2, scale=.95, source="manual-demo", review_required=False),
        Cue(id="demo-6", start=19, end=23.5, text="대사도, 효과음도. 온전히 전해지도록.", kind="speech", scale=1.1, source="manual-demo", review_required=False),
    ])


if (ROOT / "web").exists():
    app.mount("/", StaticFiles(directory=ROOT/"web", html=True), name="studio")
