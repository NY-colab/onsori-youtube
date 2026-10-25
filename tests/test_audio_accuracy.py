import threading
from types import SimpleNamespace

import numpy as np
import pytest
import soundfile as sf

from server import pipeline
from server.audio import SAMPLE_RATE
from server.lexicon import describe
from server.schema import AnalysisOptions, Cue


def speech(words):
    return {"start": 0, "end": words[-1]["end"], "text": "".join(w["text"] for w in words).strip(),
            "kind": "speech", "source": "faster-whisper/base", "words": words, "confidence": .9}


@pytest.mark.parametrize("texts", [
    [" Hello", " everyone,", " this", " sentence", " takes", " more", " than", " seven", " seconds."],
    [" 안녕하세요.", " 오늘은", " 영상 속 대사와", " 효과음을", " 읽기 쉬운 한글 자막으로", " 만드는 도구의", " 단어별 시각과", " 자막 분할을", " 확인합니다."],
])
def test_long_speech_splits_only_at_real_word_times(texts):
    words = [{"start": i * .9 + .1, "end": i * .9 + .8, "text": text} for i, text in enumerate(texts)]
    cue = speech(words)
    chunks = pipeline.split_speech_cue(cue)
    assert len(chunks) >= 2
    assert [w for c in chunks for w in c["words"]] == words
    assert "".join(c["text"].replace(" ", "") for c in chunks) == cue["text"].replace(" ", "")
    for i, chunk in enumerate(chunks):
        assert chunk["end"] - chunk["start"] <= 5
        assert len(chunk["text"]) <= 50
        assert chunk["start"] == chunk["words"][0]["start"]
        assert chunk["end"] == chunk["words"][-1]["end"]
        Cue(id=f"part-{i}", **chunk)


def test_character_limit_preserves_korean_subword_spacing():
    words = [{"start": i * .1, "end": i * .1 + .09, "text": "가나다라마바" if i % 2 else " 사아자차카타"}
             for i in range(10)]
    chunks = pipeline.split_speech_cue(speech(words))
    assert len(chunks) == 2
    assert all(len(c["text"]) <= 50 for c in chunks)
    assert chunks[0]["text"] == "".join(w["text"] for w in chunks[0]["words"]).strip()


@pytest.mark.parametrize("words", [[], [{"start": 0, "end": 8, "text": " missing words"}],
    [{"start": 3, "end": 4, "text": " complete"}, {"start": 1, "end": 8, "text": " text"}]])
def test_missing_or_invalid_alignment_does_not_invent_times_or_drop_text(words):
    cue = {"start": 0, "end": 8, "text": "complete text", "words": words}
    assert pipeline.split_speech_cue(cue) == [cue]


def test_single_long_word_is_not_given_fabricated_boundaries():
    cue = speech([{"start": 0, "end": 8, "text": "한단어"}])
    assert pipeline.split_speech_cue(cue) == [cue]


def test_split_word_times_receive_recorded_video_offset_once(monkeypatch, tmp_path):
    words = [{"start": i + .1, "end": i + .8, "text": f" word{i}"} for i in range(8)]
    chunks = pipeline.split_speech_cue(speech(words))
    monkeypatch.setattr(pipeline, "transcribe", lambda *a: (chunks, "en"))
    source = tmp_path / "speech.wav"
    sf.write(source, np.full(SAMPLE_RATE * 8, .05), SAMPLE_RATE)
    result = pipeline.analyze(source, AnalysisOptions(start_time=17, event_detection=False),
                              tmp_path, lambda *_: None, threading.Event())
    assert len(result.cues) == 2
    assert result.cues[0].start == 17.1
    assert result.cues[1].start == 22.1
    assert [w.start for c in result.cues for w in c.words] == pytest.approx([17.1 + i for i in range(8)])


def test_silence_never_becomes_an_effect_after_vocabulary_addition(monkeypatch):
    class NeverClassify:
        def __call__(self, *args, **kwargs):
            pytest.fail("Silent audio should be skipped before model inference")
    monkeypatch.setattr(pipeline, "load_ast", lambda _: (NeverClassify(), None))
    assert pipeline.detect_events(np.zeros(SAMPLE_RATE * 2, dtype=np.float32),
                                  lambda *_: None, threading.Event()) == []


@pytest.mark.parametrize("label,score,expected", [
    ("Throat clearing", .73, "Throat clearing"), ("Sneeze", .052, None),
    ("Knock", .95, "Knock"), ("Speech", .99, None),
])
def test_event_mapping_preserves_model_label_and_confidence_threshold(monkeypatch, label, score, expected):
    import torch
    model = SimpleNamespace(config=SimpleNamespace(id2label={0: label}))
    class FakeModel:
        config = model.config
        def __call__(self, **_):
            return SimpleNamespace(logits=torch.logit(torch.tensor([[score]])))
    monkeypatch.setattr(pipeline, "load_ast", lambda _: (lambda *a, **kw: {}, FakeModel()))
    events = pipeline.detect_events(np.full(SAMPLE_RATE, .1, dtype=np.float32), lambda *_: None, threading.Event())
    assert [e["label"] for e in events] == ([expected] if expected else [])
    if expected == "Throat clearing":
        assert "목을 가다듬는 소리" in describe(expected)
        assert "재채기" not in describe(expected)
