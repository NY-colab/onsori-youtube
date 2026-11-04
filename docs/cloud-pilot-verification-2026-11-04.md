# 「온소리 자막 in YouTube」 클라우드 파일럿 서버 검증

2026-11-04 기준 기록입니다.<br>클라우드 자원 승인(2026-11-02)과 기술지원 답변(2026-11-03)을 받은 뒤 운영자용 게이트웨이를 파일럿 서버에 올리고 n8n·Grafana와 연결했습니다.

## 현재 상태

| 구분 | 내용 |
| --- | --- |
| 구현 완료 | nginx 공개 경로 설정(`deploy/cloud/nginx/`), 서버 내부 점검 스크립트(`deploy/cloud/verify_loopback.sh`), Rocky Linux 8의 Python 3.6에서 동작하는 `preflight.py`, Grafana 대시보드 범례 이름 |
| 자동·모의 검사 | 클라우드 Python 검사 45개와 확장 프로그램 Node 검사 131개를 2026-11-04에 다시 실행해 모두 통과했습니다. |
| 실제 서버 검증 | 서버 내부 점검(disabled·mock), 이 PC에서 본 외부 접근 경계, n8n GET 워크플로 2개, Grafana 데이터 소스 연결과 대시보드 8개 패널 표시를 확인했습니다. |
| 배포 완료 | 파일럿 서버가 provider `disabled`, `ONSORI_ALLOW_PAID=false` 상태로 동작합니다.<br>유료 API 호출은 0회입니다.<br>Chrome 확장 프로그램의 원격 연결과 웹 스토어 반영은 이번 작업 범위에 넣지 않았습니다. |

## 서버 구성

| 항목 | 값 |
| --- | --- |
| 클라우드 | NAVER Cloud KR-1, 인스턴스 146650836 |
| 사용 기간 | 2026-11-02 ~ 2026-12-02<br>(*공식 안내는 종료 2주 전부터 1회 연장 신청을 받는다고 규정합니다.) |
| 운영체제 | Rocky Linux 8.10, 2 vCPU, 메모리 3.6GB, 호스트 Python 3.6 |
| 실행 환경 | Docker 26.1.3, Compose v2.27.0, nginx 1.24, certbot 1.22 |
| 접속 주소 | `https://211-233-192-122.sslip.io`<br>sslip.io는 주소 이름에 적힌 공인 IP로 연결해 주는 무료 이름 서비스입니다. |
| 인증서 | Let's Encrypt, 2027-02-02 만료<br>`certbot-renew.timer`가 자동 갱신하고 갱신 후 nginx를 다시 읽습니다. |
| 이미지 | Prometheus `prom/prometheus@sha256:63805ebb8d2b3920190daf1cb14a60871b16fd38bed42b857a3182bc621f4996`, gateway는 서버에서 빌드한 `sha256:8f009e93db58…` |

저장소의 `nginx.conf`, `onsori-pilot.conf`, `preflight.py`, `verify_loopback.sh`, `compose.yaml`, `prometheus.yml`은 서버 사본과 SHA-256이 같습니다.<br>서버에만 두는 파일은 Grafana 송신 주소 허용 목록(`/etc/nginx/onsori-grafana-allow.conf`), 기본 인증 해시(`/etc/nginx/onsori-prometheus.htpasswd`, 640 root:nginx), 기본 인증 원문(`/root/onsori-grafana-basic-auth.txt`, 0600), 토큰이 든 `.env`(0600)입니다.

## 외부 접근 경계

게이트웨이(8000)와 Prometheus(9090)는 서버 내부 주소(127.0.0.1)에만 열려 있습니다.<br>nginx는 아래 경로만 바깥으로 연결합니다.<br>작업 생성·삭제(POST·DELETE)는 서버 안에서만 실행합니다.

| 경로 | 허용 범위 | 이 PC에서 받은 응답 |
| --- | --- | --- |
| `/healthz` | 누구나, GET만 | 200 |
| `/v1/` | n8n 송신 주소 `180.210.76.21`만, GET만, 운영자 토큰 필요 | 403 |
| `/prometheus/` | Grafana 송신 주소 `180.210.76.21`만, 기본 인증 필요, 조회용 API(query·query_range·series·labels 등)만 | 403 |
| `/metrics` | 막음 | 404 |
| 그 밖의 경로 | 막음 | 404 |
| HTTP(80) | HTTPS로 이동 | 301 |
| IP 주소로 HTTPS 접속 | 인증서 교환 거부 | 연결 거부 |
| 8000·9090 포트 | 서버 내부 전용 | 연결 안 됨 |

(*기술지원 답변은 n8n의 고정 송신 IP를 `180.210.76.21/32`로 안내했습니다.)<br>Grafana 데이터 소스 시험 요청도 같은 주소에서 들어오는 것을 nginx 기록으로 확인했습니다.<br>nginx 접근 기록에는 접속 주소·시각·메서드·경로·응답 코드만 남기고 쿼리 문자열과 인증 헤더는 남기지 않습니다.

## 서버 내부 점검

`deploy/cloud`에서 `bash verify_loopback.sh`를 실행했습니다.<br>스크립트는 `.env`에서 토큰을 읽어 쓰고 화면에 출력하지 않습니다.

**disabled 상태(최종)**

- `healthz`는 `{"status":"ok"}`입니다.
- 토큰 없이 `/v1/status`를 부르면 401, 지표용 토큰으로 부르면 401입니다.
- 운영자 토큰으로 부르면 `provider: disabled`, `enabled: false`, `scope: speech-only`를 돌려줍니다.
- 운영자 토큰으로 `/metrics`를 부르면 401이고, 지표용 토큰으로는 `onsori_` 지표 17개를 받습니다.
- 1초 무음 합성 WAV 제출은 `503 provider_disabled`로 거절합니다.
- Prometheus의 `up{job="onsori"}`는 1입니다.

**mock 상태(시험)**

- 1초 무음 합성 WAV 제출로 작업 `24c73b362e2f4a6f988fb7e6dd26afcb`를 만들었습니다.
- 작업은 `done`으로 끝났고 자막 1줄에 `synthetic: true`, `review_required: true` 표시가 붙었습니다.
- 작업이 끝난 뒤 서버에 남은 WAV 파일은 0개입니다.
- 같은 Idempotency-Key로 다시 제출하면 새 작업 없이 200을 돌려줍니다.

## n8n 연결 (`n8n.aitestbed.kr`)

- Header Auth 자격 증명 `OnSori Operator Bearer`를 만들었습니다.<br>헤더 이름은 `Authorization`, 허용 도메인은 `211-233-192-122.sslip.io` 하나입니다.
- 「OnSori manual health and status」를 실행해 `Health` 200, `Admin status` 200(`provider: mock`, `enabled: true`, `synthetic: true`, 완료 작업 1건)을 받았습니다.
- 「OnSori manual job status」에 `base_url`과 위 작업 ID를 넣고 실행해 `Get job` 200, `status: done`, `Terminal state` true 분기를 확인했습니다.<br>응답에는 합성 자막 1줄과 "SYNTHETIC MOCK" 경고가 들어 있습니다.
- 두 워크플로 모두 Manual Trigger로만 실행하며 Publish(활성화)는 누르지 않았습니다.

## Grafana 연결 (`grafana.aitestbed.kr`, 조직 84)

- 데이터 소스 `OnSori Pilot Prometheus`를 만들었습니다.<br>주소는 `https://211-233-192-122.sslip.io/prometheus`, 인증은 기본 인증(사용자 `grafana`), 요청 방식은 POST입니다.
- Save & test 결과는 "Successfully queried the Prometheus API."입니다.
- 폴더 `OnSori Pilot`을 만들고 `integrations/grafana/onsori-operations.json`을 가져와 대시보드 `OnSori operator pilot`(uid `onsori-pilot`)을 만들었습니다.
- 8개 패널이 모두 표시됩니다.<br>종료 작업 누적(done 1), 진행 중 작업(0), 1시간 오류 작업(0), 제공업체 오디오 초(0), 게이트웨이 저장 용량, Prometheus 수집 상태(1)를 그립니다.<br>완료 시간 p95·평균 패널은 최근 5분 안에 끝난 작업이 없어 비어 있습니다.
- 범례가 지표 원문(`{__name__=…}`)으로 보이던 7개 패널에 이름을 붙여 다시 가져왔습니다.
- 조직 84의 구성원은 본인 계정 1명(Admin)입니다.<br>폴더·대시보드·데이터 소스는 이 계정만 볼 수 있습니다.

## 보안 조치

- 운영자 토큰과 Grafana 기본 인증 비밀번호가 대화 기록에 노출되어 14:23에 두 값을 새로 발급했습니다.<br>이전 토큰은 401로 거절되고 새 토큰은 200으로 통과하는 것을 확인했습니다.
- 새 값은 서버에서 `Set-Clipboard`로 바로 복사해 붙여 넣었습니다.<br>Windows PowerShell 5.1에서 `| clip`으로 복사한 값은 글자가 바뀌어 인증에 실패했습니다.<br>n8n Value 칸은 Fixed 모드에서 붙여 넣어야 하며 Expression 모드로 저장하면 토큰 대신 다른 값이 전송됩니다.
- 원인을 찾을 때 인증 헤더의 길이·앞부분 형태만 분류하는 임시 nginx 기록을 사용했습니다.<br>확인 후 임시 설정과 기록 파일을 삭제했습니다.
- 작업이 끝난 뒤 PC 클립보드에 남은 토큰을 지웠습니다.
- 운영자 토큰은 확장 프로그램에 넣지 않았습니다.

## 남은 작업

| 항목 | 상태 |
| --- | --- |
| SSH 22번 포트 | 모든 주소에 열려 있고 root 비밀번호 로그인이 가능합니다.<br>NAVER Cloud 접근 제어(ACG)에서 접속 IP를 제한할지 결정이 필요합니다. |
| 인증서 갱신 시험 | `certbot renew --dry-run`은 Let's Encrypt 시험 서버 연결이 끊겨 실패했습니다.<br>운영 서버 `/directory`는 200으로 응답합니다.<br>현재 인증서는 사용 기간이 끝난 뒤인 2027-02-02에 만료됩니다. |
| 재부팅 후 자동 기동 | 예정 |
| 백업·복구 | 예정 |
| 유료 모델(DeepInfra) | 비용·전송 동의·사용자 인증을 확정하기 전까지 꺼 둡니다. |
| Chrome 확장 프로그램 원격 연결 | 사용자 인증 방식을 확정한 뒤 진행합니다. |
| 사용 기간 연장 | 2026-11-18부터 신청할 수 있습니다. |
