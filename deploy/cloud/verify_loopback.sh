#!/usr/bin/env bash
# Loopback-only gateway checks run on the approved host from deploy/cloud.
# Tokens are read from .env and never printed. Only a synthetic 1 s silent WAV is uploaded,
# and only when the provider is mock; disabled must refuse it. No paid provider is called.
set -euo pipefail
cd "$(dirname "$0")"
api=$(grep '^ONSORI_API_TOKEN=' .env | cut -d= -f2-)
met=$(grep '^ONSORI_METRICS_TOKEN=' .env | cut -d= -f2-)
provider=$(grep '^ONSORI_PROVIDER=' .env | cut -d= -f2-)
base=http://127.0.0.1:8000
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
echo "provider=$provider"
echo "healthz=$(curl -fsS $base/healthz)"
echo "status_without_token=$(code $base/v1/status)"
echo "status_with_metrics_token=$(code -H "Authorization: Bearer $met" $base/v1/status)"
echo "status=$(curl -fsS -H "Authorization: Bearer $api" $base/v1/status)"
echo "metrics_with_api_token=$(code -H "Authorization: Bearer $api" $base/metrics)"
echo "metrics_series=$(curl -fsS -H "Authorization: Bearer $met" $base/metrics | grep -c '^onsori_')"
wav=$(mktemp --suffix=.wav)
trap 'rm -f "$wav"' EXIT
python3 -c "import wave,sys;w=wave.open(sys.argv[1],'wb');w.setnchannels(1);w.setsampwidth(2);w.setframerate(16000);w.writeframes(b'\0\0'*16000);w.close()" "$wav"
key="verify-$(date +%s)-$RANDOM"
submit=$(curl -s -w ' HTTP%{http_code}' -H "Authorization: Bearer $api" -H "Idempotency-Key: $key" \
  -F "file=@$wav;type=audio/wav" -F consent=true -F language=ko -F title='SYNTHETIC LOOPBACK CHECK' $base/v1/jobs)
echo "submit=$submit"
if [ "$provider" = mock ]; then
  job=$(printf '%s' "$submit" | python3 -c "import json,sys;print(json.loads(sys.stdin.read().rsplit(' HTTP',1)[0])['id'])")
  for _ in $(seq 1 30); do
    state=$(curl -fsS -H "Authorization: Bearer $api" $base/v1/jobs/$job | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['status'])")
    case $state in done|error|cancelled) break;; esac
    sleep 1
  done
  echo "job_state=$state"
  curl -fsS -H "Authorization: Bearer $api" $base/v1/jobs/$job | python3 -c "import json,sys;d=json.load(sys.stdin);r=d.get('result') or {};c=r.get('cues') or [];print('cues=%d synthetic=%s review_required=%s' % (len(c),r.get('metadata',{}).get('synthetic'),bool(c) and all(x.get('review_required') for x in c)))"
  echo "stored_wav_files=$(docker compose exec -T gateway sh -c 'find /data -type f -name "*.wav" | wc -l')"
  echo "idempotent_repeat=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $api" -H "Idempotency-Key: $key" -F "file=@$wav;type=audio/wav" -F consent=true -F language=ko -F title='SYNTHETIC LOOPBACK CHECK' $base/v1/jobs)"
fi
sleep 2
echo "prometheus_up=$(curl -fsS 'http://127.0.0.1:9090/api/v1/query?query=up%7Bjob%3D%22onsori%22%7D' | python3 -c "import json,sys;r=json.load(sys.stdin)['data']['result'];print(r[0]['value'][1] if r else 'no-sample')")"
