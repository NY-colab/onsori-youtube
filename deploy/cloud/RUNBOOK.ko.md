# OnSori 클라우드 운영 준비본

이 패키지는 자원 승인 전에 준비한 운영자 전용 파일이다. 대상은 Rocky Linux 8.10 호스트와 Python 3.12 컨테이너다. 2026-11-02 클라우드 승인 후 2026-11-04 파일럿 서버에 이 절차를 적용했고 이미지 빌드, Compose 기동, HTTPS, n8n GET, Grafana 연결을 실제로 확인했다. 결과와 서버 값은 [파일럿 서버 검증](../../docs/cloud-pilot-verification-2026-11-04.md)에 기록했다. 유료 API 호출은 하지 않았다.

## 승인 후 연결 순서

1. 운영자가 서버/리전/요금/저장공간, 승인 도메인·TLS, 방화벽과 접근 IP, DeepInfra 계정·모델·요율·분당/월간 한도, 보관 기간, n8n/Grafana 서비스 URL·버전을 확정한다. 식별자와 API 키는 현재 미입력이다. 이미지 태그는 준비용이며 실제 배포 전 보안 점검 후 digest로 고정한다. Docker Engine 및 Compose plugin 설치 여부도 확인한다. 자동 설치 스크립트는 제공하지 않는다.
2. 승인된 호스트에 프로젝트를 복사한다. 아래 명령은 **승인 후 운영자가 실행하는 절차**다. `deploy/cloud`에서 `python3 preflight.py --init`를 한 번 실행하면 서로 다른 임의 토큰과 `disabled` 설정을 로컬에 만든다. 기존 설정이 있으면 덮어쓰지 않는다. `.env`와 `secrets/`는 Git에 넣지 않는다. `.env`는 0600, 비밀 디렉터리는 0700이며 Prometheus의 컨테이너 UID가 토큰 파일을 읽을 수 있도록 파일만 0444다. Windows 권한 대신 실제 Linux 권한을 확인한다. 호스트 root/Docker 운영자는 이 파일과 컨테이너 환경을 볼 수 있다.
3. `python3 preflight.py`와 `docker compose config --quiet`로 검사한다. preflight는 네트워크를 쓰지 않으며 Docker 존재만 표시한다. `docker compose build gateway`, `docker compose up -d`는 승인 후에만 실행한다. `docker compose exec prometheus promtool check config /etc/prometheus/prometheus.yml`, `docker compose ps`, `curl --fail http://127.0.0.1:8000/healthz`로 실제 기동을 확인한다. 이어서 `bash verify_loopback.sh`로 토큰 구분, `/metrics` 보호, 제출 거절(disabled) 또는 합성 job 처리(mock), Prometheus scrape를 한 번에 확인한다. 스크립트는 `.env`의 토큰을 출력하지 않는다. Rocky Linux 8 호스트의 `python3`는 3.6이며 `preflight.py`와 이 스크립트는 3.6에서 동작한다. 로그에 키·음성·인증 헤더를 붙여 넣지 않는다.
4. 기본 provider는 `disabled`다. 별도 승인 후 `.env`의 `ONSORI_PROVIDER=mock`만 바꾸고 gateway를 재생성해 비과금 기능을 검증한다. 생성/조회/삭제는 운영자 토큰으로 실행한다. POST는 mono/16kHz/PCM16 WAV와 `title`, `video_id`, `language`, `consent=true`, 고유 `Idempotency-Key`가 필요하다. 응답 job ID로 상태를 확인한다. 사용자 음성은 동의와 삭제 정책이 확정되기 전 올리지 않는다. provider를 바꾸기 전에 진행 중인 job을 종료한다.
5. 승인된 호스트 nginx에 HTTPS 예시를 적용하기 전 도메인·인증서 경로와 운영자/n8n의 고정 송신 IP를 지정하고 `nginx -t`로 검사한다. 예시는 loopback 이외 `/v1/` 접근을 기본 차단한다. `8000`, `9090`은 호스트 loopback에만 바인딩하고 방화벽에서 공개하지 않는다. nginx는 `/metrics`와 그 하위 경로를 차단한다. 게이트웨이의 운영자 Bearer 토큰을 브라우저 확장 프로그램에 넣지 않는다. 파일럿 서버에는 `nginx/nginx.conf`(기본 서버 444·IP 접속 TLS 거부·query 없는 접근 기록)와 `nginx/onsori-pilot.conf`를 적용했다. `/v1/`은 n8n 송신 IP `180.210.76.21`의 GET만, `/prometheus/`는 `/etc/nginx/onsori-grafana-allow.conf`의 Grafana 송신 IP와 기본 인증(`/etc/nginx/onsori-prometheus.htpasswd`, 640 root:nginx)을 함께 통과한 조회 API만 연결한다. 인증서는 certbot webroot(`/var/www/acme`)로 받고 `certbot-renew.timer`와 nginx reload deploy hook으로 갱신한다.
6. n8n은 아래 별도 절차로 비활성 workflow를 가져온다. 연결 확인은 GET만 사용한다. 외부 Grafana 연결은 아래 별도 네트워크 결정 이후 수행한다.
7. DeepInfra 과금 승인을 받은 경우에만 운영자 한도/알림을 제공업체 콘솔에서 먼저 설정하고 API 키를 입력한다. `ONSORI_PROVIDER=deepinfra`, `ONSORI_ALLOW_PAID=true`가 함께 있어야 호출을 허용한다. 이 스위치는 월 예산 차단 장치가 아니다. 실제 모델 제공 여부·가격·응답 계약·대기열/오류/삭제/한도 초과 동작을 소규모 동의 음성으로 검증한 뒤 운영한다. 승인 전에는 `disabled` 또는 `mock`을 유지한다.

## 자원·보관·단일 워커

호스트 4GB 전체에 n8n과 Grafana까지 설치하지 않는다. 이 Compose는 gateway 768MiB/1 CPU, Prometheus 512MiB/0.5 CPU만 사용한다. 합계 1280MiB는 컨테이너 메모리 제한이며 OS·Docker·TLS proxy·빌드 캐시·파일시스템 캐시를 포함한 호스트 사용량 보장은 아니다. gateway는 SQLite와 프로세스 내부 작업 처리를 위해 Uvicorn **1 worker**로 고정한다. 수평 확장이나 여러 worker 사용은 별도 큐/DB 설계가 필요하다.

Prometheus는 7일/512MB retention을 함께 적용하고 로그는 서비스당 10MB × 2개로 순환한다. Prometheus WAL/현재 블록/볼륨 전체가 정확히 512MB 이하라는 뜻은 아니다. `onsori_storage_bytes`는 게이트웨이 저장량이며 호스트 여유 디스크나 Prometheus 용량을 대신하지 않는다. gateway 기본값은 대기열 4개(`ONSORI_MAX_QUEUE`), 일일 오디오 60분(`ONSORI_DAILY_AUDIO_MINUTES`), 결과 TTL 24시간(`ONSORI_RESULT_TTL_SECONDS`), 정리 주기 60초다. 음성은 작업 종료/삭제/정리 경로에서 제거하며 실제 보관·삭제 동작은 gateway 문서와 검증 결과를 확인한다. 일일 오디오 한도는 게이트웨이 수준 제약이며 제공업체의 전체 계정 과금 한도가 아니다. nginx는 multipart 여유를 포함해 42MiB 요청 상한을 두며 애플리케이션은 WAV 40MiB/20분 상한을 별도로 적용한다. 운영자는 디스크 여유와 Docker 볼륨을 별도로 감시하고 파일 보관 정책을 확정한다. 준비본에는 검증되지 않은 CPU·정확도 지표를 만들지 않았다.

## n8n 가져오기

`integrations/n8n/manual-health-status.json`, `manual-job-status.json`을 각각 import한다. workflow는 비활성이고 Manual Trigger만 있으며 예약·Webhook·job 생성·삭제·유료 호출·자동 재시도가 없다. SaaS의 환경변수 접근에 의존하지 않는다.

- `Configure` Edit Fields 노드의 `base_url`을 승인된 **HTTPS origin**으로 바꾼다. 경로·query·마지막 slash 없이 `https://approved.example` 형식이다. placeholder/HTTP/잘못된 origin은 `Validate configuration`의 false 출력에서 멈춘다. 잘못된 설정은 성공 결과가 아니므로 이 노드를 확인한다.
- n8n Credentials에서 **Header Auth**를 만들고 이름을 `OnSori Operator Bearer`로 지정한다. Header Name은 `Authorization`, Value는 `Bearer ` 뒤 운영자 API 토큰이다. JSON에는 credential ID나 토큰을 넣지 않았다. 각 `Admin status`/`Get job` 노드의 Generic Credential Type → Header Auth에서 이 자격증명을 수동 선택한다. 미연결 상태에서는 인증 요청을 실행할 수 없다. metrics token을 선택하지 않는다.
- job workflow의 `job_id`를 실제 응답 ID로 바꾼다. 한 번의 실행은 조회 1회만 수행한다. `Terminal state` true는 `done/error/cancelled`, false는 `queued/running` 등 진행 상태다. 출력 연결을 일부러 비워 두어 외부 메시지나 재호출을 하지 않는다. done도 품질 검증 성공을 의미하지 않는다.
- HTTP Request는 인증서 검증을 유지하고 10초 timeout을 사용한다. 4xx/5xx는 노드 실패로 표시하며 자동 재시도하지 않는다. `Health`는 공개 최소 상태, `Admin status`는 인증 상태를 보여준다. 401이면 토큰 종류/재연결, 403 또는 연결 실패면 IP 허용/TLS/경로부터 확인한다. 유료 호출로 진단하지 않는다.
- 실행 데이터 저장 비활성 설정이 있으나 서비스의 별도 로그/retention 정책도 확인한다. job 응답에는 자막 등 내용이 포함될 수 있다. 수동 실행 화면에 표시되는 데이터를 외부에 공유하지 않는다.

HTTP Request v4.2, Set v3.4, If v2.2의 JSON 구조를 사용했다. 2026-10-30 지원 n8n 2.44.6에서 두 파일을 `⋯ → Import from File`로 가져와 노드 인식과 placeholder 상태의 false 분기 정지를 확인했다([검증 기록](../../docs/cloud-preparation-verification.md)). 2026-11-04 credential 연결 후 두 workflow의 GET 실행(200)을 확인했다. Value는 **Fixed** 모드에서 붙여 넣는다. Expression 모드로 저장하면 토큰 대신 다른 값이 전송되어 401이 난다. Windows PowerShell 5.1에서는 `| clip` 대신 `| Set-Clipboard`로 복사한다. n8n 2.x의 **Publish**가 활성화에 해당하므로 연결 확인 전에는 누르지 않는다. 로그인 세션이 탭 단위라 같은 n8n을 다른 탭에서 열면 기존 탭이 로그아웃될 수 있다.

## Grafana와 Prometheus 연결

`integrations/grafana/onsori-operations.json`을 import하고 `DS_PROMETHEUS` 입력에 승인된 Prometheus 데이터 소스를 지정한다. datasource UID는 import 시 매핑하며 repository에 계정 ID를 넣지 않았다. 2026-11-04 지원 Grafana(조직 84)에서 데이터 소스 `https://<호스트>/prometheus`(기본 인증, POST)를 만들고 `OnSori Pilot` 폴더에 import해 8개 패널 렌더를 확인했다.

로컬 Grafana라면 같은 사설 네트워크/승인 tunnel에서 접근한다. **외부 SaaS Grafana는 127.0.0.1:9090에 바로 접근할 수 없다.** 별도 승인된 private connectivity 또는 별도 TLS reverse proxy의 읽기 전용 query 경로, 강한 인증, 송신 IP 제한이 필요하다. 기본 nginx 예시는 Prometheus를 공개하지 않는다. Grafana를 위해 9090이나 `/metrics`를 그대로 인터넷에 열지 않는다. 다른 선택지는 승인된 remote_write 수신 서비스이며, 이 패키지에는 수신 주소/credential/remote_write 설정을 넣지 않았다. `/metrics` 토큰은 gateway scrape용이며 Prometheus query API 인증을 제공하지 않는다. 파일럿에서는 위 nginx `/prometheus/` 경로(조회 API만, 송신 IP 제한, 기본 인증)를 사용했다. 새 송신 IP는 데이터 소스 시험의 403 기록에서 확인한 뒤 allow 파일에 한 줄씩 추가한다.

패널은 종료 상태(done/error/cancelled)별 누적 job counter, active jobs, 1시간 error 증가량, 5분 p95/평균 처리시간, 제공업체 오디오 초 증가율, gateway 저장 bytes와 scrape up을 사용한다. 관측이 없으면 빈 값/NaN일 수 있고 이를 정확도 100% 또는 장애 0건으로 해석하지 않는다. 오디오 초는 제공업체 청구 금액이 아니다. 알림 수신자/임계값은 아직 확정하지 않았으므로 자동 알림 규칙이나 임의 합격선을 넣지 않았다.

## 중단·롤백·토큰 회전

신규 제출을 중단하고 실행 중 작업을 확인한 뒤 `ONSORI_PROVIDER=disabled`, `ONSORI_ALLOW_PAID=false`로 설정해 `docker compose up -d --no-deps gateway`로 재생성한다. 이 조치는 이미 제공업체에 전송된 요청의 비용·처리를 취소하지 않는다. 긴급 중단은 `docker compose stop gateway`다. 전체 정지는 `docker compose down`이며 데이터 볼륨을 보존한다. `down -v`, 볼륨 삭제, DB 교체는 데이터 파괴 작업이므로 별도 승인·백업 없이 실행하지 않는다.

업데이트 전 서비스를 정지하고 gateway 볼륨의 SQLite/음성/결과 전체를 일관된 상태로 별도 보호된 저장소에 백업한다. 복구는 이전에 검증한 이미지 digest와 호환 가능한 데이터 백업을 함께 사용한다. DB schema가 바뀐 경우 이전 이미지로 단순 변경하지 않는다. 이 준비본은 실제 백업·복구 실행까지 검증하지 않았다.

운영자 토큰 회전은 `.env`와 n8n credential을 갱신한다. metrics 토큰 회전은 `.env`의 값과 `secrets/metrics_token` 파일을 동일하게 갱신한 뒤 gateway/Prometheus를 재생성한다. 토큰 파일을 원자적으로 교체했다면 bind mount도 새 파일을 보도록 재생성이 필요하다. 이전 키 폐기와 401 확인까지 운영자가 검증한다. Grafana 기본 인증 비밀번호 회전은 `/root/onsori-grafana-basic-auth.txt`(0600)와 htpasswd를 함께 바꾸고 nginx를 reload한 뒤 Grafana 데이터 소스의 Password를 Reset해 다시 넣는다. 토큰이나 비밀번호가 채팅·문서·화면 공유에 노출되면 즉시 회전한다. n8n/Grafana import 롤백은 해당 비활성 workflow/대시보드를 제거하면 되며 서버 job 데이터에는 영향을 주지 않는다.

## 참고한 공식 문서

- n8n HTTP Request: https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.httprequest/
- Prometheus authorization/credentials_file: https://prometheus.io/docs/prometheus/latest/configuration/configuration/
- Grafana JSON import/datasource mapping: https://grafana.com/docs/grafana/latest/visualizations/dashboards/build-dashboards/import-dashboards/

공식 문서의 옵션을 참고해 준비했으며 현재 서비스 계정에서 실행한 증거와 구분한다.
