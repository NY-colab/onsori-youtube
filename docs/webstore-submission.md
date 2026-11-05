# 「온소리 자막 in YouTube」 · 웹스토어 등록자료 0.3.9

0.3.9 업로드 자료를 준비했습니다.<br>0.3.8의 GPU 대사 분석·선택형 클라우드 대사 분석과 0.3.9의 소리 표기(효과음 ♪…♪, 배경음악 ♬…♬)가 들어 있습니다.<br>Chrome은 확장 프로그램이 웹스토어 화면을 조작하지 못하게 막아 두어, ZIP 업로드와 심사 제출은 계정 소유자가 개발자 대시보드에서 직접 합니다.

## 제출물

- `OnSori-Chrome-WebStore-0.3.9.zip`: 브라우저 확장만 포함합니다. ZIP 최상위에 manifest.json이 있습니다.
- `store-icon-128.png`: 128×128 스토어 아이콘.
- `screenshot-01-intro.png`: 서비스 소개 상세 이미지입니다(1280×800).
- `screenshot-02-analysis.png`: 영상 분석 안내 상세 이미지입니다(1280×800).
- `screenshot-03-settings.png`: 자막 크기·위치 소개 상세 이미지입니다(1280×800).
- 상세 이미지는 기존 등록자료의 서비스 소개 → 영상 분석 → 자막 크기·위치 흐름에 맞췄습니다.<br>마이 AI 랩 원본 파일 기준 (2) → (1) → (3) 순서이며 PNG 원본을 그대로 복사했습니다.
- `webstore-listing.json`: 한국어 설명, 단일 목적, 권한 사유, 데이터 처리, 심사자 실행 안내의 원문.
- `등록도우미.html`: 위 문구 15개를 항목별 복사 버튼으로 옮길 수 있는 로컬 안내 화면입니다. 스토어 업로드 ZIP에는 넣지 않습니다.
- 공개 개인정보처리방침: https://github.com/NY-colab/onsori-youtube/blob/main/docs/privacy-browser.md

## 대시보드 작업

1. [개발자 대시보드](https://chrome.google.com/webstore/devconsole) → 기존 **온소리 자막 in YouTube** 항목 → 새 확장 ZIP 업로드.
2. 스토어 등록정보: 설명·한국어·적절한 접근성 분류·아이콘·스크린샷을 입력합니다. 지원 URL은 GitHub Issues입니다.
3. 개인정보: 단일 목적과 권한별 사유를 채우고 처리방침 URL을 넣습니다. 모델 가중치는 데이터이며 실행 코드·WASM은 ZIP에 동봉되어 있으므로 원격 코드 없음입니다.
4. 웹사이트 콘텐츠, 현재 YouTube 영상과 재생 활동, 로컬 자막 캐시에 대한 데이터 처리를 정직하게 공개합니다. 0.3.8부터 사용자가 동의하면 영상 오디오·영상 ID·제목을 온소리 서버와 DeepInfra로 보내므로, 이 전송을 데이터 처리 설명에 포함합니다(`webstore-listing.json`의 데이터 처리 설명). 불필요한 개인정보·금융·건강·인증정보 항목은 선택하지 않습니다.
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

## 2026-11-05 0.3.9 제출

Browser Use 플러그인으로 사용자의 Chrome에서 개발자 대시보드를 조작해 0.3.9를 심사에 제출했습니다.<br>항목 ID는 `faoookmndmicfapakdnelnepfdcphgkp`입니다.<br>제출 후 대시보드 상태는 **검토 대기 중**이고, 항목 목록에 버전 0.3.9로 표시됩니다.<br>공개 버전은 승인 전까지 0.3.3으로 유지됩니다.<br>제출 화면에서 기본값인 ‘검토 통과 후 자동으로 게시’를 켠 채로 제출했습니다.

- 패키지: `OnSori-Chrome-WebStore-0.3.9.zip`을 업로드했습니다.<br>SHA-256 `fa6143942231de893a8b6be313b82ce90bda601aa771ae70ed97ac4373f9d524`이 `SHA256SUMS.txt`와 일치함을 확인했습니다.
- 스토어 등록정보: 상세 설명을 `webstore-listing.json` 원문으로 교체했습니다.<br>홈페이지 URL(GitHub 저장소)과 지원 URL(GitHub Issues)을 입력했습니다.<br>아이콘·상세 이미지 3장·프로모션 타일은 이미 등록되어 있어 그대로 두었습니다.
- 개인정보 보호: 단일 목적과 storage·activeTab·tabCapture·offscreen·호스트 권한 사유를 listing 원문으로 교체했습니다.<br>원격 코드는 ‘아니요’이며, 이 경우 근거 칸이 비활성화되어 설명을 입력하지 않았습니다.<br>데이터 항목은 웹 기록·사용자 활동·웹사이트 콘텐츠와 확인 3항목을 유지했습니다.<br>데이터 처리 설명은 대시보드에 별도 칸이 없어 상세 설명에 포함한 문구로 공개합니다.<br>개인정보처리방침 URL은 listing의 `privacy_policy_url`과 같습니다.
- 테스트 안내: ‘추가 안내’ 칸이 500자 제한이라 심사자 안내 원문 대신 0.3.8·0.3.9 변경점을 담은 영어 요약 496자를 저장했습니다.
- 배포: 무료·공개·기존 지역 설정을 유지했습니다.<br>계정의 사업자 선언과 테스트 사용자 이름은 기존 값을 바꾸지 않았습니다.
- 사용자가 입력 요약을 확인하고 ‘그대로 제출’을 승인한 뒤 제출했습니다.
