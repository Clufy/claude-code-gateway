#!/usr/bin/env bash
# Smoke test. Usage: scripts/self-test.sh <base-url> <proxy-key> [model]
set -euo pipefail

if [ $# -lt 2 ]; then
  echo "usage: $0 <base-url> <proxy-key> [model]" >&2
  exit 2
fi
BASE="${1%/}"
KEY="$2"
MODEL="${3:-@cf/meta/llama-3.1-8b-instruct-fast}"

BODY=$(mktemp)
trap 'rm -f "$BODY"' EXIT

fail() { echo "FAIL: $1" >&2; [ -s "$BODY" ] && head -c 400 "$BODY" >&2 && echo >&2; exit 1; }

# check <name> <expected-status> <curl args...>; response body is left in $BODY
check() {
  local name="$1" want="$2" code
  shift 2
  code=$(curl -sS -o "$BODY" -w '%{http_code}' "$@") || fail "$name: curl failed"
  [ "$code" = "$want" ] || fail "$name: expected HTTP $want, got $code"
  echo "ok   $name ($code)"
}

JSON='Content-Type: application/json'
CHAT='{"model":"'"$MODEL"'","max_tokens":50,"messages":[{"role":"user","content":"say hi"}]}'

check "health" 200 "$BASE/"
grep -q '^ok' "$BODY" || fail "health: body is not 'ok'"

check "models" 200 -H "x-api-key: $KEY" "$BASE/v1/models"

check "count_tokens" 200 -H "x-api-key: $KEY" -H "$JSON" -X POST \
  -d '{"model":"'"$MODEL"'","messages":[{"role":"user","content":"hello world"}]}' \
  "$BASE/v1/messages/count_tokens"

check "chat (non-streaming)" 200 -H "x-api-key: $KEY" -H "$JSON" -X POST -d "$CHAT" "$BASE/v1/messages"
grep -q '"type":"message"' "$BODY" || fail "chat: response lacks \"type\":\"message\""

check "missing key rejected" 401 -H "$JSON" -X POST -d "$CHAT" "$BASE/v1/messages"

check "open relay blocked" 403 -H "x-proxy-key: $KEY" -H "x-api-key: dummy" -H "$JSON" -X POST \
  -d "$CHAT" "$BASE/openai/evil.example/v1/messages"

echo "Smoke test passed."
