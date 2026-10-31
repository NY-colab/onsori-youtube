# 온소리 품질 평가 · 원본/스템 비교 절차

대사 오인식, 음악 묘사, 단락 크기를 **같은 정답·같은 엔진 호출**로 비교하기 위한 도구다. [상세 계획](../docs/cloud-update-plan.md) 6.2절(스템 순서)과 14절(평가 지표)을 실행 가능한 형태로 옮겼다. 확장 프로그램 동작은 바꾸지 않으며 채점은 측정만 한다. 특정 문장을 맞추는 치환 규칙을 만들지 않는다.

평가용 오디오·영상·정답 초안은 저작물과 개인정보가 섞일 수 있으므로 저장소가 아닌 프로젝트 `work/onsori/eval/<case_id>/`에 둔다. 이 폴더는 도구만 담는다.

## 구성

| 파일 | 역할 |
| --- | --- |
| `../server/screen_ocr.py` (기존) | 영상 하단 화면 자막을 PaddleOCR PP-OCRv5로 0.25초 간격 판독, 신뢰도 0.94 이상·2회 이상 반복된 문구만 근거로 묶음 |
| `make_case.mjs` | OCR 근거로 정답 **초안** `case.json` 생성. 기존 파일은 덮어쓰지 않음 |
| `separate_stems.py` | HT-Demucs(고정 revision)로 `vocals.wav`·`accompaniment.wav` 생성. 입력과 같은 샘플레이트·채널·길이 유지, 재구성 SNR·클리핑 기록 |
| `../browser-build/qa-inference.mjs --audio` | 격리 Chromium에서 **실제 확장 엔진**을 `offscreen.js`의 전체 분석 호출과 같은 인자(`scope:'full-video'`, `capture_frames:false`)로 실행. 외부 업로드·원격 스크립트 요청이 있으면 실패 |
| `score_captions.mjs` | 여러 실행 결과를 정답과 비교해 JSON·Markdown 보고서 작성 |
| `review_sheet.mjs` | 검토자용 청취 시트(CSV, Excel용 BOM). 줄마다 해당 시각 YouTube 링크·화면 자막·각 실행의 인식 결과와 빈 확정 칸 |
| `ast_windows.py` | 2초 창마다 AST Speech·음악 점수와 상위 악기·분위기 라벨을 원본·스템별로 기록. 환각 필터·음악 묘사 근거 판단용(문구 생성 안 함) |

## 정답(case.json) 규칙

- `speech_reference[].status`
  - `screen-ocr-draft`: 화면 자막 OCR만 근거. **실제 음성 확인 전**이므로 CER은 참고값이다.
  - `human-verified`: 사람이 해당 시각을 듣고 확인. 화면 자막과 실제 발화가 다르면 들리는 말로 고친다. 문법이 어색해도 화자의 말을 바꾸지 않는다.
  - `disputed`: 음성·화면·원래 자막이 서로 다르거나 판단 불가. 채점 보고서에 상태별 줄 수가 함께 나온다.
- 화면 자막이 없는 구간의 대사는 `unreferenced`로 따로 집계한다(오인식·환각 후보이지만 정답 없이 점수에 넣지 않음).
- `music_reference`는 시스템 출력과 무관한 10초 격자다. 들리는 것만 확장 어휘(예: `피아노`, `기타`, `부드럽고 다정한`)로 적고, 불확실하면 `null`·`[]`로 둔다. 라벨을 단 행은 `status: "human-labeled"`.
- 최소 2명이 독립적으로 작성한 뒤 합의하고 `review[]`에 남긴다. 작성자 자막·OCR·모델 출력 중 무엇을 근거로 했는지 `evidence`에 남긴다.

## 지표

| 항목 | 계산 | 해석 |
| --- | --- | --- |
| 대사 CER | 음절 단위 편집거리 / 기준 글자 수. 공백 제외·포함 두 가지. 구두점 제거 | 시간이 겹치는 기준 줄과 인식 cue를 묶어(1:N, N:1 허용, 기준 시각 ±1초) 그룹 단위 비교 |
| 누락·기준 없는 대사 | 인식 cue가 없는 기준 그룹 / 기준이 없는 인식 cue | 분리 입력에서 작은 대사가 사라지는지 확인 |
| 시간 오차 | 그룹 시작·끝 절댓값 중앙값 | 기준 시각은 화면 자막 표시 시각이라 발화 시각과 차이가 있음 |
| 음악 묘사 | 문구 속 악기·분위기·장르·보컬 어휘를 추출해 사람 라벨과 대조 | `supported / unsupported / unlabeled`. 구체 단어 수보다 근거 없는 묘사 감소가 우선 |
| 내부 문구 노출 | 음악·효과음 문구의 `미확인`, `분석 실패`, `unknown` 등 | 0이어야 함 |
| 단락 크기 점프 | 문장이 끝나지 않은 채 0.25초 안에 이어지는 대사 cue의 배율 차이 ≥ 0.05 | 한 cue 안의 크기는 원래 고정(`captionSize`가 `scale`만 사용) |
| 효과음 손실 | 기준 실행의 효과음 cue 중 분리 입력 실행에 시간 겹침이 없는 것 | `--stem 원본:분리` 쌍으로 지정 |

## 실행 순서 (Windows PowerShell, 저장소 루트)

```powershell
$case = '..\..\work\onsori\eval\ref-wbEQJ_ZXyk'
# 1) 원본 오디오: 0.3.3 확장 어댑터가 받은 트랙을 재사용(361.256초). 새로 받을 때도 같은 확장 경로를 쓴다.
ffmpeg -v error -i ..\..\work\onsori\direct-audio-test\browser-adapter.m4a -c:a pcm_s16le -ar 44100 -ac 2 "$case\audio\original.wav"
# 2) 화면 자막 근거 (영상 파일이 있을 때). 요청 JSON: video_id, windows=[[0,길이]], video, offset 0, end
.\.venv\Scripts\python.exe -m server.screen_ocr "$case\evidence\screen-ocr-request.json" "$case\evidence\screen-ocr-full.json"
# 3) 정답 초안 (이미 있으면 거부됨 → 사람이 직접 수정)
node eval\make_case.mjs --ocr "$case\evidence\screen-ocr-full.json" --video-id -wbEQJ_ZXyk --duration 361.256 --title '조선에 롱패딩을 팔았다' --audio "$case\audio\original.wav" --out "$case\case.json"
# 4) 스템 분리
.\.venv\Scripts\python.exe -X utf8 eval\separate_stems.py "$case\audio\original.wav" "$case\audio"
# 5) 같은 엔진으로 세 조건 실행 (순서대로; 같은 모델 캐시 프로필을 공유)
$env:ONSORI_CHROMIUM_PATH = "$env:LOCALAPPDATA\ms-playwright\chromium-1243\chrome-win64\chrome.exe"
foreach ($c in 'original','vocals','accompaniment') { node browser-build\qa-inference.mjs --audio "$case\audio\$c.wav" --duration 361.256 --out "$case\runs\browser-$c.json" }
# 6) 창별 음향 근거 (Python full precision AST; 브라우저 q8과 근사)
.\.venv\Scripts\python.exe -X utf8 eval\ast_windows.py "$case\evidence\ast-windows.json" "original=$case\audio\original.wav" "vocals=$case\audio\vocals.wav" "accompaniment=$case\audio\accompaniment.wav"
# 7) 검토자 청취 시트 → 확정한 줄은 case.json의 text/status/review에 옮김
node eval\review_sheet.mjs --case "$case\case.json" --run live033=..\..\work\onsori\live-033\actual-full-captions.json --run original="$case\runs\browser-original.json" --out "$case\review-sheet.csv"
# 8) 채점 (실제 Chrome 결과도 같은 방식으로 추가 가능)
node eval\score_captions.mjs --case "$case\case.json" --run live033=..\..\work\onsori\live-033\actual-full-captions.json --run original="$case\runs\browser-original.json" --run vocals="$case\runs\browser-vocals.json" --run accompaniment="$case\runs\browser-accompaniment.json" --stem original:vocals --stem original:accompaniment --out "$case\report.json" --md "$case\report.md"
```

Node 24.11의 `fs.rmSync`는 이 프로젝트의 한글 경로에서 프로세스가 비정상 종료(0xC0000409)되므로 평가 도구는 삭제 대신 새 폴더를 쓴다.

## 해석 시 주의

- 화면 자막은 편집된 문장일 수 있다. `screen-ocr-draft` 상태의 CER로 모델 채택을 확정하지 않는다.
- 스템은 정답이 아니다. 보컬 stem은 노래 가사·잔향을 대사로 남길 수 있고, 효과음은 어느 stem으로든 갈 수 있다. 원본은 항상 보존하고 원본과 함께 비교한다.
- 브라우저 실행 시간은 같은 PC의 다른 작업과 겹치면 늘어난다. 지연 비교는 단독 실행으로 다시 잰다.
- 클라우드·유료 ASR 결과도 같은 `score_captions.mjs`로 비교할 수 있지만, 이 절차는 유료 호출을 실행하지 않는다.
