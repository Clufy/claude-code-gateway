# claude-code-gateway

A Cloudflare Worker that lets [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
run against multiple AI backends through an Anthropic-compatible API.

The default `POST /v1/messages` route targets **Cloudflare Workers AI** via the local
`env.AI.run()` binding. Additional routes proxy to Gemini, OpenAI Chat Completions, the
OpenAI Responses API, or a native Anthropic Messages API (`anthropic`), through the provider
path convention or `MODEL_ROUTES`.

## Documentation

| Read this                                    | For                                                                   |
| -------------------------------------------- | --------------------------------------------------------------------- |
| [Architecture](docs/ARCHITECTURE.md)         | How a request flows through the code, and where each part lives       |
| [Configuration](docs/configuration.md)       | Routes, providers, `wrangler.jsonc` vars, security defaults, logging  |
| [Engagements and modes](docs/engagements.md) | Scoped red-team/purple engagements, the scope check endpoint and hook |
| [Session guard](docs/guard.md)               | Request and response rules, detections, `GUARD_RULES`                 |
| [MCP server](docs/mcp.md)                    | The `/mcp` tools and setting up `logs`                                |
| [Red-team harness](docs/redteam.md)          | Running the attack corpus and reading the scorecard                   |
| [Purple loop](docs/purple-loop.md)           | Drafting, testing and promoting Sigma rules                           |
| [Model qualification](docs/qualify.md)       | Checking a model works with Claude Code before you rely on it         |
| [Manual testing](docs/testing.md)            | Step-by-step checks against `wrangler dev` and a deployed Worker      |

## Quick start

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

Auth is required by default (see [Security defaults](docs/configuration.md#security-defaults)).
Set a proxy-scoped secret. Internal routes require `x-api-key`; external provider routes require `x-proxy-key` (so
`x-api-key`/`Authorization` can be the provider key).

```bash
npx wrangler secret put PROXY_KEY
```

For local dev, put `PROXY_KEY=dev-key` in `.dev.vars` (gitignored).

### 5. Configure

The shipped `wrangler.jsonc` works as is with Workers AI. To add providers, routes or other
settings, see [Configuration](docs/configuration.md).

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
- Unknown models report a 24k context window, so Claude Code compacts often. Give the
  model a `MODEL_ROUTES` entry with `contextTokens` to report its real window.

## Revert to Anthropic's API

Remove the proxy-related entries from `~/.claude/settings.json` and unset any session
exports:

```bash
unset ANTHROPIC_BASE_URL ANTHROPIC_MODEL ANTHROPIC_SMALL_FAST_MODEL ANTHROPIC_API_KEY ANTHROPIC_CUSTOM_HEADERS
```

## How it works

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) walks one request through the code. In short:

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

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md) to set up and send changes, and [SECURITY.md](SECURITY.md) to
report a vulnerability privately. Released under the [MIT License](LICENSE).
