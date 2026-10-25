"""Evidence-based music captions: AST/AudioSet tags + librosa onset/beat analysis.

Model scores are heuristic gates, not calibrated probabilities. Do not infer
song identity, artist, mood from volume, or an instrument from a genre alone.
"""
from __future__ import annotations

import numpy as np
import re
from .audio import SAMPLE_RATE, dbfs

INSTRUMENTS = {
    "Acoustic guitar": "어쿠스틱 기타", "Electric guitar": "일렉트릭 기타",
    "Bass guitar": "베이스 기타", "Guitar": "기타", "Ukulele": "우쿨렐레",
    "Banjo": "밴조", "Mandolin": "만돌린", "Sitar": "시타르",
    "Piano": "피아노", "Electric piano": "전자 피아노", "Organ": "오르간",
    "Synthesizer": "신시사이저", "Harpsichord": "하프시코드",
    "Drum kit": "드럼", "Drum machine": "전자 드럼", "Drum": "북",
    "Snare drum": "스네어 드럼", "Bass drum": "베이스 드럼", "Timpani": "팀파니",
    "Cymbal": "심벌", "Hi-hat": "하이햇", "Tambourine": "탬버린",
    "Marimba, xylophone": "마림바·실로폰 계열", "Vibraphone": "비브라폰",
    "Trumpet": "트럼펫", "Trombone": "트롬본", "French horn": "호른",
    "Violin, fiddle": "바이올린", "Cello": "첼로", "Double bass": "콘트라베이스",
    "String section": "현악 합주", "Orchestra": "관현악",
    "Flute": "플루트", "Saxophone": "색소폰", "Clarinet": "클라리넷",
    "Harp": "하프", "Harmonica": "하모니카", "Accordion": "아코디언",
    "Bagpipes": "백파이프", "Brass instrument": "금관악기",
    "Wind instrument, woodwind instrument": "관악기", "Bowed string instrument": "현악기",
    "Plucked string instrument": "뜯는 현악기", "Keyboard (musical)": "건반악기",
    "Percussion": "타악기",
}
GENRES = {
    "Pop music": "팝", "Hip hop music": "힙합", "Rock music": "록", "Heavy metal": "헤비메탈",
    "Punk rock": "펑크 록", "Rhythm and blues": "R&B", "Soul music": "소울",
    "Reggae": "레게", "Country": "컨트리", "Swing music": "스윙", "Funk": "펑크",
    "Folk music": "포크", "Jazz": "재즈", "Disco": "디스코", "Classical music": "클래식",
    "Opera": "오페라", "Electronic music": "전자음악", "House music": "하우스",
    "Techno": "테크노", "Dubstep": "덥스텝", "Drum and bass": "드럼 앤 베이스",
    "Electronic dance music": "전자 댄스 음악", "Ambient music": "앰비언트",
    "Blues": "블루스", "Flamenco": "플라멩코", "Traditional music": "전통음악",
    "Lullaby": "자장가", "New-age music": "뉴에이지",
}
MOODS = {"Happy music": "밝고 경쾌한", "Funny music": "익살스러운",
         "Sad music": "슬픈 분위기의", "Tender music": "부드럽고 다정한",
         "Exciting music": "고조되는 분위기의", "Angry music": "격한 분위기의",
         "Scary music": "긴장감을 주는"}
VOCALS = {"Singing": "노랫소리", "Choir": "합창", "Rapping": "랩",
          "Humming": "허밍", "A capella": "아카펠라", "Vocal music": "보컬"}
MUSIC_LABELS = set(INSTRUMENTS) | set(GENRES) | set(MOODS) | set(VOCALS) | {"Music", "Musical instrument", "Background music", "Song"}


def music_caption_detail(caption: dict) -> tuple[str, str | None]:
    """Keep generated music descriptions separate from measured music tags.

    CoNeTTE describes the dominant source and may ignore the music entirely.
    Such sentences do not belong to a music cue. Retain raw output in metadata.
    This relevance check cannot establish that the remaining description is true.
    """
    english = str(caption.get("text", ""))
    terms = ["music", "musical", "song", "melody", "singing", "rhythm", "beat",
             "instrument"] + [label.lower() for label in INSTRUMENTS]
    if not any(re.search(r"\b" + re.escape(term) + r"\b", english, re.I) for term in terms):
        return "", "not_music_description"
    description = str(caption.get("text_ko") or english).strip()
    return ("AI 추정: " + description if description else ""), None
# Remove parent descriptions when their more specific child is supported.
FAMILIES = {
    "Guitar": {"Acoustic guitar", "Electric guitar", "Bass guitar"},
    "Piano": {"Electric piano"},
    "Keyboard (musical)": {"Piano", "Electric piano", "Organ", "Synthesizer", "Harpsichord"},
    "Brass instrument": {"Trumpet", "Trombone", "French horn"},
    "Wind instrument, woodwind instrument": {"Brass instrument", "Trumpet", "Trombone", "French horn", "Flute", "Saxophone", "Clarinet"},
    "Bowed string instrument": {"Violin, fiddle", "Cello", "Double bass", "String section"},
    "Plucked string instrument": {"Guitar", "Acoustic guitar", "Electric guitar", "Bass guitar", "Harp", "Ukulele", "Banjo", "Mandolin", "Sitar"},
    "Percussion": {"Drum kit", "Drum", "Drum machine", "Snare drum", "Bass drum", "Timpani", "Cymbal", "Hi-hat", "Tambourine", "Marimba, xylophone", "Vibraphone"},
    "Drum": {"Drum kit", "Drum machine", "Snare drum", "Bass drum"},
}


def music_score(scores: dict[str, float]) -> float:
    return max((scores.get(label, 0) for label in MUSIC_LABELS), default=0)


def select_tags(scores: dict[str, float]) -> dict:
    def ranked(vocabulary, threshold):
        return [{"label": label, "text": text, "score": round(float(scores.get(label, 0)), 4)}
                for label, text in vocabulary.items() if scores.get(label, 0) >= threshold]
    instruments = ranked(INSTRUMENTS, .20)
    labels = {v["label"] for v in instruments}
    rejected = set()
    for parent, children in FAMILIES.items():
        if parent not in labels:
            continue
        present = children & labels
        # A weak subtype must not replace a much stronger parent (e.g. a
        # piano must not become an electric piano merely because it scored .2).
        supported = {child for child in present if scores[child] >= max(.30, scores[parent]*.75)}
        if supported:
            rejected.add(parent)
        rejected.update(present - supported)
    instruments = [v for v in instruments if v["label"] not in rejected]
    instruments.sort(key=lambda v: v["score"], reverse=True)
    def confident_one(vocabulary, threshold, margin):
        candidates = sorted(ranked(vocabulary, 0), key=lambda v: v["score"], reverse=True)
        if not candidates or candidates[0]["score"] < threshold or (len(candidates) > 1 and candidates[0]["score"] - candidates[1]["score"] < margin):
            return None
        return candidates[0]
    return {"instruments": instruments[:2], "genre": confident_one(GENRES, .28, .08),
            "mood": confident_one(MOODS, .30, .10), "vocal": confident_one(VOCALS, .30, .08),
            "source": "AST/AudioSet (scores are not calibrated probabilities)"}


def rhythm_features(audio: np.ndarray) -> dict:
    """Report rhythm only when several strong onsets support the tracked beats.

    Beat trackers impose regularity; checking beat spacing alone would create
    confident but imaginary rhythms in drones and speech.
    """
    if len(audio) < 4 * SAMPLE_RATE or dbfs(audio) < -60:
        return {}
    import librosa
    hop = 256
    onset = librosa.onset.onset_strength(y=audio, sr=SAMPLE_RATE, hop_length=hop)
    if len(onset) < 8 or float(np.max(onset)) < .1:
        return {}
    tempo, beats = librosa.beat.beat_track(onset_envelope=onset, sr=SAMPLE_RATE, hop_length=hop, trim=True)
    if len(beats) < 5:
        return {}
    threshold = max(float(np.percentile(onset, 75)), float(np.max(onset)) * .18)
    supported = sum(float(np.max(onset[max(0, int(b)-2):int(b)+3])) >= threshold for b in beats) / len(beats)
    beat_times = librosa.frames_to_time(beats, sr=SAMPLE_RATE, hop_length=hop)
    intervals = np.diff(beat_times)
    coverage = float((beat_times[-1]-beat_times[0])/(len(audio)/SAMPLE_RATE))
    bpm = float(np.asarray(tempo).reshape(-1)[0])
    if supported < .8 or coverage < .5 or np.std(intervals)/np.mean(intervals) > .12 or not 45 <= bpm <= 220:
        return {}
    return {"description": "규칙적인 박자가 이어짐", "estimated_bpm": round(bpm, 1),
            "onset_support": round(supported, 3), "source": "librosa 0.11.0"}


def describe_music(features: dict, relative_db=0) -> str:
    instruments = "·".join(tag["text"] for tag in features.get("instruments", []))
    genre = features.get("genre")
    mood = features.get("mood")
    parts = []
    if mood:
        parts.append(mood["text"] + " 음악")
    if instruments:
        parts.append(instruments + " 연주")
    if genre:
        parts.append(genre["text"] + "풍")
    if features.get("vocal"):
        parts.append(features["vocal"]["text"] + " 함께 들림")
    if features.get("rhythm"):
        parts.append(features["rhythm"]["description"])
    if not parts:
        # Keep uncertainty in analysis metadata, not in the viewing caption.
        # A generic description is preferable to inventing an instrument or mood.
        parts.append("배경 음악이 이어짐")
    intensity = "크게 들리는 " if relative_db >= 8 else "작게 들리는 " if relative_db <= -8 else ""
    return "♪ " + intensity + " · ".join(parts)
