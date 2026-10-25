import json
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from server.schema import AnalysisOptions, CaptionReference, Cue, Document, Word
from server.speech_reference import Reference, apply_speech_references, fetch_human_references

VIDEO = "jNQXAC9IVRw"
OTHER = "abcdefghijk"

@pytest.fixture(autouse=True)
def isolate_ocr(monkeypatch):
    import server.app as backend
    monkeypatch.setattr(backend,"correct_from_screen",lambda doc,*args:doc)



def document(text="오늘은 소리가 글자가 됨니다", start=10, end=13):
    return Document(video_id=VIDEO, duration=20, cues=[Cue(
        id="speech", start=start, end=end, kind="speech", text=text,
        source="faster-whisper/base", words=[Word(start=start, end=end, text=text)])])


def reference(text="오늘은 소리가 글자가 됩니다", start=10, end=13,
              source="youtube-human-caption", video_id=VIDEO):
    return Reference(video_id, start, end, text, source)


def test_corrects_from_exact_human_caption_and_preserves_provenance():
    doc = document()
    original = doc.cues[0].model_dump()
    result = apply_speech_references(doc, [reference()])
    cue = result.cues[0]
    assert cue.text == "오늘은 소리가 글자가 됩니다"
    assert (cue.start, cue.end) == (10, 13)
    assert cue.words == []
    assert cue.speech_correction.original_text == original["text"]
    assert cue.speech_correction.original_words[0].text == original["text"]
    assert cue.review_required
    assert result.metadata["speech_reference"]["corrected"] == 1
    Document.model_validate_json(result.model_dump_json())


@pytest.mark.parametrize("ref", [reference(video_id=OTHER), reference(start=0,end=3),
    reference(text="지금 구독하고 좋아요를 눌러 주세요"), reference(start=10,end=20),
    reference(source="ocr"), reference(text="[음악이 흐른다]")])
def test_rejects_unrelated_video_time_text_and_untrusted_ocr(ref):
    doc = document()
    before = doc.cues[0].model_dump()
    apply_speech_references(doc, [ref])
    assert doc.cues[0].model_dump() == before


def test_prefers_human_caption_to_similar_native_observation():
    doc = document()
    apply_speech_references(doc, [reference("오늘은 소리가 글자가 됨니다!", source="youtube-native-caption"), reference()])
    assert doc.cues[0].speech_correction.reference_source == "youtube-human-caption"


def test_short_unreliable_asr_is_not_automatically_rewritten():
    doc = document("네")
    apply_speech_references(doc, [reference("예")])
    assert doc.cues[0].text == "네"


def test_joins_adjacent_source_captions_but_does_not_duplicate_rolling_text():
    doc = document()
    apply_speech_references(doc, [reference("오늘은 소리가",end=11.5), reference("글자가 됩니다",start=11.5)])
    assert doc.cues[0].text == "오늘은 소리가 글자가 됩니다"
    rolling = document()
    apply_speech_references(rolling, [reference("오늘은 소리가",end=12), reference("소리가 글자가 됩니다",start=11)])
    assert rolling.cues[0].speech_correction is None


def test_sound_cues_and_source_transcripts_are_not_rewritten():
    for kind, source in [("sound","faster-whisper/base"), ("speech","youtube-transcript-api")]:
        doc = document()
        doc.cues[0].kind, doc.cues[0].source = kind, source
        apply_speech_references(doc, [reference()])
        assert doc.cues[0].speech_correction is None


def test_caption_option_validation_is_bounded_and_same_video():
    item = dict(video_id=VIDEO, start=10, end=13, text="원본 자막")
    assert AnalysisOptions(video_id=VIDEO,caption_references=[item]).caption_references
    for change in [dict(video_id=OTHER), dict(end=30), dict(text="x"*501), dict(start=float("nan")), dict(source="ocr")]:
        with pytest.raises(ValidationError):
            AnalysisOptions(video_id=VIDEO,caption_references=[{**item,**change}])
    with pytest.raises(ValidationError):
        AnalysisOptions(caption_references=[item])
    with pytest.raises(ValidationError):
        AnalysisOptions(video_id=VIDEO,caption_references=[item]*2001)


def test_fetch_selects_human_requested_language_and_limits_to_window(monkeypatch):
    import youtube_transcript_api
    requested = []
    class Track:
        is_generated = False
        language_code = "ko"
        def fetch(self):
            return [SimpleNamespace(start=1,duration=2,text="범위 밖"),
                    SimpleNamespace(start=10,duration=3,text="오늘은 소리가 글자가 됩니다"),
                    SimpleNamespace(start=15,duration=40,text="지나치게 긴 항목")]
    class Tracks:
        def find_manually_created_transcript(self,languages):
            requested.extend(languages)
            return Track()
    class Api:
        def __init__(self,**kwargs): pass
        def list(self,video_id):
            assert video_id == VIDEO
            return Tracks()
    monkeypatch.setattr(youtube_transcript_api,"YouTubeTranscriptApi",Api)
    refs = fetch_human_references(VIDEO,"ko",10,20)
    assert requested == ["ko"]
    assert len(refs) == 1 and refs[0].source == "youtube-human-caption"


def test_upload_execute_applies_sources_before_persisting(monkeypatch,tmp_path):
    import server.app as backend
    job = backend.Job()
    folder = tmp_path/job.id
    folder.mkdir()
    monkeypatch.setattr(backend,"DATA",tmp_path)
    monkeypatch.setattr(backend.pipeline,"analyze",lambda *args: document())
    monkeypatch.setattr(backend,"fetch_human_references",lambda *args: [reference()])
    backend.execute(job,AnalysisOptions(video_id=VIDEO,start_time=10),path=tmp_path/"source.wav")
    saved = json.loads((folder/"result.json").read_text(encoding="utf-8"))
    assert job.status == "done"
    assert saved["cues"][0]["text"] == "오늘은 소리가 글자가 됩니다"
    assert saved["cues"][0]["speech_correction"]["original_text"].endswith("됨니다")


def test_fetch_failure_retains_original_asr(monkeypatch,tmp_path):
    import server.app as backend
    job = backend.Job()
    (tmp_path/job.id).mkdir()
    monkeypatch.setattr(backend,"DATA",tmp_path)
    monkeypatch.setattr(backend.pipeline,"analyze",lambda *args: document())
    def fail(*args): raise RuntimeError("unavailable")
    monkeypatch.setattr(backend,"fetch_human_references",fail)
    backend.execute(job,AnalysisOptions(video_id=VIDEO),path=tmp_path/"source.wav")
    assert job.status == "done"
    assert job.result["cues"][0]["speech_correction"] is None
    assert "됨니다" in job.result["cues"][0]["text"]
    assert any("원본 제작 자막" in w for w in job.result["warnings"])


def test_source_reference_opt_out_keeps_asr_and_skips_network(monkeypatch,tmp_path):
    import server.app as backend
    job = backend.Job()
    (tmp_path/job.id).mkdir()
    monkeypatch.setattr(backend,"DATA",tmp_path)
    monkeypatch.setattr(backend.pipeline,"analyze",lambda *args: document())
    def unexpected(*args): pytest.fail("opted out of caption fetching")
    monkeypatch.setattr(backend,"fetch_human_references",unexpected)
    backend.execute(job,AnalysisOptions(video_id=VIDEO,use_caption_references=False),path=tmp_path/"source.wav")
    assert job.status == "done"
    assert job.result["cues"][0]["speech_correction"] is None
