# Architecture

How the Worker is laid out, how one request moves through it, and where to make common changes.
For what each feature does and how to configure it, follow the links in the [README](../README.md).

## Repository layout

```text
src/                 The Worker (Cloudflare Workers runtime)
  index.ts           Entry point: matches the URL and runs the handler for each route
  config.ts          Reads env vars into one validated ProxyConfig (routes, limits, guard, roles)
  engagement.ts      Engagement scopes and windows (ENGAGEMENTS), shared by guard, modes and MCP
  http/              Request plumbing: proxy-key auth, body limit, error shapes, request id, SSE keepalive
  routing/           Which backend serves a model: MODEL_ROUTES matching, fallback dispatch,
                     upstream fetch with retries and key scrubbing, /v1/models listing
  providers/         One file per backend (workers-ai, openai, gemini, anthropic) behind provider.ts
  translate/         Anthropic <-> provider format helpers: API types, SSE builders (common.ts),
                     reasoning effort, tool_choice, Hermes text tool calls, token estimates
  logs/              Request log line, detection audit lines, per-request stats, SSE tap,
                     Cloudflare observability (logs API) client
  guard/             Session guard: request and response rules, detections, /v1/guard/check
  modes/             redteam/ and purple/ model aliases and their prompt packs
  mcp/               The /mcp server and its tools (engagement, logs, redteam, purple)
  purple/            Sigma parser, evaluator, rule drafter and GUARD_RULES promotion
  shared/redteam/    Red-team runner, corpus loader, scorers and judge. Runtime-agnostic:
                     used by both the Worker (MCP redteam tool) and the Node CLI in scripts/
test/                Vitest suites, mirroring src/ folder by folder
  *.test.ts          Run inside workerd (vitest project "workers")
  *.node.test.ts     Run in Node (project "node"); used where a test reads files from disk
  *.bench.test.ts    CPU-budget benchmarks, only with `npm run bench`
  helpers.ts         callWorker(), makeEnv(), stubFetch(), fakeAI()
scripts/             Node CLIs: qualify (model qualification), redteam (harness), update-psl
claude-code/hooks/   The scope-guard PreToolUse hook for Claude Code
redteam/corpus/      Attack cases, one folder per suite (deliberate injection text: test data)
redteam/purple/      Dogfood Sigma rules and their benign probe set
docs/                User docs; docs/history/ holds the original specs and plans
wrangler.jsonc       Worker config and the shipped vars (MODELS, MODEL_ROUTES)
```

## One request: `POST /v1/messages`

```text
index.ts handleRequest
  ├─ http/          rate limit + proxy key (auth.ts), body size cap (body-limit.ts)
  ├─ modes/         applyMode: engagement header, redteam/ or purple/ alias, prompt pack
  ├─ guard/         request rules over the incoming messages (detections, optional block)
  ├─ routing/       planTargets: MODEL_ROUTES match -> target list (route + fallbacks)
  │                 dispatchWithFallback -> callTarget for each target until one is accepted
  │    ├─ workers-ai:  providers/workers-ai.ts calls env.AI.run() directly
  │    └─ others:      providers/<name>.ts converts the request (translate/*),
  │                    routing/upstream.ts fetches with retries, scrubs the key,
  │                    the provider converts the response back to Anthropic format
  ├─ http/keepalive streaming only: pings the client until the first byte arrives
  └─ logs/          finalizeMessagesResponse: response guard over tool_use blocks
                    (SSE tap for streams), then one request log line
```

The other routes in `index.ts`:

| Route                                      | Handler                                             |
| ------------------------------------------ | --------------------------------------------------- |
| `GET /`                                    | Health check                                        |
| `GET /v1/models`, `GET /v1/models/{id}`    | `routing/models.ts`                                 |
| `POST /v1/messages/count_tokens`           | `translate/tokens.ts`                               |
| `POST /v1/guard/check`                     | `guard/check.ts` (the scope check used by the hook) |
| `/mcp`                                     | `mcp/server.ts`                                     |
| `POST /{provider}/{host/path}/v1/messages` | Path convention: `handleExternal` in `index.ts`     |

## Where to make common changes

| Change                    | Where                                                                                                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add or change a model     | `wrangler.jsonc` vars (`MODELS`, `MODEL_ROUTES`); no code change. See [configuration](configuration.md)                                               |
| Add a backend type        | New `src/providers/<name>.ts` implementing `Provider`; register it in `routing/dispatch.ts` `PROVIDERS`; add the name to `BackendType` in `config.ts` |
| Add a config var          | `config.ts` (`loadConfig` and `ProxyConfig`), the comment block in `wrangler.jsonc`, [configuration](configuration.md)                                |
| Add a built-in guard rule | `guard/request-rules.ts` or `guard/response-rules.ts`; its id and severity in `BUILTIN_RULES` (`guard/ids.ts`); wire it in `guard/index.ts`           |
| Add an MCP tool           | New `src/mcp/<name>-tool.ts` exporting a `ToolRegistrar` (`tool-kit.ts`); add it to `TOOLS` in `mcp/server.ts`                                        |
| Add red-team cases        | `redteam/corpus/<suite>/cases.json` ([redteam](redteam.md#adding-cases))                                                                              |

## Rules that keep it working

- **Workers runtime.** Everything in `src/` runs in workerd: no `node:` imports, no `process`,
  no `Buffer`. `src/shared/**` must also run in Node, so it imports only sibling `./*.ts` files
  (enforced by `test/shared/redteam/core.node.test.ts`).
- **No model ids in `src/`.** Models live in config; `test/model-ids.node.test.ts` fails if one
  is hard-coded.
- **Secrets never reach a client or a log.** Upstream bodies are scrubbed in `routing/upstream.ts`;
  detection excerpts are redacted in `guard/redact.ts`.
- **Checks.** `npm run check` (types for src, test and scripts, then formatting) and `npm test`
  must pass before a change lands.
