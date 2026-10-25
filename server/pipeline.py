from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import threading
from urllib.parse import parse_qs, urlparse
from uuid import uuid4

import numpy as np
import soundfile as sf

from .audio import SAMPLE_RATE, MAX_DURATION, active_bounds, dbfs, decode_audio, envelope, reference_level, volume_style, volume_profile
from .lexicon import EVENTS, describe
from .music import music_score, select_tags, rhythm_features, describe_music
from .schema import AnalysisOptions, Cue, Document

ROOT = Path(__file__).resolve().parents[1]
MODEL_DIR = ROOT / "models"
os.environ.setdefault("HF_HOME", str(MODEL_DIR / "huggingface"))
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
AST_ID = "MIT/ast-finetuned-audioset-10-10-0.4593"
AST_REVISION = "f826b80d28226b62986cc218e5cec390b1096902"
WHISPER_BASE_REVISION = "ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66"
_whisper = None
_whisper_name = None
_ast = None
_extractor = None


class Cancelled(Exception):
    pass


def check_cancel(cancel):
    if cancel.is_set():
        raise Cancelled("분석을 취소했습니다.")


def caption_python() -> Path:
    return ROOT / ".venv-caption" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def dependencies() -> dict:
    return {"whisper": importlib.util.find_spec("faster_whisper") is not None,
            "events": importlib.util.find_spec("torch") is not None and importlib.util.find_spec("transformers") is not None,
            "captioning": caption_python().is_file() and (ROOT / "server/caption_worker.py").is_file()}


def youtube_id(url: str) -> str:
    p = urlparse(url.strip())
    if p.scheme != "https" or p.username or p.password or p.port not in (None, 443):
        raise ValueError("https://www.youtube.com/watch?v=… 또는 https://youtu.be/… 주소를 넣어 주세요.")
    host = (p.hostname or "").lower()
    if host == "youtu.be":
        video_id = p.path.strip("/")
    elif host in ("youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"):
        video_id = parse_qs(p.query).get("v", [""])[0] if p.path == "/watch" else p.path.split("/")[2] if p.path.startswith(("/shorts/", "/embed/", "/live/")) else ""
    else:
        raise ValueError("유튜브 영상 주소만 사용할 수 있습니다.")
    if not re.fullmatch(r"[\w-]{11}", video_id, flags=re.ASCII):
        raise ValueError("유효한 유튜브 영상 ID를 찾지 못했습니다.")
    return video_id


def fetch_transcript(video_id: str, language: str):
    from youtube_transcript_api import YouTubeTranscriptApi
    import requests
    class TimedSession(requests.Session):
        def request(self, method, url, **kwargs):
            kwargs.setdefault("timeout", 20)
            return super().request(method, url, **kwargs)
    preferred = list(dict.fromkeys([language if language != "auto" else "ko", "ko", "en"]))
    with TimedSession() as session:
        api = YouTubeTranscriptApi(http_client=session)
        transcripts = api.list(video_id)
        try:
            selected = transcripts.find_transcript(preferred)
        except Exception:
            selected = next(iter(transcripts))
        result = selected.fetch()
        return [{"start": x.start, "end": x.start + x.duration, "text": " ".join(x.text.split())} for x in result], selected.language_code


def download_youtube(video_id, folder, cancel, visual=False):
    import yt_dlp
    def progress(_):
        check_cancel(cancel)
    def match_filter(info, *, incomplete=False):
        if info.get("is_live") or info.get("live_status") == "is_live":
            return "라이브 방송은 재생 중인 탭 구간 녹음을 사용하세요."
        if (info.get("duration") or 0) > MAX_DURATION:
            return "20분을 초과한 영상입니다. 필요한 구간을 녹음하거나 파일을 나누어 주세요."
    options = {"format": "bestaudio/best", "outtmpl": str(folder / "youtube.%(ext)s"),
               "noplaylist": True, "quiet": True, "no_warnings": True,
               "socket_timeout": 20, "retries": 1, "fragment_retries": 1,
               "max_filesize": 100*1024*1024, "progress_hooks": [progress],
               "match_filter": match_filter, "restrictfilenames": True,
               "js_runtimes": {"node": {}}, "cachedir": str(MODEL_DIR / "yt-dlp")}
    if visual:
        options.update(format="bestvideo[height<=720]/best[height<=720]",
                       outtmpl=str(folder / "reference-video.%(ext)s"))
    with yt_dlp.YoutubeDL(options) as dl:
        info = dl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=True)
        if not info:
            raise ValueError("오디오를 가져오지 못했습니다. 탭 구간 녹음 또는 파일 업로드를 사용하세요.")
        path = Path(dl.prepare_filename(info))
        if not path.is_file():
            raise ValueError("오디오 파일이 내려받아지지 않았습니다. 탭 구간 녹음을 사용하세요.")
        return path, str(info.get("title") or video_id)


def split_speech_cue(cue, max_seconds=5.0, max_chars=50):
    """Split at observed word boundaries; never estimate missing word times."""
    if cue["end"] - cue["start"] <= max_seconds and len(cue["text"]) <= max_chars:
        return [cue]
    words = cue.get("words", [])
    # Incomplete alignment must not silently drop text (including punctuation).
    compact = lambda text: re.sub(r"\s+", "", text)
    if not words or compact("".join(w["text"] for w in words)) != compact(cue["text"]):
        return [cue]
    previous = cue["start"]
    for word in words:
        if (not np.isfinite(word["start"]) or not np.isfinite(word["end"])
                or word["start"] < previous or word["end"] <= word["start"]
                or word["end"] > cue["end"]):
            return [cue]
        previous = word["start"]
    groups, current = [], []
    for word in words:
        text = "".join(w["text"] for w in [*current, word]).strip()
        if current and (word["end"] - current[0]["start"] > max_seconds or len(text) > max_chars):
            groups.append(current)
            current = []
        current.append(word)
    groups.append(current)
    if len(groups) == 1:
        return [cue]
    return [{**cue, "start": group[0]["start"], "end": group[-1]["end"],
             "text": "".join(w["text"] for w in group).strip(), "words": group}
            for group in groups]


def transcribe(audio, options, update, cancel):
    global _whisper, _whisper_name
    from faster_whisper import WhisperModel
    if _whisper_name != options.whisper_model:
        update(.2, f"Whisper {options.whisper_model} 준비 중 · 첫 실행은 모델을 내려받습니다")
        _whisper = WhisperModel(options.whisper_model, device="cpu", compute_type="int8",
                                cpu_threads=min(8, os.cpu_count() or 4), download_root=str(MODEL_DIR / "whisper"),
                                revision=WHISPER_BASE_REVISION if options.whisper_model == "base" else None)
        _whisper_name = options.whisper_model
    check_cancel(cancel)
    segments, info = _whisper.transcribe(audio, language=None if options.language == "auto" else options.language,
                                       beam_size=5, word_timestamps=True, vad_filter=True,
                                       condition_on_previous_text=False, vad_parameters={"min_silence_duration_ms": 400})
    cues = []
    duration = len(audio) / SAMPLE_RATE
    for seg in segments:
        check_cancel(cancel)
        if not seg.text.strip() or seg.end <= seg.start or seg.start >= duration:
            continue
        words = [{"start": max(seg.start, w.start), "end": min(seg.end, duration, w.end), "text": w.word}
                 for w in (seg.words or []) if w.end > w.start and w.start < duration]
        words = [w for w in words if w["end"] > w["start"]]
        cues.extend(split_speech_cue({"start": max(0, seg.start), "end": min(seg.end, duration), "text": seg.text.strip(),
                     "words": words, "confidence": round(float(np.clip(np.exp(seg.avg_logprob), 0, 1)), 4),
                     "kind": "speech", "source": f"faster-whisper/{options.whisper_model}"}))
        update(.2 + .3 * min(seg.end / duration, 1), "대사와 단어별 시각 분석 중")
    return cues, info.language


def load_ast(update):
    global _ast, _extractor
    if _ast is None:
        update(.51, "효과음 모델 준비 중 · 첫 실행은 약 350MB를 내려받습니다")
        import torch
        from transformers import ASTFeatureExtractor, ASTForAudioClassification
        torch.set_num_threads(min(6, os.cpu_count() or 4))
        _extractor = ASTFeatureExtractor.from_pretrained(AST_ID, revision=AST_REVISION)
        _ast = ASTForAudioClassification.from_pretrained(AST_ID, revision=AST_REVISION, use_safetensors=True).eval()
    return _extractor, _ast


def detect_events(audio, update, cancel):
    import torch
    extractor, model = load_ast(update)
    duration = len(audio) / SAMPLE_RATE
    events = []
    # 2-second overlapping windows. AST is a clip classifier, so event boundaries
    # remain estimates; energy helps with isolated transients, not source separation.
    starts = np.arange(0, max(.01, duration - .25), 1.0)
    for i, start in enumerate(starts):
        check_cancel(cancel)
        end = min(duration, start + 2.0)
        chunk = audio[int(start*SAMPLE_RATE):int(end*SAMPLE_RATE)]
        if dbfs(chunk) < -60:
            continue
        inputs = extractor(chunk, sampling_rate=SAMPLE_RATE, return_tensors="pt")
        with torch.inference_mode():
            scores = torch.sigmoid(model(**inputs).logits[0]).cpu().numpy()
        order = np.argsort(scores)[::-1]
        # Detect music presence separately so a generic parent cannot discard
        # instrument/genre evidence. Describe each merged music phrase below.
        score_map = {model.config.id2label[int(k)]: float(v) for k, v in enumerate(scores)}
        strength = music_score(score_map)
        a, b = active_bounds(audio, float(start), float(end))
        if strength >= .24 and b - a >= .08:
            events.append({"label": "Music", "start": a, "end": b, "kind": "music",
                           "confidence": round(strength, 4), "source": "AST/AudioSet + librosa"})
        # Keep at most one strongest sound class; music has its own lane.
        seen = set()
        for index in order[:15]:
            label = model.config.id2label[int(index)]
            if label not in EVENTS or scores[index] < .24:
                continue
            kind = EVENTS[label][2]
            if kind == "music":
                continue
            if kind in seen:
                continue
            seen.add(kind)
            a, b = active_bounds(audio, float(start), float(end))
            if b - a < .08:
                continue
            events.append({"label": label, "start": a, "end": b, "kind": kind,
                           "confidence": round(float(scores[index]), 4), "source": "AST/AudioSet"})
        update(.52 + .30 * (i+1) / len(starts), f"효과음·음악 분석 {i+1}/{len(starts)}")
    # Merge only same class, preserve distinct sound events. Short gaps avoid flicker.
    merged = []
    for event in sorted(events, key=lambda e: (e["label"], e["start"])):
        if merged and event["label"] == merged[-1]["label"] and event["start"] <= merged[-1]["end"] + .15:
            merged[-1]["end"] = max(merged[-1]["end"], event["end"])
            merged[-1]["confidence"] = max(merged[-1]["confidence"], event["confidence"])
        else:
            merged.append(event.copy())
    # Display manageable segments (long continuous beds are split into 8s phrases).
    output = []
    for event in merged:
        for a in np.arange(event["start"], event["end"] - .001, 8):
            output.append({**event, "start": float(a), "end": min(float(a)+8, event["end"])})
    music_events = [event for event in output if event["kind"] == "music"]
    for i, event in enumerate(music_events):
        check_cancel(cancel)
        chunk = audio[int(event["start"]*SAMPLE_RATE):int(event["end"]*SAMPLE_RATE)]
        # A full phrase supplies more context than a two-second effect window.
        inputs = extractor(chunk, sampling_rate=SAMPLE_RATE, return_tensors="pt")
        with torch.inference_mode():
            scores = torch.sigmoid(model(**inputs).logits[0]).cpu().numpy()
        features = select_tags({model.config.id2label[int(k)]: float(v) for k, v in enumerate(scores)})
        # Speech overlapping music can create spurious beat estimates.
        speech_score = max((float(v) for k,v in enumerate(scores)
                            if model.config.id2label[int(k)] in ("Speech", "Conversation", "Narration, monologue")), default=0)
        if speech_score < .35:
            try:
                features["rhythm"] = rhythm_features(chunk)
            except Exception as exc:
                features["rhythm_unavailable"] = type(exc).__name__
        event["music_features"] = features
        update(.82 + .02 * (i+1)/len(music_events), f"악기·분위기·리듬 분석 {i+1}/{len(music_events)}")
    return sorted(output, key=lambda e: e["start"])


def detailed_captions(audio, cues, folder, update, cancel):
    executable = caption_python()
    if not executable.exists():
        raise ValueError("상세 캡셔닝 환경이 없습니다. Install-Detail-Captions.cmd를 먼저 실행하세요.")
    # Limit expensive optional descriptions, clearly report the exact scope.
    selected = [c for c in cues if c["kind"] != "speech"][:24]
    if not selected:
        selected = [{"id": "ambient", "start": 0, "end": min(10, len(audio)/SAMPLE_RATE)}]
    clips = []
    for i, cue in enumerate(selected):
        path = folder / f"caption-{i}.wav"
        sf.write(path, audio[int(cue["start"]*SAMPLE_RATE):int(cue["end"]*SAMPLE_RATE)], SAMPLE_RATE)
        clips.append({"id": cue["id"], "start": cue["start"], "end": cue["end"], "path": str(path.resolve())})
    manifest, result = folder / "caption-input.json", folder / "caption-output.json"
    manifest.write_text(json.dumps({"segments": clips, "device": "cpu"}), encoding="utf-8")
    update(.84, "CoNeTTE가 소리 묘사 문장을 생성합니다 · 최대 24개 구간")
    with (folder / "caption-log.txt").open("w", encoding="utf-8") as log:
        process = subprocess.Popen([str(executable), "-X", "utf8", str(ROOT/"server/caption_worker.py"),
                                    "--manifest", str(manifest), "--output", str(result)],
                                   stdout=log, stderr=log, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        while process.poll() is None:
            if cancel.wait(.5):
                # Only this application's own optional worker is terminated.
                process.terminate()
                process.wait(timeout=10)
                raise Cancelled()
    if process.returncode or not result.exists():
        raise ValueError("상세 캡셔닝이 실패했습니다. 작업 폴더의 caption-log.txt를 확인하세요.")
    data = json.loads(result.read_text(encoding="utf-8"))
    try:
        from .translation import translate_captions, MODEL_ID as TRANSLATION_ID
        data["captions"] = translate_captions(data["captions"], update, cancel)
        data["translation_model"] = TRANSLATION_ID
    except Cancelled:
        raise
    except Exception as exc:
        data.setdefault("warnings", []).append("한국어 상세 설명 번역에 실패해 영어 원문을 보존했습니다. " + type(exc).__name__)
    from .music import music_caption_detail
    descriptions = {str(c["id"]): c for c in data["captions"]}
    for cue in cues:
        if cue["id"] in descriptions:
            caption = descriptions[cue["id"]]
            if cue["kind"] == "music":
                cue["details"], reason = music_caption_detail(caption)
                if reason:
                    caption["display_suppressed"] = reason
            else:
                cue["details"] = str(caption.get("text_ko") or caption["text"])
    (folder / "caption-translated.json").write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return data


def analyze(path: Path, options: AnalysisOptions, folder: Path, update, cancel, transcript=None, warnings=None):
    warnings = list(warnings or [])
    update(.14, "오디오 디코딩과 음량 측정 중")
    audio = decode_audio(path)
    check_cancel(cancel)
    duration = len(audio) / SAMPLE_RATE
    reference = reference_level(audio)
    cues, language = [], options.language
    if transcript is not None:
        for item in transcript:
            start, end = max(0, item["start"]), min(duration, item["end"])
            if end > start and item["text"].strip():
                cues.append({"start": start, "end": end, "text": item["text"].strip(), "kind": "speech",
                             "source": "youtube-transcript-api", "confidence": None})
    elif options.transcribe:
        cues, language = transcribe(audio, options, update, cancel)
        if any(c["end"] - c["start"] > 5 or len(c["text"]) > 50 for c in cues):
            warnings.append("일부 대사는 단어 시각이 없거나 단일 단어가 길어 5초·50자 안에 나누지 못했습니다. 직접 검수하세요.")
    if options.event_detection:
        cues.extend(detect_events(audio, update, cancel))
        warnings.append("효과음 시각은 2초 분류 창과 음량으로 추정합니다. 겹치는 소리의 종류·경계는 직접 검수하세요.")
    music_analysis = {}
    for i, cue in enumerate(cues):
        cue["id"] = f"cue-{i+1:04}"
        cue.update(volume_style(audio, cue["start"], cue["end"], reference))
        cue["volume_profile"] = volume_profile(audio, cue["start"], cue["end"], reference)
        cue["review_required"] = True
        if "label" in cue:
            label = cue.pop("label")
            if cue["kind"] == "music":
                features = cue.pop("music_features", {})
                music_analysis[cue["id"]] = features
                cue["text"] = describe_music(features, cue["relative_db"])
            else:
                cue["text"] = describe(label, cue["relative_db"])
    if any(features.get("rhythm_unavailable") for features in music_analysis.values()):
        warnings.append("일부 음악의 박자 분석을 완료하지 못했습니다. 악기·분위기 분류 결과만 표시합니다.")
    captions = None
    if options.audio_captioning:
        try:
            captions = detailed_captions(audio, cues, folder, update, cancel)
            warnings.extend(captions.get("warnings", []))
            warnings.append("상세 묘사는 최대 24개 구간을 CoNeTTE로 생성하고 OPUS-MT로 번역합니다. 오인식·오역을 직접 검수하세요. 영어 원문은 JSON 메타데이터에 보존합니다.")
        except Cancelled:
            raise
        except Exception as exc:
            warnings.append(str(exc))
    check_cancel(cancel)
    for cue in cues:
        cue["start"] = round(cue["start"] + options.start_time, 3)
        cue["end"] = round(cue["end"] + options.start_time, 3)
        for word in cue.get("words", []):
            word["start"] += options.start_time
            word["end"] += options.start_time
        for point in cue["volume_profile"]:
            point["time"] = round(point["time"] + options.start_time, 3)
    times, levels = envelope(audio, max(.1, duration / 1200))
    document = Document(title=options.title, video_id=options.video_id,
                        duration=round(duration + options.start_time, 3), cues=cues, warnings=warnings,
                        metadata={"language": language, "reference_dbfs": round(reference, 2),
                                  "audio_sample_rate": SAMPLE_RATE, "analyzed_start": options.start_time,
                                  "analyzed_end": round(duration + options.start_time, 3),
                                  "volume_source": "mixed audio RMS, not isolated speaker loudness",
                                  "volume_profile_method": "100ms RMS, fixed recording reference, attack 0.85/release 0.35; acoustic emphasis only",
                                  "music_analysis": music_analysis,
                                  "event_model": AST_ID if options.event_detection else None,
                                  "captioning": captions,
                                  "envelope": [{"time": round(float(t)+options.start_time, 3), "dbfs": round(float(d), 2)} for t,d in zip(times, levels)]})
    (folder / "result.json").write_text(document.model_dump_json(indent=2), encoding="utf-8")
    return document
