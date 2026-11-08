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

### 4. Set the proxy key

Auth is required by default (see Security defaults below). Set a proxy-scoped secret.
Internal routes require `x-api-key`; external provider routes require `x-proxy-key` (so
`x-api-key`/`Authorization` can be the provider key).

```bash
npx wrangler secret put PROXY_KEY
```

For local dev, put `PROXY_KEY=dev-key` in `.dev.vars` (gitignored).

### 5. Configure vars in `wrangler.jsonc`

`wrangler.jsonc` is the source of truth for non-sensitive config. Dashboard vars are
deleted on deploy; secrets (`PROXY_KEY`) are not. Edit the `vars` block, then deploy:

```jsonc
"vars": {
    "MODELS": "@cf/meta/llama-3.3-70b-instruct-fp8-fast,@cf/meta/llama-3.1-8b-instruct-fast",
    "ALLOWED_HOSTS": "api.openai.com,generativelanguage.googleapis.com"
}
```

| Var                 | Default                   | Purpose                                          |
| ------------------- | ------------------------- | ------------------------------------------------ |
| `ALLOWED_HOSTS`     | built-in list (see below) | Comma-separated provider hosts; `*` allows any   |
| `ALLOW_HTTP`        | `false`                   | Allow `http://` provider URLs                    |
| `ALLOW_ANONYMOUS`   | `false`                   | Run without `PROXY_KEY`                          |
| `MAX_BODY_BYTES`    | `33554432` (32 MiB)       | Max POST body size                               |
| `UPSTREAM_TTFB_MS`  | `120000`                  | Time to first upstream byte                      |
| `UPSTREAM_TOTAL_MS` | `600000`                  | Per-attempt limit, non-streaming requests        |
| `MODELS`            | built-in Workers AI list  | Models returned by `GET /v1/models`              |
| `VISION_MODELS`     | none                      | Models flagged as vision-capable                 |
| `MULTI_TOOL_MODELS` | none                      | Models flagged as supporting multiple tool calls |

Default `ALLOWED_HOSTS`: `api.openai.com`, `generativelanguage.googleapis.com`,
`api.anthropic.com`, `openrouter.ai`, `api.groq.com`, `api.deepseek.com`,
`api.mistral.ai`, `api.x.ai`.

### 6. Security defaults (since Phase 1)

| Default           | Behavior and opt-out                                                                                                                                                    | Error text                                                                                                                    |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Auth required     | With no `PROXY_KEY`, API requests fail with `500`. Opt out with `ALLOW_ANONYMOUS=true`. A wrong or missing key gets `401`.                                              | `proxy not configured: set PROXY_KEY or ALLOW_ANONYMOUS=true`; `invalid x-api-key` / `invalid x-proxy-key`                    |
| Host allowlist    | External routes only reach hosts in `ALLOWED_HOSTS` (`403`). IP literals and custom ports are also rejected. Opt out with `ALLOWED_HOSTS=*`.                            | `Provider host not allowed by ALLOWED_HOSTS`; `IP-literal provider hosts are not allowed`; `custom ports are not allowed`     |
| HTTPS only        | `http://` provider URLs get `403`. Opt out with `ALLOW_HTTP=true`. Credentials in the URL and unparseable URLs (`400`) are always rejected.                             | `http provider URLs are disabled; set ALLOW_HTTP=true`; `credentials in provider URL are not allowed`; `invalid provider URL` |
| Body limit        | POST bodies over the limit get `413`. Tune with `MAX_BODY_BYTES`.                                                                                                       | `request body exceeds MAX_BODY_BYTES (<n> bytes)`                                                                             |
| Upstream timeouts | Slow upstreams get `504`. Tune with `UPSTREAM_TTFB_MS` and `UPSTREAM_TOTAL_MS`.                                                                                         | `upstream timed out after <n> ms`                                                                                             |
| Header allowlist  | Only allowlisted client headers are forwarded upstream; the rest are stripped. There is no opt-out variable.                                                            | none                                                                                                                          |
| Invalid config    | A malformed var (e.g. `MAX_BODY_BYTES=abc`, `ALLOW_HTTP=yes`) makes every request fail with `500` instead of silently using a default. Fix the var in `wrangler.jsonc`. | `invalid config: <VAR>` (e.g. `invalid config: MAX_BODY_BYTES`)                                                               |

Provider API keys are scrubbed from upstream error text before it is returned.

### 7. Rate limiting and logging (built in)

Messages endpoints are rate-limited per client IP (100 requests / 60 s) via a
Cloudflare rate-limiting binding; over-limit requests get `429 rate_limit_error`
with a `retry-after` header. Each messages request also emits one JSON log line
(`requestId`, `path`, `status`, `durationMs`) visible in `wrangler tail` and
Workers Logs.

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
npm test                                      # offline unit tests
npx wrangler dev --port 8080                  # needs PROXY_KEY in .dev.vars
npm run smoke -- http://127.0.0.1:8080 <key>  # live smoke test
```

The smoke test calls Workers AI through the remote AI binding, so you must be logged in
to wrangler.

## Running Claude Code on open-source models

- `WebSearch` is expected not to work: it is a server-side Anthropic tool that the
  backends do not implement.
- There is no prompt caching, so long sessions resend the full context every turn.
- Unknown models report a 24k context window, so Claude Code compacts often. Add the
  model to `CONTEXT_TOKENS` in `src/models.ts` to give it its real window.

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
