# 사용한 오픈소스와 모델

확인일: 2026-10-25. GitHub의 실제 저장소, 저자 모델 카드와 설치된 배포본을 확인했습니다. 확장과 스튜디오는 이 프로젝트용으로 작성했으며, 아래 라이브러리와 공개 가중치를 로컬에서 호출합니다. ZIP에는 타사 바이너리·모델 가중치가 포함되지 않습니다.

## 실제 연결한 구성

| 역할 | 출처 | 적용 버전 / 라이선스 |
| --- | --- | --- |
| 대사·단어별 시각 | [SYSTRAN/faster-whisper](https://github.com/SYSTRAN/faster-whisper), 기반 연구 [OpenAI Whisper](https://github.com/openai/whisper) | faster-whisper 1.2.1, CTranslate2 4.8.3; MIT. 기본 base CPU int8 |
| 기존 YouTube 스크립트 | [jdepoix/youtube-transcript-api](https://github.com/jdepoix/youtube-transcript-api) | 1.2.4; MIT |
| URL 오디오 추출 | [yt-dlp/yt-dlp](https://github.com/yt-dlp/yt-dlp) | 2026.10.21; 소스 Unlicense. Node.js 런타임 사용 |
| 효과음·음악 분류 | [YuanGongND/ast](https://github.com/YuanGongND/ast), [저자 AST 모델](https://huggingface.co/MIT/ast-finetuned-audioset-10-10-0.4593) | 연구 코드/모델 BSD-3-Clause. Transformers AST 구현으로 추론 |
| 음악의 박자 근거 | [librosa/librosa](https://github.com/librosa/librosa) | 0.11.0; ISC. onset_strength/beat_track 결과를 실제 onset과 대조 |
| 생성형 오디오 묘사 | [Labbeti/conette-audio-captioning](https://github.com/Labbeti/conette-audio-captioning), [CoNeTTE 모델](https://huggingface.co/Labbeti/conette) | conette 0.4.0; 코드·모델 MIT. 별도 Python 3.10 환경 |
| 영어 묘사의 한국어 번역 | [Helsinki-NLP/Opus-MT](https://github.com/Helsinki-NLP/Opus-MT), [opus-mt-tc-big-en-ko](https://huggingface.co/Helsinki-NLP/opus-mt-tc-big-en-ko) | 모델 CC BY 4.0. 저작자 Helsinki-NLP / OPUS-MT 팀; [이용허락](https://creativecommons.org/licenses/by/4.0/) |
| 모델 실행 | [PyTorch](https://github.com/pytorch/pytorch), [Transformers](https://github.com/huggingface/transformers) | 주 환경 torch/torchaudio 2.8.0 CPU, Transformers 4.57.6; PyTorch BSD 계열, Transformers Apache-2.0 |
| 캡셔닝 전용 실행 | 위 라이브러리 + [spaCy](https://github.com/explosion/spaCy) | torch 1.13.1 CPU, torchaudio 0.13.1 CPU, Transformers 4.30.2; spaCy 및 en_core_web_sm MIT |
| 디코딩·음량 | [PyAV](https://github.com/PyAV-Org/PyAV), [NumPy](https://github.com/numpy/numpy), [SoundFile](https://github.com/bastibe/python-soundfile) | PyAV 17.1.0 BSD-3-Clause, NumPy 2.2.6 BSD, SoundFile 0.14.0 BSD. 포함 FFmpeg/libsndfile의 별도 라이선스는 해당 배포본을 따름 |
| 로컬 API | [FastAPI](https://github.com/fastapi/fastapi), [Uvicorn](https://github.com/encode/uvicorn) | FastAPI 0.162.0 MIT, Uvicorn 0.54.0 BSD-3-Clause |

주 환경 83개, 캡셔닝 환경 105개 패키지의 실제 버전·배포 메타데이터는 [dependencies-main.json](dependencies-main.json), [dependencies-caption.json](dependencies-caption.json)에 기록했습니다. 주 환경 목록은 현재 requirements.txt를 설치한 별도 검증 환경에서 추출했습니다. 이 목록에는 간접 의존성도 있습니다. 라이선스 필드가 비어 있는 배포본은 허가가 없다는 뜻이 아니며 원본 배포의 LICENSE를 확인해야 합니다. 배포본에 포함된 제3자 구성요소의 조건이 추가로 적용될 수 있습니다.

## 선택 이유와 변경 사항

- Whisper는 대사를 인식하고, AST는 소리 종류를 분류하며, CoNeTTE는 소리를 문장으로 묘사합니다. Whisper만으로 문 닫힘·재채기 설명을 생성한다고 처리하지 않습니다.
- 사용자가 언급한 PyTorch AudioCaptioning 계열에서 [wsntxxn/AudioCaption](https://github.com/wsntxxn/AudioCaption)도 검토했습니다. 이 프로토타입에는 저자 가중치·추론 API가 있는 CoNeTTE를 선택했습니다. 해당 AudioCaption 저장소 코드를 통째로 복제한 것은 아닙니다.
- 기획서의 음원 분리는 이 CPU 프로토타입에 포함하지 않았습니다. 음량은 혼합 오디오에서 측정합니다. TensorFlow YAMNet 대신 PyTorch AST를 사용했습니다.
- AST의 세부 음악 태그와 librosa 박자 근거를 연결했습니다. Demucs 4.1.0도 지정 영상 앞 8초에 시험했지만 세부 묘사 개선을 확인하지 못해 제품 의존성에는 추가하지 않았습니다. 코드 라이선스와 모델 카드의 조건을 구별했으며, 적용·실험 범위와 음악 QA 자료 출처는 [music-dynamics.md](music-dynamics.md)에 기록했습니다.
- CoNeTTE의 구형 PyTorch 요구와 주 환경의 최신 PyTorch를 분리했습니다. `server/caption_worker.py`는 검증된 PCM 구간만 입력받으며 모델 추론 중 pip 설치를 실행하지 않습니다.
- AST/Whisper/CoNeTTE/번역 모델의 기본 가중치 revision을 고정했습니다. [models.json](models.json)에 이번 실행에서 확인한 파일 크기·SHA-256이 있습니다. CLI에서 사용자가 다른 Whisper 크기를 선택하면 그 모델은 별도로 다운로드하며 여기서 검증한 base revision과 구별됩니다.
- OPUS-MT 원본 변환의 공유 vocab 오류는 [OPUS-MT-train issue #81](https://github.com/Helsinki-NLP/OPUS-MT-train/issues/81) 및 [모델 discussion #7](https://huggingface.co/Helsinki-NLP/opus-mt-tc-big-en-ko/discussions/7)을 참고했습니다. 고정된 source.spm/target.spm의 원래 piece ID로 두 사전을 재구성했습니다. 가중치는 수정하지 않았습니다. Windows 한글 경로는 SentencePiece의 파일명 로더 대신 Python으로 읽은 바이트로 로드합니다.
- 한국어 의성어·유형 설명표, 타이밍 병합, 음량 대비 배율, 편집·확장 UI는 본 프로젝트의 구현입니다. 분류 결과를 사람이 확인하지 않고 확정된 사실로 바꾸지 않습니다.

## 시험 자료

- Whisper 저자 저장소의 [JFK 시험 음성](https://github.com/openai/whisper/blob/main/tests/jfk.flac): 영어 전사 통합 실행.
- [ESC-50](https://github.com/karolpiczak/ESC-50): 문 두드림과 재채기 소수 파일로 기능을 시험했습니다. 데이터셋은 CC BY-NC이며 **시험 오디오를 이 소스 ZIP에 넣지 않았습니다**. 학습 또는 상업용 데이터셋으로 배포하지 않습니다.
- CoNeTTE는 librosa가 제공하는 trumpet·robin 예제도 시험했습니다. 개별 녹음 저작자·CC BY 3.0 출처는 [caption-engine.md](caption-engine.md)에 기록했습니다. 해당 오디오 역시 ZIP에 포함하지 않습니다.
- 한국어 전사는 Windows Microsoft Heami Desktop 합성 음성으로 시험했습니다. 사람 음성의 대표 정확도 평가로 간주하지 않습니다.
- 스튜디오 데모 자막은 직접 작성한 기능 예시이며 분석 성능의 증거가 아닙니다.

## Chrome 기반

[Manifest V3](https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3), [tabCapture](https://developer.chrome.com/docs/extensions/reference/api/tabCapture), [offscreen](https://developer.chrome.com/docs/extensions/reference/api/offscreen) 공식 문서를 기준으로 구현했습니다. 탭 캡처는 Chrome 116 이상에서 사용자의 확장 아이콘 클릭으로 시작해야 합니다. 외부 호스팅 자바스크립트나 원격 실행 코드를 내려받지 않습니다.

## Screen caption correction

[PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) 3.3.2 (Apache-2.0), PaddlePaddle 3.2.2 and PaddleX 3.3.13: PP-OCRv5_mobile_det plus [korean_PP-OCRv5_mobile_rec](https://huggingface.co/PaddlePaddle/korean_PP-OCRv5_mobile_rec). These models run locally; weights download into models/paddlex. EasyOCR was evaluated against the same video but is not used in the shipped correction pipeline.
