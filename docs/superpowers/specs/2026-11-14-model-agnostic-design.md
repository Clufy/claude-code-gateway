# Phase 8 — Model-agnostic proxy: design

**Date:** 2026-11-14 · **Branch:** `feat/phase8-model-agnostic`, stacked on `feat/phase6-redteam-harness` at `bd1864a` (which now holds Phase 7)

## Intent

The owner wants to **change or add models, from any provider, by editing config only, never `src/`**.

The proxy already does most of this:

- `MODELS` lists the Workers AI models.
- `MODEL_ROUTES` sends any model name to `workers-ai`, `openai`, `openai-responses` or `gemini`, with fallbacks.

Some things are still baked into code:

- `src/models.ts` hard-codes three Workers AI model ids (`DEFAULT_MODELS`) and their context windows (`CONTEXT_TOKENS`).
- Vision and multi-tool support are separate comma lists.
- There is no Anthropic backend.
- Features that need a model take whichever one is listed first. Phase 7's `draft_rule` defaulted to glm-5.3, a reasoning model that returned no text.

## Goals

1. **No model ids in `src/`.** `DEFAULT_MODELS` and `CONTEXT_TOKENS` leave the code. The current three models and their context windows move into `wrangler.jsonc` `vars` as the shipped default config, so a fresh deploy behaves as today.
2. **Model profiles live on `MODEL_ROUTES` entries.** Each route entry can carry these settings beside the existing `contextTokens`:
    - `vision` (boolean)
    - `multiTool` (boolean)
    - `reasoning` (boolean)

    Adding a model means writing one route entry.

3. **Native `anthropic` provider.** It works in `MODEL_ROUTES` (`"provider": "anthropic"`) and in the path convention (`/anthropic/{provider_url}/v1/messages`). Claude models, and any Anthropic-compatible API, can then sit beside the other providers.
4. **A named model per feature, called a "role model".** Features that need a model use one configured for that job, and stop taking whichever model is listed first:
    - `DRAFT_MODEL` is the default model for the MCP `purple` `draft_rule`.
    - `JUDGE_MODEL` is the default judge model for the MCP `redteam` tool.

    An explicit argument still wins.

## Non-goals

- Changing where unrouted names go. A name that matches no route still goes to Workers AI unchanged, as today.
- Fetching model catalogs from providers at runtime.
- Per-model request tuning: temperature, prompt templates, thinking budgets sent upstream.
- Changing the qualify or redteam **CLIs**. They already take explicit `--models` and `--judge-model`.
- Renaming the project or the `claude-workers-ai-proxy` observability default.

## Anti-goals

The work fails, even if it technically works, if any of these happen:

- A deploy that sets none of the new keys behaves differently from today in routing, listing or context windows. Only the defaults move.
- Existing `VISION_MODELS` / `MULTI_TOOL_MODELS` users silently lose capability flags.
- The `anthropic` provider leaks the proxy key, or the client's own `x-api-key`/`Authorization`, to the upstream API, or relays upstream credentials back to the client.
- A model id reappears in `src/` as a fallback. Examples in comments and error texts are fine; behaviour is not.

## Constraints

- **Config validation.** It stays as strict as today, with unknown route keys rejected:
    - `vision`, `multiTool` and `reasoning` must be booleans.
    - A malformed value fails with the existing `500 invalid config: MODEL_ROUTES`.
    - `DRAFT_MODEL` and `JUDGE_MODEL` are plain strings. Empty means unset.
- **Workers runtime.** Strict TypeScript and the existing test layout: vitest workers and node projects.
- **No new dependencies.**
- **The `anthropic` backend follows the security model of the existing external providers:**
    - `baseUrl` is checked against `ALLOWED_HOSTS` and `ALLOW_HTTP`; `api.anthropic.com` is already allowed.
    - The key comes from `keySecret` on routes, or from `x-api-key`/`Authorization` on the path convention.
    - Upstream errors are scrubbed of the key.
- **Process.** Work stays local: no push and no deploy, with `--dry-run` only for bundle size. Commits carry no Co-Authored-By trailer.

## Approaches considered

| Approach                                                                                               | Trade-off                                                                                                                                                                                                                                                                | Decision                         |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- |
| **Grow `MODEL_ROUTES`** with optional `vision` / `multiTool` / `reasoning` beside `contextTokens`      | One place per model, and exact route names already appear in `/v1/models`. It reuses the existing strict route parser and the `contextTokens` precedent. An identity route (`provider: workers-ai`, same name) is needed just to attach a profile to a Workers AI model. | **Chosen by the owner**          |
| Separate `MODEL_PROFILES` var keyed by model id                                                        | It keeps "what it can do" apart from "where it goes". But adding one model can touch three vars (`MODELS`, `MODEL_PROFILES`, `MODEL_ROUTES`).                                                                                                                            | Rejected: more places to edit    |
| One `MODELS` JSON registry replacing `MODELS`, `MODEL_ROUTES`, `VISION_MODELS` and `MULTI_TOOL_MODELS` | It gives the tidiest end state. But it is a breaking config change and the biggest rewrite.                                                                                                                                                                              | Rejected: breaks existing config |

## Decided by the owner

- The scope is all four goals above. The driver is swapping models without code.
- When `MODELS` is unset, the defaults move to config: today's three models ship in `wrangler.jsonc`, not in code.
- The registry grows `MODEL_ROUTES`.

## Design

### 1. Default config moves to `wrangler.jsonc`

`vars` gains two entries:

- `MODELS`: today's three ids, in the same order.
- `MODEL_ROUTES`: three identity `workers-ai` routes, each with its `contextTokens` from today's `CONTEXT_TOKENS`, and `reasoning: true` for glm-5.3. The other two get `reasoning` set from what Phase 7 observed: kimi-k2.6 and deepseek-v4-pro both emit thinking blocks, so `true`. The builder confirms these against the Workers AI model pages.

In `src/models.ts`:

- With `MODELS` unset, `/v1/models` lists only the exact (non-glob) `MODEL_ROUTES` names, which may be none.
- An unknown model's context window stays `DEFAULT_CONTEXT_TOKENS` (24 000). That is a conservative constant, not a model id.

The README states that replacing `MODEL_ROUTES` replaces the shipped profiles, so a user who keeps those models should keep their entries.

### 2. Route profile keys

`ROUTE_KEYS` gains `vision`, `multiTool` and `reasoning`. For a listed id, each of the four profile settings (`contextTokens`, `vision`, `multiTool`, `reasoning`) resolves in this order:

1. The matching route's own key, when present.
2. **One hop to the backing model:** the key on the route whose exact (non-glob) pattern equals the matching route's `model` and whose `provider` is the same as the matching route's (P8-D1a). For example, `claude-sonnet-*` → `@cf/zai-org/glm-5.3` picks up the shipped identity route's 1,048,576 and `reasoning: true`. Only one hop is taken; chains are not followed.
3. For `vision` and `multiTool` only: the legacy `VISION_MODELS` / `MULTI_TOOL_MODELS` lists, matched on the listed id or the backing model, exactly as today.
4. Otherwise `DEFAULT_CONTEXT_TOKENS` (24 000) for `contextTokens`, and `false` for the booleans.

The shipped identity routes set only `contextTokens` and `reasoning`, so the legacy lists keep deciding `vision` and `multiTool` for those models.

**Accepted break (ruling P8-D1):** A deploy that sets its own `MODEL_ROUTES` replaces the shipped routes, and loses the shipped context windows unless it copies the identity entries. Today those windows came from code. The README "Upgrading" note says this and gives the three entries to copy. A separate var that user routes cannot wipe was rejected, because it is the `MODEL_PROFILES` approach the owner turned down.

`reasoning` is reported as a new capability, `thinking: { name: 'thinking', supported }`. The proxy itself does not change requests because of it. It is information for clients, and for features (§4) to size their token budgets.

### 3. `anthropic` provider

`BackendType` gains `'anthropic'`. `src/providers/anthropic.ts` implements `Provider` as a near pass-through:

- **Request.** The Anthropic Messages body is sent unchanged, with two exceptions:
    - `model` becomes the target model.
    - In assistant turns, unsigned `thinking` blocks (no or empty signature) are dropped; `redacted_thinking` is always kept (P8-D2a). An assistant turn emptied by the strip is dropped whole. Workers AI produces unsigned thinking blocks. A session that switches to, or falls back onto, an `anthropic` route would otherwise be rejected (ruling P8-D2). Signed blocks from a real Anthropic turn are kept.

    The rest of the request: It goes to `${baseUrl}/messages` with these headers:
    - `x-api-key: <key>`;
    - `anthropic-version: 2023-06-01`;
    - `content-type`;
    - the client's `anthropic-beta`, if present.

    No other inbound header is forwarded. That excludes the proxy key, `Authorization`, `x-engagement`, `x-proxy-*` and cookies.

- **Response.** The body is passed through unchanged, streaming SSE included, after the existing upstream-error scrubbing. The response is rebuilt with an **allowlist of headers**: `content-type` and `retry-after` (ruling P8-D4). Everything else is dropped, including Anthropic's `request-id`, `anthropic-organization-id`, `anthropic-ratelimit-*` and `set-cookie`. The proxy's own `request-id` is then set as for every other backend.

Other wiring:

- The provider is registered in `PROVIDERS`, the path-convention type list and the `MODEL_ROUTES` provider enum.
- It needs `baseUrl` and `keySecret` like other non-`workers-ai` routes, e.g. `https://api.anthropic.com/v1`.
- The guard, logging, rate limiting and fallback apply unchanged, because they sit outside the provider.

### 4. Role models

New vars:

- **`DRAFT_MODEL`.** `purple` `draft_rule` uses `model` argument → `DRAFT_MODEL` → the first `/v1/models` id (today's behaviour, kept as the last resort).
- **`JUDGE_MODEL`.** The MCP `redteam` tool uses `judgeModel` argument → `JUDGE_MODEL`. When neither is set there is no judge, as today. Setting `JUDGE_MODEL` deliberately turns on judging for runs that pass no `judgeModel`. **`judgeModel: ""` explicitly turns the judge off,** even when `JUDGE_MODEL` is set (ruling P8-D3). The zod `describe` text says so, and the precedence uses `??`, so an empty string is not replaced.
- **Where they live.** Both are parsed in `loadConfig` into `ProxyConfig` (`draftModel?` and `judgeModel?`; an empty string means unset). MCP handlers read `ctx.config`.

**Draft budget:** when the chosen model's route has `reasoning: false`, `draft_rule` may use a smaller `max_tokens` (1500). Otherwise it keeps 4096. The builder decides whether that is worth it; the default is to keep 4096 for every model.

The README "Purple loop" section and the TESTING checks recommend setting `DRAFT_MODEL` to a non-reasoning model.

### 5. Docs and tests

- **README:** the provider table and path convention gain `anthropic`, the route-key table gains the three profile keys, and new sections cover the role-model vars and the moved defaults. The `wrangler.jsonc` comment block is updated.
- **TESTING:** a manual `anthropic` route check against `wrangler dev`, plus a role-model check.
- **Tests:**
    - `/v1/models` with no `MODELS` and no routes returns an empty list.
    - The shipped `wrangler.jsonc` config reproduces today's listing and context windows.
    - Profile keys override the legacy lists.
    - The legacy lists still work.
    - Bad profile values are rejected.
    - `anthropic` requests have the exact outgoing URL, headers and body. A test asserts that no proxy or client credentials are forwarded.
    - Streaming pass-through, and key scrubbing on an upstream error.
    - Role-model precedence for both tools.
    - A grep-style test: `src/**` contains no `@cf/` model id outside comments and example strings. The builder picks a robust form, such as a list of allowed files and lines.

## Calls made after the builder check (the owner asked for autonomous execution)

- **P8-D1:** Aliases inherit profile keys one hop from the backing model's exact route. Deploys with their own `MODEL_ROUTES` must copy the identity entries, and this is documented.
- **P8-D2:** The `anthropic` provider drops unsigned `thinking` blocks (no or empty signature) from assistant turns; `redacted_thinking` is always kept (P8-D2a), and a turn emptied by the strip is dropped.
- **P8-D1a:** The one-hop target must be on the same provider as the matching route.
- **P8-D3:** `judgeModel: ""` turns the judge off.
- **P8-D4:** The `anthropic` response headers are allowlisted to `content-type` and `retry-after`, and the proxy's `request-id` wins.

## Left to the builder

- File layout inside `src/providers/anthropic.ts`, and whether it reuses the upstream fetch helpers directly or goes through `convertToProviderRequest`.
- The exact form of the "no model ids in `src/`" check.
- Whether the reasoning-aware draft budget is implemented (default: no).
- Exact README wording, and where the new sections sit.
