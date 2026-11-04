# 클라우드 연결 파일럿 클라이언트

승인된 서버를 운영자가 시험하는 Node 22+ 도구다. 브라우저 확장 프로그램에 운영자 토큰을 저장하거나 포함하지 않는다. 현재 확장 0.3.3을 변경하지 않고 서버가 만든 대사 검토용 JSON을 기존 `extension/core.js`로 검증한다. 사용자에게 공개하는 자동 클라우드 연결 UI는 별도 사용자 인증·HTTPS origin·동의/개인정보 문구를 확정한 뒤 구현한다.

## 실행

1. [서버 운영 절차](../../deploy/cloud/RUNBOOK.ko.md)에 따라 `disabled` 서버를 구성하고, 우선 `mock`으로 연결을 검증한다.
2. 현재 셸에 `ONSORI_GATEWAY_URL`과 `ONSORI_API_TOKEN`을 안전하게 주입한다. 토큰을 명령 인자·스크린샷·Git에 넣지 않는다. URL은 경로가 없는 승인된 HTTPS origin이다.
3. 동의받은 mono/16kHz/PCM16 WAV를 준비한다. 최대 20분·40MiB다. 파일 준비는 분석 대상에 대한 사용 권한을 전제로 한다. 이 도구는 YouTube 영상이나 URL을 다운로드하지 않는다.
4. 아래 예시는 프로젝트 루트에서 실행한다. 실제 입력/출력 경로를 지정하고 출력 파일은 존재하지 않아야 한다.

인자와 값은 다음처럼 공백으로 분리한다.

```sh
node scripts/cloud_pilot.mjs --audio work/pilot.wav --out work/pilot-review.json --video-id -wbEQJ_ZXyk --consent --mock
```

`--mock` 결과는 합성 시험 자막이며 실제 영상에 적용하지 않는다. 로컬 비과금 시험에 한해 `--loopback`으로 `http://127.0.0.1:포트`를 허용한다. 유료 외부 분석은 비용과 업로드 동의가 확정되고 서버의 두 과금 설정이 켜진 경우에만 `--mock` 대신 `--paid`를 사용한다. 이번 준비 작업에서는 유료 호출을 하지 않았다.

프로그램은 업로드 전 idempotency key, 접수 후 작업 ID를 출력한다. 연결이 끊겨도 새 작업을 자동 제출하지 않는다. 응답을 못 받은 경우 출력된 동일 `--key`와 같은 파일/제목/영상 ID로 확인할 수 있다. 작업 ID를 받았다면 업로드하지 말고 조회를 재개한다.

```sh
node scripts/cloud_pilot.mjs --job 실제작업ID --out work/pilot-review.json --video-id -wbEQJ_ZXyk --paid
```

결과는 대사만 담는다. 원본 자막/화면 자막 대조, 음악·효과음 분석, 측정한 음량에 따른 크기 변환은 아직 이 경로에 포함하지 않았다. `scale=1`, `review_required=true`를 유지한다. 실제 결과를 검토한 뒤 기존 온소리의 JSON 가져오기 기능으로 시험할 수 있으나, 기존 자막 전체를 교체할 수 있으므로 먼저 내보내기로 보관한다. 음악/효과음이 포함된 기존 결과와 자동 병합하지 않는다.

## 자동 검증

```sh
node --test integrations/client/cloud-client.test.mjs
python -m pytest tests/test_cloud_pilot.py -q
```

두 번째 검사는 loopback 서버를 실제로 띄우고 1초 무음 WAV를 전송한다. 합성 결과 수신 → 기존 자막 스키마 검증 → JSON 저장 → 서버 원본 음성 삭제 → 지표 집계까지 확인한다. 한국어 인식 정확도·유료 서비스 응답·Rocky 서버 배포·YouTube 표시를 검증하는 시험은 아니다.
