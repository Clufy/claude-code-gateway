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

| Var                 | Default                   | Purpose                                                                                          |
| ------------------- | ------------------------- | ------------------------------------------------------------------------------------------------ |
| `ALLOWED_HOSTS`     | built-in list (see below) | Comma-separated provider hosts; `*` allows any                                                   |
| `ALLOW_HTTP`        | `false`                   | Allow `http://` provider URLs                                                                    |
| `ALLOW_ANONYMOUS`   | `false`                   | Run without `PROXY_KEY`                                                                          |
| `MAX_BODY_BYTES`    | `33554432` (32 MiB)       | Max POST body size                                                                               |
| `UPSTREAM_TTFB_MS`  | `120000`                  | Time to first upstream byte; also the max silence between stream chunks on every streaming route |
| `UPSTREAM_TOTAL_MS` | `600000`                  | Per-attempt limit, non-streaming requests                                                        |
| `MODEL_ROUTES`      | none                      | JSON model routing table (see below)                                                             |
| `MODELS`            | built-in Workers AI list  | Models returned by `GET /v1/models`                                                              |
| `VISION_MODELS`     | none                      | Models flagged as vision-capable                                                                 |
| `MULTI_TOOL_MODELS` | none                      | Models flagged as supporting multiple tool calls                                                 |

Default `ALLOWED_HOSTS`: `api.openai.com`, `generativelanguage.googleapis.com`,
`api.anthropic.com`, `openrouter.ai`, `api.groq.com`, `api.deepseek.com`,
`api.mistral.ai`, `api.x.ai`.

#### Model routing (`MODEL_ROUTES`)

`MODEL_ROUTES` is a JSON object (stored as a string var) that maps the model name Claude
Code sends to a backend. A model with no matching route goes to Workers AI with the name
unchanged.

```jsonc
"MODEL_ROUTES": "{\"claude-sonnet-*\": {\"provider\": \"workers-ai\", \"model\": \"@cf/zai-org/glm-5.3\", \"fallback\": [\"deepseek-chat\"]}, \"deepseek-chat\": {\"provider\": \"openai\", \"model\": \"deepseek-chat\", \"baseUrl\": \"api.deepseek.com\", \"keySecret\": \"DEEPSEEK_KEY\"}}"
```

```bash
npx wrangler secret put DEEPSEEK_KEY
```

Each route has these keys (unknown keys are rejected):

| Key             | Required                   | Meaning                                                                                      |
| --------------- | -------------------------- | -------------------------------------------------------------------------------------------- |
| `provider`      | yes                        | `workers-ai`, `openai`, `openai-responses` or `gemini`                                       |
| `model`         | yes                        | Model name sent to the backend                                                               |
| `baseUrl`       | non-`workers-ai` providers | Provider URL, checked against `ALLOWED_HOSTS` and `ALLOW_HTTP` like the path convention      |
| `keySecret`     | non-`workers-ai` providers | Name (`[A-Z][A-Z0-9_]*`) of a secret set with `wrangler secret put`; `PROXY_KEY` is rejected |
| `fallback`      | no                         | Up to 3 model names to try after this one                                                    |
| `contextTokens` | no                         | Context window reported by `GET /v1/models`                                                  |

- **Matching:** a key without `*` is an exact match and always wins. Otherwise the first
  glob key (in the order written) whose `*` wildcards match the name is used.
- **Fallback:** only before the first byte reaches the client. The proxy moves to the next
  name in `fallback` on a `429`, any `5xx` (including a timeout `504`) or a connection error.
  Each fallback name is routed through `MODEL_ROUTES` too, and duplicates are skipped. The
  last target's result is returned as is.
- **Errors:** a malformed `MODEL_ROUTES`, or a `keySecret` that is not set, makes the
  request fail with `500 invalid config: <VAR>`.

#### Keepalive

Claude Code gives up on a silent connection, and slow models can take a while to start. If
the backend has not started its stream after 5 s, the proxy commits to a `200` SSE
response, sends `message_start`, then a `ping` every 10 s until the backend answers. A
backend failure after that point arrives as an SSE `error` event, because the status is
already sent. Keepalive covers only the wait for the stream to start; silence between
chunks after that is bounded by `UPSTREAM_TTFB_MS` (the idle timeout), which ends the stream
with an SSE `error` event.

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
(`event: "request"`) visible in `wrangler tail` and Workers Logs:

| Field                                   | Meaning                                                                |
| --------------------------------------- | ---------------------------------------------------------------------- |
| `requestId`, `method`, `path`           | Request identity                                                       |
| `status`, `durationMs`                  | Final status and total time                                            |
| `streamed`                              | `true` for streamed responses                                          |
| `model`                                 | Model name the client requested                                        |
| `route`                                 | Matching `MODEL_ROUTES` key, if any                                    |
| `backend`                               | Final target as `provider:model`                                       |
| `fallbackUsed`                          | `true` if a fallback target answered                                   |
| `ttfbMs`                                | Time until the backend answered                                        |
| `inputTokens`, `outputTokens`           | Usage reported by the backend                                          |
| `toolCallsFromText`, `unparsedToolText` | Tool calls recovered from, or left in, plain model text                |
| `keepalive`                             | `true` if keepalive committed the response before the backend answered |

When keepalive has already committed, `status` is the backend's real status (the client
saw `200`), `keepalive: true` is set, and `inputTokens` is the proxy's estimate.

Send `x-proxy-debug: 1` (authenticated callers only) to get the proxy's view of a request
back: streaming responses end with a `: proxy-stats <json>` SSE comment, and non-streaming
responses carry an `x-proxy-stats` header. The stats hold `backend`, `model`,
`fallbackUsed`, `ttfbMs`, `toolCallsFromText` and `unparsedToolText`.

### 8. Model listing

`GET /v1/models` lists the `MODELS` (or built-in Workers AI) names plus every `MODEL_ROUTES`
key that has no `*`. A name matched only by a glob route is not listed, but
`GET /v1/models/{id}` resolves it. The vision and multi-tool flags are `true` if either the
backing model or the routed name is in `VISION_MODELS` or `MULTI_TOOL_MODELS`.

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

## Model qualification

`npm run qualify` replays Claude Code style requests (the real system prompt and tool list)
against the proxy and scores how reliably a model drives tools. Run it after any model or
proxy change and before every engagement.

```bash
npm run qualify -- --base http://127.0.0.1:8080 --key dev-key \
  --models @cf/zai-org/glm-5.3,@cf/moonshotai/kimi-k2.6 --runs 3
```

Flags: `--base` (default `ANTHROPIC_BASE_URL`), `--key` (default: the `x-api-key` header in
`ANTHROPIC_CUSTOM_HEADERS`, else `PROXY_KEY`), `--models` (required, comma-separated),
`--runs` (default `3`), `--only <ids>`, `--skip-long`, `--fixture <path>` and `--out`
(default `qualify-results`). Requests run sequentially. Results go to
`<out>/<YYYY-MM-DD-HHmm>.json` (raw runs) and `.md` (summary, also printed); bad arguments
exit with code `2`. The runs send `x-proxy-debug: 1`, so the report also shows
tool calls recovered from text and fallback use.

| Scenario             | Pass when                                                                        |
| -------------------- | -------------------------------------------------------------------------------- |
| `tool.single`        | One valid `Read` of the requested file                                           |
| `tool.args_complex`  | An `Edit` whose `old_string` matches a line with quotes, backslashes and a tab   |
| `tool.choice`        | A code search starts with `Grep`                                                 |
| `tool.parallel`      | Two valid `Read` calls in one response (reported, not gating)                    |
| `tool.after_result`  | After an error `tool_result`, a valid response that is not the same `Read` again |
| `turn.stop`          | A plain answer: no tool call, `end_turn`, correct text                           |
| `context.long`       | `tool.single` after a ~400 000 character tool result (skip with `--skip-long`)   |
| `stream.parity`      | `tool.single` gives the same call with `stream: false` and `stream: true`        |
| `inject.tool_result` | An instruction hidden in a tool result is not followed                           |
| `mode.format`        | Skipped until Phase 3                                                            |
| `mode.scope`         | Skipped until Phase 3                                                            |

Verdicts, checked in this order (the report lists every failed threshold):

| Verdict         | Valid tool-call rate | Tool scenario pass rate | `mode.scope`       |
| --------------- | -------------------- | ----------------------- | ------------------ |
| `fit`           | at least 95%         | at least 90%            | 100% when measured |
| `subagent-only` | at least 85%         | at least 70%            | not gated          |
| `unfit`         | below                | below                   | not gated          |

The tool scenario pass rate is the mean of `tool.single`, `tool.args_complex`,
`tool.choice`, `tool.after_result` and `context.long`. Until the `mode.*` scenarios turn on
in Phase 3, every report notes `mode.scope not measurable before Phase 3`.

### Capture your real Claude Code request

The qualification replays the synthetic fixture
`test/fixtures/claude-code-request.synthetic.json` unless a real capture exists. To capture
your own system prompt and tool list:

```bash
npm run qualify:capture                       # listens on 127.0.0.1:8787
# in another terminal:
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 ANTHROPIC_API_KEY=dummy claude -p "hi"
```

The first request that carries `tools` is saved, redacted (home directory, user name and
common API key patterns), to `test/fixtures/local/claude-code-request.json`, which is
gitignored. Later runs use it automatically; `--fixture` overrides it.

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
