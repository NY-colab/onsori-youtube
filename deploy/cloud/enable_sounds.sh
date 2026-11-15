#!/bin/bash
# Turns on music/effect description (Google Gemini) without showing the key.
# Usage: bash enable_sounds.sh [/path/to/file-with-GEMINI_API_KEY]
# With a file, the key is read from its GEMINI_API_KEY= line; otherwise it is asked for (hidden).
set -euo pipefail
cd "$(dirname "$0")"
umask 077
[ -f .env ] || { echo ".env not found"; exit 1; }
if [ "${1:-}" != "" ]; then
  KEY=$(grep -m1 '^GEMINI_API_KEY=' "$1" | cut -d= -f2- | tr -d '"' | tr -d '[:space:]')
else
  read -rs -p "Gemini API key (hidden): " KEY; echo
fi
[ -n "$KEY" ] || { echo "no key, nothing changed"; exit 1; }
cp -p .env ".env.bak.$(date +%Y%m%d%H%M%S)"
grep -v -E '^(ONSORI_SOUNDS|GEMINI_API_KEY)=' .env > .env.new || true
printf 'ONSORI_SOUNDS=gemini\nGEMINI_API_KEY=%s\n' "$KEY" >> .env.new
unset KEY
chmod 600 .env.new && mv .env.new .env
python3 preflight.py
docker compose up -d --no-deps --force-recreate gateway
for i in $(seq 1 30); do curl -fs http://127.0.0.1:8000/healthz >/dev/null && break; sleep 1; done
curl -fs http://127.0.0.1:8000/v1/availability | python3 -c 'import json,sys;d=json.load(sys.stdin);print("sounds:",d.get("sounds"),"model:",d.get("sound_model"))'
