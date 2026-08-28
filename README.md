# claude-worker-proxy

A Cloudflare Worker that lets [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
run against multiple AI backends through an Anthropic-compatible API.

The default `POST /v1/messages` route targets **Cloudflare Workers AI** via the local
`env.AI.run()` binding. Additional routes proxy to Gemini, OpenAI Chat Completions, or
the OpenAI Responses API using the provider path convention.

## Supported routes

| Method | Path                                 | Purpose                              |
| ------ | ------------------------------------ | ------------------------------------ |
| `GET`  | `/`                                  | Health check: `ok`                   |
| `GET`  | `/v1/models`                         | List supported models                |
| `GET`  | `/v1/models/{id}`                    | Retrieve one model                   |
| `POST` | `/v1/messages/count_tokens`          | Estimate input token count           |
| `POST` | `/v1/messages`                       | Anthropic Messages API -> Workers AI |
| `POST` | `/{type}/{provider_url}/v1/messages` | External provider proxy              |

## External provider path convention

The proxy key (if any) goes in `x-proxy-key`; the provider API key goes in `x-api-key`
or `Authorization: Bearer <key>`.

Examples:

```bash
# Gemini (Google AI Studio)
curl -X POST https://<worker>/gemini/generativelanguage.googleapis.com/v1/messages \
  -H 'x-api-key: $GOOGLE_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"model":"gemini-1.5-flash","messages":[{"role":"user","content":"hi"}]}'

# OpenAI Chat Completions
curl -X POST https://<worker>/openai/api.openai.com/v1/messages \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'

# OpenAI Responses API
curl -X POST https://<worker>/openai-responses/api.openai.com/v1/messages \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
```

## Deploy

### 1. Log in

```bash
npx wrangler login
```

### 2. Install and type-check

```bash
npm install
npm run check
```

### 3. Deploy

```bash
npm run deploy
```

After deploy, note the Worker URL.

### 4. Optional: protect the proxy

Set a proxy-scoped secret. If set, internal routes require `x-api-key`; external
provider routes require `x-proxy-key` (so `x-api-key`/`Authorization` can be the
provider key).

```bash
npx wrangler secret put PROXY_KEY
```

### 5. Optional: configure the model list

The `GET /v1/models` endpoint uses a default Workers AI model list. Override it with a
comma-separated `MODELS` variable:

```bash
npx wrangler vars put MODELS
# value: @cf/meta/llama-3.3-70b-instruct-fp8-fast,@cf/meta/llama-3.1-8b-instruct-fast
```

## Point Claude Code at the Worker

Edit `~/.claude/settings.json`. Replace the URL and pick a model that works with your
chosen backend.

### Without a `PROXY_KEY` (Workers AI)

```json
{
    "env": {
        "ANTHROPIC_BASE_URL": "https://<worker-subdomain>.workers.dev",
        "ANTHROPIC_MODEL": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        "ANTHROPIC_SMALL_FAST_MODEL": "@cf/meta/llama-3.1-8b-instruct-fast"
    }
}
```

### With a `PROXY_KEY` (Workers AI)

```json
{
    "env": {
        "ANTHROPIC_BASE_URL": "https://<worker-subdomain>.workers.dev",
        "ANTHROPIC_CUSTOM_HEADERS": "x-api-key: your-proxy-key-value",
        "ANTHROPIC_MODEL": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        "ANTHROPIC_SMALL_FAST_MODEL": "@cf/meta/llama-3.1-8b-instruct-fast"
    }
}
```

Claude Code still expects an API key; use a dummy value:

```bash
export ANTHROPIC_API_KEY="sk-ant-dummy"
```

## Test locally

```bash
npx wrangler dev --port 8080
./scripts/self-test.sh http://127.0.0.1:8080
```

## Revert to Anthropic's API

Remove the proxy-related entries from `~/.claude/settings.json` and unset any session
exports:

```bash
unset ANTHROPIC_BASE_URL ANTHROPIC_MODEL ANTHROPIC_SMALL_FAST_MODEL ANTHROPIC_API_KEY ANTHROPIC_CUSTOM_HEADERS
```

## How it works

- Unknown Anthropic request fields are ignored rather than rejected.
- Tool-use blocks are reconstructed from provider-native tool deltas where possible.
- Streaming responses emit Anthropic SSE events (`message_start`, `content_block_*`,
  `message_delta`, `message_stop`).
- Token usage is exact when the provider reports it; otherwise estimated from character
  count for Workers AI.

## Limitations

- Files API, Batches API, prompt caching, and managed-agent features are **not**
  implemented.
- `PROXY_KEY` is a single shared secret with no per-user rate limiting beyond
  Cloudflare's platform controls.
