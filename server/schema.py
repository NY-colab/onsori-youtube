from __future__ import annotations

import math
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="ignore", allow_inf_nan=False)


class Word(StrictModel):
    start: float = Field(ge=0, le=86400)
    end: float = Field(gt=0, le=86400)
    text: str = Field(max_length=500)

    @model_validator(mode="after")
    def interval(self):
        if self.end <= self.start:
            raise ValueError("단어 종료 시각은 시작 시각보다 커야 합니다.")
        return self


class VolumePoint(StrictModel):
    time: float = Field(ge=0, le=86400)
    dbfs: float = Field(ge=-120, le=12)
    scale: float = Field(ge=.75, le=1.55)


class CaptionReference(StrictModel):
    """Absolute video times; native caption observations are evidence, never OCR guesses."""
    video_id: str = Field(pattern=r"^[A-Za-z0-9_-]{11}$")
    start: float = Field(ge=0, le=86400)
    end: float = Field(gt=0, le=86400)
    text: str = Field(min_length=1, max_length=500)
    source: Literal["youtube-native-caption"] = "youtube-native-caption"

    @model_validator(mode="after")
    def interval(self):
        if self.end <= self.start or self.end - self.start > 15 or not self.text.strip():
            raise ValueError("참조 자막은 비어 있지 않은 15초 이내 구간이어야 합니다.")
        return self


class SpeechCorrection(StrictModel):
    original_text: str = Field(min_length=1, max_length=2000)
    original_source: str = Field(max_length=200)
    corrected_text: str = Field(min_length=1, max_length=2000)
    reference_source: Literal["youtube-human-caption", "youtube-native-caption", "youtube-screen-ocr"]
    reference_video_id: str = Field(pattern=r"^[A-Za-z0-9_-]{11}$")
    reference_start: float = Field(ge=0, le=86400)
    reference_end: float = Field(gt=0, le=86400)
    similarity: float = Field(ge=0, le=1)
    original_words: list[Word] = Field(default_factory=list, max_length=1000)
    word_timing_status: Literal["cleared_after_source_correction"] = "cleared_after_source_correction"

    @model_validator(mode="after")
    def interval(self):
        if self.reference_end <= self.reference_start:
            raise ValueError("교정 근거의 종료 시각은 시작 시각보다 커야 합니다.")
        return self


class Cue(StrictModel):
    id: str = Field(min_length=1, max_length=100)
    start: float = Field(ge=0, le=86400)
    end: float = Field(gt=0, le=86400)
    text: str = Field(min_length=1, max_length=2000)
    kind: Literal["speech", "sound", "music"]
    dbfs: float | None = Field(default=None, ge=-120, le=12)
    relative_db: float | None = Field(default=None, ge=-120, le=120)
    scale: float = Field(default=1, ge=.75, le=1.55)
    confidence: float | None = Field(default=None, ge=0, le=1)
    source: str = Field(default="manual", max_length=200)
    review_required: bool = True
    details: str = Field(default="", max_length=4000)
    words: list[Word] = Field(default_factory=list, max_length=1000)
    volume_profile: list[VolumePoint] = Field(default_factory=list, max_length=12002)
    speech_correction: SpeechCorrection | None = None

    @model_validator(mode="after")
    def interval(self):
        if self.end <= self.start:
            raise ValueError("자막 종료 시각은 시작 시각보다 커야 합니다.")
        for word in self.words:
            if word.start < self.start - .05 or word.end > self.end + .05:
                raise ValueError("단어 시각은 자막 구간 안에 있어야 합니다.")
        previous = -1
        for point in self.volume_profile:
            if point.time < self.start - .05 or point.time > self.end + .05 or point.time <= previous:
                raise ValueError("음량 변화 시각은 자막 구간 안에서 증가해야 합니다.")
            previous = point.time
        return self


class Document(StrictModel):
    schema_version: Literal["1.0"] = "1.0"
    video_id: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_-]{11}$")
    title: str = Field(default="온소리 자막", max_length=300)
    duration: float = Field(gt=0, le=86400)
    cues: list[Cue] = Field(default_factory=list, max_length=10000)
    warnings: list[str] = Field(default_factory=list, max_length=100)
    metadata: dict = Field(default_factory=dict)

    @model_validator(mode="after")
    def timeline(self):
        ids = set()
        for cue in self.cues:
            if cue.end > self.duration + .05:
                raise ValueError("자막이 영상 길이를 초과합니다.")
            if cue.id in ids:
                raise ValueError("중복 자막 ID가 있습니다.")
            ids.add(cue.id)
        self.cues.sort(key=lambda c: (c.start, c.end, c.id))
        return self


class ScreenFrame(StrictModel):
    video_id: str = Field(pattern=r"^[A-Za-z0-9_-]{11}$")
    time: float = Field(ge=0, le=86400)
    jpeg: str = Field(max_length=350000, pattern=r"^data:image/jpeg;base64,[A-Za-z0-9+/=]+$")


class AnalysisOptions(StrictModel):
    language: str = Field(default="ko", pattern=r"^(auto|[a-z]{2,3})$")
    whisper_model: Literal["tiny", "base", "small", "medium", "large-v3", "turbo"] = "base"
    event_detection: bool = True
    audio_captioning: bool = False
    video_id: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_-]{11}$")
    title: str = Field(default="내 영상", max_length=300)
    start_time: float = Field(default=0, ge=0, le=86400-1200)
    # Set false in the CLI when only sound analysis is desired.
    transcribe: bool = True
    use_caption_references: bool = True
    caption_references: list[CaptionReference] = Field(default_factory=list, max_length=2000)
    screen_frames: list[ScreenFrame] = Field(default_factory=list, max_length=241)

    @model_validator(mode="after")
    def reference_video(self):
        if self.caption_references and (not self.video_id or any(x.video_id != self.video_id for x in self.caption_references)):
            raise ValueError("참조 자막과 분석 영상 ID가 일치해야 합니다.")
        if self.screen_frames and (not self.video_id or any(x.video_id != self.video_id for x in self.screen_frames)):
            raise ValueError("화면 자막과 분석 영상 ID가 일치해야 합니다.")
        return self


class YoutubeOptions(AnalysisOptions):
    url: str = Field(max_length=1000)


def timestamp(seconds: float, sep=".") -> str:
    ms = max(0, round(seconds * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f"{h:02}:{m:02}:{s:02}{sep}{ms:03}"


def subtitle_text(document: Document, fmt: str) -> str:
    """Flatten overlapping lanes so conventional players do not lose dialogue."""
    points = sorted({t for c in document.cues for t in (round(c.start, 3), round(c.end, 3))})
    intervals = []
    for a, b in zip(points, points[1:]):
        active = [c for c in document.cues if c.start < b - .0001 and c.end > a + .0001]
        if not active or b <= a:
            continue
        active.sort(key=lambda c: (c.kind != "speech", c.start, c.id))
        # Strip markup meaning in subtitle formats; JSON retains exact text.
        text = "\n".join(c.text.replace("<", "‹").replace(">", "›").replace("\r", "").replace("\n\n", "\n") for c in active)
        if intervals and intervals[-1][2] == text and abs(intervals[-1][1] - a) < .001:
            intervals[-1] = (intervals[-1][0], b, text)
        else:
            intervals.append((a, b, text))
    out = ["WEBVTT\n"] if fmt == "vtt" else []
    sep = "." if fmt == "vtt" else ","
    for i, (a, b, text) in enumerate(intervals, 1):
        out.append(f"{i}\n{timestamp(a, sep)} --> {timestamp(b, sep)}\n{text}\n")
    return "\n".join(out) + "\n"
