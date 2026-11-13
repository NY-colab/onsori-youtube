#!/usr/bin/env bash
# One real caption correction through the gateway on loopback, run on the server from deploy/cloud.
# Sends two synthetic Korean lines (no user data) with the operator token from .env. With
# ONSORI_CORRECTION=deepinfra this is one billed provider request of about a thousand tokens.
# Neither the token nor the provider key is printed.
set -euo pipefail
cd "$(dirname "$0")"
api=$(grep '^ONSORI_API_TOKEN=' .env | cut -d= -f2-)
base=http://127.0.0.1:8000
echo "availability=$(curl -fsS $base/v1/availability)"
body='{"title":"경제 뉴스","context":["오늘의 금융 시장 소식입니다."],"lines":[{"id":"1","text":"한국은행이 기준 금니를 올렸습니다"},{"id":"2","text":"네 맞습니다"}]}'
start=$(date +%s%N)
result=$(curl -sS -w ' HTTP%{http_code}' --max-time 90 -H "Authorization: Bearer $api" -H 'Content-Type: application/json' \
  --data-binary "$body" $base/v1/corrections)
end=$(date +%s%N)
echo "correction=$result"
echo "seconds=$(( (end - start) / 1000000000 ))"
echo "metrics: curl -fsS -H \"Authorization: Bearer \$(grep '^ONSORI_METRICS_TOKEN=' .env | cut -d= -f2-)\" $base/metrics | grep onsori_correction"
