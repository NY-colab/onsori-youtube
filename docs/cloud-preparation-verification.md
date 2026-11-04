# 온소리 클라우드 연결 준비 검증 기록

검증일: 2026-10-30  
구분: **승인 전 로컬 준비본**. 배포·실제 AI 추론 완료 기록이 아니다.

## 실제 실행 결과

| 대상 | 결과 | 검증 범위 |
| --- | --- | --- |
| Gateway | 37개 통과 | 토큰 분리, 실제 WAV 검증, 큐, idempotency, 취소, 재시작, TTL, 일일 한도, 제공자 응답·오류 계약 |
| 배포·n8n·Grafana | 6개 통과 | Compose/YAML/JSON 구조, 포트·자원 제한, workflow 연결·비활성 상태, 지표 이름과 credential 미포함 |
| 실제 HTTP 파일럿 연결 | 1개 통과 | Uvicorn 기동 → 합성 WAV 업로드 → 모의 완료 → Node 클라이언트 → 기존 core 스키마 → JSON 저장 → WAV 삭제·metrics 확인 |
| 클라이언트 경계 | 8개 통과 | HTTP/URL·동의·과금 선택·재시도 금지·완료/영상/모의 결과 검증·경로 주입 거부 |
| 기존 확장과 검토 화면 | 110개 통과 | 기존 전체 분석·OCR/참조·타이밍·크기·표시·X/Y·메시지/동의 회귀 검사 |

고유 검사 **162개 통과**. Python 검사 44개는 기존 Python 3.10.20 환경에서 먼저 실행한 뒤, 새 독립 Python 3.12.14 환경에서도 통과했다. 환경을 바꿔 반복한 44개를 별도의 검사 수로 더하지 않았다. Node는 v24.11.1이다. 모든 실행은 Windows 로컬에서 수행했다.

Python 3.12 환경에는 `cloud_gateway/requirements-dev.txt`만 설치했다. 기존 torch·Whisper 가상환경을 서버 배포 의존성으로 가져오지 않았다. 테스트에서 Starlette의 httpx TestClient 지원 방식에 관한 deprecation 안내 1개가 나왔으며 실패는 없었다. 운영 HTTP 경로는 Uvicorn으로 별도 확인했다.

배포 ZIP을 별도 폴더에 풀어 Python 검사 44개와 클라이언트 검사 8개가 다시 통과하는 것도 확인했다. 최초 검사 로그 수집에서 Windows 문자 인코딩 오류가 있었지만 시험 프로세스는 정상 종료했고, UTF-8 설정 후 다시 수집해 44개 통과를 확인했다. 이는 제품 오류나 추가 고유 검사 건수로 계산하지 않는다. ZIP은 CRC와 파일별 SHA-256을 검증했으며 전체 확장 프로그램은 포함하지 않는다.

## 실행 명령

프로젝트의 `outputs/onsori`에서 실행했다. 가상환경 경로는 이 작업 공간 기준이다.

```powershell
../../work/onsori/cloud-py312/Scripts/python.exe -m pytest tests/test_cloud_gateway.py tests/test_cloud_assets.py tests/test_cloud_pilot.py -q --tb=short --basetemp='../../work/onsori/cloud-prep-tests-py312' -o cache_dir='../../work/onsori/cloud-prep-pytest-cache-py312'
node --test integrations/client/cloud-client.test.mjs
node --test extension/*.test.mjs web/review.test.mjs
```

## 모의 연결 시험의 정확한 의미

- 입력: 1초짜리 mono/16kHz/PCM16 무음 WAV. 실제 영상의 소리가 아니다.
- 분석: `ONSORI_PROVIDER=mock`, `ONSORI_ALLOW_PAID=false`, 제공자 API 키 없음.
- 출력: `SYNTHETIC MOCK`로 표시한 합성 대사 1개, 영상 ID와 시간 길이 보존, `scale=1`, `review_required=true`.
- 확인: 클라이언트가 기존 확장의 `validateDocument`로 검사한 뒤 파일 저장, 서버 원본 WAV 삭제, 완료 지표 1건 집계.
- 서버: 시험 중 loopback으로만 열었고 시험 종료 시 해당 프로세스를 종료했다. 상시 실행 서버를 남기지 않았다.

이 시험은 **연결·데이터 규격·정리 동작**의 증거다. 무음에서 대사를 인식했다고 보거나, Nemotron의 한국어 정확도·음악 설명·자막 크기 품질을 검증했다고 해석하면 안 된다.

## 검토 과정에서 반영한 사항

- Docker 빌드 context를 최소 파일 허용 목록으로 제한하는 `.dockerignore` 추가. 모델·오디오·가상환경·키·시험 데이터가 빌드에 들어가지 않게 했다.
- 외부 API는 고정 주소만 사용하고 redirect·자동 재시도·환경 프록시 의존을 차단했다.
- 타임스탬프가 없거나 범위를 벗어나면 임의 시각을 만들지 않고 실패 처리한다.
- 기본 provider는 disabled이며 mock 결과는 실제 결과와 구별한다. 사용자가 보는 기존 확장의 동작은 바꾸지 않았다.
- 원격 대사 결과에는 음악·효과음·측정 음량·OCR 개선이 들어 있다고 표시하지 않는다.
- nginx 예시는 승인된 IP만 허용하고 요청 빈도·동시 연결·본문 시간 제한을 둔다. Gateway 임시 공간은 동시 업로드 여유를 고려해 96MiB로 설정했다.
- 원본 음성·API 키·시험 DB를 ZIP 허용 목록에서 제외한다. 배포 묶음은 구성 파일·코드·검사와 문서만 포함한다.

## 2026-10-30 추가 확인: 지원 서비스 계정

aitestbed.kr 마이스튜디오 기준 n8n·Grafana는 2026-10-30 승인(서비스 종료 2027-01-30), **클라우드는 신청중**이다. 같은 날 기술지원 요청(유형 클라우드 DevOps: 클라우드 승인 일정, Grafana 데이터소스, 대시보드 공개 범위, n8n 송신 IP)을 등록했고 답변대기다.

| 대상 | 실제 확인 | 아직 못 한 것 |
| --- | --- | --- |
| n8n 2.44.6 (`n8n.aitestbed.kr`, 개인 프로젝트) | `⋯ → Import from File`로 두 workflow를 가져와 저장. Manual Trigger v1·Set v3.4·If v2.2·HTTP Request v4.2 모두 인식(알 수 없는 노드 0). 경고는 HTTP 노드의 `Credentials for 'Header Auth' are not set` 각 1건(의도된 미연결). health workflow를 placeholder 상태로 1회 수동 실행 → `Validate configuration`의 false 분기에서 멈추고 Health·Admin status 미실행 | credential 생성·연결, 실제 Gateway GET, job workflow 실행. 서버 승인 후 진행. Publish(활성화)는 하지 않음 |
| Grafana 12.4.13 OSS (`grafana.aitestbed.kr`, SSO) | 여러 팀이 쓰는 Main Org.의 Editor. 데이터소스 0개, `datasources:create`/`write` 권한 없음, Prometheus 플러그인은 설치됨 | 데이터소스는 운영측 생성 또는 권한 부여 필요. 대시보드 import·패널 렌더 미실행 |

n8n 2.x에서는 활성화 스위치 대신 **Publish**가 있고, 로그인 세션이 탭 단위로 묶이는 것으로 보인다. 다른 탭에서 같은 주소를 열거나 도구로 REST를 직접 호출한 뒤 기존 탭이 `Session expired`로 끊긴 일이 있었다. 운영 작업은 로그인한 탭 하나에서 화면 조작으로 한다.

## 아직 실행하지 않은 검사

아래 목록은 2026-10-30 기준이다. 1~4번은 2026-11-04 파일럿 서버에서 실행했다([파일럿 서버 검증](cloud-pilot-verification-2026-11-04.md)). 재부팅·부하·백업 복구는 그 기록의 남은 작업에 옮겼다.

1. Docker 이미지 빌드와 Compose 기동: 로컬 Docker가 없어 미실행. YAML 정적 검사와 애플리케이션 Python 3.12 실행만 완료했다.
2. Rocky Linux 8.10 서버의 SELinux·파일 권한·방화벽·TLS·부하·재부팅 검사: 클라우드 승인·접속 정보 필요(2026-10-30 신청중).
3. 지원 n8n 계정의 credential 연결·GET 요청 실행: 서버 필요. import·노드 버전·검증 분기는 위에서 확인.
4. 지원 Grafana 계정에서 실제 import·Prometheus 연결·패널 렌더: 데이터소스 권한과 서버 필요.
5. 실제 DeepInfra 요청·한국어 시간 정보·과금·외부 보관 정책: 계정·비용 선택·동의 샘플 필요. 이번에는 유료 요청 0회.
6. Chrome에서 원격 결과 자동 표시: 사용자별 인증·도메인·클라이언트 통합 후 시험할 항목. 이번에는 실제 YouTube 영상으로 새 원격 경로를 시험하지 않았다.
7. Demucs/Bandit/CoNeTTE 신규 모델 실행과 비교 평가: 별도 모델 환경·평가 자료를 준비하는 후속 단계.

## 현재 배포 경계

현재 `extension/manifest.json`은 0.3.3이며 기존 확장 파일은 변경하지 않았다. GitHub 업로드, Chrome 웹 스토어 제출, 클라우드 배포, 지원 서비스 계정 변경은 이번 작업에서 수행하지 않았다. 운영자용 준비 파일을 일반 사용자용 완제품으로 배포하지 않는다.
