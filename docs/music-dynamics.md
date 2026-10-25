# 음악 묘사와 시간별 글자 크기

확인일: 2026-10-25. 기본 로컬 분석에 적용됩니다. 선택 CoNeTTE 설치나 외부 API 키가 없어도 작동합니다.

## 바뀐 동작

이전에는 AST가 `Music`을 가장 높은 소리 유형으로 고르면 악기 관련 점수가 자막에서 사라졌습니다. 이제 음악 유무와 세부 특징을 별도로 판단하고, 최대 8초의 음악 구간에서 악기·장르·분위기·보컬 점수를 확인합니다. 한국어 표현표는 본 프로젝트의 구현입니다.

- 악기 최대 2개: 점수 0.20 이상. 상위 분류와 하위 악기가 겹치면 중복을 줄입니다. 하위 악기가 부모를 대체하려면 0.30 이상이면서 부모 점수의 75% 이상이어야 합니다. 약한 전자 피아노 점수가 강한 피아노 점수를 덮지 못합니다.
- 장르 0.28, 분위기·보컬 0.30 이상. 차순위와 각각 0.08, 0.10, 0.08 이상 차이가 있어야 선택합니다. 차순위가 최소 점수 아래여도 비교합니다. 이는 오인식을 줄이기 위한 휴리스틱이며 검증된 확률 기준은 아닙니다.
- 박자: [librosa 0.11.0](https://github.com/librosa/librosa)의 onset_strength와 beat_track을 사용합니다. 4초 이상, 5개 이상 박자, 박자 주변 실제 강한 onset 지지율 80% 이상, 구간 점유율 50% 이상, 박자 간격 변동계수 0.12 이하일 때 `규칙적인 박자가 이어짐`을 표시합니다. 추정 BPM은 내부 근거로만 보존합니다.
- 대사 점수가 0.35 이상이면 박자 분석을 생략합니다. 말의 리듬을 음악의 박자로 쓰지 않기 위한 제한입니다. 저음량·지속음·무음에서는 임의의 규칙적인 박자를 만들지 않습니다.
- 특징을 충분히 확인하지 못하면 `♪ 음악 · 악기·분위기 미확인`으로 남깁니다. 곡 제목, 연주자, 모든 악기 구성이나 감정을 확정하지 않습니다.

기본 정보량에서 구체적인 문구를 볼 수 있습니다. 간결한 정보량은 기존대로 소리 유형만 보여 줍니다. 자세한 정보량은 선택 CoNeTTE의 문장과 검토 표시도 더합니다. `metadata.music_analysis`에 선택 근거가 저장됩니다.

## 볼륨·강세 표현

구간 평균만 사용하던 배율에 `volume_profile`을 추가했습니다. 0.1초 RMS를 영상의 공통 기준 음량과 비교하고 .75–1.55배로 제한합니다. 상승은 빠르게(계수 .85), 하강은 점진적으로(.35) 처리합니다. 재생 시간 사이의 값은 보간하고 화면에는 0.5px 단위로 반영합니다.

YouTube 오버레이와 스튜디오 미리보기가 같은 계산을 사용합니다. 같은 자막이 계속 표시되면 노드를 유지해 자막 등장 애니메이션이 매 프레임 반복되지 않습니다. 글자 크기 변화 시 원래 목표 크기로부터 다시 화면에 맞추므로 축소가 누적되지 않습니다. 표현 강도 0은 고정, .5는 부드럽게, 1은 강하게입니다.

이는 **혼합 소리의 물리적인 세기 변화**입니다. 언어적인 강세, 단어 의미, 사람별 목소리·감정이나 음악과 대사의 분리 음량이 아닙니다. 짧은 소리도 포착하지만 0.1초보다 훨씬 짧은 피크의 정확한 시각을 보장하지 않습니다. 이전 JSON은 기존 구간 배율로 계속 표시되며, 새 분석부터 시간별 크기가 생성됩니다. JSON에만 시간별 배율을 보존합니다.

## 실제 입력을 사용한 확인

| 입력 | 실제 생성 문구 | 글자 배율 범위 |
| --- | --- | --- |
| librosa trumpet, 5.333초 중 활성 구간 0–3.15초 | ♪ 트럼펫 연주 | .848–1.204 |
| librosa choice, 앞 8초 | ♪ 베이스 기타 연주 · 규칙적인 박자가 이어짐 | .781–1.253 |
| librosa pistachio, 앞 8초 | ♪ 피아노 연주 · 규칙적인 박자가 이어짐 | .750–1.319 |

모델이 선택한 결과이며 사람에 의한 전체 악기 정답 평가가 아닙니다. 샘플 이름이나 파일 설명은 추론 입력에 사용하지 않았습니다. 피아노 샘플도 분위기 근거가 약해 밝은 음악이라고 쓰지 않았습니다.

지정한 YouTube `-wbEQJ_ZXyk`(조선에 롱패딩을 팔았다)의 기존 저장 원본 앞 60초를 새 로직으로 분석했습니다. 기존 대사 9개를 유지하고, 음악 8개·효과음 3개와 총 896개 음량 지점을 생성했습니다. 이 구간의 음악 8개는 모두 악기·분위기 미확인이었습니다. 대사에 가려진 음악을 이번 수정으로 완전히 해결했다고 주장하지 않습니다. 기존 전체 결과는 덮어쓰지 않았습니다.

음원 분리도 별도로 시험했습니다. [Demucs 4.1.0](https://github.com/adefossez/demucs)의 htdemucs를 앞 8초에만 적용해 보컬을 제외한 성분을 AST에 입력했습니다. Speech 점수는 .7186→.0440으로 감소했지만 Guitar .1176, Piano .0702로 악기 기준에 못 미쳤습니다. 추가 비용에 비해 구체적 묘사 개선을 확인하지 못해 **제품에는 연결하지 않았습니다**. 코드 MIT와 모델 가중치 이용조건은 구별했으며, 확인한 HF 모델 카드에는 명시적 라이선스 필드가 없었습니다. 실험 가중치·오디오는 배포 ZIP에 포함하지 않습니다.

## 브라우저 검증

실제 확장을 격리 Chromium에 로드하고, 통제한 PCM 파일에서 서버가 생성한 JSON을 적용했습니다. 같은 대사의 작은 소리 38.5px → 강조 구간 60px → 회복 38.5px를 확인했습니다. 강조 전후에는 같은 DOM 노드를 유지했고 고정 모드에서는 38.5px로 일정했습니다. 스튜디오는 28px→43.5px였습니다. 트럼펫 설명 표시, 원본 연결, JSON 가져오기와 pageerror 0을 확인했습니다.

이 검증은 재현 가능한 재생 fixture를 사용합니다. 실제 Chrome 사용자 권한으로 탭 오디오를 캡처했다는 증거가 아니며 해당 검사는 여전히 별도입니다.

## 출처와 재현

- AST: [저자 GitHub](https://github.com/YuanGongND/ast), [AudioSet ontology](https://github.com/audioset/ontology). 모델 revision은 models.json에 고정합니다.
- librosa: [0.11.0 onset_strength](https://librosa.org/doc/0.11.0/generated/librosa.onset.onset_strength.html), [beat_track](https://librosa.org/doc/0.11.0/generated/librosa.beat.beat_track.html), [ISC 라이선스](https://github.com/librosa/librosa/blob/0.11.0/LICENSE.md). 라이브러리 코드를 복제하지 않고 고정 버전 패키지를 호출합니다.
- trumpet: Mihai Sorohan, CC BY 3.0. 기존 caption-engine.md의 출처를 따릅니다.
- choice: Admiral Bob 2020, Snowflake 참여, [원출처](http://dig.ccmixter.org/files/admiralbob77/61638). librosa 메타데이터는 CC BY-NC 3.0 문구와 BY-NC 4.0 링크가 혼재합니다. Brian McFee의 drums+bass 발췌 예제를 QA에만 사용하며 재배포하지 않습니다.
- pistachio: The Piano Lady / Lena Orsa, [원출처](https://freesound.org/people/lena_orsa/sounds/442789/), librosa 제공 설명 기준 CC BY-NC 3.0. QA에만 사용하고 재배포하지 않습니다.
- 구현: server/music.py, server/audio.py, server/pipeline.py, server/schema.py, extension/core.js, extension/content.js, web/app.js. 단위 검사는 tests/test_music_dynamics.py와 extension/core.test.mjs에 있습니다.
- 프로젝트 내 재현 파일: work/onsori/music-dynamics-qa.py, selected-video-music-qa.py, dynamic-browser-qa.js. 결과·출처 텍스트·분리 실험은 work/onsori/music-dynamics/, 화면은 work/onsori/browser-qa/dynamic-*.png에 보존합니다. 사용자 오디오·브라우저 프로필은 ZIP에서 제외합니다.
