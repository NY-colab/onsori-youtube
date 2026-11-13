# 「온소리 자막 in YouTube」 0.4.0 · 1분 단위 분석, 영상별 저장, Claude Haiku 자막 보정

## 바뀐 동작

### 1분 단위 분석(버퍼링)

- 영상 전체 오디오를 받은 뒤 1분씩 나눠 분석합니다.<br>구간 하나가 끝날 때마다 그 구간의 자막을 바로 영상에 표시합니다.
- 재생 위치가 있는 구간을 먼저 분석하고, 그 뒤 구간, 앞쪽 구간 순서로 진행합니다.<br>구간을 시작할 때마다 재생 위치를 다시 확인하므로, 탐색하면 다음 구간부터 새 위치를 따라갑니다.
- 구간 경계는 목표 시각 앞뒤 8초 안에서 가장 조용한 0.2초 지점으로 옮깁니다.<br>각 구간은 앞뒤 1.5초를 더 듣고 분석하며, 대사는 가운데 시각이 속한 구간에만 남깁니다.<br>경계에 걸쳐 두 구간에서 겹쳐 인식한 대사는 시간과 글자가 겹치면 더 긴 쪽 하나만 남깁니다.<br>경계를 넘어 이어지는 같은 음악·효과음 자막은 하나로 합칩니다.
- 글자 크기 기준 음량은 구간별이 아니라 영상 전체의 중앙값을 씁니다.<br>구간이 바뀌어도 같은 크기의 소리는 같은 크기의 글자로 보입니다.
- 분석 작업자(Web Worker)와 AI 모델을 구간마다 새로 띄우지 않고, 첫 구간에서 불러온 모델을 마지막 구간까지 그대로 씁니다.
- 진행 상태에 `자막 준비 02:00/12:30 · 02:00–03:00 구간 · …`처럼 준비된 길이와 분석 중인 구간을 표시합니다.

### 영상별 저장과 이어서 분석

- 자막을 영상마다 따로 저장합니다(`cc:<영상 ID>`).<br>0.3.x의 묶음 저장(`captionCache`, 최대 8개)은 처음 실행할 때 영상별 저장으로 옮깁니다.
- 최근 최대 60개 영상, 약 40MB까지 보관하고 오래된 영상부터 지웁니다.<br>Chrome 확장 저장소의 기본 한도 10MB를 넘기기 위해 `unlimitedStorage` 권한을 추가했습니다(설치 경고가 없는 권한입니다).
- 분석 중 같은 영상을 새로고침하면 분석을 취소하지 않고 이어 갑니다.<br>새로고침한 페이지는 그때까지 저장된 구간의 자막을 바로 표시합니다.
- 다른 영상으로 이동하거나 탭을 닫으면 분석을 멈추고 저장한 구간은 남깁니다.<br>그 영상으로 돌아오면 자동 분석이 남은 구간만 이어서 분석합니다.
- 직접 취소했거나 오류로 멈춘 영상은 자동으로 이어 가지 않습니다.<br>패널의 **남은 구간 이어서 분석**으로 계속합니다.
- 패널에 `12개 자막 · 03:00 / 12:30 분석됨`처럼 분석된 길이를 표시합니다.
- 분석한 구간이 있는 영상에서 탭 녹음을 하면 녹음 구간만 바꾸고 나머지 저장 구간은 유지합니다.

### Claude Haiku 대사 오타 보정(선택)

- 패널의 **Claude Haiku로 대사 오타 보정**을 켜면, 음성 인식 대사 중 YouTube 원래 자막으로 교정하지 못한 줄의 오타를 Claude Haiku(`claude-haiku-5-5`)가 고칩니다.<br>영상 전체 분석은 1분 구간마다, 탭 녹음은 녹음 구간마다 한 번 요청합니다.
- 사용자의 Anthropic API 키로 동작합니다.<br>키는 YouTube 페이지 옆 패널이 아니라 확장 설정 화면(`ai-settings.html`)에서만 입력합니다.<br>저장 전에 모델 조회로 키와 Claude Haiku 사용 권한을 확인하며, 틀린 키는 저장하지 않습니다.<br>계정을 바꿀 때는 새 계정의 키를 저장하면 기존 키를 대신하고, **키 삭제**로 지울 수 있습니다.
- 보내는 정보는 인식한 대사 글자, 영상 제목, 바로 앞 대사 4줄입니다.<br>소리와 화면 이미지는 보내지 않고, 요청은 이 기기에서 Anthropic API로 바로 갑니다.
- 맞춤법·띄어쓰기·잘못 들은 낱말만 고치도록 지시하고, 응답은 JSON 스키마로 받습니다.<br>원문과 글자 수가 크게 다르거나 비슷하지 않은 고쳐 쓰기, 소리 표기(♪·♬)를 넣은 응답은 받아들이지 않습니다.<br>고친 대사는 원문을 `ai_correction.original_text`에 남기고 출처에 `+claude-haiku`를 붙입니다.
- 요청이 실패하거나 Claude가 거절하면 그 구간은 인식한 원문을 표시하고 경고를 남깁니다.<br>키가 틀렸거나 권한이 없으면 남은 구간의 보정을 멈춥니다.
- Anthropic 공식 TypeScript SDK(`@anthropic-ai/sdk` 1.3.0)를 잠금 파일 버전 그대로 `vendor/anthropic/anthropic-sdk.mjs`에 번들했습니다.<br>원격 실행 코드는 여전히 없으며, 연결 허용 목록(CSP `connect-src`)에 `https://api.anthropic.com`을 추가했습니다.<br>호스트 권한은 추가하지 않았습니다.

### Claude Code CLI 연결(API 키 없이)

- 설정할 것이 없습니다.<br>이 PC에 연결 프로그램이 설치되어 있고 Claude Code가 로그인되어 있으면, 확장이 스스로 확인해 보정을 켜고 API 키 없이 Claude Code CLI로 보정합니다.<br>패널에는 ‘켜짐 · 이 PC의 Claude Code로 자동 보정합니다’가 표시되고, 사용자가 끈 경우에만 꺼집니다.<br>연결 상태 확인(claude.exe 버전·로그인 조회)은 5분 동안 저장해 두고 분석을 시작할 때 다시 확인합니다.<br>보정 요청은 Claude Code 로그인 계정의 사용량에 포함됩니다.
- 확장은 Chrome 네이티브 메시징으로 로컬 연결 프로그램(`native-host/onsori-claude-bridge.mjs`)에 대사 글자만 넘깁니다.<br>연결 프로그램은 정해진 명령 하나만 실행합니다: `claude -p --model claude-haiku-5-5 --effort low`에 도구 0개(`--tools ""`), 훅 끔(`disableAllHooks`), MCP 끔(`--strict-mcp-config`), 사용자·프로젝트 설정 미적용(`--setting-sources ""`), 대화 기록 저장 끔(`--no-session-persistence`), 고정 보정 지시문과 JSON 스키마.<br>확장이 지시문이나 도구를 바꿔 보낼 수 없고, 빈 작업 폴더에서 실행해 프로젝트 CLAUDE.md를 읽지 않습니다.
- `nativeMessaging`은 필수 권한입니다.<br>쓸 때마다 권한을 묻지 않도록, 확장을 설치하거나 이 버전으로 업데이트할 때 Chrome이 ‘협력하는 네이티브 애플리케이션과 통신’ 권한을 한 번 표시합니다.<br>웹스토어로 배포하면 기존 사용자는 업데이트 때 이 권한을 승인해야 확장이 다시 켜집니다.<br>연결 프로그램이 없는 PC에서는 아무것도 실행하지 않고 패널에 ‘이 PC에서 Claude Code 연결 프로그램을 찾지 못해 보정하지 않습니다’를 표시합니다.
- `Install-Claude-Bridge.cmd`(내부적으로 `native-host/install.mjs`)가 연결 프로그램을 `%LOCALAPPDATA%\OnSori\claude-bridge`에 복사하고, Chrome 호스트 정보를 현재 사용자 레지스트리(`HKCU`)에 등록합니다.<br>관리자 권한은 필요 없고, `--uninstall`로 제거합니다.<br>허용하는 확장은 웹스토어 버전, 이 저장소의 `extension` 폴더에서 불러온 버전, 이 PC의 Chrome 프로필에 이미 불러온 온소리 확장(프로필 설정의 확장 경로와 manifest 이름만 읽어 찾음), 직접 지정한 확장 ID입니다.<br>압축해제 확장 ID는 Chrome과 같은 방식(폴더 경로 UTF-16 SHA-256)으로 계산하며, 한글 경로에서 실제 Chromium의 ID와 일치함을 확인했습니다.
- 설정 화면의 **연결 확인**은 Claude Code 버전·로그인 상태를 본 뒤, 짧은 시험 보정 한 번으로 실제 호출까지 확인합니다.<br>로그인이 만료됐으면 `claude auth login` 안내를, 연결 프로그램이 없으면 설치 방법과 확장 ID를 표시합니다.
- 분석 중 Claude Code 요청은 서비스 워커의 일반 작업 순서를 기다리지 않게 처리해, 보정 응답을 기다리는 동안에도 진행 상태와 구간 저장이 멈추지 않습니다.

### 온소리 서버 보정(운영자 API 키)

- Claude Code 연결 프로그램이 없는 PC에서도 사용자가 설정할 것 없이 보정하도록, 온소리 클라우드 게이트웨이에 `POST /v1/corrections`를 추가했습니다.<br>서버는 운영자의 Anthropic API 키로 공식 Python SDK(`anthropic` 1.17.0)를 써서 `claude-haiku-5-5`에 확장과 같은 지시문·JSON 스키마로 요청합니다.<br>API 키는 서버 `.env`에만 두고 확장에는 넣지 않습니다.
- 확장은 이 설치의 무작위 열쇠(`osi_`)로 대사 글자, 영상 제목, 앞 대사 4줄만 보냅니다.<br>서버는 대사 글자를 데이터베이스·로그에 남기지 않고, 설치별·날짜별 보정 줄 수와 요청·토큰 수만 기록합니다.<br>Anthropic 오류 내용은 그대로 돌려주지 않고 정해진 코드(`correction_rate_limited` 등)로만 알립니다.
- 하루 한도는 설치별 3,000줄, 서버 전체 20,000줄이 기본값입니다(`ONSORI_INSTALL_DAILY_CORRECTION_LINES`, `ONSORI_DAILY_CORRECTION_LINES`).<br>한도를 넘으면 그날 남은 구간은 원문으로 표시합니다.
- 연결 순서는 본인 API 키(직접 고른 경우) → 이 PC의 Claude Code → 온소리 서버 → 본인 API 키입니다.<br>`/v1/availability`가 `corrections: true`를 알려 줄 때만 서버 보정을 씁니다.
- 서버 설정은 `ONSORI_CORRECTION=anthropic`과 `ANTHROPIC_API_KEY`입니다.<br>`preflight.py`가 두 값을 검사하고, nginx에 `/v1/corrections`(POST, 128KB) 경로를 추가했습니다.

### 온소리 서버 보정 공급자 DeepInfra(2026-11-13)

- 팀 Claude 구독을 서버에서 다른 이용자의 보정에 쓰는 방식은 Anthropic 방침상 허용되지 않고, Anthropic API는 별도 결제를 집행하기 어려워 서버 보정 공급자를 DeepInfra로 바꿨습니다.<br>Gemini API 무료 등급은 웹 스토어에 공개된 확장에 맞지 않아 제외했습니다.<br>(*Gemini API 약관은 18세 미만이 이용할 가능성이 있는 서비스에 쓸 수 없고, 무료 등급의 입력·응답을 제품 개선과 사람 검토에 쓴다고 규정합니다.)<br>CLOVA Studio는 외부 공개 서비스 앱 심사가 필요해 시험 서버 사용 기간 안에 연결하기 어려웠습니다.
- 게이트웨이에 `ONSORI_CORRECTION=deepinfra`를 추가했습니다.<br>DeepInfra의 OpenAI 호환 주소(`https://api.deepinfra.com/v1/openai/chat/completions`)에 기존 `httpx`로 요청하며, 새 패키지는 없습니다.<br>확장과 같은 지시문을 system 메시지로, 같은 JSON 스키마를 `response_format`(`json_schema`, strict)으로 보내고 `temperature` 0, `reasoning_effort` `none`으로 추론을 끕니다.
- 기본 모델은 `deepseek-ai/DeepSeek-V4-Flash-0731`입니다(입력 100만 토큰당 $0.06, 출력 $0.18, 2026-11-13 DeepInfra 가격).<br>`ONSORI_CORRECTION_MODEL`로 다른 DeepInfra 모델을, `ONSORI_CORRECTION_REASONING`으로 추론 설정을 고릅니다.
- 키는 클라우드 대사 분석과 같은 `DEEPINFRA_API_KEY`를 씁니다.<br>오디오 유료 분석 스위치(`ONSORI_ALLOW_PAID`)와는 별개이며, 보정을 켜도 소리는 서버 밖으로 나가지 않습니다.
- 같은 요청이 두 번 과금될 수 있어 재시도하지 않습니다.<br>DeepInfra 오류 응답은 대사 글자를 되돌려 줄 수 있어 본문을 읽지 않고 상태 코드만 정해진 코드로 바꿉니다: 401·403 `correction_provider_auth`, 402 `correction_provider_billing`, 404 `correction_model_unavailable`, 400·422 `correction_bad_request`, 429 `correction_rate_limited`, 그 밖 `correction_provider_error`.<br>응답은 1MB까지만 받습니다.
- `/v1/availability`에 `correction_provider`를 더했고, `correction_model`은 실제 모델 이름을 알려 줍니다.<br>확장은 이 값으로 패널에 ‘켜짐 · 온소리 서버를 거쳐 자동 보정합니다(DeepInfra · DeepSeek V4 Flash)’를 표시하고, 설정 화면에도 같은 이름과 모델 ID를 보여 줍니다.<br>패널 스위치 이름은 ‘AI로 대사 오타 보정’으로 바꿨습니다.
- 모델 이름 검사가 `claude-haiku-5-5` 같은 소문자 이름만 받아, DeepInfra 모델(`owner/Name`)로 고친 자막 문서를 `core.js`가 거부하고 모델을 `claude-haiku-5-5`로 잘못 기록하는 문제를 찾아 고쳤습니다.<br>`core.js`·`web/core.js`와 `ai-correction.js`가 `[A-Za-z0-9._/-]` 100자까지 받습니다.<br>서버로 고친 대사는 출처에 `+ai-correction`을 붙이고, Claude로 고친 대사는 기존대로 `+claude-haiku`를 붙입니다.
- 서버 배포 파일을 함께 바꿨습니다.<br>`enable_correction.sh`는 기본으로 DeepInfra 키를 화면에 보이지 않게 받고(`.env`에 키가 있으면 Enter로 그대로 사용), `anthropic` 인자로 Anthropic을 고릅니다.<br>`--disable`은 클라우드 대사 분석이 DeepInfra를 쓰지 않을 때만 DeepInfra 키를 지웁니다.<br>새 `check_correction.sh`는 합성 문장 2줄을 운영자 토큰으로 한 번 보정해 결과와 걸린 시간을 보여 줍니다.<br>`preflight.py`, `.env.example` 2곳, `RUNBOOK.ko.md`도 맞췄습니다.
- 안내 문구를 실제 전송처에 맞췄습니다.<br>`privacy.html`, `help.html`, `ai-settings.html`, `docs/privacy-browser.md`, `README.md`, `docs/webstore-listing.json`에 연결별 전송처(이 PC의 Claude Code·본인 API 키는 Anthropic, 온소리 서버는 DeepInfra)와 DeepInfra 데이터 처리 방침(요청 내용을 디스크에 저장하거나 학습에 쓰지 않음)을 적었습니다.<br>웹스토어 데이터 공개 설명의 자막 캐시 수도 실제 동작(최근 최대 60개 영상)으로 고쳤습니다.
- 서버 검사 88개(`tests/test_cloud_corrections.py` 37개 중 DeepInfra 24개 추가)와 확장 검사 179개를 2026-11-13에 실행해 모두 통과했습니다.<br>DeepInfra 검사는 HTTPX MockTransport로 요청 주소, 인증 머리글, 본문(대사 글자만, 추가 필드 제거), 오류 코드, 재시도 없음, 응답 크기 제한, DB에 대사 글자 없음을 확인합니다.<br>실제 DeepInfra 키로 한 보정은 서버 배포와 키 입력 뒤에 확인합니다.

## 바뀐 파일

- 새 파일: `extension/ai-config.js`, `extension/ai-correction.js`, `extension/ai-settings.html`·`.js`·`.css`, `extension/vendor/anthropic/anthropic-sdk.mjs`, `browser-build/qa-stream.mjs`, `native-host/`(연결 프로그램·설치·검사), `Install-Claude-Bridge.cmd`.
- 분석: `browser-engine.js`(구간 계획·소유·병합, 스트리밍 분석, 작업자 세션), `browser-inference-worker.js`(모델 유지 모드), `browser-engine-signal.js`(고정 기준 음량), `offscreen.js`.
- 저장·흐름: `worker.js`, `core.js`(`readyDocument`, `captionKey`, `ai_correction` 검증), `content-entry.js`, `controls.js`, `popup.html`·`popup.css`.
- 안내: `help.html`, `privacy.html`, `docs/privacy-browser.md`, `README.md`.

## 검증

- Node 검사 177개(`extension/*.test.mjs`, `web/review.test.mjs`, `native-host/*.test.mjs`)를 2026-11-12에 실행해 모두 통과했습니다.<br>Claude Code 연결 검사는 가짜 claude 실행 파일로 실행 인자·입력·오류 분류·시간 초과를, 설치본을 별도 프로세스로 띄워 Chrome과 같은 stdin/stdout 프레임 통신을 확인합니다.<br>새 검사는 구간 계획·재생 위치 우선·경계 중복 제거·음악 병합, 작업자 1개 재사용, 이어서 분석, 분 단위 저장과 새로고침 중 유지, 이동 후 재개, 취소·오류 뒤 자동 재개 중지, 영상별 저장 이전과 한도, 키 저장 경로 제한, 보정 수락·거절 규칙, 번들 SDK의 요청 형태와 오류 구분을 확인합니다.
- `browser-build/qa-stream.mjs`로 실제 한국어 녹음 60초를 세 번 이은 180초 오디오를 Playwright Chromium에서 분석했습니다(GPU 사용, 모델은 QA 프로필 캐시).<br>재생 위치를 70초로 두자 60.1–120.2초 구간이 68초 만에 먼저 표시됐고, 120.2–180초가 139초, 0–60.1초가 204초에 이어졌습니다.<br>세 구간의 대사가 경계에서 잘리거나 겹치지 않았고, 경계를 넘는 배경 음악은 하나의 자막으로 합쳐졌습니다.<br>세 번째 구간 안에서 Whisper가 한 줄을 한 번 더 인식한 경우가 있었으며, 이는 구간 경계와 관계없는 인식 결과입니다.
- 같은 검사에서 번들 SDK를 확장 CSP 안에서 불러와, 일부러 틀린 키로 `api.anthropic.com`에 모델 조회를 보냈습니다.<br>401 응답을 받아 `invalid_key`로 구분했으므로 CSP·CORS에 막히지 않음을 확인했습니다.<br>원격 JS·MJS·WASM 요청은 0건이었습니다.
- 새 프로필에서 설정 화면에 틀린 키를 넣으면 ‘Anthropic API 키가 올바르지 않거나 만료되었습니다.’를 표시하고 키를 저장하지 않았습니다.<br>도구 모음 창에는 사용 설정 뒤 보정 행이 표시되고, 키가 있으면 ‘API 키 관리’와 켜짐 안내를 보여 줍니다.
- `scripts/package_store.py` 검사를 통과해 `OnSori-Chrome-WebStore-0.4.0.zip`(54개 파일)을 만들었습니다.
- 이 PC의 실제 Claude Code 2.1.89로 연결 프로그램을 시험했습니다.<br>로그인이 만료된 상태에서는 보정 요청이 ‘OAuth access token has been revoked’로 끝나 `cli_auth`로 구분됐습니다.<br>`claude auth login`으로 다시 로그인한 뒤, 설치본(`%LOCALAPPDATA%\OnSori\claude-bridge`)을 Chrome과 같은 방식으로 호출했습니다.
- 오타가 든 5줄로 모델을 비교했습니다.<br>`haiku` 별칭은 이 CLI에서 Haiku 4.5(`claude-haiku-4-5-20251001`)로 연결됐고, 20초가 걸렸으며 ‘어쩔수’를 ‘어쇨 수’로 잘못 고쳤습니다.<br>`claude-haiku-5-5`를 지정하면 9초 안에 ‘금니→금리’, ‘상승율→상승률’, ‘나타났 습니다→나타났습니다’, ‘어쩔수→어쩔 수’, ‘다음주 에는 환율 도 지켜 봐야 겠습니다→다음 주에는 환율도 지켜봐야겠습니다’를 모두 바르게 고쳤고, 구어 ‘아 진짜 대박이다 ㅋㅋ’는 그대로 두었습니다.<br>그래서 연결 프로그램은 `claude-haiku-5-5`를 지정하고, 그 이름을 모르는 이전 CLI에서만 `haiku` 별칭으로 다시 요청합니다.
- 실제 브라우저(Playwright Chromium, 시험용으로만 Chromium 레지스트리에 임시 등록 후 삭제)에서 설정 화면의 **연결 확인**을 눌렀습니다.<br>설정 화면 → 서비스 워커 → 연결 프로그램 → Claude Code 경로로 3.3초 만에 ‘연결됨 · 2.1.89 (Claude Code) · claude.ai team 구독 · claude-haiku-5-5’와 시험 보정 성공(‘안녕 하세요 반갑 습니다’ → ‘안녕하세요 반갑습니다’)을 표시했습니다.
- 같은 방식으로 실제 한국어 녹음 60초의 Whisper 결과 7줄을 Claude Code로 보정했습니다.<br>오타가 없는 줄이어서 고친 줄은 0개였고, 오류 없이 74초에 분석과 보정을 마쳤습니다.
- 아무것도 저장하지 않은 새 Chromium 프로필에서 도구 모음 창을 열자 0.8초 만에 보정 행이 ‘켜짐 · 이 PC의 Claude Code로 자동 보정합니다’로 표시됐고, 저장된 보정 설정은 없었습니다.<br>설치 프로그램은 이 PC의 Chrome에 불러온 온소리 확장으로 `outputs/onsori/extension` 버전(`amafcdcihcfadmdfodlgdaphoapaacom`)을 찾았습니다.
- 남은 확인 항목은 실제 YouTube 페이지에서의 분 단위 표시와 새로고침·이동 흐름, 사용자 Chrome에서의 Claude Code 연결, 실제 Anthropic 키로 한 보정 결과입니다.

## 반영 상태

소스와 확장 폴더(`extension/`)에 반영했습니다.<br>0.4.0 ZIP 릴리스와 웹스토어 제출은 하지 않았습니다.<br>압축해제 설치본에는 `chrome://extensions`의 새로고침과 YouTube 새로고침으로 반영합니다.

### 파일럿 서버 배포(2026-11-13)

- 파일럿 서버(`/opt/onsori`)를 먼저 `/root/onsori-backup-20261113`에 백업했습니다.<br>백업에는 서버 코드, nginx 설정, SQLite 데이터베이스(SQLite 백업 기능으로 복사), 이전 gateway 이미지 ID가 들어 있습니다.<br>이전 이미지는 `onsori-pilot-gateway:pre-20261113` 태그로 남겨 두었습니다.
- 새 `cloud_gateway/`와 `deploy/cloud/` 파일을 올렸고, 서버 사본의 SHA-256이 저장소와 같음을 확인했습니다.<br>`preflight.py` 통과 후 gateway 이미지를 다시 빌드했습니다(`sha256:a9a3880c…`, `anthropic` 1.17.0, `httpx` 0.28.1).<br>gateway만 재생성했고 healthy 상태로 올라왔으며, Prometheus는 그대로입니다.
- nginx에 `/v1/corrections` 경로를 반영하고 `nginx -t` 통과 후 reload했습니다.
- `verify_loopback.sh`는 기존과 같이 통과했습니다(토큰 구분, `/metrics` 보호, 제출 거절 503, Prometheus `up` 1).<br>보정 지표 5개가 새로 보입니다.
- 이 PC에서 확인한 공개 경로입니다.<br>`/v1/availability`는 `corrections: false`, `/v1/corrections`는 열쇠 없이 POST하면 401, GET은 403, 확장 출처의 사전 요청(preflight)은 200과 해당 출처 허용, `/v1/status`는 403, `/metrics`는 404입니다.
- 서버의 자막 보정은 `ONSORI_CORRECTION=disabled` 상태입니다.<br>DeepInfra 연결 코드는 아래 ‘파일럿 서버 DeepInfra 연결 배포’에서 올렸습니다.

### 파일럿 서버 DeepInfra 연결 배포(2026-11-13)

- 배포 전에 서버 코드(`cloud_gateway/`, `deploy/cloud/`), SQLite 데이터베이스(SQLite 백업 기능으로 복사, 무결성 검사 ok), 이전 이미지 ID를 `/root/onsori-backup-20261113b`에 백업했습니다.<br>이전 이미지(`sha256:a9a3880c…`)는 `onsori-pilot-gateway:pre-20261113b` 태그로 남겨 두었습니다.
- 바뀐 파일 8개(`cloud_gateway/app.py`·`requirements.txt`·`.env.example`, `deploy/cloud/preflight.py`·`enable_correction.sh`·`check_correction.sh`·`.env.example`·`RUNBOOK.ko.md`)를 올리고, 서버 사본의 SHA-256이 저장소와 같음을 확인했습니다.
- `preflight.py` 통과 후 gateway 이미지를 다시 빌드했습니다(`sha256:25d704f8…`).<br>gateway만 재생성했고 약 32초 만에 healthy 상태가 됐습니다.<br>Prometheus와 nginx는 바꾸지 않았습니다.
- `verify_loopback.sh`는 이전과 같이 통과했습니다(토큰 구분, `/metrics` 보호, 제출 거절 503, Prometheus `up` 1).
- 이 PC에서 공개 경로를 확인했습니다.<br>`/v1/availability`는 새 항목 `correction_provider`와 함께 `corrections: false`를 알려 줍니다.<br>`/v1/corrections`는 열쇠 없는 POST 401, GET 403, 확장 출처의 사전 요청 200이고, `/v1/status`는 403, `/metrics`는 404입니다.
- 보정 요청과 유료 호출은 0회입니다.<br>운영자가 서버에서 `bash enable_correction.sh`로 DeepInfra 키를 넣으면 보정이 켜집니다.
- 서버에서 확인하던 중 `enable_correction.sh`의 키 형식 검사가 UTF-8 환경에서 정상 키를 거절하는 문제를 찾았습니다.<br>`LC_ALL=C`로 검사하고 붙여 넣은 줄끝(`\r`)을 지우도록 고쳐 서버에 다시 올렸습니다(SHA-256 일치).
- 운영자가 서버에서 DeepInfra 키를 넣어 보정을 켰습니다.<br>`/v1/availability`는 `corrections: true`, `correction_provider: deepinfra`, `correction_model: deepseek-ai/DeepSeek-V4-Flash-0731`을 알려 줍니다.
- `check_correction.sh`로 합성 문장 2줄을 보정했습니다.<br>‘한국은행이 기준 금니를 올렸습니다’를 ‘한국은행이 기준 금리를 올렸습니다’로 고쳤고, 고칠 것이 없는 ‘네 맞습니다’는 그대로 두었습니다(HTTP 200, 입력 409토큰, 출력 36토큰, 1초 미만).<br>잔액 충전 전 시도 1회는 `correction_provider_billing`으로 끝나 실패 1회로 집계됐습니다.
