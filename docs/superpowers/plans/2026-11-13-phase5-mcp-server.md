# Phase 5: MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve `POST /mcp` from the same Worker: a stateless streamable-HTTP MCP server with two tools, `engagement` (list, get, scope_check) and `logs` (findings, activity via the Workers Observability query API).

**Architecture:** `src/mcp/server.ts` builds a fresh `McpServer` plus a stateless `WebStandardStreamableHTTPServerTransport` per request (no Durable Object). Each tool lives in its own file under `src/mcp/` and returns one JSON text block. `src/observability.ts` is the only code that talks to `api.cloudflare.com`. Request lines gain a `tools` field so `logs activity` can show tool names.

**Tech Stack:** Cloudflare Workers, TypeScript strict, `@modelcontextprotocol/sdk` 1.32.2, `zod` 4, `@cfworker/json-schema` 4, vitest 4 (workers + node projects).

**Spec:** `docs/superpowers/specs/2026-11-07-security-workflows-roadmap-design.md` §5.5 (MCP server), §6 (phase table), §7 (constraints), §8 ("MCP is stateless").

## User decisions (2026-11-13)

- U1: `logs` queries the Workers Observability telemetry API with a `CF_API_TOKEN` secret and a `CF_ACCOUNT_ID` var. When neither is set, `logs` answers with a clear "not configured; use `wrangler tail`" message. Tests stub `fetch`; no real token is needed.
- U2: use `@modelcontextprotocol/sdk` (stateless web-standard transport, JSON responses, the Workers-safe validator). A controller spike on 2026-11-13 confirmed that initialize, tools/list and tools/call work in workerd under vitest, and that a bad `action` comes back as `isError`.
- U3: Claude Code registration is a README snippet only (`claude mcp add --transport http …`). Don't edit any settings.json or `.mcp.json`.

## Decisions (Claude's calls, binding for this plan)

- **D1 Route and methods.** Only `POST /mcp` reaches the transport. `GET`, `DELETE` and every other method on `/mcp` get `405` with `allow: POST` and no body work. A stateless server must not open a standalone SSE stream, because that would hang the Worker.
- **D2 Auth.** The only accepted credential is `Authorization: Bearer <PROXY_KEY>`; `x-api-key` is not accepted on `/mcp`. Check it with the existing `checkProxyAuth`, before any MCP code runs:
    - wrong or missing key: `401` JSON `{"error":"invalid authorization"}`;
    - no `PROXY_KEY` and no `ALLOW_ANONYMOUS`: `500` `proxy not configured: set PROXY_KEY or ALLOW_ANONYMOUS=true`.

    The existing rate limiter (`enforceRateLimit`) runs before auth, the same as on `/v1/messages`.

- **D3 Transport options.** Pass these, every request:
    - `sessionIdGenerator: undefined`
    - `enableJsonResponse: true`
    - `maxRequestBodySize: 65536`

    The server is `new McpServer({ name: 'claude-worker-proxy', version: '0.5.0' }, { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() })`. Import the SDK's ajv validator nowhere: ajv compiles with `new Function`, and Workers forbid that.

- **D4 Tool shape.** Each tool's `inputSchema` is a flat zod raw shape: a required `action` enum plus optional scalar fields. The handler checks per action that the fields it needs are present, and returns `isError` naming the missing field. Keep descriptions to two sentences or fewer. Each field's `.describe()` says which actions use it. There is no nesting and no `z.discriminatedUnion`, because open models handle flat schemas better (spec §5.5).
- **D5 Tool output.** Every result is `{ content: [{ type: 'text', text: JSON.stringify(payload) }] }`. Errors are `{ content: [{ type: 'text', text: <message> }], isError: true }`. Messages are one sentence and never contain a secret.
- **D6 `mcp` log line.** Each `tools/call` logs exactly one line: `{"event":"mcp","requestId","tool","action","ok","durationMs"}`. It logs no arguments and no results. Other JSON-RPC methods log nothing.
- **D7 `engagement` actions.**
    - `list` → `{ engagements: [{ name, window: { start, end }, active, defaultMode }] }`. `start` and `end` are ISO strings. `active` is `inWindow(e, now)`.
    - `get` (needs `name`) → `{ name, scope, exclude, window, active, roe, defaultMode }`. `scope` includes `llmTargets`.
    - `scope_check` (needs `name` and `target`) → `{ target, normalized, verdict, inWindow, decision, reasons }`:
        - `verdict`, `inWindow` and `normalized` come from `checkScope(e, target, now)`;
        - `decision` and `reasons` come from `decideHosts(e, [target], now)`, so the wording matches the scope hook;
        - `target` longer than 2048 chars returns `isError` `target too long (max 2048 chars)`.
    - An unknown `name` returns `isError` `unknown engagement: <name>`. The name is echoed only if it matches `/^[A-Za-z0-9_.-]{1,64}$/`; otherwise the message is `unknown engagement`.
    - With no engagements configured, `list` returns `{ engagements: [], hint: 'set the ENGAGEMENTS secret' }`.
- **D8 Observability config.** `loadConfig` gains `observability: { accountId: string; apiToken: string; service: string } | null`:
    - `CF_ACCOUNT_ID` must match `/^[0-9a-f]{32}$/`;
    - `CF_API_TOKEN` must be non-empty;
    - setting only one of the two throws `ConfigError` naming the missing variable;
    - `service` is `OBSERVABILITY_SERVICE`, default `'claude-workers-ai-proxy'` (the wrangler `name`).
- **D9 Query client.** `queryEvents` sends `POST https://api.cloudflare.com/client/v4/accounts/{accountId}/workers/observability/telemetry/query` with `authorization: Bearer <apiToken>` and `content-type: application/json`. Body:

    ```json
    { "queryId": "proxy-mcp-logs", "view": "events", "dry": true, "limit": <n>,
      "timeframe": { "from": <ms>, "to": <ms> },
      "parameters": { "filterCombination": "and", "filters": [ ... ] } }
    ```

    - `filters` always contains `{ key: '$metadata.service', operation: 'eq', type: 'string', value: service }` and `{ key: 'event', operation: 'eq', type: 'string', value: <'detection'|'request'> }`, plus the caller's filters.
    - Custom log fields are filtered by their bare key (`event`, `engagement`, `ruleId`, `severity`). Cloudflare's docs show `$metadata.*` and `$workers.*` keys but don't state how custom JSON keys are named. So the client **also re-checks every filter on the parsed `source` object** and drops rows that fail. If the server ignores an unknown key, the results are still correct, just possibly fewer than `limit`.
    - Timeout: `AbortSignal.timeout(10000)`.
    - Rows come from `result.events.events`. `source` may be an object or a JSON string; parse failures drop the row.
    - Rows are sorted by `timestamp` descending on the client.

- **D10 Query errors.** `queryEvents` never throws. It returns `{ ok: false, error }` where `error` is one of:
    - `logs query timed out after 10 s`
    - `logs query failed: HTTP <status>[: <first errors[].message, ≤200 chars>]`
    - `logs query returned an unexpected response`

    The token never appears in any error, log line or result.

- **D11 `logs` arguments.**
    - `since`: `\d{1,4}[mhd]` (relative), or an ISO-8601 date-time, parsed with `Date.parse`. The default is `24h`. The lower bound is clamped to `now − 7 days`; a `since` in the future or unparseable returns `isError` `invalid since: use e.g. 30m, 24h, 7d or an ISO time`.
    - `limit`: default 50, clamped to 1..100.
    - `engagement`: exact match.
    - `rule` (findings only): exact `ruleId`, or a family prefix when it ends with `.` (`secret.` → `starts_with`).
    - `severity` (findings only): a minimum. `low` means all; `medium` means `in [medium, high]`; `high` means `in [high]`.
- **D12 `logs` output.**
    - `findings` → `{ count, returned, rows: [{ time, ruleId, severity, engagement, requestId, excerpt }] }`. `excerpt` is passed through `redact()` again and cut to 300 chars.
    - `activity` → `{ count, returned, rows: [{ time, requestId, model, route, backend, status, durationMs, ttfbMs, tools, engagement, mode, streamError }] }`. Fields absent in the source row are omitted.
    - `time` is ISO.
    - `count` is the API's `result.events.count` when it is a number, otherwise `returned`.
    - The JSON text is capped at 32 KB: drop rows from the end until it fits, and set `truncated: true`.
    - Not configured → `isError` `logs not configured: set CF_ACCOUNT_ID and the CF_API_TOKEN secret, or use wrangler tail`.
- **D13 `tools` on request lines.** `RequestLog.tools?: string[]` holds the unique `tool_use` names in the response, in first-seen order:
    - at most 16 names, each cut to 64 chars;
    - omitted when empty;
    - for streamed responses, collected at `content_block_start` regardless of the guard and of the open-block cap;
    - for non-streamed responses, collected from the response body's `content`.
- **D14 Package versions.** `dependencies` (not dev): `"@modelcontextprotocol/sdk": "1.32.2"`, `"zod": "^4.0.0"`, `"@cfworker/json-schema": "^4.1.1"`. Install with `npm install --save-exact @modelcontextprotocol/sdk@1.32.2 zod@^4 @cfworker/json-schema@^4.1.1`.

## Global Constraints

- Workers runtime; TypeScript; no Node-only APIs in `src/` (spec §7).
- `global_fetch_strictly_public` stays on (spec §7). `api.cloudflare.com` is public, so this doesn't affect `logs`.
- Existing provider converter contracts and the path convention must keep working (spec §7).
- Prettier formatting as configured. `npm run check` must pass. `npm test` (workers and node projects) must be green.
- No Co-Authored-By trailers on commits. Never push. Never run `wrangler deploy` in any form. Never edit `.dev.vars`, any settings.json, or `.mcp.json`.
- No network in tests or by subagents: no curl, no real DNS, no real Cloudflare API. Stub `fetch` with `stubFetch` from `test/helpers.ts`.
- MCP is stateless: no Durable Object and no session ids (spec §5.5, §8).
- Exactly two tools in this phase, `engagement` and `logs`. Adding a fifth tool overall needs a qualification run (spec §5.5).

## Review Focus

1. **Claude Code's own traffic**: the `notifications/initialized` POST, a `GET /mcp` probe and a `DELETE`. The notification gets `202`; `GET` and `DELETE` get `405` at once with no hang. Tests in Task 2.
2. **Auth edge cases**: `Bearer` with the wrong key, a missing header, `x-api-key` instead of `Authorization`, no `PROXY_KEY` at all, and `ALLOW_ANONYMOUS=true`. Each must be answered before the SDK runs. Tests in Task 2.
3. **Hostile or broken Observability responses**: HTTP 500 with an `errors` array, non-JSON, a missing `result.events`, `source` as a string or as garbage, a timeout. The tool returns `isError` text, never a 500 from `/mcp`, and never the token. Tests in Task 4.
4. **Out-of-range `logs` arguments**: `since=30d`, `since=yesterday`, a future ISO `since`, `limit=0` and `limit=1000`, `severity=critical`. These are clamped, or return `isError` from the zod enum. Tests in Task 5.
5. **Odd `engagement` inputs**: an unknown name containing control characters or 500 chars (not echoed), `scope_check` with a URL, a CIDR, `127.0.0.1` or an empty string, and `ENGAGEMENTS` unset. Tests in Task 3.

---

### Task 1: Dependencies and observability config

**Files:**

- Modify: `package.json`, `package-lock.json` (via `npm install`, D14)
- Modify: `src/config.ts` (the `ProxyConfig` interface and `loadConfig`)
- Test: `test/config-observability.test.ts`

**Interfaces:**

- Produces: `ProxyConfig.observability: ObservabilityConfig | null` and `export interface ObservabilityConfig { accountId: string; apiToken: string; service: string }` in `src/config.ts`.

- [ ] **Step 1: Install the dependencies (D14).** Run `npm install --save-exact @modelcontextprotocol/sdk@1.32.2` then `npm install zod@^4 @cfworker/json-schema@^4.1.1`. Expected: all three are listed under `dependencies`.
- [ ] **Step 2: Write the failing tests** in `test/config-observability.test.ts`:

```ts
const ACC = '0123456789abcdef0123456789abcdef'
it('is null when neither var is set', () => expect(loadConfig({}).observability).toBeNull())
it('parses both with the default service', () =>
    expect(loadConfig({ CF_ACCOUNT_ID: ACC, CF_API_TOKEN: 't0k' }).observability).toEqual({
        accountId: ACC,
        apiToken: 't0k',
        service: 'claude-workers-ai-proxy'
    }))
it('takes OBSERVABILITY_SERVICE', () =>
    expect(
        loadConfig({ CF_ACCOUNT_ID: ACC, CF_API_TOKEN: 't', OBSERVABILITY_SERVICE: 'x' }).observability?.service
    ).toBe('x'))
it('rejects a token without an account id', () =>
    expect(() => loadConfig({ CF_API_TOKEN: 't' })).toThrow(expect.objectContaining({ variable: 'CF_ACCOUNT_ID' })))
it('rejects an account id without a token', () =>
    expect(() => loadConfig({ CF_ACCOUNT_ID: ACC })).toThrow(expect.objectContaining({ variable: 'CF_API_TOKEN' })))
it.each(['ABC', '0123456789ABCDEF0123456789ABCDEF', ACC + '0'])('rejects account id %s', (id) =>
    expect(() => loadConfig({ CF_ACCOUNT_ID: id, CF_API_TOKEN: 't' })).toThrow(
        expect.objectContaining({ variable: 'CF_ACCOUNT_ID' })
    )
)
it('never puts the token in the error message', () => {
    try {
        loadConfig({ CF_ACCOUNT_ID: 'bad', CF_API_TOKEN: 'sekrit-token' })
    } catch (e) {
        expect(String((e as Error).message)).not.toContain('sekrit-token')
    }
})
```

- [ ] **Step 3: Run** `npx vitest run --project workers test/config-observability.test.ts`. Expected: FAIL because `observability` is undefined.
- [ ] **Step 4: Implement** the `observability` parsing in `loadConfig` (D8). Use the existing `str()` helper and `ConfigError(variable, message)` pattern.
- [ ] **Step 5: Run** `npm test` and `npm run check`. Expected: green and clean.
- [ ] **Step 6: Commit** `feat(config): add MCP SDK deps and CF_ACCOUNT_ID/CF_API_TOKEN observability config`.

### Task 2: `/mcp` endpoint (transport, auth, methods, log line)

**Files:**

- Create: `src/mcp/server.ts`
- Modify: `src/index.ts` (route before `externalMatch`)
- Test: `test/mcp-endpoint.test.ts`, plus a helper `mcpCall` added to `test/helpers.ts`

**Interfaces:**

- Consumes: `checkProxyAuth` (`src/auth.ts`), `enforceRateLimit` (`src/index.ts`), `ProxyConfig`.
- Produces:
    - `export async function handleMcp(request: Request, config: ProxyConfig, requestId: string, now?: () => number): Promise<Response>` in `src/mcp/server.ts`. It assumes auth has already passed.
    - `export type ToolRegistrar = (server: McpServer, ctx: McpContext) => void`
    - `export interface McpContext { config: ProxyConfig; requestId: string; now: () => number }`
    - `export function logged(ctx: McpContext, tool: string, action: string, run: () => Promise<CallToolResult>): Promise<CallToolResult>`, which writes the D6 line.
    - `handleMcp` registers the registrars in `const TOOLS: ToolRegistrar[]`. Task 2 ships it empty; Tasks 3 and 5 append to it.
    - The test helper `mcpCall(method: string, params?: unknown, opts?: { env?: Env; headers?: Record<string,string>; id?: number | null }): Promise<Response>` posts JSON-RPC to `/mcp` with `authorization: Bearer test-key`, `content-type: application/json`, `accept: application/json, text/event-stream` and `mcp-protocol-version: 2025-06-18`. `id: null` sends a notification (no `id`).

- [ ] **Step 1: Write the failing tests** in `test/mcp-endpoint.test.ts`:
    - `initialize` returns 200 with `result.serverInfo.name === 'claude-worker-proxy'` and `result.capabilities.tools` defined.
    - `tools/list` returns 200 with `result.tools` as an array (empty in this task).
    - `notifications/initialized` (`id: null`) returns 202.
    - `GET /mcp` and `DELETE /mcp` return 405 with header `allow: POST`.
    - Auth:
        - no `authorization` header → 401, body `{"error":"invalid authorization"}`;
        - `Bearer wrong` → 401;
        - `x-api-key: test-key` without `authorization` → 401;
        - env with no `PROXY_KEY` → 500 whose text contains `proxy not configured`;
        - env with no `PROXY_KEY` and `ALLOW_ANONYMOUS: 'true'` → `initialize` 200.
    - A body over 65536 bytes → 413.
    - A body of `{` → a JSON-RPC parse error response (`error.code === -32700`), not a 500.
    - D6 is tested in Task 3, since tools/call needs a tool.
- [ ] **Step 2: Run** `npx vitest run --project workers test/mcp-endpoint.test.ts`. Expected: FAIL with 404s from the router.
- [ ] **Step 3: Implement** `handleMcp` and the route (D1–D3). Per request:
    1. create the server and transport;
    2. apply each registrar;
    3. call `await server.connect(transport)`;
    4. `return transport.handleRequest(request)`.

    In `src/index.ts`:
    - `/mcp` with a method other than POST → 405;
    - POST → `enforceRateLimit`, then the D2 Bearer check, then `handleMcp`.

    Parse the Bearer token case-insensitively on the scheme (`/^Bearer\s+(.+)$/i`).

- [ ] **Step 4: Run** `npm test` and `npm run check`. Expected: green and clean.
- [ ] **Step 5: Commit** `feat(mcp): stateless /mcp endpoint with bearer auth`.

### Task 3: `engagement` tool

**Files:**

- Create: `src/mcp/engagement-tool.ts`
- Modify: `src/mcp/server.ts` (append to `TOOLS`)
- Test: `test/mcp-engagement.test.ts`

**Interfaces:**

- Consumes: `McpContext`, `ToolRegistrar`, `logged` (Task 2); `checkScope`, `inWindow`, `Engagement` (`src/engagement.ts`); `decideHosts` (`src/guard/decide.ts`).
- Produces: `export const registerEngagementTool: ToolRegistrar`.

- [ ] **Step 1: Write the failing tests.** Reuse the `ACME` engagement shape from `test/guard-check.test.ts`, with `now` fixed at `2026-11-15T00:00:00Z` (inside the window) via `handleMcp`'s `now` parameter. Call through `handleMcp` directly with a `loadConfig` result, or through `mcpCall` with `ENGAGEMENTS` in the env. Parse `result.content[0].text` as JSON.
    - `tools/list` has exactly one tool named `engagement`. Its `inputSchema.properties.action.enum` is `['list','get','scope_check']`, `required` is `['action']`, and its description has at most 2 sentences.
    - `list` → `engagements[0]` equals `{ name: 'acme', window: { start: '2026-11-10T00:00:00.000Z', end: '2026-11-21T23:59:59.000Z' }, active: true, defaultMode: 'redteam' }`.
    - `list` with no `ENGAGEMENTS` → `{ engagements: [], hint: 'set the ENGAGEMENTS secret' }`.
    - `get` with `name: 'acme'` → `scope.domains` equals `['*.acme-test.com']` and `roe` equals `''`.
    - `get` without `name` → `isError`, text `name is required for get`.
    - `get` with `name: 'nope'` → `isError`, text `unknown engagement: nope`. With `name: 'a\nb'` or `'x'.repeat(500)` → text exactly `unknown engagement`.
    - `scope_check`, all with `name: 'acme'`:
        - `target: 'https://app.acme-test.com/x'` → `verdict: 'in_scope'`, `decision: 'allow'`, `reasons: []`;
        - `target: 'mail.acme-test.com'` → `verdict: 'excluded'`, `decision: 'deny'`;
        - `target: 'evil.example.org'` → `verdict: 'out_of_scope'`, `decision: 'deny'`;
        - `target: ''` → `verdict: 'invalid_target'`;
        - `target: '127.0.0.1'` → `decision: 'allow'`;
        - `target: 'x'.repeat(2049)` → `isError` `target too long (max 2048 chars)`.
    - `scope_check` with `now` after the window → `inWindow: false` and `decision: 'deny'`.
    - `action: 'nope'` → `isError` (from SDK validation), HTTP 200.
    - D6: one `tools/call` writes exactly one `console.log` line that parses to `{ event: 'mcp', tool: 'engagement', action: 'get', ok: true }` plus a `requestId` and a numeric `durationMs`, and no `target` or `name` keys. A failed call logs `ok: false`.
- [ ] **Step 2: Run** `npx vitest run --project workers test/mcp-engagement.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `registerEngagementTool` (D4, D5, D7). Description: `Engagements configured on this proxy: list them, get one's scope, window and rules of engagement, or check whether a host, IP, CIDR or URL is in scope right now.`
- [ ] **Step 4: Run** `npm test` and `npm run check`. Expected: green and clean.
- [ ] **Step 5: Commit** `feat(mcp): engagement tool (list, get, scope_check)`.

### Task 4: Observability query client

**Files:**

- Create: `src/observability.ts`
- Test: `test/observability.test.ts`

**Interfaces:**

- Consumes: `ObservabilityConfig` (Task 1).
- Produces:
    - `export interface LogFilter { key: string; operation: 'eq' | 'starts_with' | 'in'; type: 'string'; value: string | string[] }`
    - `export interface LogRow { time: number; source: Record<string, unknown> }`
    - `export type QueryResult = { ok: true; rows: LogRow[]; count: number } | { ok: false; error: string }`
    - `export async function queryEvents(cfg: ObservabilityConfig, event: 'detection' | 'request', from: number, to: number, filters: LogFilter[], limit: number): Promise<QueryResult>` (D9, D10).
    - `export function matches(source: Record<string, unknown>, f: LogFilter): boolean` (the client-side re-check).

- [ ] **Step 1: Write the failing tests** with `stubFetch`:
    - The request goes to `https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/workers/observability/telemetry/query` with method POST and header `authorization: Bearer t0k`. Its JSON body has `view: 'events'`, `dry: true`, `limit: 50`, `timeframe: { from, to }`, and `parameters.filters` that start with the service filter and the `event` filter (D9).
    - A 200 response with `result.events.events` holding three rows, where:
        - one row's `source` is an object;
        - one row's `source` is a JSON string;
        - one row's `source` is `'not json'`;

        returns `ok: true` with 2 rows, sorted newest first.

    - Re-check: a row whose `source.event` is `'request'` when `'detection'` was asked for is dropped. A row failing an `engagement` `eq` filter is dropped. `starts_with` and `in` work in `matches`.
    - `count` takes `result.events.count` when it is a number, otherwise the row count.
    - HTTP 500 with `{ errors: [{ message: 'bad query' }] }` → `{ ok: false, error: 'logs query failed: HTTP 500: bad query' }`.
    - HTTP 403 with a non-JSON body → `error` `logs query failed: HTTP 403`.
    - 200 with `{}` → `error` `logs query returned an unexpected response`.
    - `fetch` rejecting with a `TimeoutError` DOMException → `error` `logs query timed out after 10 s`.
    - A generic rejection → `error` `logs query failed: network error`.
    - No error string, for any of the cases above, contains `t0k`.
- [ ] **Step 2: Run** `npx vitest run --project workers test/observability.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `queryEvents` and `matches` (D9, D10). `errors[].message` is cut to 200 chars. Pass `signal: AbortSignal.timeout(10000)` to `fetch`.
- [ ] **Step 4: Run** `npm test` and `npm run check`. Expected: green and clean.
- [ ] **Step 5: Commit** `feat(observability): Workers Observability telemetry query client`.

### Task 5: `logs` tool

**Files:**

- Create: `src/mcp/logs-tool.ts`
- Modify: `src/mcp/server.ts` (append to `TOOLS`)
- Test: `test/mcp-logs.test.ts`

**Interfaces:**

- Consumes: `queryEvents`, `LogFilter`, `LogRow` (Task 4); `redact` (`src/guard/redact.ts`); `McpContext`, `logged` (Task 2).
- Produces: `export const registerLogsTool: ToolRegistrar` and `export function parseSince(since: string | undefined, now: number): number | null`. It returns the clamped `from` in ms, or `null` when the input is invalid.

- [ ] **Step 1: Write the failing tests.** Use `stubFetch` returning canned event rows, and fix `now = Date.parse('2026-11-13T12:00:00Z')`.
    - `parseSince`:
        - `undefined` → `now − 24h`;
        - `'30m'` → `now − 30 min`;
        - `'30d'` → `now − 7d` (clamped);
        - `'2026-11-13T00:00:00Z'` → that time;
        - `'yesterday'` → `null`;
        - `'2026-11-14T00:00:00Z'` (future) → `null`.
    - `tools/list` (with Task 3 merged) has exactly two tools, `engagement` and `logs`. The `logs` action enum is `['findings','activity']`.
    - `findings` with `engagement: 'acme'`, `rule: 'secret.'`, `severity: 'medium'` → the request filters include:
        - `{ key: 'engagement', operation: 'eq', value: 'acme' }`
        - `{ key: 'ruleId', operation: 'starts_with', value: 'secret.' }`
        - `{ key: 'severity', operation: 'in', value: ['medium','high'] }`

        The rows map to `{ time, ruleId, severity, engagement, requestId, excerpt }`.

    - An excerpt holding `ghp_` followed by 36 alphanumerics comes back without its 36-char tail (re-redacted).
    - `rule: 'secret.egress'` → an `eq` filter.
    - `activity` rows keep `model`, `tools`, `durationMs` and `ttfbMs`, omit absent fields, and never include `excerpt`.
    - `limit: 0` → zod `isError`. `limit: 1000` → `isError` (zod `max(100)`). Omitted → the request body has `limit: 50`.
    - `severity: 'critical'` → `isError`.
    - `since: 'yesterday'` → `isError` `invalid since: use e.g. 30m, 24h, 7d or an ISO time`.
    - Not configured (no `CF_*` in the env) → `isError` with the D12 text, and `fetch` is never called.
    - An upstream 500 → `isError` with the D10 text; HTTP 200 from `/mcp`.
    - 300 rows with 400-char excerpts → `truncated: true`, the text is at most 32768 bytes, and it parses as JSON.
    - D6: `logs` calls log `tool: 'logs'` with their action.
- [ ] **Step 2: Run** `npx vitest run --project workers test/mcp-logs.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `registerLogsTool` and `parseSince` (D11, D12). `limit` is `z.number().int().min(1).max(100).optional()`. Description: `Query this proxy's Workers Logs: findings are guard detection lines and activity is request lines (model, tools, timings). Filter by engagement, time since, rule and minimum severity; logs are kept 3 days on Free and 7 on Paid.`
- [ ] **Step 4: Run** `npm test` and `npm run check`. Expected: green and clean.
- [ ] **Step 5: Commit** `feat(mcp): logs tool (findings, activity)`.

### Task 6: Tool names on request lines

**Files:**

- Modify: `src/request-log.ts` (`RequestLog`, the tracker, the non-stream path)
- Test: `test/request-log.test.ts` (extend)

**Interfaces:**

- Produces: `RequestLog.tools?: string[]` (D13), read by `logs activity` (Task 5 maps it through unchanged).

- [ ] **Step 1: Write the failing tests:**
    - A streamed response with `tool_use` blocks `Bash`, `Read` and `Bash` → the request line has `tools: ['Bash','Read']`.
    - A streamed response with 20 distinct tool names → 16 names.
    - A 100-char name → cut to 64.
    - The names are still collected when the guard is disabled (`GUARD_RULES` disabling every rule) and when 17 or more blocks are open at once.
    - A non-streamed response whose `content` has `tool_use` blocks gets `tools`.
    - A text-only response has no `tools` key.
- [ ] **Step 2: Run** `npx vitest run --project workers test/request-log.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** D13 in `src/request-log.ts`. The name collector is separate from the guard's block map and runs even when `guard` is undefined.
- [ ] **Step 4: Run** `npm test` and `npm run check`. Expected: green and clean.
- [ ] **Step 5: Commit** `feat(log): record tool_use names on request lines`.

### Task 7: Docs

**Files:**

- Modify: `README.md` (new section "MCP server"; config table rows), `TESTING.md` (new section "§14 MCP server")

- [ ] **Step 1: README "MCP server" section:**
    - what `/mcp` is: stateless, the two tools and their actions;
    - the registration snippet:

        ```bash
        claude mcp add --transport http proxy https://<your-worker>.workers.dev/mcp --header "Authorization: Bearer <PROXY_KEY>"
        ```

    - that GET returns 405 by design;
    - `logs` setup:
        1. create an API token with the Workers Observability permission (the query endpoint requires the Edit/Write level);
        2. `npx wrangler secret put CF_API_TOKEN`;
        3. set `CF_ACCOUNT_ID` in `wrangler.jsonc` `vars`;
        4. optionally set `OBSERVABILITY_SERVICE` if the Worker is renamed;
    - retention is 3 days on Free and 7 on Paid;
    - without the token, `logs` says to use `wrangler tail`;
    - a known limit: custom-field filter key names are applied on the server and re-checked on the client (D9). If `findings` returns nothing while detections exist, run the TESTING §14 key check.

    Add `CF_ACCOUNT_ID`, `CF_API_TOKEN` and `OBSERVABILITY_SERVICE` to the config table. In the logging section, mention the `mcp` log line (D6) and the `tools` field (D13).

- [ ] **Step 2: TESTING §14:**
    1. a local `wrangler dev` check with `curl` for initialize, tools/list and an `engagement` call;
    2. `claude mcp add` against the local URL, then `/mcp` in Claude Code shows the 2 tools;
    3. after a deploy, a `logs findings` call against real logs. If it returns empty while detections exist, query the API's keys endpoint (`POST …/workers/observability/telemetry/keys`) to read the real custom-field key names.
- [ ] **Step 3: Run** `npm run check`. Expected: clean.
- [ ] **Step 4: Commit** `docs: MCP server setup, logs configuration and tests`.

### Task 8: Final verification (controller)

- [ ] **Step 1:** `npm test` twice and `npm run check`. Expected: green twice and clean.
- [ ] **Step 2:** Controller only: check bundle size with `npx wrangler deploy --dry-run --outdir .wrangler/dryrun`. It uploads nothing. Expected: the gzip size is under 3 MB, the Free-plan limit. Record the size in the ledger.
- [ ] **Step 3:** Live local check on `wrangler dev --port 8791` with a throwaway engagement: initialize, tools/list (2 tools), `engagement list`/`scope_check`, `logs findings` with no `CF_*` set (expect the not-configured text), and 401 without auth. Stop the dev server per the Windows cleanup note.
- [ ] **Step 4:** Final whole-branch review, then ponytail-review on `$(git merge-base HEAD feat/phase4-guard-hook)..HEAD`.
