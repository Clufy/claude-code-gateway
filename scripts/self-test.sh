#!/usr/bin/env bash
set -euo pipefail

BASE="${1:-http://127.0.0.1:8080}"
MODEL="${2:-@cf/meta/llama-3.1-8b-instruct-fast}"

echo "== health =="
curl -sS "${BASE}/" | grep -q '^ok$' && echo "health ok"

echo "== list models =="
curl -sS "${BASE}/v1/models" | head -c 200
echo

echo "== count tokens =="
curl -sS -X POST "${BASE}/v1/messages/count_tokens" \
  -H 'Content-Type: application/json' \
  -d '{"model":"'"${MODEL}"'","messages":[{"role":"user","content":"hello world"}]}'
echo

echo "== non-streaming chat =="
curl -sS -X POST "${BASE}/v1/messages" \
  -H 'Content-Type: application/json' \
  -d '{"model":"'"${MODEL}"'","messages":[{"role":"user","content":"say hi"}],"max_tokens":50}' \
  | head -c 400
echo

echo "Self-test complete."
