#!/usr/bin/env bash
# Turns caption typo correction on or off on the pilot server.
#   bash enable_correction.sh              # DeepInfra (default): asks for the DeepInfra API key without showing it
#   bash enable_correction.sh anthropic    # Claude Haiku: asks for the Anthropic API key without showing it
#   bash enable_correction.sh --disable    # turns correction off and removes keys only correction used
# Keys are typed on the server only; they never go through chat, documents or the extension.
# The DeepInfra key is shared with cloud speech analysis (ONSORI_PROVIDER=deepinfra) if that is on.
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] || { echo ".env가 없습니다. 먼저 python3 preflight.py --init을 실행하세요."; exit 1; }
mode=${1:-deepinfra}
case "$mode" in deepinfra|anthropic|--disable) ;; *) echo "사용법: bash enable_correction.sh [deepinfra|anthropic|--disable]"; exit 1;; esac
value() { grep -E "^$1=" .env | tail -n 1 | cut -d= -f2- || true; }
speech=$(value ONSORI_PROVIDER)
deepinfra_key=$(value DEEPINFRA_API_KEY)
anthropic_key=$(value ANTHROPIC_API_KEY)
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
# ONSORI_CORRECTION_MODEL / ONSORI_CORRECTION_REASONING and the line limits are kept as they are.
grep -v -E '^(ONSORI_CORRECTION|ANTHROPIC_API_KEY|DEEPINFRA_API_KEY)=' .env > "$tmp" || true
case "$mode" in
  deepinfra)
    if [ -n "$deepinfra_key" ]; then
      read -rsp "DeepInfra API key (Enter만 누르면 .env의 기존 키 사용): " key; echo
      [ -n "$key" ] || key=$deepinfra_key
    else
      read -rsp "DeepInfra API key: " key; echo
    fi
    key=${key%$'\r'}  # a pasted Windows line end
    # LC_ALL=C: in a UTF-8 locale grep's [!-~] range also rejects plain letters.
    if [ "${#key}" -lt 16 ] || printf '%s' "$key" | LC_ALL=C grep -q '[^!-~]'; then echo "키 형식이 올바르지 않습니다(공백 없는 16자 이상)."; exit 1; fi
    printf 'ONSORI_CORRECTION=deepinfra\nDEEPINFRA_API_KEY=%s\nANTHROPIC_API_KEY=%s\n' "$key" "$anthropic_key" >> "$tmp"
    ;;
  anthropic)
    read -rsp "Anthropic API key (sk-ant-...): " key; echo
    case "$key" in sk-ant-*) ;; *) echo "sk-ant-로 시작하는 키가 아닙니다."; exit 1;; esac
    printf 'ONSORI_CORRECTION=anthropic\nANTHROPIC_API_KEY=%s\nDEEPINFRA_API_KEY=%s\n' "$key" "$deepinfra_key" >> "$tmp"
    ;;
  --disable)
    # Cloud speech analysis keeps its DeepInfra key; otherwise the key is removed too.
    [ "$speech" = deepinfra ] || deepinfra_key=
    printf 'ONSORI_CORRECTION=disabled\nANTHROPIC_API_KEY=\nDEEPINFRA_API_KEY=%s\n' "$deepinfra_key" >> "$tmp"
    ;;
esac
unset key deepinfra_key anthropic_key
install -m 600 "$tmp" .env
python3 preflight.py
docker compose up -d --no-deps --force-recreate gateway
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS http://127.0.0.1:8000/v1/availability; then echo; exit 0; fi
  sleep 2
done
echo "gateway가 응답하지 않습니다. docker compose logs gateway를 확인하세요."; exit 1
