"""Conservative source-backed ASR correction; no generated dialogue."""
from __future__ import annotations

from bisect import bisect_left, bisect_right
from dataclasses import dataclass
from difflib import SequenceMatcher
import re
import unicodedata

from .schema import CaptionReference, Document, SpeechCorrection


def reference_spacing(text, original):
    """Recover whitespace lost by OCR using aligned ASR boundaries, not rewrites."""
    a=re.sub(r'\s+','',original);b=re.sub(r'\s+','',text)
    spaces=set();index=0
    for char in original:
        if char.isspace():spaces.add(index)
        else:index+=1
    mapped=set();index=0
    for char in text:
        if char.isspace():mapped.add(index)
        else:index+=1
    for tag,i,j,k,l in SequenceMatcher(None,a,b,autojunk=False).get_opcodes():
        if tag=='equal' and j-i>=2:mapped.update(k+(p-i) for p in spaces if i<=p<=j)
    result=''.join((' ' if i in mapped and i else '')+c for i,c in enumerate(b))
    result=re.sub(r'\s+([,.!?])',r'\1',result)
    return re.sub(r'([,!?])(?=[가-힣A-Za-z])',r'\1 ',result)


def apply_screen_references(document, references):
    """Match complete subtitle spans to one or more adjacent ASR cues.

    OCR refs come only from repeated high-confidence video pixels. Never splice
    guessed text into a sentence or treat a partial caption as the whole speech.
    """
    import math
    refs=sorted([r for r in references if r.video_id==document.video_id and
        r.source=='youtube-screen-ocr' and 0<=r.start<r.end<=document.duration+.8 and
        r.end-r.start<=15 and 4<=len(normalized(r.text))<=500],key=lambda r:r.start)
    speech=sorted([c for c in document.cues if c.kind=='speech'],key=lambda c:c.start)
    candidates=[]
    for i,first in enumerate(speech):
        group=[]
        for last in speech[i:i+3]:
            if last.speech_correction or 'whisper' not in last.source:break
            if group and last.start-group[-1].end>1.2:break
            group.append(last)
            original=' '.join(c.text for c in group)
            if last.end-first.start>15:break
            nearby=[r for r in refs if r.end>=first.start and r.start<=last.end]
            for j,ref in enumerate(nearby):
                parts=[]
                for tail in nearby[j:j+4]:
                    if parts and (tail.start-parts[-1].end>1.2 or tail.start<parts[-1].end-.3):break
                    parts.append(tail)
                    if abs(ref.start-first.start)>3.5 or abs(tail.end-last.end)>1.5:continue
                    overlap=max(0,min(tail.end,last.end)-max(ref.start,first.start))
                    if overlap/(last.end-first.start)<.3 or overlap/(tail.end-ref.start)<.6:continue
                    text=' '.join(r.text for r in parts)
                    a,b=normalized(original),normalized(text)
                    if min(len(a),len(b))/max(len(a),len(b),1)<.75:continue
                    # Do not drop an unobserved sentence at either edge.
                    if SequenceMatcher(None,a[:3],b[:3]).ratio()<.66 or SequenceMatcher(None,a[-3:],b[-3:]).ratio()<.66:continue
                    score=SequenceMatcher(None,a,b,autojunk=False).ratio()
                    phonetic=SequenceMatcher(None,unicodedata.normalize('NFD',a),unicodedata.normalize('NFD',b),autojunk=False).ratio()
                    if score>=.68 and phonetic>=.80 and not any(x in text for x in ('[',']','♪')):
                        candidates.append((score,len(a),list(group),text,ref,tail))
    used=set();replacements=[];count=0
    for score,_,group,text,ref,tail in sorted(candidates,key=lambda x:(x[0],x[1]),reverse=True):
        if any(c.id in used for c in group):continue
        original=' '.join(c.text for c in group)
        text=reference_spacing(text,original)
        if text==original and len(group)==1:continue
        used.update(c.id for c in group)
        cue=group[0].model_copy(deep=True)
        cue.end=group[-1].end
        cue.text=text
        cue.words=[]
        cue.volume_profile=sorted([p for c in group for p in c.volume_profile],key=lambda p:p.time)
        cue.volume_profile=list({p.time:p for p in cue.volume_profile}.values())
        # RMS energy average, one stable size for the entire merged sentence.
        weight=sum(c.end-c.start for c in group)
        cue.scale=sum(c.scale*(c.end-c.start) for c in group)/weight
        if all(c.dbfs is not None for c in group):
            cue.dbfs=10*math.log10(sum(10**(c.dbfs/10)*(c.end-c.start) for c in group)/weight)
            reference=document.metadata.get('reference_dbfs')
            if isinstance(reference,(int,float)):
                cue.relative_db=max(-120,min(120,cue.dbfs-reference))
                cue.scale=max(.75,min(1.55,1+cue.relative_db/40))
        cue.speech_correction=SpeechCorrection(original_text=original,
            original_source=group[0].source,corrected_text=text,
            reference_source=ref.source,reference_video_id=ref.video_id,
            reference_start=ref.start,reference_end=tail.end,similarity=score,
            original_words=[w for c in group for w in c.words])
        cue.source+='+'+ref.source
        cue.review_required=True
        replacements.append(cue);count+=1
    document.cues=sorted([c for c in document.cues if c.id not in used]+replacements,key=lambda c:(c.start,c.end,c.id))
    document.metadata['screen_correction']={'available':len(refs),'corrected':count,
        'method':'repeated OCR at confidence >= 0.94; timed lexical agreement; exact source text'}
    return document


@dataclass(frozen=True)
class Reference:
    video_id: str
    start: float
    end: float
    text: str
    source: str


def fetch_human_references(video_id: str, language: str, start: float = 0,
                           end: float = 86400) -> list[Reference]:
    """Only original, human-created captions in the requested language.

    Network failures are handled by the job caller; generated captions and
    translated/unrelated language tracks are deliberately not a fallback.
    """
    import requests
    from youtube_transcript_api import YouTubeTranscriptApi

    class TimedSession(requests.Session):
        def request(self, method, url, **kwargs):
            kwargs.setdefault("timeout", 8)
            return super().request(method, url, **kwargs)

    languages = [language] if language != "auto" else ["ko", "en"]
    with TimedSession() as session:
        track = YouTubeTranscriptApi(http_client=session).list(video_id).find_manually_created_transcript(languages)
        if track.is_generated or track.language_code not in languages:
            return []
        result = []
        for item in track.fetch():
            if item.start + item.duration < start or item.start > end:
                continue
            try:
                checked = CaptionReference(video_id=video_id, start=item.start,
                                           end=item.start + item.duration, text=" ".join(item.text.split()))
            except ValueError:
                continue
            result.append(Reference(video_id, checked.start, checked.end, checked.text, "youtube-human-caption"))
            if len(result) >= 2000:
                break
        return result


def native_references(items: list[CaptionReference]) -> list[Reference]:
    return [Reference(x.video_id, x.start, x.end, " ".join(x.text.split()), x.source) for x in items]


def normalized(text: str) -> str:
    return re.sub(r"[^\w]", "", unicodedata.normalize("NFKC", text), flags=re.UNICODE).lower().replace("_", "")


def apply_speech_references(document: Document, references: list[Reference]) -> Document:
    """Replace only closely aligned, recognizably matching ASR with exact source text.

    Times and acoustic volume profiles remain unchanged. Original words are
    preserved as provenance and cleared from the corrected cue: they no longer
    describe the displayed text and cannot legitimately drive word highlighting.
    """
    refs = sorted((r for r in references[:4000] if r.video_id == document.video_id
                   and r.source in ("youtube-human-caption", "youtube-native-caption")
                   and 0 <= r.start < r.end <= 86400 and r.end-r.start <= 15
                   and 0 < len(r.text.strip()) <= 500), key=lambda r: (r.start, r.end))
    starts = [r.start for r in refs]
    corrected = 0
    for cue in document.cues:
        if cue.kind != "speech" or "whisper" not in cue.source.lower() or cue.speech_correction:
            continue
        original = normalized(cue.text)
        if len(original) < 4:
            continue
        nearby = refs[bisect_left(starts, cue.start-.8):bisect_right(starts, cue.end)]
        candidates = []
        for source in ("youtube-human-caption", "youtube-native-caption"):
            local = [r for r in nearby if r.source == source]
            for i, first in enumerate(local):
                parts = []
                for last in local[i:i+4]:
                    if parts and last.start > parts[-1].end + .7:
                        break
                    parts.append(last)
                    if abs(first.start-cue.start) > .8 or abs(last.end-cue.end) > .8:
                        continue
                    overlap = max(0, min(cue.end, last.end)-max(cue.start, first.start))
                    if overlap / (cue.end-cue.start) < .75 or overlap / (last.end-first.start) < .75:
                        continue
                    # Never join rolling/overlapping caption observations twice.
                    if any(b.start < a.end-.15 for a,b in zip(parts, parts[1:])):
                        continue
                    text = " ".join(r.text.strip() for r in parts)
                    target = normalized(text)
                    if not target or min(len(target),len(original))/max(len(target),len(original)) < .6:
                        continue
                    if "[" in text or "]" in text or "♪" in text:
                        continue
                    similarity = SequenceMatcher(None, original, target, autojunk=False).ratio()
                    threshold = .64 if source == "youtube-human-caption" else .84
                    if similarity >= threshold:
                        candidates.append((source == "youtube-human-caption", similarity, text, first, last))
        if not candidates:
            continue
        _, similarity, text, first, last = max(candidates, key=lambda x: (x[0], x[1]))
        if cue.text == text:
            continue
        cue.speech_correction = SpeechCorrection(
            original_text=cue.text, original_source=cue.source, corrected_text=text,
            reference_source=first.source, reference_video_id=first.video_id,
            reference_start=first.start, reference_end=last.end,
            similarity=round(similarity, 4), original_words=list(cue.words))
        cue.text = text
        cue.words = []
        cue.source = cue.source + "+" + first.source
        cue.review_required = True
        corrected += 1
    document.metadata["speech_reference"] = {
        "available": len(refs), "corrected": corrected,
        "method": "timestamp and lexical agreement; exact caption text; no grammar generation or OCR",
        "native_caption_trust": "observed page captions; human authorship unverified",
    }
    return document
