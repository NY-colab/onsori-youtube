import threading
from types import SimpleNamespace

import numpy as np
import pytest
import soundfile as sf

from server import pipeline
from server.audio import SAMPLE_RATE, reference_level, volume_profile
from server.music import select_tags, describe_music, rhythm_features
from server.schema import AnalysisOptions, Cue


def test_specific_music_survives_generic_parent_and_deduplicates_family():
    features = select_tags({"Music": .99, "Musical instrument": .96, "Trumpet": .85,
                            "Brass instrument": .9, "Wind instrument, woodwind instrument": .7, "Jazz": .4})
    assert [tag["label"] for tag in features["instruments"]] == ["Trumpet"]
    text = describe_music(features)
    assert "트럼펫 연주" in text and "재즈풍" in text
    assert "금관악기" not in text and "음악이 흐른다" not in text


def test_music_does_not_guess_low_confidence_or_conflicting_mood():
    features = select_tags({"Piano": .19, "Jazz": .1, "Happy music": .50, "Sad music": .48})
    assert features["mood"] is None and features["genre"] is None
    assert describe_music(features) == "♪ 배경 음악이 이어짐"


def test_weak_subtype_does_not_replace_stronger_piano():
    features = select_tags({"Music": .77, "Piano": .43, "Electric piano": .287, "Keyboard (musical)": .384})
    assert [tag["label"] for tag in features["instruments"]] == ["Piano"]


def test_music_margin_considers_runner_up_below_threshold():
    features = select_tags({"Happy music": .31, "Sad music": .29, "Pop music": .29, "Jazz": .27})
    assert features["mood"] is None and features["genre"] is None


def test_music_can_express_instrument_mood_genre_and_voice():
    features = select_tags({"Piano": .86, "Happy music": .65, "Pop music": .73, "Singing": .75})
    text = describe_music(features)
    assert all(term in text for term in ("피아노", "밝고 경쾌한", "팝풍", "노랫소리"))
    assert "미확인" not in text


def test_music_detection_keeps_detailed_evidence_when_music_wins(monkeypatch):
    import torch
    class FakeModel:
        config = SimpleNamespace(id2label={0:"Music", 1:"Piano", 2:"Happy music", 3:"Speech"})
        def __call__(self, **_):
            return SimpleNamespace(logits=torch.logit(torch.tensor([[.99, .8, .6, .01]])))
    monkeypatch.setattr(pipeline, "load_ast", lambda _: (lambda *a, **kw: {}, FakeModel()))
    events = pipeline.detect_events(np.full(SAMPLE_RATE, .1, dtype=np.float32), lambda *_:None, threading.Event())
    assert len(events) == 1
    assert events[0]["music_features"]["instruments"][0]["label"] == "Piano"


def test_profile_captures_accent_within_one_cue_and_recovers_smoothly():
    audio = np.full(SAMPLE_RATE*4, .015, dtype=np.float32)
    audio[2*SAMPLE_RATE:int(2.2*SAMPLE_RATE)] = .30
    profile = volume_profile(audio, 0, 4, reference_level(audio))
    at = lambda t: min(profile, key=lambda p: abs(p["time"]-t))["scale"]
    assert at(2.1) > at(1) + .4
    assert at(2.2) > at(2.4) > at(3.5)
    assert max(p["scale"] for p in profile) <= 1.55
    assert profile[0]["time"] == 0 and profile[-1]["time"] == 4


def test_silence_never_grows_and_profiles_stay_in_trim_bounds():
    profile = volume_profile(np.zeros(SAMPLE_RATE), .1234, .9786, -60)
    assert all(p["scale"] == .75 for p in profile)
    assert profile[0]["time"] == .123 and profile[-1]["time"] == .979
    Cue(id="a", start=.1234, end=.9786, text="silent", kind="sound", volume_profile=profile)


@pytest.mark.parametrize("profile", [
    [{"time":0, "scale":1, "dbfs":-20}, {"time":0, "scale":1, "dbfs":-20}],
    [{"time":2, "scale":1, "dbfs":-20}],
    [{"time":0, "scale":float("nan"), "dbfs":-20}],
    [{"time":0, "scale":2, "dbfs":-20}],
])
def test_schema_rejects_invalid_profiles(profile):
    with pytest.raises(ValueError):
        Cue(id="a", start=0, end=1, text="hello", kind="speech", volume_profile=profile)


def test_analyze_offsets_dynamics_once_and_retains_music_evidence(monkeypatch, tmp_path):
    features = select_tags({"Trumpet":.85, "Music":.9})
    monkeypatch.setattr(pipeline, "detect_events", lambda *a:[{"label":"Music", "kind":"music", "start":0, "end":1, "music_features":features}])
    path = tmp_path / "music.wav"
    sf.write(path, np.full(SAMPLE_RATE, .1), SAMPLE_RATE)
    doc = pipeline.analyze(path, AnalysisOptions(start_time=17, transcribe=False), tmp_path, lambda *_:None, threading.Event())
    cue = doc.cues[0]
    assert cue.volume_profile[0].time == 17 and cue.volume_profile[-1].time == 18
    assert "트럼펫" in cue.text
    assert doc.metadata["music_analysis"][cue.id]["instruments"][0]["label"] == "Trumpet"


def test_steady_tone_and_silence_are_not_called_regular_rhythm():
    t = np.arange(SAMPLE_RATE*6)/SAMPLE_RATE
    assert not rhythm_features(np.zeros_like(t, dtype=np.float32))
    assert not rhythm_features((.1*np.sin(2*np.pi*440*t)).astype(np.float32))


def test_repeated_percussive_onsets_support_rhythm():
    audio = np.zeros(SAMPLE_RATE*8, dtype=np.float32)
    rng = np.random.default_rng(7)
    for start in np.arange(.2, 7.8, .5):
        burst = rng.normal(size=800) * .2 * np.exp(-np.arange(800)/120)
        i = int(start*SAMPLE_RATE)
        audio[i:i+800] = burst
    result = rhythm_features(audio)
    assert result["description"] == "규칙적인 박자가 이어짐"
    assert 115 < result["estimated_bpm"] < 125
def test_generated_music_detail_rejects_unrelated_sources():
    from server.music import music_caption_detail
    for text in ["a man is speaking while a printer is printing",
                 "a person is walking on a hard surface while a dog barks in the background"]:
        assert music_caption_detail({"text": text}) == ("", "not_music_description")
    detail, reason = music_caption_detail({"text": "an electric guitar is playing a song in the background", "text_ko": "배경에서 일렉트릭 기타가 연주됨"})
    assert detail == "AI 추정: 배경에서 일렉트릭 기타가 연주됨"
    assert reason is None

