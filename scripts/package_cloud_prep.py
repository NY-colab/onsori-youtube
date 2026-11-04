"""Package the operator connection kit using explicit file allowlists; no deployment."""
from pathlib import Path
import hashlib
import json
import zipfile

ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT.parent / 'onsori-cloud-preparation-20261030.zip'
FILES = [
    '.dockerignore',
    'cloud_gateway/__init__.py', 'cloud_gateway/app.py', 'cloud_gateway/README.md',
    'cloud_gateway/requirements.txt', 'cloud_gateway/requirements-dev.txt',
    'cloud_gateway/.env.example', 'cloud_gateway/.gitignore',
    'deploy/cloud/Dockerfile', 'deploy/cloud/compose.yaml', 'deploy/cloud/.env.example',
    'deploy/cloud/.gitignore', 'deploy/cloud/prometheus.yml', 'deploy/cloud/nginx-https.conf.example',
    'deploy/cloud/preflight.py', 'deploy/cloud/RUNBOOK.ko.md',
    'integrations/n8n/manual-health-status.json', 'integrations/n8n/manual-job-status.json',
    'integrations/grafana/onsori-operations.json',
    'integrations/client/cloud-client.mjs', 'integrations/client/cloud-client.test.mjs',
    'integrations/client/README.ko.md', 'scripts/cloud_pilot.mjs',
    'scripts/package_cloud_prep.py', 'extension/core.js', 'extension/caption-style.js', 'extension/package.json',
    'tests/test_cloud_gateway.py', 'tests/test_cloud_assets.py', 'tests/test_cloud_pilot.py',
    'docs/cloud-preparation-verification.md',
]
README = '''# 온소리 클라우드 연결 준비 파일

2026-10-30 작성. 운영자 파일럿용이며 Chrome에 설치하는 확장 ZIP이 아닙니다.

1. `deploy/cloud/RUNBOOK.ko.md`의 승인 후 연결 순서를 따릅니다.
2. 서버는 disabled가 기본입니다. 먼저 mock으로 연결만 시험합니다.
3. `integrations/n8n/`에는 수동 점검 workflow 2개가 있습니다.
4. `integrations/grafana/`에는 Prometheus datasource를 지정할 대시보드가 있습니다.
5. `integrations/client/README.ko.md`에서 운영자 파일럿 사용법을 확인합니다.
6. `docs/cloud-preparation-verification.md`는 작업 공간에서 수행한 검사 기록입니다.

원본 확장 중 core.js(및 그 설정 모듈 caption-style.js)와 package.json만 규격 검사용으로 포함했습니다. 기존 확장 110개 회귀 검사는 원본 저장소에서 수행했으며, 이 묶음에는 전체 확장·UI·모델이 없습니다.
검사 재현에는 Python 3.12 및 Node 22+가 필요합니다. requirements-dev.txt로 시험 의존성을 설치한 뒤 cloud 관련 pytest 3개 파일과 cloud-client.test.mjs를 실행합니다. 실제 Docker/Rocky/n8n/Grafana 및 유료 모델 연결은 승인 후 검증합니다.

API 키·실오디오·모델·가상환경·테스트 DB·신청 화면은 포함하지 않았습니다. 상세 업데이트 계획은 별도 cloud-update-plan.md로 제공하며 이 기술 묶음에는 과거 작업 이력/신청 증빙을 복사하지 않았습니다.
MANIFEST.sha256.json에서 포함된 파일의 SHA-256을 확인할 수 있습니다. 승인 정보 없이 배포하거나 유료 API를 켜지 마세요.
'''


def main():
    contents = {name: (ROOT / name).read_bytes() for name in FILES}
    contents['README.ko.md'] = README.encode('utf-8')
    for name in contents:
        assert not any(part in {'.env', '__pycache__', '.venv', 'data', 'secrets', '.test-tmp'} for part in Path(name).parts)
        assert not name.endswith(('.wav', '.sqlite3', '.pyc', '.mp4'))
    manifest = {name: hashlib.sha256(data).hexdigest() for name, data in sorted(contents.items())}
    contents['MANIFEST.sha256.json'] = (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
    with zipfile.ZipFile(TARGET, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, data in sorted(contents.items()): archive.writestr(name, data)
    with zipfile.ZipFile(TARGET) as archive:
        assert archive.testzip() is None
        assert set(archive.namelist()) == set(contents)
        for name, digest in manifest.items(): assert hashlib.sha256(archive.read(name)).hexdigest() == digest
    digest = hashlib.sha256(TARGET.read_bytes()).hexdigest()
    TARGET.with_suffix('.zip.sha256').write_text(f'{digest}  {TARGET.name}\n', encoding='utf-8')
    print(json.dumps({'path':str(TARGET), 'files':len(contents), 'bytes':TARGET.stat().st_size,
                      'sha256':digest, 'crc_and_hashes':'PASS'}, ensure_ascii=False))


if __name__ == '__main__': main()
