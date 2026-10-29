# 웹스토어 제출 자료 · 0.3.3

현재 상태: **미제출**. GitHub 공개, ZIP 생성, 테스트 통과는 Chrome 웹스토어 제출·승인과 다릅니다. 확장 ID나 승인 URL은 실제 대시보드 결과를 받은 뒤에만 기록합니다.

## 제출물

- `OnSori-Chrome-WebStore-0.3.3.zip`: 브라우저 확장만 포함합니다. ZIP 최상위에 manifest.json이 있습니다. EXE나 Python 소스 ZIP을 올리지 마세요.
- `store-icon-128.png`: 128×128 스토어 아이콘.
- `screenshot-01-start.png`: 현재 0.3.3에 포함된 실제 help.html 시작 안내 화면을 1280×800으로 렌더한 이미지입니다. YouTube 분석 화면으로 오인하지 않습니다.
- `webstore-listing.json`: 한국어 설명, 단일 목적, 권한 사유, 데이터 처리, 심사자 실행 안내의 원문.
- `등록도우미.html`: 위 문구 15개를 항목별 복사 버튼으로 옮길 수 있는 로컬 안내 화면입니다. 스토어 업로드 ZIP에는 넣지 않습니다.
- 공개 개인정보처리방침: https://github.com/NY-colab/onsori-youtube/blob/main/docs/privacy-browser.md

## 대시보드 작업

1. [개발자 대시보드](https://chrome.google.com/webstore/devconsole) → **새 항목** → 확장 ZIP 업로드.
2. 스토어 등록정보: 설명·한국어·적절한 접근성 분류·아이콘·스크린샷을 입력합니다. 지원 URL은 GitHub Issues입니다.
3. 개인정보: 단일 목적과 권한별 사유를 채우고 처리방침 URL을 넣습니다. 모델 가중치는 데이터이며 실행 코드·WASM은 ZIP에 동봉되어 있으므로 원격 코드 없음입니다.
4. 웹사이트 콘텐츠, 현재 YouTube 영상과 재생 활동, 로컬 자막 캐시에 대한 데이터 처리를 정직하게 공개합니다. 외부 서버로 전송하지 않는다는 이유로 데이터 처리 없음이라고 답하지 않습니다. 불필요한 개인정보·금융·건강·인증정보 항목은 선택하지 않습니다.
5. 심사자 안내를 추가하고 무료·공개 배포 범위를 확인한 뒤 심사에 제출합니다. 개인정보·주소·거래자 여부·계정 인증은 확인된 사실에 따라 계정 소유자가 입력합니다. 게시자를 임의로 사업자 또는 비사업자로 선언하지 않습니다.
6. 제출 확인 화면의 확장 ID·상태·URL을 기록합니다. 승인되기 전에는 ‘Chrome에 추가’ 공개 링크가 생겼다고 안내하지 않습니다.

## 사용자가 직접 해야 하는 범위

Google 로그인·본인 인증·개발자 약관 동의·계정 사실 확인은 계정 소유자가 수행합니다. 개발자 등록은 이번 대화에서 이미 완료됐다고 확인했습니다. 계정 인증 정보나 결제 정보를 채팅에 보내지 않아도 됩니다.

2026-10-25에는 자동화 도구가 Windows Chrome의 현재 URL을 확인하지 못해 화면 조작이 중단되었습니다. 같은 턴에서 다른 자동화 경로로 계정 화면을 우회 조작하지 않습니다. 이 제한이 계속되면 준비된 ZIP 업로드와 제출 클릭도 계정 소유자가 해야 하며, 코드·자료 준비는 대신 수행합니다.

## 확인한 공식 문서

- [개발자 등록](https://developer.chrome.com/docs/webstore/register)
- [웹스토어 게시](https://developer.chrome.com/docs/webstore/publish)
- [이미지 규격](https://developer.chrome.com/docs/webstore/images)
- [개인정보 필드](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)
- [로컬 처리도 공개해야 하는 사용자 데이터 FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)
- [MV3 원격 코드 요건](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements)

## 2026-10-29 등록 시도

Chrome 새 탭 열기 요청은 `Not allowed`로 거부됐습니다. 사용자가 연 웹스토어 등록 탭을 대상으로 다시 확인했으나 `The extensions gallery cannot be scripted.`로 접근이 차단됐습니다. 우회 조작하지 않았고 업로드·심사 제출은 수행하지 않았습니다. 현재 탭 제목은 개발자 계약이고 URL은 `/webstore/devconsole/register`로 확인됐습니다. 이미 등록한 다른 Google 계정이 있다면 그 계정인지 먼저 확인해야 합니다. 실제 개발자 계약·본인 인증·등록비 결제는 계정 소유자가 직접 처리합니다.
