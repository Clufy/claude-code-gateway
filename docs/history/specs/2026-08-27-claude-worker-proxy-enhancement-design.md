# Claude Worker Proxy Enhancement Design

**Date:** 2026-08-27  
**Status:** Draft pending review  
**Goal:** Make the existing Cloudflare Workers AI-based Claude proxy compatible with the Claude Code VS Code extension while adding multi-provider support inspired by `glidea/claude-worker-proxy`.

## 1. Purpose

The current Worker exposes a minimal Anthropic Messages API facade over Cloudflare Workers AI. We want to:

1. Keep the Workers AI backend working unchanged at the default `/v1/messages` route.
2. Add the external-provider model from the reference repo: `gemini`, `openai`, and `openai-responses` backends.
3. Improve Claude Code VS Code extension compatibility by supporting the supporting endpoints it may call (`/v1/models`, `/v1/messages/count_tokens`) and matching Anthropic error/response shapes more closely.

## 2. Non-goals

- We will not implement Anthropic-only surfaces that cannot be proxied to our backends (managed agents, server tools, computer use, etc.).
- We will not add billing, per-user auth, or rate-limiting beyond what Cloudflare provides.
- We will not add an automated GitHub Actions deploy pipeline in this phase.

## 3. Proposed Architecture

A TypeScript Worker with a small provider abstraction:

```
src/
  index.ts          # routing, auth, error formatting, request-id
  provider.ts       # Provider interface
  types.ts          # Anthropic-compatible shared types
  utils.ts          # SSE helpers, id generation, URL building, schema cleaning
  providers/
    workers-ai.ts   # existing env.AI.run backend
    gemini.ts       # ported from reference
    openai-chat.ts  # OpenAI Chat Completions via openai SDK
    openai-responses.ts  # OpenAI Responses API via openai SDK
```

### Provider Interface

```ts
export interface Provider {
    // Override for providers that want full control (OpenAI SDK streaming)
    handle?(request: Request, baseUrl: string, apiKey: string): Promise<Response>

    // Convert an Anthropic request to a provider HTTP request
    convertToProviderRequest(request: Request, baseUrl: string, apiKey: string): Promise<Request>

    // Convert a provider HTTP response to an Anthropic response
    convertToClaudeResponse(providerResponse: Response): Promise<Response>
}
```

The `workers-ai` provider returns Anthropic-format responses itself, so it uses both `convertToProviderRequest` (sets up `env.AI.run` options internally) and `convertToClaudeResponse`.

## 4. Routes

| Method | Path                                 | Purpose                                                          |
| ------ | ------------------------------------ | ---------------------------------------------------------------- |
| `GET`  | `/`                                  | Health check: `ok`                                               |
| `POST` | `/v1/messages`                       | Anthropic Messages API → Workers AI                              |
| `GET`  | `/v1/models`                         | List supported models                                            |
| `GET`  | `/v1/models/{id}`                    | Retrieve one model                                               |
| `POST` | `/v1/messages/count_tokens`          | Estimate input token count                                       |
| `POST` | `/{type}/{provider_url}/v1/messages` | External provider proxy (`gemini`, `openai`, `openai-responses`) |

External-provider path parsing mirrors the reference implementation: the first path segment is the `type`, everything before `/v1/messages` is the provider base URL, and `http:/` is normalized to `http://`.

## 5. request/response shapes

### `POST /v1/messages` (Workers AI)

Accepts any Anthropic-compatible `MessagesRequest` object. Required fields: `model`, `messages`. Optional fields initially handled: `system`, `max_tokens`, `temperature`, `stream`, `tools`. Additional Anthropic fields (`top_p`, `top_k`, `stop_sequences`, `tool_choice`, `metadata`, `thinking`, `output_config`, etc.) are accepted and ignored rather than rejected.

Response matches Anthropic `MessagesResponse` for non-streaming and emits Anthropic SSE events (`message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`) for streaming.

### External provider routes

Accept the same Anthropic request body and transform it into the target provider format. The reference implementations already exist; we port them with minimal changes.

- Extract the provider API key from `x-api-key` or `Authorization`.
- Strip those headers before forwarding.
- Pass the remaining headers and body to the provider.
- Transform the response back into Anthropic format, including tool calls and streaming deltas.

### `GET /v1/models`

Return a model list in Anthropic format:

```json
{
  "data": [ { "id": "...", "display_name": "...", "type": "model", ... } ],
  "has_more": false,
  "first_id": null,
  "last_id": null
}
```

Source: an optional `MODELS` environment variable as a comma-separated list. If unset, return a minimal default set so the Claude Code extension does not receive an empty list. For model objects we populate:

- `id`
- `type: "model"`
- `display_name`
- `max_input_tokens` (nullable)
- `max_tokens` (nullable)
- `created_at` (epoch value)
- `capabilities` with all flags set to `supported: false` except safe defaults when known

`GET /v1/models/{id}` returns the same object for any known model, or a `404 not_found_error` for unknown models.

### `POST /v1/messages/count_tokens`

Returns:

```json
{ "input_tokens": 123 }
```

Token count is estimated (`ceil(total_characters / 4)`) across messages, system prompt, and tool descriptions. This matches the current heuristic. A future enhancement could call a provider-specific counter, but estimation is sufficient for Claude Code compatibility.

## 6. Authentication

### Workers AI route

Keep the existing optional `PROXY_KEY` behavior.

- If `env.PROXY_KEY` is set, require `x-api-key` header and compare using `crypto.subtle.timingSafeEqual`.
- Otherwise allow unauthenticated requests.

### External provider routes

Use the provider API key from `x-api-key` or `Authorization`. The optional `env.PROXY_KEY`, if set, is enforced via a separate `x-proxy-key` header so it does not collide with the provider key that Claude Code sends as `x-api-key`. If `env.PROXY_KEY` is unset, external routes are unauthenticated at the proxy layer and rely on the provider key.

## 7. Headers

- `anthropic-version` — accepted and ignored (proxy does not version).
- `anthropic-beta` — accepted and ignored.
- `x-api-key` / `Authorization` — used as described above.
- `request-id` — generated for every response (`req_<uuid>`) and included in response headers and error bodies.
- `content-type: application/json` on JSON responses; `text/event-stream` on streaming responses.

## 8. Errors

All errors return JSON:

```json
{
    "type": "error",
    "error": {
        "type": "invalid_request_error|authentication_error|not_found_error|api_error|rate_limit_error",
        "message": "..."
    },
    "request_id": "req_..."
}
```

Mapping:

- 400 → `invalid_request_error`
- 401 → `authentication_error`
- 404 → `not_found_error`
- 429 → `rate_limit_error`
- 5xx → `api_error`

Provider errors are passed through when the provider returns a non-2xx response to keep details intact, but a `request_id` is still added.

## 9. Streaming and SSE

All streaming providers emit Anthropic SSE events. A shared `processProviderStream` helper parses provider SSE chunks and sends Anthropic-format events. Provider-specific line processors only need to extract text, tool calls, and finish reasons.

## 10. Tool calls

- The existing Workers AI tool-call reconstruction is preserved.
- For external providers, port the reference implementations that convert Anthropic tool_use/tool_result blocks to provider-native shapes and back.

## 11. Unsupported fields

Instead of rejecting unknown Anthropic request fields, we log them once and ignore them. This maximizes compatibility with future Claude Code versions. If ignoring a field would break correctness (e.g., `tool_choice: any` being treated as `auto`), translate it conservatively or fall back to sending `auto`.

## 12. Wrangler and Tooling

- Add `package.json`, `tsconfig.json`, `.prettierrc`.
- Migrate config to `wrangler.jsonc` with schema support.
- Set `compatibility_date` to the current date during implementation.
- Enable `observability.enabled: true`.
- Keep the `AI` binding for Workers AI.
- Add `compatibility_flags` (e.g., `global_fetch_strictly_public`) if needed for the `openai` package, `nodejs_compat` if required.
- Generate `worker-configuration.d.ts` with `wrangler types` and never hand-write `Env`.
- Add a small `curl` self-test script and examples in the README.

## 13. Implementation Phases

1. **Scaffold** — TypeScript build, lint/format, `wrangler.jsonc`, typed `Env`.
2. **Port existing logic** to `providers/workers-ai.ts` and `src/index.ts` router; ensure `/v1/messages` behavior is identical to today's JS Worker.
3. **Add compatibility endpoints** — `/v1/models`, `/v1/models/{id}`, `/v1/messages/count_tokens`.
4. **Port external providers** — `gemini`, `openai-chat`, `openai-responses`. Use the reference repo as the source and adapt to the shared `Provider` interface.
5. **Polish** — README updates, self-test script, observability, error-shape verification.

## 14. Validation

- `npx wrangler deploy` succeeds.
- `npx tsc --noEmit` passes.
- `npx prettier --check .` passes.
- Self-test against `/`, `/v1/models`, `/v1/messages/count_tokens`, and `/v1/messages` for both streaming and non-streaming Workers AI responses.
- Manual end-to-end with Claude Code: set `ANTHROPIC_BASE_URL` to the Worker and run a short prompt.

## 15. Extended features (if feasible)

### 15.1 Rich content blocks in `/v1/messages`

Accept Anthropic content block types beyond `text` and tool blocks:

- `text` — always supported.
- `image` (base64 or URL) — convert to provider-native image input where the backend supports vision (Gemini, OpenAI Chat Completions, some Workers AI models). Return `400` if the backend cannot accept images.
- `document` (base64 PDF or plain text) — convert to text or provider-native document input if supported.
- `thinking` / `redacted_thinking` — pass through unchanged on assistant turns; strip on provider requests.
- `cache_control` — accepted and stripped before forwarding; never stored or acted on by the proxy.

### 15.2 Files API

Add a minimal `POST /v1/files`, `GET /v1/files/{id}`, `DELETE /v1/files/{id}` and `GET /v1/files/{id}/content` surface backed by R2.

- Requires an `[r2]` binding (`BUCKET`).
- Uploads receive an Anthropic `file_id` and metadata response.
- When a message references a file by `file_id`, the provider implementation fetches the file from R2 and inlines it in the provider request.
- This enables Claude Code file attachments and multi-turn file reuse.

This feature is feasible and useful, but it adds an R2 dependency and non-trivial provider-specific conversion logic.

### 15.3 Message Batches API

A pass-through of `POST /v1/messages/batches`, `GET /v1/messages/batches/{id}`, `DELETE /v1/messages/batches/{id}`, and `/v1/messages/batches/{id}/results`.

- Requires a `[queue]` binding and a `queue` handler in the same Worker.
- Producer enqueues each batch request; consumer calls the provider and stores results in KV/D1.
- Polling endpoints read status from KV/D1 and stream results.

This is feasible on Cloudflare, but it significantly expands scope and is unlikely to be needed for the interactive Claude Code VS Code extension. Recommended as a later phase rather than part of the initial implementation.

### 15.4 Prompt caching and compaction

- `cache_control` markers are accepted in requests and stripped before forwarding so that clients do not receive validation errors.
- Anthropic server-side prompt caching and compaction cannot be provided over non-Anthropic backends because they require the provider to understand and honor cache breakpoints. We do not implement compaction or summary logic in the proxy.
- For Claude Code compatibility we preserve `cache_control` blocks when they appear on messages sent to `/v1/messages/count_tokens` and `/v1/messages`, and silently ignore them during provider conversion.
