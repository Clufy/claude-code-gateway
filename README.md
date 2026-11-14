# claude-code-gateway

[![CI](https://github.com/Clufy/claude-code-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/Clufy/claude-code-gateway/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Clufy/claude-code-gateway)

**Run [Claude Code](https://docs.anthropic.com/en/docs/claude-code) on any model: open models on
Cloudflare Workers AI, OpenAI, Gemini or Anthropic, through one Worker you deploy yourself.**

claude-code-gateway is a Cloudflare Worker that speaks the Anthropic Messages API, so Claude Code
talks to it as if it were Anthropic. Behind it, each model name routes to a backend of your choice,
and every session passes a security layer built for AI-assisted red and purple teaming.

```text
Claude Code ──Anthropic Messages API──▶ claude-code-gateway ──▶ Workers AI · OpenAI · Gemini · Anthropic
                                         (your Worker)
                                         auth · routing · fallbacks · session guard · scope check · /mcp
```

## Why

- **Use Claude Code with the model you choose.** It ships configured for GLM-5.3, Kimi K2.6 and
  DeepSeek V4 Pro on Workers AI, with no GPU of your own. Add OpenAI, Gemini, DeepSeek, Groq,
  OpenRouter or Anthropic itself with one JSON route each, and no code change.
- **Keep the full Claude Code experience.** Streaming, tool use, extended thinking, vision for
  the models you flag, token counting and `/v1/models` with real context windows, all translated
  to each backend's format.
- **Point AI agents at targets safely.** Engagements pin what a session may touch, and a Claude
  Code hook blocks tool calls that reach outside that scope.

## Features

- **Multi-provider routing:**
    - Workers AI, OpenAI Chat Completions and Responses, Gemini, and the Anthropic Messages API.
    - Up to 3 fallback models per route, retries that honour `retry-after`, and per-route
      context windows.
- **Secure by default:**
    - A proxy key is required, and requests without one are refused.
    - Provider hosts must be on an allowlist, and http:// URLs are rejected.
    - Bodies are capped in size and requests are rate limited.
    - Provider keys are scrubbed from every upstream response, streamed or not.
- **Session guard:** flags prompt injection, secrets and risky tool calls in each turn and in the
  model's `tool_use` blocks. It never blocks or alters traffic, and you can add your own rules
  in `GUARD_RULES`.
- **Engagements and the scope hook:** red-team and purple engagements with scope, exclusions and
  time windows. A `PreToolUse` hook denies Claude Code tool calls aimed outside the scope.
- **Red-team harness:** 70 canary-based attack cases in 7 suites, mapped to the OWASP Top 10 for
  LLM Applications (LLM01, 02, 05, 06 and 07). Run it against this Worker, or a model endpoint
  your engagement puts in scope, and read the scorecard.
- **Purple loop:** a model drafts a Sigma rule from a finding. You test the rule against events or
  the Worker's own logs, then promote it to a guard rule.
- **MCP server:** `engagement`, `logs`, `redteam` and `purple` tools at `/mcp`, usable from
  Claude Code itself.
- **Model qualification:** `npm run qualify` replays real Claude Code traffic and scores how
  reliably a model drives tools before you depend on it.

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

### One-click deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Clufy/claude-code-gateway)

The button copies this repo into your GitHub account and deploys it to your Cloudflare account,
using Workers AI with the shipped models. Setup asks for `PROXY_KEY`: pick a long random value,
the key Claude Code will send. Then skip to [Point Claude Code at the Worker](#point-claude-code-at-the-worker).

### Or deploy from your machine

#### 1. Log in

```bash
npx wrangler login
```

#### 2. Install and type-check

```bash
npm install
npm run check
```

#### 3. Deploy

```bash
npm run deploy
```

After deploy, note the Worker URL.

#### 4. Set the proxy key

Auth is required by default (see [Security defaults](docs/configuration.md#security-defaults)).
Set a proxy-scoped secret. Internal routes require `x-api-key`; external provider routes require `x-proxy-key` (so
`x-api-key`/`Authorization` can be the provider key).

```bash
npx wrangler secret put PROXY_KEY
```

For local dev, `cp .dev.vars.example .dev.vars` and set `PROXY_KEY` there (`.dev.vars` is gitignored).

#### 5. Configure

The shipped `wrangler.jsonc` works as is with Workers AI. To add providers, routes or other
settings, see [Configuration](docs/configuration.md).

## Point Claude Code at the Worker

Edit `~/.claude/settings.json`. Replace the URL and pick a model that works with your
chosen backend.

```json
{
    "env": {
        "ANTHROPIC_BASE_URL": "https://<worker-subdomain>.workers.dev",
        "ANTHROPIC_CUSTOM_HEADERS": "x-api-key: your-proxy-key-value",
        "ANTHROPIC_MODEL": "@cf/zai-org/glm-5.3",
        "ANTHROPIC_SMALL_FAST_MODEL": "@cf/moonshotai/kimi-k2.6"
    }
}
```

If you deliberately run without a `PROXY_KEY` (`ALLOW_ANONYMOUS=true`, see
[Security defaults](docs/configuration.md#security-defaults)), leave out `ANTHROPIC_CUSTOM_HEADERS`.

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
