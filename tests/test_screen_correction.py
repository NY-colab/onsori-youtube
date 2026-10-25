import pytest
from pydantic import ValidationError
from server.schema import AnalysisOptions, Cue, Document
from server.speech_reference import Reference, apply_screen_references
from server.screen_ocr import stable_references

VIDEO='-wbEQJ_ZXyk'
def cue(id,text,start,end):
    return Cue(id=id,text=text,start=start,end=end,kind='speech',source='faster-whisper/base',scale=1.1)
def ref(text,start,end,video=VIDEO):return Reference(video,start,end,text,'youtube-screen-ocr')

def test_repeated_pixels_required_and_low_confidence_never_promoted():
    rows=[(6,'이것은 옷이오, 이불이오?',.99),(6.25,'이것은 옷이오, 이불이오?',.98),
          (9,'입는 웃이에요.',.5),(9.25,'입는 웃이에요.',.9),(11,'한 번 걸쳐보세요.',.99)]
    refs=stable_references(rows,VIDEO)
    assert len(refs)==1 and refs[0]['text']=='이것은 옷이오, 이불이오?'

def test_complete_screen_sentence_merges_asr_split_and_preserves_original():
    doc=Document(video_id=VIDEO,duration=60,cues=[cue('a','이것은 오시오',2.687,7.167),cue('b','이불이요?',7.167,8.067)])
    apply_screen_references(doc,[ref('이것은 옷이오, 이불이오?',6.16,8.16)])
    assert len(doc.cues)==1
    assert doc.cues[0].text=='이것은 옷이오, 이불이오?'
    assert doc.cues[0].speech_correction.original_text=='이것은 오시오 이불이요?'
    assert doc.cues[0].scale==pytest.approx(1.1)
    Document.model_validate_json(doc.model_dump_json())

def test_partial_reference_must_not_delete_unseen_sentence():
    doc=Document(video_id=VIDEO,duration=60,cues=[cue('a','한양의 작은 옷 가게. 뒷편 창고는 현대와 이어져 있었습니다.',18,23)])
    apply_screen_references(doc,[ref('뒤편 창고는 현대와 이어져 있었습니다.',20,23)])
    assert doc.cues[0].speech_correction is None

@pytest.mark.parametrize('references',[
    [ref('이것은 옷이오, 이불이오?',30,33)],
    [ref('이것은 옷이오, 이불이오?',6,8,'abcdefghijk')],
    [ref('구독과 좋아요를 눌러 주세요',6,8)]])
def test_unrelated_time_video_and_text_cannot_correct(references):
    doc=Document(video_id=VIDEO,duration=60,cues=[cue('a','이것은 오시오 이불이요?',5,8)])
    apply_screen_references(doc,references)
    assert doc.cues[0].speech_correction is None

def test_two_screen_lines_correct_one_speech_segment():
    doc=Document(video_id=VIDEO,duration=60,cues=[cue('a','입는 오시예요. 한 번 걸쳐보세요.',9.1,11.2)])
    apply_screen_references(doc,[ref('입는 옷이에요.',9.1,10.2),ref('한번 걸쳐보세요.',10.5,11.5)])
    assert doc.cues[0].text=='입는 옷이에요. 한 번 걸쳐보세요.'

def test_bounded_frames_and_video_binding():
    frame=dict(video_id=VIDEO,time=7,jpeg='data:image/jpeg;base64,YWJj')
    assert AnalysisOptions(video_id=VIDEO,screen_frames=[frame]).screen_frames
    for frames in [[frame]*242,[{**frame,'video_id':'abcdefghijk'}],[{**frame,'time':float('nan')}],[{**frame,'jpeg':'http://remote/image'}]]:
        with pytest.raises(ValidationError):AnalysisOptions(video_id=VIDEO,screen_frames=frames)
