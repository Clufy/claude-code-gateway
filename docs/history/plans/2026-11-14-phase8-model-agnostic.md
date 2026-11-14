# Phase 8 — Model-agnostic Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Models from any provider are added or changed by editing config only. There are no model ids in `src/`; per-model profiles live on `MODEL_ROUTES`; there is a native `anthropic` provider; and `DRAFT_MODEL` and `JUDGE_MODEL` pick the model for each feature.

**Architecture:**

- `src/config.ts` gains three profile keys on route entries, an `anthropic` backend, and two role-model fields on `ProxyConfig`.
- `src/models.ts` resolves capabilities from routes, taking one hop to the backing model's own route. The shipped defaults move into `wrangler.jsonc` `vars`.
- A new pass-through provider, `src/providers/anthropic.ts`, plugs into the existing `PROVIDERS` registry. The MCP `purple` and `redteam` tools read the role models from `ctx.config`.

**Tech Stack:** TypeScript strict, Cloudflare Workers, vitest 4 (`workers` and `node` projects), zod 4, `@modelcontextprotocol/sdk`.

**Spec:** `docs/superpowers/specs/2026-11-14-model-agnostic-design.md`. It includes rulings P8-D1 to P8-D4.

## Global Constraints

- **No model ids in `src/`:** after this phase, no `@cf/` model id appears in `src/**` behaviour. Comments and example text in error messages are allowed, but only on lines a test allowlists.
- **Behaviour without new config is unchanged:** a deploy that sets none of the new keys behaves as today in routing, listing and context windows, once the shipped `wrangler.jsonc` vars are applied. An unrouted model name still goes to Workers AI unchanged.
- **Strict config validation:**
    - `vision`, `multiTool` and `reasoning` on a route must be booleans.
    - Unknown route keys are still rejected.
    - A bad value fails with `ConfigError('MODEL_ROUTES', …)`, which surfaces as `500 invalid config: MODEL_ROUTES`.
    - `DRAFT_MODEL` and `JUDGE_MODEL` are trimmed strings; empty means unset.
- **`anthropic` provider security:**
    - Upstream, it sends only `x-api-key: <route or provider key>`, `anthropic-version: 2023-06-01`, `content-type: application/json`, and the client's `anthropic-beta` if present.
    - It never sends the proxy key, the client's `x-api-key`/`Authorization`, `x-engagement`, `x-proxy-*` or cookies.
    - The response headers relayed are only `content-type` and `retry-after`. The proxy's own `request-id` wins.
    - Upstream error bodies are scrubbed of the key with the existing `scrubUpstreamError`.
- **Package and runtime:**
    - No new dependencies.
    - `src/**` runs in Workers: no `node:` imports, no `process`, no `Buffer`.
    - Imports are extensionless, except imports of `src/shared/redteam/*.ts`, which keep `.ts`.
- **Process:**
    - Commits carry no Co-Authored-By trailer.
    - Never push. Subagents never run wrangler or `npm install`, and never use the network.
- **Definition of done for each task:** `npm test` is green, and `npx tsc --noEmit && npx tsc -p test/tsconfig.json --noEmit && npx prettier --check .` is clean.

## Review Focus

1. **Alias inheritance:** A glob alias (`claude-sonnet-*` → `@cf/zai-org/glm-5.3`) with no profile keys reports its backing model's identity-route `contextTokens` and `reasoning`. The alias's own key wins. Exactly one hop is taken, never two. Pinned in Task 2.
2. **Proxy key never reaches Anthropic:** On the default `/v1/messages` path, the inbound `x-api-key` is the **proxy key**. It must never reach Anthropic: the provider sets `x-api-key` from the route's secret only. Pinned in Task 3.
3. **Fallback from Workers AI to `anthropic`:** The history carries unsigned `thinking` blocks. They are stripped, and signed ones are kept. Assistant messages whose `content` is a string are untouched. Pinned in Task 3.
4. **Empty config:**
    - No `MODELS` and no `MODEL_ROUTES`: `/v1/models` is an empty list, and `/v1/messages` with any name still reaches Workers AI.
    - `MODELS` set without routes: each id reports 24 000 and `false` capabilities, unless the legacy lists say otherwise.

    Pinned in Task 2.

5. **Role-model precedence:**
    - `JUDGE_MODEL` set and `judgeModel: ""` gives no judge.
    - `DRAFT_MODEL` set to a name absent from `/v1/models` is still used, because explicit config wins.

    Pinned in Task 4.

## File Structure

| File                                                | Responsibility                                                                                                                     |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `src/config.ts`                                     | `Route` profile keys, the `'anthropic'` backend, and `draftModel`/`judgeModel` on `ProxyConfig`                                    |
| `src/models.ts`                                     | `/v1/models` listing; profile resolution (own route → backing route → legacy lists → default); `thinking` capability; no model ids |
| `wrangler.jsonc`                                    | Shipped default `MODELS` and identity `MODEL_ROUTES`; the comment block documents the new keys and vars                            |
| `src/providers/anthropic.ts`                        | Pass-through `Provider`: header allowlists, unsigned-thinking strip, model swap                                                    |
| `src/dispatch.ts`                                   | Register `anthropic` in `PROVIDERS`                                                                                                |
| `src/mcp/purple-tool.ts`, `src/mcp/redteam-tool.ts` | Role-model precedence                                                                                                              |
| `README.md`, `TESTING.md`                           | Docs for each task's feature                                                                                                       |

---

### Task 1: Config — profile keys, `anthropic` backend, role models

**Files:**

- Modify: `src/config.ts`. Change `BackendType` and `Route` (lines 5-13), `ProxyConfig` (25-39), `BACKENDS`/`ROUTE_KEYS` (112-113), `parseRoutes` and `loadConfig`.
- Test: the existing `MODEL_ROUTES` parser tests. Find them with `grep -l "contextTokens must be a positive integer" test/`. Add a new `describe` there, or in `test/config-routes.test.ts` if none exists.

**Interfaces:**

- Produces:
    - `type BackendType = 'workers-ai' | 'openai' | 'openai-responses' | 'gemini' | 'anthropic'`
    - `Route` gains `vision?: boolean; multiTool?: boolean; reasoning?: boolean`
    - `ProxyConfig` gains `draftModel: string | null; judgeModel: string | null`, set from `DRAFT_MODEL` and `JUDGE_MODEL`, trimmed, with `''` → `null`.

- [ ] **Step 1: Write the failing tests:**
    - Each of `vision`/`multiTool`/`reasoning` set to `true` and to `false` is copied onto the `Route`.
    - Each set to `"yes"` throws `ConfigError` with the message `route "<pattern>" <key> must be a boolean`.
    - `provider: 'anthropic'` without `baseUrl`/`keySecret` throws `route "<pattern>" requires baseUrl and keySecret`.
    - `provider: 'anthropic'` with `baseUrl: 'https://api.anthropic.com/v1', keySecret: 'ANTHROPIC_KEY'` parses.
    - `loadConfig({ DRAFT_MODEL: '  m1 ', JUDGE_MODEL: '' })` gives `draftModel: 'm1'` and `judgeModel: null`.
    - When the vars are absent, both are `null`.
- [ ] **Step 2: Run** `npx vitest run --project workers <that test file>`. Expected: FAIL.
- [ ] **Step 3: Implement.** Add `'anthropic'` to `BACKENDS`, add the three keys to `ROUTE_KEYS`, validate each as a boolean with the exact message above, and add the role fields to `loadConfig`.
- [ ] **Step 4: Run** the same command. Expected: PASS. Then run `npm test` and the check commands.
- [ ] **Step 5: Commit** `feat(config): route profile keys, anthropic backend, role models`.

---

### Task 2: Model profiles and shipped defaults (no model ids in `src/`)

**Files:**

- Modify: `src/models.ts` (delete `DEFAULT_MODELS` and `CONTEXT_TOKENS`; rewrite `toModel`, `configuredModelIds`, `listing`), `wrangler.jsonc` (`vars` plus the comment block), `README.md` (§5 vars table, the route-key table under "Model routing (`MODEL_ROUTES`)", "Model listing", and a new "Upgrading to model-agnostic config" note).
- Test: `test/models.test.ts` (update and extend), plus new `test/model-ids.node.test.ts` and `test/shipped-config.node.test.ts`.
- Any other test that relied on the built-in list must set `MODELS` explicitly in its env. Find them by running the full suite after Step 3. Change only the env setup, never the assertion intent.

**Interfaces:**

- Consumes: `Route.vision/multiTool/reasoning/contextTokens` (Task 1); `findRouteEntry(id, routes)` from `src/routing`.
- Produces: listing entries gain `capabilities.thinking: { name: 'thinking', supported: boolean }`. `DEFAULT_CONTEXT_TOKENS = 24000` stays, as the only fallback.

**Shipped `wrangler.jsonc` `vars` (exact):**

```jsonc
"MODELS": "@cf/zai-org/glm-5.3,@cf/moonshotai/kimi-k2.6,@cf/deepseek-ai/deepseek-v4-pro-0813",
"MODEL_ROUTES": "{\"@cf/zai-org/glm-5.3\":{\"provider\":\"workers-ai\",\"model\":\"@cf/zai-org/glm-5.3\",\"contextTokens\":1048576,\"reasoning\":true},\"@cf/moonshotai/kimi-k2.6\":{\"provider\":\"workers-ai\",\"model\":\"@cf/moonshotai/kimi-k2.6\",\"contextTokens\":262144,\"reasoning\":true},\"@cf/deepseek-ai/deepseek-v4-pro-0813\":{\"provider\":\"workers-ai\",\"model\":\"@cf/deepseek-ai/deepseek-v4-pro-0813\",\"contextTokens\":1048576,\"reasoning\":true}}"
```

**Resolution:** For a listed `id`, let `own = findRouteEntry(id, routes)?.route`, and let `backing = own?.model ?? id`. Then let `hop` be the route whose **exact** pattern (no `*`) equals `backing`, provided it is not `own` itself.

| Setting               | Resolution order                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------- |
| `contextTokens`       | `own` → `hop` → 24 000                                                                            |
| `reasoning`           | `own` → `hop` → `false`                                                                           |
| `vision`, `multiTool` | `own` → `hop` → legacy list (`VISION_MODELS`/`MULTI_TOOL_MODELS`, on `id` or `backing`) → `false` |

The listing logic is unchanged: `MODELS` ids followed by exact route keys, without duplicates. When `MODELS` is unset or empty, the listing is just the exact route keys.

- [ ] **Step 1: Write the failing tests** in `test/models.test.ts`. They use `makeEnv`, whose env has no `MODELS`/`MODEL_ROUTES` unless set:
    - `empty config lists no models`: with no `MODELS` and no routes, `data` is `[]`.
    - `unrouted name still reaches Workers AI`: with no config, `POST /v1/messages` with `model: 'any-model'` calls the fake `AI.run` with `'any-model'`.
    - `MODELS without routes reports defaults`: `MODELS: 'a,b'` gives each entry `max_input_tokens` 24000 and all four capabilities `false`.
    - `alias inherits one hop`: with the shipped `MODEL_ROUTES` plus `'claude-sonnet-*': {provider:'workers-ai', model:'@cf/zai-org/glm-5.3'}`, `GET /v1/models/claude-sonnet-4-5` reports `max_input_tokens` 1048576 and `thinking.supported` `true`.
    - `own key beats hop`: the same, but the alias has `contextTokens: 5000` and `reasoning: false`, giving 5000 and `false`.
    - `no second hop`: a chain `a` → `b`, where `b` is exact with model `c`, and `c` is exact with `contextTokens: 9`. `a` reports 24000.
    - `profile beats legacy list`: route `vision: false` together with `VISION_MODELS` naming the id gives `false`. Without the route key, the list still gives `true`.
    - Keep the existing legacy-list tests, rewritten only to set their own routes and `MODELS`.
- [ ] **Step 2: Write** `test/shipped-config.node.test.ts`:
    - Read `wrangler.jsonc` with `node:fs`.
    - Strip `//` line comments outside strings with a small helper, then `JSON.parse`.
    - Feed `vars` into `loadConfig`.
    - Assert that the listing built from that config reproduces today's exact output: ids in order `[glm-5.3, kimi-k2.6, deepseek-v4-pro-0813]`, `max_input_tokens` `[1048576, 262144, 1048576]`, `vision`/`multi_tool_use` all `false`, and `thinking` all `true`.
    - If `listModels` needs an `Env`, pass the parsed vars as the env.
- [ ] **Step 3: Write** `test/model-ids.node.test.ts`. It walks `src/**/*.ts` and fails on any line containing `@cf/` unless one of these holds:
    - after trimming, the line starts with `//` or `*`;
    - the line is listed in an inline `ALLOWED` array of `{ file, includes }` pairs. That array starts with the `redteam-tool.ts` example error text `self:@cf/meta/llama-3.1-8b-instruct`.

    Make it report every offending `file:line`.

- [ ] **Step 4: Run** `npx vitest run --project workers test/models.test.ts` and `npx vitest run --project node test/shipped-config.node.test.ts test/model-ids.node.test.ts`. Expected: FAIL.
- [ ] **Step 5: Implement** `src/models.ts` per the Resolution table, update `wrangler.jsonc`, then run the full `npm test`. Fix every test that relied on the removed built-in list by setting `MODELS` (and, if it needs context windows, the shipped `MODEL_ROUTES`) in its env.
- [ ] **Step 6: Docs.**
    - README: document the three route keys in the table, the `thinking` capability, the shipped defaults in `wrangler.jsonc`, and the one-hop inheritance.
    - Add the Upgrading note: a deploy with its own `MODEL_ROUTES` must copy the three identity entries, which are shown, to keep their context windows.
    - Update the `wrangler.jsonc` comment block: `MODELS` default is "the shipped value below", and there is a line for each new route key.
- [ ] **Step 7: Run** `npm test` and the check commands. Expected: green and clean.
- [ ] **Step 8: Commit** `feat(models): profiles on MODEL_ROUTES, shipped defaults in wrangler.jsonc, no model ids in src`.

---

### Task 3: `anthropic` provider

**Files:**

- Create: `src/providers/anthropic.ts`.
- Modify: `src/dispatch.ts` (add `anthropic` to `PROVIDERS`), `README.md` (supported routes, path convention example, provider list in the route-key table), `TESTING.md` (new §17 "Anthropic provider", manual checks against `wrangler dev` mirroring §14/§15 style).
- Test: `test/anthropic-provider.test.ts`. Stub `globalThis.fetch` via `stubFetch` from `test/helpers.ts`.

**Interfaces:**

- Consumes: `Provider` (`src/provider.ts`), `buildUrl` (`src/utils.ts`), `BackendType` `'anthropic'` (Task 1).
- Produces:
    - `export class AnthropicProvider implements Provider`, with `convertToProviderRequest(request, baseUrl, apiKey)` and `convertToClaudeResponse(res)`.
    - `export function stripUnsignedThinking(messages: unknown): unknown`. It returns a new messages array. In each `role: 'assistant'` message whose `content` is an array, it drops blocks whose `type` is `thinking` or `redacted_thinking` and that lack a string `signature`. All other input is returned as is.

**Behaviour:**

- Request URL: `buildUrl(baseUrl, 'messages')`.
- Request headers are built fresh, not copied from the inbound request:
    - `x-api-key`: the key with any `Bearer ` prefix removed;
    - `anthropic-version: 2023-06-01`;
    - `content-type: application/json`;
    - `anthropic-beta`: copied only if the inbound request has it.
- Body: the parsed inbound JSON, with `messages` → `stripUnsignedThinking(messages)`. `model` is already the target model, set by `callTarget`. Everything else is untouched.
- `convertToClaudeResponse`: a new `Response(res.body, { status, statusText, headers })`, where `headers` holds only `content-type` and `retry-after` copied from `res`. The proxy's `request-id` is applied later by the existing code. Check that `withRequestId` sets it once upstream `request-id` is absent.

- [ ] **Step 1: Write the failing tests.**
    - Through `MODEL_ROUTES` (`claude-*` → `{provider:'anthropic', model:'claude-sonnet-4-5', baseUrl:'https://api.anthropic.com/v1', keySecret:'ANTHROPIC_KEY'}`, env `ANTHROPIC_KEY: 'sk-ant-test'`), via `callWorker('/v1/messages', …)` with the proxy key as `x-api-key` plus `x-engagement` and `cookie` headers:
        - the stub saw URL `https://api.anthropic.com/v1/messages`;
        - its header names are exactly `{anthropic-version, content-type, x-api-key}` (plus `anthropic-beta` when the client sent one);
        - `x-api-key` is `'sk-ant-test'` and **not** the proxy key;
        - the body equals the client body with `model: 'claude-sonnet-4-5'`.
    - Unsigned-thinking strip:
        - assistant content `[{type:'thinking',thinking:'t'},{type:'text',text:'a'}]` → `[{type:'text',text:'a'}]`;
        - a block with `signature:'s'` is kept;
        - a `redacted_thinking` without a signature is dropped;
        - a user message with a thinking-like block is untouched;
        - string `content` is untouched.
    - Streaming: the upstream returns `text/event-stream` with two SSE events, and the client receives byte-identical body text.
    - Response headers:
        - upstream sends `request-id: up-1`, `anthropic-organization-id: org`, `anthropic-ratelimit-requests-remaining: 5`, `set-cookie: a=b`, `retry-after: 3`;
        - the client sees `retry-after: 3`, a `request-id` that is the proxy's (not `up-1`), and none of the others.
    - An upstream `401` with a body containing `sk-ant-test` returns the status with `[redacted]` in place of the key.
    - Path convention: `POST /anthropic/api.anthropic.com/v1/v1/messages` with `x-proxy-key` and `x-api-key: sk-client` sends `x-api-key: sk-client` upstream, and `x-proxy-key` is not forwarded.
    - Fallback: a Workers AI route that falls back to an anthropic route sees the strip applied, and the stub gets no unsigned thinking.
- [ ] **Step 2: Run** `npx vitest run --project workers test/anthropic-provider.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `src/providers/anthropic.ts` and register it in `PROVIDERS`.
- [ ] **Step 4: Run.** Expected: PASS. Then run `npm test` and the check commands.
- [ ] **Step 5: Docs.**
    - README: `anthropic` in the supported-routes table, a path-convention example, and the provider enum in the route-key table.
    - Note the thinking strip and the header allowlist.
    - Add TESTING §17.
- [ ] **Step 6: Commit** `feat(providers): native anthropic pass-through provider`.

---

### Task 4: Role models for `draft_rule` and the `redteam` judge

**Files:**

- Modify:
    - `src/mcp/purple-tool.ts` (`draft`, line ~45);
    - `src/mcp/redteam-tool.ts` (judge selection, lines ~116-122; the `judgeModel` describe at ~177);
    - `README.md` (§5 vars table: `DRAFT_MODEL` and `JUDGE_MODEL`; "Purple loop", which recommends a non-reasoning `DRAFT_MODEL`; the red-team section);
    - `TESTING.md` (§15 and §16 add a role-model check);
    - the `wrangler.jsonc` comment block (two lines).
- Test: `test/mcp-purple.test.ts`, `test/mcp-redteam.test.ts`.

**Interfaces:**

- Consumes: `ctx.config.draftModel`, `ctx.config.judgeModel` (Task 1).
- Produces:
    - draft model = `a.model || ctx.config.draftModel || (await firstModel(...))`. When none resolves, the error stays `'no routed models; pass model'`.
    - judge model = `a.judgeModel ?? ctx.config.judgeModel`. A judge is created only when the result is a non-empty string. `judgeModel` describe text: `'Routed model that scores judge cases; defaults to JUDGE_MODEL, "" for no judge; run only'`.

- [ ] **Step 1: Write the failing tests.**
    - purple: with env `DRAFT_MODEL: 'm-draft'` and no `model` arg, the stubbed `/v1/messages` body has `model: 'm-draft'` and `/v1/models` is **not** called.
    - purple: with an explicit `model: 'm-arg'`, `m-arg` is used.
    - purple: with `DRAFT_MODEL` naming a model absent from `/v1/models`, it is still used.
    - redteam: with `JUDGE_MODEL: 'm-judge'` and no `judgeModel`, judge calls go to `m-judge`.
    - redteam: `judgeModel: ''` with `JUDGE_MODEL` set gives no judge call, and judge-scored cases are reported as unscored, the same as today without a judge. Assert this the way existing no-judge tests do.
    - redteam: neither set gives no judge, as today.
- [ ] **Step 2: Run** `npx vitest run --project workers test/mcp-purple.test.ts test/mcp-redteam.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the precedence exactly as in Produces.
- [ ] **Step 4: Run.** Expected: PASS. Then run `npm test` and the check commands.
- [ ] **Step 5: Docs** as listed under Files.
- [ ] **Step 6: Commit** `feat(mcp): DRAFT_MODEL and JUDGE_MODEL role models`.

---

### Task 5: Controller verification (not dispatched)

- [ ] Run `npm run check` and `npm test`.
- [ ] Run `npx wrangler deploy --dry-run --outdir .wrangler/dryrun` and record the gzip size against 398.69 KiB.
- [ ] Live on `wrangler dev` (port 8791, shipped vars):
    - `/v1/models` matches the pre-change listing: same ids, context windows 1048576/262144/1048576.
    - `--var DRAFT_MODEL:@cf/moonshotai/kimi-k2.6`, then `purple draft_rule` uses kimi and returns a valid draft.
    - Kill the dev tree afterwards.
- [ ] Anthropic is checked live only if an Anthropic key is available. Otherwise the unit tests stand, and the ledger says so.
- [ ] Final whole-branch review (opus), one fix wave, then ponytail on `bd1864a..HEAD`.
