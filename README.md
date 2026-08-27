# claude-workers-ai-proxy

A Cloudflare Worker that lets [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
run against Cloudflare Workers AI models instead of Anthropic's API, using Workers AI's
daily free Neuron allocation for development and testing.

Claude Code speaks the Anthropic Messages API (`POST /v1/messages`, streaming and
non-streaming). Workers AI uses a different shape and is called through the `env.AI.run()`
binding. This Worker sits in the middle: it accepts Anthropic-format requests, calls
Workers AI, and translates the response (including streamed tokens) back into a valid
Anthropic Messages API response, so Claude Code can't tell the difference.

## Deploy

### 1. Log in

```bash
npx wrangler login
```

### 2. Deploy the Worker

```bash
npx wrangler deploy
```

Wrangler reads `wrangler.toml`, which declares the `AI` binding. The Worker calls
Workers AI directly through that binding — no separate API key or REST call is needed.

After deploy, note the Worker URL (for example
`https://claude-workers-ai-proxy.<your-subdomain>.workers.dev`).

### 3. Optional: protect it with a shared secret

If you set a `PROXY_KEY` secret, the Worker requires a matching `x-api-key` header on
every request. Leave it unset to allow unauthenticated access.

```bash
npx wrangler secret put PROXY_KEY
```

Then in Claude Code, include that same value in `ANTHROPIC_CUSTOM_HEADERS`.

## Point Claude Code at the Worker

Edit `~/.claude/settings.json` (create it if it doesn't exist). Replace the URL with
your deployed Worker URL and pick Workers AI model IDs that work for you.

### Without a `PROXY_KEY`

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://claude-workers-ai-proxy.<your-subdomain>.workers.dev",
    "ANTHROPIC_MODEL": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    "ANTHROPIC_SMALL_FAST_MODEL": "@cf/meta/llama-3.1-8b-instruct-fast"
  }
}
```

### With a `PROXY_KEY`

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://claude-workers-ai-proxy.<your-subdomain>.workers.dev",
    "ANTHROPIC_CUSTOM_HEADERS": "x-api-key: your-proxy-key-value",
    "ANTHROPIC_MODEL": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    "ANTHROPIC_SMALL_FAST_MODEL": "@cf/meta/llama-3.1-8b-instruct-fast"
  }
}
```

Notes:

- `ANTHROPIC_CUSTOM_HEADERS` uses `Name: Value` format. If `PROXY_KEY` is set, the
  `x-api-key` value must match it exactly.
- Claude Code will still look for an API key/authentication. You can satisfy it with a
  dummy value, e.g. `export ANTHROPIC_API_KEY="sk-ant-dummy"`. The Worker ignores the
  `x-api-key`/`Authorization` value unless `PROXY_KEY` is set.

### Example Workers AI model IDs

- `@cf/meta/llama-3.3-70b-instruct-fp8-fast`
- `@cf/meta/llama-3.1-70b-instruct`
- `@cf/meta/llama-3.1-8b-instruct-fast`
- `@cf/meta/llama-3.2-3b-instruct`
- `@cf/deepseek-ai/deepseek-r1-distill-qwen-32b`

Run `npx wrangler ai models` to see what's currently available on your account.

## Test in a throwaway directory first

Point Claude Code at the Worker only for an isolated project before touching real code.

```bash
mkdir ~/claude-proxy-test && cd ~/claude-proxy-test
```

Either export the variables for that shell only, or use a project-local
`.claude/settings.json` in that directory instead of editing `~/.claude/settings.json`:

```bash
export ANTHROPIC_BASE_URL="https://claude-workers-ai-proxy.<your-subdomain>.workers.dev"
export ANTHROPIC_MODEL="@cf/meta/llama-3.1-8b-instruct-fast"
export ANTHROPIC_SMALL_FAST_MODEL="@cf/meta/llama-3.1-8b-instruct-fast"
export ANTHROPIC_API_KEY="sk-ant-dummy"
# only if you set PROXY_KEY:
export ANTHROPIC_CUSTOM_HEADERS="x-api-key: your-proxy-key-value"

claude -p "Say hello in one sentence."
```

If you get a coherent reply, the proxy is working end to end.

## Revert to Anthropic's API directly

Remove the proxy-related variables from `~/.claude/settings.json` (and unset any
shell exports). The `env` block should go back to whatever you had before, for example:

```json
{
  "env": {}
}
```

Then unset any session exports and restart `claude`:

```bash
unset ANTHROPIC_BASE_URL
unset ANTHROPIC_MODEL
unset ANTHROPIC_SMALL_FAST_MODEL
unset ANTHROPIC_API_KEY
unset ANTHROPIC_CUSTOM_HEADERS
```

Claude Code will go back to the default Anthropic API endpoint and subscription
authentication.

## How it works

- `GET /` returns `ok` (health check).
- `POST /v1/messages` is the only accepted endpoint; anything else returns `404`.
- If `PROXY_KEY` is set, the `x-api-key` header must match (timing-safe comparison),
  otherwise the request is rejected with `401`.
- The Anthropic body (`model`, `messages`, `system`, `max_tokens`, `temperature`,
  `stream`) is flattened to plain strings for Workers AI:
  - `text` blocks become their text.
  - `tool_result` blocks become `JSON.stringify(content)`.
  - `tool_use` blocks become `[called tool <name> with input <json>]`.
  - A `system` value is prepended as a `system` role message.
- Non-streaming responses are wrapped in a valid Anthropic `message` object with a
  generated `msg_<uuid>` id and estimated token usage.
- Streaming responses are re-emitted as Anthropic SSE events:
  `message_start` → `content_block_start` → repeated `content_block_delta`
  (`text_delta`) → `content_block_stop` → `message_delta` → `message_stop`.

## Limitations

- **Token usage is estimated, not exact.** Workers AI does not return exact input/output
  token counts, so `input_tokens` is `0` and `output_tokens` is estimated from text
  length (`ceil(chars / 4)`).
- **Tool calls are flattened to plain text.** `tool_use` and `tool_result` blocks are
  converted to readable text rather than reconstructed as structured tool calls. This
  means multi-step agentic tool-calling workflows may behave less reliably than they do
  with Claude itself.
- **`PROXY_KEY` is a single shared secret, not per-user auth.** Anyone with the key can
  use the Worker, and there is no per-user identification or rate limiting beyond what
  Cloudflare provides.
- **Free-tier limits apply.** Workers AI free tier is capped at 10,000 neurons/day, and
  larger models consume more neurons per request.
