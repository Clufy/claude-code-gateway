# Testing Checklist — claude-worker-proxy

**Deployed URL:** `https://claude-workers-ai-proxy.<your-subdomain>.workers.dev`

**Local dev:** `npx wrangler dev --port 8080` then use `http://127.0.0.1:8080`.

## Prerequisites

- A `PROXY_KEY` secret is set (required unless `ALLOW_ANONYMOUS=true`). It protects **internal routes** (`/v1/models*`, `/v1/messages*`) via the `x-api-key` header, and **external routes** (`/{type}/{provider_url}/v1/messages`) via the `x-proxy-key` header.
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

| #   | Command                                                                         | Expected                                         |
| --- | ------------------------------------------------------------------------------- | ------------------------------------------------ |
| 2.1 | `curl -sS -w "\n[%{http_code}]\n" "$BASE/v1/models"` (no key)                   | `401` `authentication_error` `invalid x-api-key` |
| 2.2 | `curl -sS -H "x-api-key: wrong" -w "\n[%{http_code}]\n" "$BASE/v1/models"`      | `401`                                            |
| 2.3 | `curl -sS -H "x-api-key: $PROXY_KEY" -w "\n[%{http_code}]\n" "$BASE/v1/models"` | `200` JSON                                       |

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

| Command                                                                                | Expected                                                 |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `curl -sS -X POST "$BASE/nonexistent-type/api.example.com/v1/messages"`                | `404` `Provider type 'nonexistent-type' not found`       |
| `curl -sS "$BASE/definitely-not-a-route"`                                              | `404 not_found_error`                                    |
| `curl -sS -H "x-api-key: $PROXY_KEY" -X POST "$BASE/v1/messages" -d '{"messages":[]}'` | `400 invalid_request_error` `missing or invalid 'model'` |

## 8b. Allowlist

The allowlist is always active (defaults in README). With `ALLOWED_HOSTS="api.openai.com"`:

```bash
curl -sS -X POST "$BASE/gemini/generativelanguage.googleapis.com/v1/messages" \
  -H "x-api-key: $GOOGLE_API_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"gemini-1.5-flash","messages":[{"role":"user","content":"hi"}]}' \
  -w "\n[%{http_code}]\n"
```

**Expected:** `[403]` `permission_error` `Provider host not allowed by ALLOWED_HOSTS`. A request to `/openai/api.openai.com/v1/messages` still succeeds.

## 8b2. Hardening behaviors

**Open-relay check:** a request to an unlisted host must return 403.

```bash
curl -sS -X POST "$BASE/openai/evil.example/v1/messages" \
  -H "x-proxy-key: $PROXY_KEY" -H "x-api-key: dummy" -H 'Content-Type: application/json' \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}' \
  -w "\n[%{http_code}]\n"
```

Anything other than `[403]` means the proxy is an open relay.

| #   | Scenario                                                                                         | Expected                                                            |
| --- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| a   | Open relay (command above)                                                                       | `403` `Provider host not allowed by ALLOWED_HOSTS`                  |
| b   | Oversized body: see command below                                                                | `413` `request body exceeds MAX_BODY_BYTES (33554432 bytes)`        |
| c   | Upstream timeout: set `UPSTREAM_TTFB_MS` to `1` in `wrangler.jsonc` vars, call an external route | `504` `upstream timed out after 1 ms`                               |
| d   | Not configured: no `PROXY_KEY` and no `ALLOW_ANONYMOUS` (empty `.dev.vars`), `GET /v1/models`    | `500` `proxy not configured: set PROXY_KEY or ALLOW_ANONYMOUS=true` |
| e   | Invalid config: `MAX_BODY_BYTES` set to `abc` in vars, any request                               | `500` `invalid config: MAX_BODY_BYTES`                              |

Oversized body (row b):

```bash
head -c 40000000 /dev/zero | curl -sS -X POST "$BASE/v1/messages" \
  -H "x-api-key: $PROXY_KEY" -H 'Content-Type: application/json' --data-binary @- \
  -w "\n[%{http_code}]\n"
```

Automated smoke test (health, models, count_tokens, chat, 401, open-relay 403):
`npm run smoke -- "$BASE" "$PROXY_KEY"`.

## 8c. Rate limiting

The `RATE_LIMITER` binding allows 100 requests per IP per 60s on the messages endpoints. To verify, fire 101+ rapid requests:

```bash
for i in $(seq 1 105); do
  curl -s -o /dev/null -w "%{http_code}\n" -X POST "$BASE/v1/messages/count_tokens" \
    -H 'Content-Type: application/json' \
    -d '{"model":"'"$MODEL"'","messages":[{"role":"user","content":"hi"}]}'
done | sort | uniq -c
```

**Expected:** a mix of `200`s and at least one `429` once the limit trips. Over-limit responses carry `retry-after: 60` and `rate_limit_error`. (Note: `count_tokens` is not limited, so target `/v1/messages` with a valid model for a definitive check.)

## 8d. Structured logs

In `npx wrangler dev` output (or Workers Logs in the dashboard), each messages request emits one JSON line:

```json
{ "requestId": "req_...", "method": "POST", "path": "/v1/messages", "status": 200, "durationMs": 812 }
```

## 8e. Streaming errors surface as Anthropic error events

If a provider stream dies mid-flight (network drop, provider 5xx after headers), the proxy emits an
Anthropic SSE `error` event and closes the stream — instead of ending the message silently. Verify by
watching `wrangler tail` while killing the upstream, or trust the unit path: any exception inside
`processProviderStream` / the OpenAI stream pumps lands in `sendErrorEvent`.

**Expected last events on failure:** `event: error` with `{"type":"error","error":{"type":"api_error",...}}`.

## 8f. Retries

- **OpenAI (both flavors):** the SDK client retries twice on 429/5xx/connection errors before the proxy gives up.
- **Gemini + generic providers:** `fetchWithRetry` retries twice on 429/500/502/503/504 with backoff
  (honors `retry-after`, capped at 5 s). Verify in `wrangler tail` — a failing upstream shows repeat
  request log lines for one inbound request.
- **Usage:** `cache_read_input_tokens` is forwarded when providers report it (OpenAI
  `prompt_tokens_details.cached_tokens`, Gemini `cachedContentTokenCount`); Gemini streaming now
  forwards real token counts in the final `message_delta` instead of zeros.

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
