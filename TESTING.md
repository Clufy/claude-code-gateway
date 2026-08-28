# Testing Checklist — claude-worker-proxy

**Deployed URL:** `https://claude-workers-ai-proxy.<your-subdomain>.workers.dev`

**Local dev:** `npx wrangler dev --port 8080` then use `http://127.0.0.1:8080`.

## Prerequisites

- A `PROXY_KEY` secret is set. It protects **internal routes** (`/v1/models*`, `/v1/messages*`) via the `x-api-key` header, and **external routes** (`/{type}/{provider_url}/v1/messages`) via the `x-proxy-key` header.
- For external providers you need the provider API key: Gemini (`GOOGLE_API_KEY`) or OpenAI (`OPENAI_API_KEY`).

Set these shell variables before copying any command:

```bash
BASE="https://claude-workers-ai-proxy.<your-subdomain>.workers.dev"
PROXY_KEY="<your-proxy-key>"
MODEL="@cf/meta/llama-3.1-8b-instruct-fast"
```

---

## 1. Health check

```bash
curl -sS -w "\n[%{http_code}]\n" "$BASE/"
```

**Expected:** `ok` and `[200]`, with a `request-id: req_<uuid>` response header.

## 2. Authentication

| # | Command | Expected |
|---|---------|----------|
| 2.1 | `curl -sS -w "\n[%{http_code}]\n" "$BASE/v1/models"` (no key) | `401` `authentication_error` `invalid x-api-key` |
| 2.2 | `curl -sS -H "x-api-key: wrong" -w "\n[%{http_code}]\n" "$BASE/v1/models"` | `401` |
| 2.3 | `curl -sS -H "x-api-key: $PROXY_KEY" -w "\n[%{http_code}]\n" "$BASE/v1/models"` | `200` JSON |

Every error body must have the shape `{"type":"error","error":{"type":...,"message":...},"request_id":"req_..."}`, and the `request-id` header must equal the body's `request_id`.

## 3. Model endpoints

```bash
# List models
curl -sS -H "x-api-key: $PROXY_KEY" -w "\n[%{http_code}]\n" "$BASE/v1/models"

# Single known model
curl -sS -H "x-api-key: $PROXY_KEY" -w "\n[%{http_code}]\n" "$BASE/v1/models/$MODEL"

# Unknown model -> 404
curl -sS -H "x-api-key: $PROXY_KEY" -w "\n[%{http_code}]\n" "$BASE/v1/models/does-not-exist"
```

**Expected:** list returns `{"data":[...],"has_more":false,"first_id":null,"last_id":null}`; single returns a model object with `id`, `type:"model"`, `display_name`; unknown returns `404 not_found_error`.

## 4. Token counting

```bash
curl -sS -H "x-api-key: $PROXY_KEY" -X POST "$BASE/v1/messages/count_tokens" \
  -H 'Content-Type: application/json' \
  -d '{"model":"'"$MODEL"'","messages":[{"role":"user","content":"hello world"}]}' \
  -w "\n[%{http_code}]\n"
```

**Expected:** `{"input_tokens": <positive int>}` and `[200]`.

## 5. Workers AI — non-streaming chat

```bash
curl -sS -H "x-api-key: $PROXY_KEY" -X POST "$BASE/v1/messages" \
  -H 'Content-Type: application/json' \
  -d '{"model":"'"$MODEL"'","max_tokens":100,"messages":[{"role":"user","content":"Say hello in one sentence."}]}' \
  -w "\n[%{http_code}]\n"
```

**Expected:** `[200]` and an Anthropic message: `{"id":"msg_...","type":"message","role":"assistant","model":...,"content":[{"type":"text","text":"..."}],"stop_reason":"end_turn","stop_sequence":null,"usage":{"input_tokens":N,"output_tokens":M}}`.

## 6. Workers AI — streaming chat

```bash
curl -sSN -H "x-api-key: $PROXY_KEY" -X POST "$BASE/v1/messages" \
  -H 'Content-Type: application/json' \
  -d '{"model":"'"$MODEL"'","stream":true,"max_tokens":100,"messages":[{"role":"user","content":"Say hello in one sentence."}]}'
```

**Expected:** a `text/event-stream` response with, in order:
`message_start` → `content_block_start` (text) → one or more `content_block_delta` (`text_delta`) → `content_block_stop` → `message_delta` (`stop_reason`) → `message_stop`.

## 7. External providers

> Requires the provider key; the proxy key goes in `x-proxy-key`.

```bash
# Gemini
curl -sS -X POST "$BASE/gemini/generativelanguage.googleapis.com/v1/messages" \
  -H "x-proxy-key: $PROXY_KEY" -H "x-api-key: $GOOGLE_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"gemini-1.5-flash","messages":[{"role":"user","content":"hi"}]}'

# OpenAI Chat Completions
curl -sS -X POST "$BASE/openai/api.openai.com/v1/messages" \
  -H "x-proxy-key: $PROXY_KEY" -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'

# OpenAI Responses API
curl -sS -X POST "$BASE/openai-responses/api.openai.com/v1/messages" \
  -H "x-proxy-key: $PROXY_KEY" -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
```

**Expected:** each returns `[200]` with an Anthropic-format message (non-streaming) or Anthropic SSE (streaming). Without the provider key, expect `401 missing provider api key`; without `x-proxy-key`, expect `401 invalid x-proxy-key`.

## 8. Error paths

| Command | Expected |
|---------|----------|
| `curl -sS -X POST "$BASE/nonexistent-type/api.example.com/v1/messages"` | `404` `Provider type 'nonexistent-type' not found` |
| `curl -sS "$BASE/definitely-not-a-route"` | `404 not_found_error` |
| `curl -sS -H "x-api-key: $PROXY_KEY" -X POST "$BASE/v1/messages" -d '{"messages":[]}'` | `400 invalid_request_error` `missing or invalid 'model'` |

## 9. Tool calling (Workers AI)

```bash
curl -sS -H "x-api-key: $PROXY_KEY" -X POST "$BASE/v1/messages" \
  -H 'Content-Type: application/json' \
  -d '{"model":"'"$MODEL"'","max_tokens":200,"tools":[{"name":"get_weather","description":"Get weather","input_schema":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}],"messages":[{"role":"user","content":"What is the weather in Paris?"}]}'
```

**Expected:** `[200]` with `stop_reason:"tool_use"` and a `content` block of `type:"tool_use"` carrying `id`, `name:"get_weather"`, and parsed `input`.

## 10. Claude Code end-to-end

Set `~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://claude-workers-ai-proxy.<your-subdomain>.workers.dev",
    "ANTHROPIC_CUSTOM_HEADERS": "x-api-key: <your-proxy-key>",
    "ANTHROPIC_MODEL": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    "ANTHROPIC_SMALL_FAST_MODEL": "@cf/meta/llama-3.1-8b-instruct-fast"
  }
}
```

Then `export ANTHROPIC_API_KEY="sk-ant-dummy"` and run `claude -p "Say hello in one sentence"`.