# Configuration

Routes, providers, every `wrangler.jsonc` var, the security defaults, logging and model listing.

## Supported routes

| Method | Path                                 | Purpose                              |
| ------ | ------------------------------------ | ------------------------------------ |
| `GET`  | `/`                                  | Health check: `ok`                   |
| `GET`  | `/v1/models`                         | List supported models                |
| `GET`  | `/v1/models/{id}`                    | Retrieve one model                   |
| `POST` | `/v1/messages/count_tokens`          | Estimate input token count           |
| `POST` | `/v1/messages`                       | Anthropic Messages API -> Workers AI |
| `POST` | `/{type}/{provider_url}/v1/messages` | External provider proxy              |

`{type}` is `gemini`, `openai`, `openai-responses` or `anthropic`.

## External provider path convention

The proxy key (if any) goes in `x-proxy-key`; the provider API key goes in `x-api-key`
or `Authorization: Bearer <key>`. `{provider_url}` includes the provider's version prefix
(`api.openai.com/v1`, `generativelanguage.googleapis.com/v1beta`, `api.anthropic.com/v1`),
because the proxy appends `chat/completions`, `responses`, `messages` or `models/...` to it.

Examples:

```bash
# Gemini (Google AI Studio)
curl -X POST https://<worker>/gemini/generativelanguage.googleapis.com/v1beta/v1/messages \
  -H 'x-api-key: $GOOGLE_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"model":"gemini-1.5-flash","messages":[{"role":"user","content":"hi"}]}'

# OpenAI Chat Completions
curl -X POST https://<worker>/openai/api.openai.com/v1/v1/messages \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'

# OpenAI Responses API
curl -X POST https://<worker>/openai-responses/api.openai.com/v1/v1/messages \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'

# Anthropic Messages API (native pass-through)
curl -X POST https://<worker>/anthropic/api.anthropic.com/v1/v1/messages \
  -H "x-proxy-key: $PROXY_KEY" \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"claude-sonnet-4-5","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}'
```

### The `anthropic` provider

`anthropic` is a near pass-through for Claude models and any Anthropic-compatible API, by path
convention or as a `MODEL_ROUTES` provider (with `baseUrl`, e.g. `https://api.anthropic.com/v1`,
and `keySecret`):

- **Request:** the Messages body is sent as is to `{provider_url}/messages`, with `model` set to
  the target model. In assistant turns, `thinking` blocks without a signature (missing or empty)
  are dropped: Workers AI produces unsigned thinking, which Anthropic rejects after a model switch
  or a fallback. Signed blocks and every `redacted_thinking` block (which never has a signature)
  are kept. An assistant turn left empty by the strip is removed from `messages`.
- **Request headers** are built fresh: `x-api-key` (the provider key, with any `Bearer` prefix
  removed), `anthropic-version: 2023-06-01`, `content-type`, and the client's `anthropic-beta` if
  sent. No other inbound header is forwarded: not the proxy key, `Authorization`, `x-engagement`,
  `x-proxy-*` or cookies. Anyone holding the proxy key can turn on any `anthropic-beta` header or
  body feature (server tools, `mcp_servers`), and all of it is billed to the route's `keySecret`.
- **Response:** the body, streaming SSE included, is relayed unchanged except that the key
  is scrubbed from it, error or not. Only the `content-type` and `retry-after` headers are kept. Anthropic's
  `request-id`, `anthropic-organization-id`, `anthropic-ratelimit-*` and `set-cookie` are dropped,
  and the proxy's own `request-id` is set.

## Vars in `wrangler.jsonc`

`wrangler.jsonc` is the source of truth for non-sensitive config. Dashboard vars are
deleted on deploy; secrets (`PROXY_KEY`) are not. Edit the `vars` block, then deploy:

```jsonc
"vars": {
    "MODELS": "…",       // shipped defaults: keep the existing MODELS and MODEL_ROUTES values
    "MODEL_ROUTES": "…", // (see "Upgrading to model-agnostic config"), or the shipped models are lost
    "ALLOWED_HOSTS": "api.openai.com,generativelanguage.googleapis.com" // the key you add
}
```

Keep the shipped `MODELS` and `MODEL_ROUTES` values when you add vars;
[Upgrading to model-agnostic config](#upgrading-to-model-agnostic-config) explains why.

| Var                     | Default                   | Purpose                                                                                                                                |
| ----------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `ALLOWED_HOSTS`         | built-in list (see below) | Comma-separated provider hosts; `*` allows any                                                                                         |
| `ALLOW_HTTP`            | `false`                   | Allow `http://` provider URLs                                                                                                          |
| `ALLOW_ANONYMOUS`       | `false`                   | Run without `PROXY_KEY`                                                                                                                |
| `MAX_BODY_BYTES`        | `33554432` (32 MiB)       | Max POST body size                                                                                                                     |
| `UPSTREAM_TTFB_MS`      | `120000`                  | Time to first upstream byte; also the max silence between stream chunks on every streaming route                                       |
| `UPSTREAM_TOTAL_MS`     | `600000`                  | Limit for non-streaming requests: per attempt on external providers, all retries together on Workers AI                                |
| `MODEL_ROUTES`          | shipped value (see below) | JSON model routing table (see below)                                                                                                   |
| `MODELS`                | shipped value (see below) | Models returned by `GET /v1/models`                                                                                                    |
| `DRAFT_MODEL`           | none                      | Default model for the MCP `purple` tool's `draft_rule`; falls back to the first `/v1/models` entry (see [Purple loop](purple-loop.md)) |
| `JUDGE_MODEL`           | none                      | Default judge model for the MCP `redteam` tool; `judgeModel: ""` turns the judge off (see [Red-team harness](redteam.md))              |
| `VISION_MODELS`         | none                      | Models flagged as vision-capable                                                                                                       |
| `MULTI_TOOL_MODELS`     | none                      | Models flagged as supporting multiple tool calls                                                                                       |
| `GUARD_RULES`           | none                      | JSON session-guard settings: disable rules, change severities, add regex rules (see [Session guard](guard.md))                         |
| `CF_ACCOUNT_ID`         | none                      | Your Cloudflare account id (32 lowercase hex characters); enables the MCP `logs` tool (see [MCP server](mcp.md))                       |
| `CF_API_TOKEN`          | none                      | Secret (`wrangler secret put`), not a var: API token for the `logs` tool; needs `CF_ACCOUNT_ID` too                                    |
| `OBSERVABILITY_SERVICE` | `claude-workers-ai-proxy` | Worker name the `logs` tool filters on; set it if you rename the Worker (the wrangler `name`)                                          |

Default `ALLOWED_HOSTS`: `api.openai.com`, `generativelanguage.googleapis.com`,
`api.anthropic.com`, `openrouter.ai`, `api.groq.com`, `api.deepseek.com`,
`api.mistral.ai`, `api.x.ai`.

### Model routing (`MODEL_ROUTES`)

`MODEL_ROUTES` is a JSON object (stored as a string var) that maps the model name Claude
Code sends to a backend. A model with no matching route goes to Workers AI with the name
unchanged.

```jsonc
"MODEL_ROUTES": "{\"claude-sonnet-*\": {\"provider\": \"workers-ai\", \"model\": \"@cf/zai-org/glm-5.3\", \"fallback\": [\"deepseek-chat\"]}, \"deepseek-chat\": {\"provider\": \"openai\", \"model\": \"deepseek-chat\", \"baseUrl\": \"https://api.deepseek.com/v1\", \"keySecret\": \"DEEPSEEK_KEY\"}}"
```

```bash
npx wrangler secret put DEEPSEEK_KEY
```

Each route has these keys (unknown keys are rejected):

| Key             | Required                   | Meaning                                                                                         |
| --------------- | -------------------------- | ----------------------------------------------------------------------------------------------- |
| `provider`      | yes                        | `workers-ai`, `openai`, `openai-responses`, `gemini` or `anthropic`                             |
| `model`         | yes                        | Model name sent to the backend                                                                  |
| `baseUrl`       | non-`workers-ai` providers | Provider URL including any version prefix (see **Base URLs** below)                             |
| `keySecret`     | non-`workers-ai` providers | Name (`[A-Z][A-Z0-9_]*`) of a secret set with `wrangler secret put`; `PROXY_KEY` is rejected    |
| `fallback`      | no                         | Up to 3 model names to try after this one                                                       |
| `contextTokens` | no                         | Context window reported by `GET /v1/models`; default 24 000 (see **One-hop inheritance** below) |
| `reasoning`     | no                         | `true` reports the `thinking` capability in `GET /v1/models`; default `false`                   |
| `vision`        | no                         | Overrides `VISION_MODELS` for this model                                                        |
| `multiTool`     | no                         | Overrides `MULTI_TOOL_MODELS` for this model                                                    |

- **Shipped defaults:** `wrangler.jsonc` ships `MODELS` and `MODEL_ROUTES` with `@cf/zai-org/glm-5.3`,
  `@cf/moonshotai/kimi-k2.6` and `@cf/deepseek-ai/deepseek-v4-pro-0813`, each an identity route that
  carries its context window and `reasoning: true`. No model id is hard-coded in `src/`.
- **Base URLs:** include any version prefix (e.g. `https://api.openai.com/v1`); the proxy appends
  `chat/completions`, `responses` or `messages`. The URL is checked against `ALLOWED_HOSTS` and
  `ALLOW_HTTP` like the path convention.
- **One-hop inheritance:** a route that leaves `contextTokens`, `reasoning`, `vision` or `multiTool`
  unset takes them from the backing model's exact route on the same provider (the route whose key,
  with no `*`, equals its `model`). Only one hop is followed, so `claude-sonnet-*` pointing at
  `@cf/zai-org/glm-5.3` reports that model's window, but a chain of aliases does not. A route's own
  value always wins. Without either, a model reports 24 000, so set `contextTokens` for
  large-context models.
- **Matching:** a key without `*` is an exact match and always wins. Otherwise the first
  glob key (in the order written) whose `*` wildcards match the name is used.
- **Fallback:** only before a backend's response is accepted (before any backend content is
  relayed; keepalive pings may already have reached the client). The proxy moves to the next
  name in `fallback` on a `429`, any `5xx` (including a timeout `504`) or a connection error.
  Each fallback name is routed through `MODEL_ROUTES` too (so a catch-all `"*"` route also
  captures fallback names), and duplicates are skipped. The last target's result is
  returned as is.
- **Workers AI errors:** a Workers AI `429` or `5xx` is retried twice with backoff, then
  returned with its status (`429 rate_limit_error`, or `502 api_error` for a `5xx`), so
  route fallback applies. Other `4xx` responses are returned at once as
  `invalid_request_error`. An unknown model is not retried; if the binding reports it as a
  thrown error it comes back as `502 api_error`, so route fallback still applies.
- **Errors:** a malformed `MODEL_ROUTES`, or a `keySecret` that is not set, makes the
  request fail with `500 invalid config: <VAR>`. Secrets are resolved up front, so a missing
  secret for a fallback target fails every request on that route, even when the primary is
  healthy.

### Keepalive

Claude Code gives up on a silent connection, and slow models can take a while to start. If
a streaming `POST /v1/messages` request (`stream: true`) has not had its backend stream
start after 5 s, the proxy commits to a `200` SSE
response, sends `message_start`, then a `ping` every 10 s until the backend answers. A
backend failure after that point arrives as an SSE `error` event, because the status is
already sent. Keepalive covers only the wait for the stream to start; silence between
chunks after that is bounded by `UPSTREAM_TTFB_MS` (the idle timeout), which ends the stream
with an SSE `error` event. Keepalive has no opt-out and does not apply to non-stream
requests or to the `/{type}/{provider_url}/v1/messages` path.

## Security defaults

| Default           | Behavior and opt-out                                                                                                                                                                                                     | Error text                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Auth required     | With no `PROXY_KEY`, API requests fail with `500`. Opt out with `ALLOW_ANONYMOUS=true`. A wrong or missing key gets `401`.                                                                                               | `proxy not configured: set PROXY_KEY or ALLOW_ANONYMOUS=true`; `invalid x-api-key` / `invalid x-proxy-key`                    |
| Host allowlist    | External routes only reach hosts in `ALLOWED_HOSTS` (`403`). IP literals and custom ports are also rejected. Opt out with `ALLOWED_HOSTS=*`.                                                                             | `Provider host not allowed by ALLOWED_HOSTS`; `IP-literal provider hosts are not allowed`; `custom ports are not allowed`     |
| HTTPS only        | `http://` provider URLs get `403`. Opt out with `ALLOW_HTTP=true`. Credentials in the URL and unparseable URLs (`400`) are always rejected.                                                                              | `http provider URLs are disabled; set ALLOW_HTTP=true`; `credentials in provider URL are not allowed`; `invalid provider URL` |
| Body limit        | POST bodies over the limit get `413`. Tune with `MAX_BODY_BYTES`.                                                                                                                                                        | `request body exceeds MAX_BODY_BYTES (<n> bytes)`                                                                             |
| Upstream timeouts | Slow upstreams get `504`; on streaming `/v1/messages` a 504 after keepalive has committed arrives as a `200` plus an SSE `error` event (keepalive has no opt-out). Tune with `UPSTREAM_TTFB_MS` and `UPSTREAM_TOTAL_MS`. | `upstream timed out after <n> ms`                                                                                             |
| Header allowlist  | Only allowlisted client headers are forwarded upstream; the rest are stripped. There is no opt-out variable.                                                                                                             | none                                                                                                                          |
| Invalid config    | A malformed var (e.g. `MAX_BODY_BYTES=abc`, `ALLOW_HTTP=yes`) makes every request fail with `500` instead of silently using a default. Fix the var in `wrangler.jsonc`.                                                  | `invalid config: <VAR>` (e.g. `invalid config: MAX_BODY_BYTES`)                                                               |

Provider API keys that appear verbatim in an upstream response are scrubbed before it is returned:
error bodies whole, and successful (including streamed) bodies as they arrive, so an error event
inside a `200` stream is covered too. A key that model output spreads over several stream events is
not contiguous in the bytes and is not caught.

## Rate limiting and logging

Messages endpoints are rate-limited per client IP (100 requests / 60 s) via a
Cloudflare rate-limiting binding; over-limit requests get `429 rate_limit_error`
with a `retry-after` header. Each messages request also emits one JSON log line
(`event: "request"`) visible in `wrangler tail` and Workers Logs:

| Field                                   | Meaning                                                                                                |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `requestId`, `method`, `path`           | Request identity                                                                                       |
| `status`, `durationMs`                  | Final status and total time                                                                            |
| `streamed`                              | `true` for streamed responses                                                                          |
| `model`                                 | Model name the client requested                                                                        |
| `route`                                 | Matching `MODEL_ROUTES` key, if any (the shipped models have identity routes, so they log one)         |
| `backend`                               | Final target as `provider:model`; path-convention requests log only the provider type                  |
| `fallbackUsed`                          | `true` if a fallback target answered                                                                   |
| `ttfbMs`                                | Time until the backend answered                                                                        |
| `inputTokens`, `outputTokens`           | Usage reported by the backend; on Workers AI often the proxy's characters/4 estimate                   |
| `toolCallsFromText`, `unparsedToolText` | Tool calls recovered from, or left in, plain model text                                                |
| `keepalive`                             | `true` if keepalive committed the response before the backend answered                                 |
| `streamError`                           | Streamed response ended with an SSE `error` event (its `error.type`), or `error` if the stream broke   |
| `cancelled`                             | `true` if the client cancelled the stream before it ended                                              |
| `engagement`, `mode`                    | `x-engagement` name and the resolved mode; present only when an engagement was named                   |
| `tools`                                 | Unique `tool_use` names in the response, first-seen order (at most 16, 64 chars each); omitted if none |

When keepalive has already committed, `status` is the backend's real status (the client
saw `200`), `keepalive: true` is set, and `inputTokens` is the proxy's estimate.

Send `x-proxy-debug: 1` (authenticated callers only) to get the proxy's view of a request
back: streaming responses end with a `: proxy-stats <json>` SSE comment, and non-streaming
responses carry an `x-proxy-stats` header. The stats hold `backend`, `model`,
`fallbackUsed`, `ttfbMs`, `toolCallsFromText` and `unparsedToolText`.

Each MCP `tools/call` (see [MCP server](mcp.md)) also logs one `event: "mcp"` line with `requestId`,
`tool`, `action`, `ok` and `durationMs`. It never logs arguments or results; other MCP methods
log nothing.

## Model listing

`GET /v1/models` lists the `MODELS` names (the shipped list in `wrangler.jsonc`; none if unset) plus every `MODEL_ROUTES`
key that has no `*`. A name matched only by a glob route is not listed, but
`GET /v1/models/{id}` resolves it. A `redteam/` or `purple/` prefix on `{id}` is stripped
first, so `GET /v1/models/redteam/claude-x` describes `claude-x`. Each entry reports `max_input_tokens` and the
`vision`, `multi_tool_use` and `thinking` capabilities, resolved from the route (then its one-hop
backing route, see Model routing). `vision` and `multi_tool_use` fall back to `VISION_MODELS` /
`MULTI_TOOL_MODELS` (the backing model or the routed name); `thinking` falls back to `false`.

### Upgrading to model-agnostic config

The built-in model list and context windows are gone from the code. A deploy that sets its own
`MODEL_ROUTES` replaces the shipped value, so copy these three identity entries into it to keep
the context windows:

```jsonc
"@cf/zai-org/glm-5.3": {"provider": "workers-ai", "model": "@cf/zai-org/glm-5.3", "contextTokens": 1048576, "reasoning": true},
"@cf/moonshotai/kimi-k2.6": {"provider": "workers-ai", "model": "@cf/moonshotai/kimi-k2.6", "contextTokens": 262144, "reasoning": true},
"@cf/deepseek-ai/deepseek-v4-pro-0813": {"provider": "workers-ai", "model": "@cf/deepseek-ai/deepseek-v4-pro-0813", "contextTokens": 1048576, "reasoning": true}
```

A deploy that sets its own `MODELS` and no `MODEL_ROUTES` still works, but every listed model
reports 24 000 tokens and no `thinking`.
