# Phase 1: Foundation & Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the Worker on a real test harness and close the open-relay, fail-open-auth, cleartext-key, header-leak, unbounded-body, no-timeout and vars-wiped-on-deploy problems without breaking the user's current Claude Code setup.

**Architecture:** A typed `src/config.ts` parses every setting once per request and fails closed on invalid values. Small single-purpose modules (`provider-url.ts`, `upstream-headers.ts`, `body-limit.ts`, `upstream.ts`) are wired into the existing router in `src/index.ts`. Provider converters keep their contracts and only swap how they build upstream headers.

**Tech Stack:** TypeScript (strict), Cloudflare Workers (wrangler 4.126), vitest + `@cloudflare/vitest-pool-workers`, Node 24 for tooling.

**Spec:** `docs/superpowers/specs/2026-11-07-security-workflows-roadmap-design.md` (§4 findings F1–F7, F10; §5.1; §6 "Phase 1 detail" items 1–12)

## Global Constraints

- Prettier: 4-space indent, single quotes, no semicolons, `printWidth: 120`, `trailingComma: none`. `npm run check` must pass.
- TypeScript `strict`; no Node-only APIs in `src/` (Workers runtime only).
- Existing provider converter contracts (`Provider` interface in `src/provider.ts`) and the `/{type}/{provider_url}/v1/messages` path convention keep working.
- Every new default that could break the current setup is documented in README with the env var that restores old behavior.
- Error bodies keep the shape `{"type":"error","error":{"type":...,"message":...},"request_id":"req_..."}`, with a `request-id` header equal to `request_id`.
- `npm test` needs no Cloudflare login, no network and no cost; live calls only in opt-in `npm run smoke`.
- Commits: conventional-commit style as in `git log`; **no `Co-Authored-By` trailers** (user preference).
- Work on a feature branch `feat/phase1-hardening` (create via superpowers:using-git-worktrees at execution start), never on `main`.
- Deployed state (2026-11-07): only `PROXY_KEY` secret is set; last deploy shipped `"vars": {}`. Do **not** run `wrangler deploy` in this plan; the user deploys.

## Review Focus

1. **Claude Code's real traffic still works** after the header allowlist: an Anthropic-style streaming request with `anthropic-beta`, `anthropic-version`, `accept: text/event-stream` and `x-api-key` on `/v1/messages` must still stream from Workers AI. Test owned by Task 5 (`claude code shaped request still streams`).
2. **Large legitimate bodies** (a base64 image making the body ~20 MB) and **chunked bodies with no `content-length`** under the limit must pass untouched. Tests owned by Task 6.
3. **Long streams are not cut by the timeout:** an upstream that sends headers immediately and then trickles chunks for longer than `UPSTREAM_TTFB_MS` must complete. Test owned by Task 7 (`streaming body may outlast ttfb`).
4. **Scrubbed provider errors stay useful:** a provider 401 whose message echoes the key keeps its status and the rest of the message; only the key and any `Bearer …` token become `[redacted]`. Test owned by Task 7.
5. **Sloppy env values:** `ALLOWED_HOSTS=" API.OpenAI.com , ,api.groq.com. "` normalizes to exact hosts; `ALLOW_HTTP=TRUE` is accepted; `ALLOW_HTTP=yes` is a clear `invalid config: ALLOW_HTTP` 500, not a silent false. Tests owned by Task 2.

---

## File Structure

| File                                                                                                                          | Responsibility                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `vitest.config.ts` (create)                                                                                                   | Workers-runtime test project, no remote bindings                               |
| `test/tsconfig.json` (create)                                                                                                 | Types for tests (pool-workers + worker types)                                  |
| `test/helpers.ts` (create)                                                                                                    | `makeEnv`, `callWorker`, `fakeAI`, `readSse`, `stubFetch`                      |
| `test/*.test.ts` (create)                                                                                                     | Ported checks: hermes, blocks, reasoning, tool-choice, stream, nonstream       |
| `test/security/*.test.ts` (create)                                                                                            | Config, auth, provider URL, headers, body limit, upstream timeout/scrub        |
| `src/config.ts` (create)                                                                                                      | `loadConfig(env)` → `ProxyConfig`; `ConfigError`                               |
| `src/provider-url.ts` (create)                                                                                                | Parse/normalize/authorize provider base URL                                    |
| `src/upstream-headers.ts` (create)                                                                                            | Header allowlist for upstream requests                                         |
| `src/body-limit.ts` (create)                                                                                                  | Size-limited body reading                                                      |
| `src/upstream.ts` (create)                                                                                                    | `fetchUpstream` (retry + timeouts), `scrubUpstreamError`                       |
| `src/auth.ts` (modify)                                                                                                        | Add `checkProxyAuth`                                                           |
| `src/errors.ts` (modify)                                                                                                      | Add `request_too_large` error type                                             |
| `src/index.ts` (modify)                                                                                                       | Wire config, auth, body limit, URL policy, upstream; remove superseded helpers |
| `src/providers/openai.ts`, `gemini.ts` (modify)                                                                               | Use `upstreamHeaders()` instead of `new Headers(request.headers)`              |
| `wrangler.jsonc`, `README.md`, `TESTING.md`, `scripts/self-test.sh`, `package.json`, `.prettierignore`, `.gitignore` (modify) | Config source of truth, docs, smoke test, scripts                              |
| `scripts/*-check.mjs` (delete)                                                                                                | Replaced by `test/`                                                            |

---

### Task 1: Workers-runtime test harness and ported checks

**Files:**

- Create: `vitest.config.ts`, `test/tsconfig.json`, `test/helpers.ts`, `test/router.test.ts`, `test/hermes.test.ts`, `test/blocks.test.ts`, `test/reasoning.test.ts`, `test/tool-choice.test.ts`, `test/stream.test.ts`, `test/nonstream.test.ts`
- Modify: `package.json`, `.prettierignore`
- Delete: `scripts/hermes-check.mjs`, `scripts/blocks-check.mjs`, `scripts/reasoning-check.mjs`, `scripts/tool-choice-check.mjs`, `scripts/stream-check.mjs`, `scripts/nonstream-check.mjs`

**Interfaces:**

- Produces (`test/helpers.ts`, used by every later test):
    - `makeEnv(overrides?: Record<string, unknown>): Env`. Defaults: `{ PROXY_KEY: 'test-key', AI: fakeAI([{ response: 'hi' }]) }`, no `RATE_LIMITER`. An override value of `undefined` deletes the key.
    - `callWorker(input: string | Request, init?: RequestInit, env?: Env): Promise<Response>`. Relative paths resolve against `https://proxy.test`; calls `worker.fetch(request, env ?? makeEnv())` from `src/index.ts`.
    - `fakeAI(chunks: unknown[] | ((model: string, options: any) => Response | Promise<Response>)): { run(...): Promise<Response> }`. Array form returns an SSE `Response` of `data: <json>\n\n` lines.
    - `readSse(res: Response): Promise<{ event: string; data: any }[]>`.
    - `stubFetch(handler: (req: Request) => Response | Promise<Response>): { calls: Request[]; restore(): void }`, implemented with `vi.spyOn(globalThis, 'fetch')`.

- [ ] **Step 1: Install dev dependencies**

Run: `npm install -D vitest @cloudflare/vitest-pool-workers`
Expected: both added to `devDependencies`. Pick the vitest major the installed pool-workers version declares as its peer.

- [ ] **Step 2: Write `vitest.config.ts` and `test/tsconfig.json`**

Use the config API from the installed `@cloudflare/vitest-pool-workers` README (it changed across versions, so check it rather than assuming). Requirements:

- Do **not** point it at `wrangler.jsonc`. The `ai` binding there is `remote: true` and would need a login. Give miniflare `compatibilityDate: '2026-08-27'` and `compatibilityFlags: ['global_fetch_strictly_public', 'nodejs_compat']` inline.
- Include `test/**/*.test.ts`.
- `test/tsconfig.json` extends `../tsconfig.json`, overrides `include` to `["../worker-configuration.d.ts", "../src/**/*.ts", "./**/*.ts"]`, removes the `test` exclude, and adds the pool-workers types per its README.

- [ ] **Step 3: Write `test/helpers.ts` with the interfaces above**

- [ ] **Step 4: Port each `scripts/*-check.mjs` to `test/<name>.test.ts`**

Convert each `assert.*` to the equivalent `expect`, keeping every input and every expected value identical. Import from `../src/...` directly instead of `.tmp-check`. `nonstream`/`stream` use `fakeAI` and `readSse` from helpers instead of their local copies. Then add one smoke test of the harness itself:

```ts
// test/router.test.ts
it('health check is ok', async () => {
    const res = await callWorker('/')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
})
```

- [ ] **Step 5: Update `package.json` scripts and `.prettierignore`**

- `"test": "vitest run"`
- `"check": "wrangler types && tsc --noEmit && tsc -p test/tsconfig.json --noEmit && prettier --check ."`
- Remove `check:hermes`, `check:blocks`, `check:reasoning`, `check:tool-choice`, `check:stream`, `check:nonstream`, `check:all`.
- `.prettierignore`: add `.claude/`.
- `.gitignore`: `.tmp-check/` can stay. Nothing generates it any more, but it is harmless.

- [ ] **Step 6: Run the suite**

Run: `npm test`
Expected: all ported tests PASS, with the same count of assertions as the old scripts (spot-check `stream.test.ts`, which had the most). No login prompt, no network.

- [ ] **Step 7: Delete the six `scripts/*-check.mjs` files and run checks**

Run: `npm test && npm run check`
Expected: both pass.

- [ ] **Step 8: Commit**

```bash
git add -A vitest.config.ts test package.json package-lock.json .prettierignore scripts
git commit -m "test: move checks to vitest-pool-workers"
```

---

### Task 2: Typed config with fail-closed parsing

**Files:**

- Create: `src/config.ts`, `test/security/config.test.ts`
- Modify: `src/index.ts` (call `loadConfig` at the top of `fetch`)

**Interfaces:**

- Produces:

```ts
export interface ProxyConfig {
    proxyKey: string | null
    allowAnonymous: boolean
    allowedHosts: ReadonlySet<string> | '*'
    allowHttp: boolean
    maxBodyBytes: number
    upstreamTtfbMs: number
    upstreamTotalMs: number
}
export class ConfigError extends Error {
    readonly variable: string
}
export const DEFAULT_ALLOWED_HOSTS: readonly string[] // spec §6 item 4, exact list below
export const DEFAULT_MAX_BODY_BYTES = 33554432 // 32 MiB
export const DEFAULT_UPSTREAM_TTFB_MS = 120000
export const DEFAULT_UPSTREAM_TOTAL_MS = 600000
export function loadConfig(env: unknown): ProxyConfig // throws ConfigError
```

`DEFAULT_ALLOWED_HOSTS` = `api.openai.com`, `generativelanguage.googleapis.com`, `api.anthropic.com`, `openrouter.ai`, `api.groq.com`, `api.deepseek.com`, `api.mistral.ai`, `api.x.ai`.

Parsing rules:

- Booleans: case-insensitive `true` or `false`; unset means `false`; anything else throws.
- Integers: positive base-10 integers only; unset means the default.
- `ALLOWED_HOSTS`:
    - Comma-split, trim, lowercase, strip one trailing `.`, drop empty entries.
    - `*` alone means `'*'`.
    - An entry containing `/`, `:`, `@` or whitespace, or `*` mixed with other hosts, throws.
    - Unset or empty after cleaning means the default list.
- `PROXY_KEY`: an empty string counts as unset (`null`).

- [ ] **Step 1: Write failing tests**

```ts
describe('loadConfig', () => {
    it('applies defaults', () => {
        const c = loadConfig({ PROXY_KEY: 'k' })
        expect(c.proxyKey).toBe('k')
        expect(c.allowAnonymous).toBe(false)
        expect(c.allowHttp).toBe(false)
        expect(c.maxBodyBytes).toBe(33554432)
        expect(c.upstreamTtfbMs).toBe(120000)
        expect(c.upstreamTotalMs).toBe(600000)
        expect([...(c.allowedHosts as Set<string>)].sort()).toEqual([...DEFAULT_ALLOWED_HOSTS].sort())
    })
    it('normalizes sloppy ALLOWED_HOSTS', () => {
        const c = loadConfig({ ALLOWED_HOSTS: ' API.OpenAI.com , ,api.groq.com. ' })
        expect([...(c.allowedHosts as Set<string>)].sort()).toEqual(['api.groq.com', 'api.openai.com'])
    })
    it('star means open', () => expect(loadConfig({ ALLOWED_HOSTS: '*' }).allowedHosts).toBe('*'))
    it.each(['https://api.openai.com', 'api.openai.com:443', 'a@b.com', '*,api.openai.com'])(
        'rejects ALLOWED_HOSTS entry %s',
        (v) => expect(() => loadConfig({ ALLOWED_HOSTS: v })).toThrow(ConfigError)
    )
    it('accepts TRUE, rejects yes', () => {
        expect(loadConfig({ ALLOW_HTTP: 'TRUE' }).allowHttp).toBe(true)
        expect(() => loadConfig({ ALLOW_HTTP: 'yes' })).toThrowError(
            expect.objectContaining({ variable: 'ALLOW_HTTP' })
        )
    })
    it.each(['0', '-5', '1.5', 'abc'])('rejects MAX_BODY_BYTES=%s', (v) =>
        expect(() => loadConfig({ MAX_BODY_BYTES: v })).toThrow(ConfigError)
    )
    it('empty PROXY_KEY is unset', () => expect(loadConfig({ PROXY_KEY: '' }).proxyKey).toBeNull())
})

it('invalid config fails every request with 500', async () => {
    const res = await callWorker('/', undefined, makeEnv({ ALLOW_HTTP: 'yes' }))
    expect(res.status).toBe(500)
    const body = await res.json<any>()
    expect(body.error).toEqual({ type: 'api_error', message: 'invalid config: ALLOW_HTTP' })
    expect(res.headers.get('request-id')).toBe(body.request_id)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/security/config.test.ts`
Expected: FAIL, cannot resolve `../../src/config`.

- [ ] **Step 3: Implement `src/config.ts`; in `src/index.ts` `fetch`, call `loadConfig(env)` first**

On a `ConfigError`, `console.error` the message and return `anthropicError(500, 'api_error', \`invalid config: ${e.variable}\`, requestId)`. This applies to every route, including `/`. Pass the resulting `ProxyConfig`into`handleRequest` as a new parameter.

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS (all, including Task 1's).

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/index.ts test/security/config.test.ts
git commit -m "feat: typed config with fail-closed parsing"
```

---

### Task 3: Fail-closed proxy auth on every route

**Files:**

- Modify: `src/auth.ts`, `src/index.ts` (`requireProxyKey`, and the external-route key check in `handleExternal`)
- Create: `test/security/auth.test.ts`

**Interfaces:**

- Consumes: `ProxyConfig` (Task 2).
- Produces: `checkProxyAuth(provided: string | null, cfg: ProxyConfig): Promise<'ok' | 'unauthorized' | 'not_configured'>`.
    - `cfg.proxyKey === null`: returns `'ok'` if `cfg.allowAnonymous`, else `'not_configured'`.
    - Otherwise: `'ok'` if `verifyProxyKey` matches, else `'unauthorized'`.

Router behavior:

- `'not_configured'`: `500 api_error` `proxy not configured: set PROXY_KEY or ALLOW_ANONYMOUS=true`.
- `'unauthorized'`: the existing 401 messages (`invalid x-api-key` on internal routes, `invalid x-proxy-key` on external routes).
- Health `/` is exempt.

- [ ] **Step 1: Write failing tests**

```ts
const msg = { model: 'm', messages: [{ role: 'user', content: 'hi' }] }
const post = (path: string, headers: Record<string, string> = {}) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(msg)
})

it('no PROXY_KEY and no ALLOW_ANONYMOUS → 500 not configured on internal and external routes', async () => {
    const env = makeEnv({ PROXY_KEY: undefined })
    for (const [path, init] of [
        ['/v1/models', undefined],
        ['/v1/messages', post('/v1/messages')],
        ['/v1/messages/count_tokens', post('/v1/messages/count_tokens')],
        ['/openai/api.openai.com/v1/messages', post('', { 'x-api-key': 'sk-provider' })]
    ] as const) {
        const res = await callWorker(path, init, env)
        expect(res.status, path).toBe(500)
        expect((await res.json<any>()).error.message).toBe(
            'proxy not configured: set PROXY_KEY or ALLOW_ANONYMOUS=true'
        )
    }
})
it('health check stays open when not configured', async () => {
    expect((await callWorker('/', undefined, makeEnv({ PROXY_KEY: undefined }))).status).toBe(200)
})
it('ALLOW_ANONYMOUS=true restores open behavior', async () => {
    const res = await callWorker('/v1/models', undefined, makeEnv({ PROXY_KEY: undefined, ALLOW_ANONYMOUS: 'true' }))
    expect(res.status).toBe(200)
})
it('wrong key → 401, right key → 200', async () => {
    expect((await callWorker('/v1/models', { headers: { 'x-api-key': 'nope' } })).status).toBe(401)
    expect((await callWorker('/v1/models', { headers: { 'x-api-key': 'test-key' } })).status).toBe(200)
})
it('external route checks x-proxy-key, not x-api-key', async () => {
    const res = await callWorker('/openai/api.openai.com/v1/messages', post('', { 'x-api-key': 'test-key' }))
    expect(res.status).toBe(401)
    expect((await res.json<any>()).error.message).toBe('invalid x-proxy-key')
})
```

Note: this changes the existing behavior where a `/{type}/...` route with no `PROXY_KEY` skipped the check. Note this in the commit body.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/security/auth.test.ts`
Expected: FAIL. The not-configured cases return 200/401 today.

- [ ] **Step 3: Implement `checkProxyAuth` and use it in both places in `src/index.ts`**

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS. Update any Task 1 test that relied on the open default by passing `x-api-key: test-key`.

- [ ] **Step 5: Commit**

```bash
git add src/auth.ts src/index.ts test
git commit -m "feat: fail closed when PROXY_KEY is unset"
```

---

### Task 4: Provider URL policy (allowlist, HTTPS-only, normalization)

**Files:**

- Create: `src/provider-url.ts`, `test/security/provider-url.test.ts`
- Modify: `src/index.ts`. Delete `normalizeProviderUrl` and `providerHostAllowed`, and call `resolveProviderUrl` in `handleExternal` **before** the provider key is extracted.

**Interfaces:**

- Consumes: `ProxyConfig` (Task 2).
- Produces:

```ts
export type ProviderUrlResult = { ok: true; baseUrl: string } | { ok: false; status: 400 | 403; message: string }
export function resolveProviderUrl(raw: string, cfg: Pick<ProxyConfig, 'allowedHosts' | 'allowHttp'>): ProviderUrlResult
```

Rules, in order:

1. Repair `http:/x` and `https:/x` to `//`.
2. No scheme means prefix `https://`.
3. Parse with `new URL`. On failure: `400 "invalid provider URL"`.
4. Userinfo present: `400 "credentials in provider URL are not allowed"`.
5. `http:` and not `allowHttp`: `403 "http provider URLs are disabled; set ALLOW_HTTP=true"`.
6. Lowercase the hostname and strip one trailing `.`.
7. If `allowedHosts !== '*'`:
    - IPv4/IPv6 literal: `403 "IP-literal provider hosts are not allowed"`.
    - Explicit port: `403 "custom ports are not allowed"`.
    - Host not in the set: `403 "Provider host not allowed by ALLOWED_HOSTS"`.
8. Result: `baseUrl` = `${protocol}//${host}${pathname}` without a trailing `/` (same shape the old `normalizeProviderUrl` returned).

Router: a failed result maps to `anthropicError(status, status === 403 ? 'permission_error' : 'invalid_request_error', message, requestId)`.

- [ ] **Step 1: Write failing tests**

Unit cases on `resolveProviderUrl` with `cfg = { allowedHosts: new Set(['api.openai.com']), allowHttp: false }`:

| raw                                             | expected                        |
| ----------------------------------------------- | ------------------------------- |
| `api.openai.com`                                | ok, `https://api.openai.com`    |
| `https:/api.openai.com/v1`                      | ok, `https://api.openai.com/v1` |
| `API.OPENAI.COM.`                               | ok, `https://api.openai.com`    |
| `api.openai.com/../evil.com`                    | ok, host stays `api.openai.com` |
| `http://api.openai.com`                         | 403 http disabled               |
| `evil.com`                                      | 403 not allowed                 |
| `api.openai.com.evil.com`                       | 403 not allowed                 |
| `api.openai.com@evil.com`                       | 400 credentials                 |
| `user:pw@api.openai.com`                        | 400 credentials                 |
| `evil.com#api.openai.com`                       | 403 not allowed                 |
| `api.openai.com:8443`                           | 403 custom ports                |
| `[::1]`                                         | 403 IP-literal                  |
| `127.0.0.1`                                     | 403 IP-literal                  |
| `%`                                             | 400 invalid provider URL        |
| with `allowHttp: true`: `http://api.openai.com` | ok                              |
| with `allowedHosts: '*'`: `1.2.3.4:8080`        | ok, `https://1.2.3.4:8080`      |

Router-level tests:

- **Open relay closed:** POST `/openai/evil.com/v1/messages` with a valid `x-proxy-key` returns `403 permission_error`, and `stubFetch` records **zero** calls.
- **Encoded path:** POST `/openai/api.openai.com%2F..%2F..%40evil.com/v1/messages` never fetches a host other than `api.openai.com`. Assert on `stubFetch().calls[*].url` hostnames, or expect a 4xx with zero calls.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/security/provider-url.test.ts`
Expected: FAIL, module missing.

- [ ] **Step 3: Implement `resolveProviderUrl` and wire it into `handleExternal`**

Wrap `decodeURIComponent` of the path segments in try/catch so a malformed escape returns `400 invalid provider URL` instead of a 500.

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/provider-url.ts src/index.ts test/security/provider-url.test.ts
git commit -m "feat: deny-by-default provider host allowlist, https only"
```

---

### Task 5: Upstream header allowlist

**Files:**

- Create: `src/upstream-headers.ts`, `test/security/upstream-headers.test.ts`
- Modify: `src/providers/openai.ts:153` and `:471`, `src/providers/gemini.ts:19`. Replace `new Headers(request.headers)` with `upstreamHeaders(request.headers)`. The converters then set their own auth and `Content-Type` exactly as today.

**Interfaces:**

- Produces: `export const UPSTREAM_HEADER_ALLOWLIST: readonly string[]` = `content-type`, `accept`, `anthropic-version`, `anthropic-beta`, `openai-organization`, `openai-project`, `user-agent`; and `export function upstreamHeaders(inbound: Headers): Headers`, which copies only those headers (case-insensitive).

- [ ] **Step 1: Write failing tests**

```ts
it('drops everything not allowlisted', () => {
    const h = upstreamHeaders(
        new Headers({
            'cf-connecting-ip': '1.2.3.4',
            'x-forwarded-for': '1.2.3.4',
            cookie: 'a=b',
            'x-proxy-key': 'p',
            'x-api-key': 'k',
            authorization: 'Bearer k',
            'x-engagement': 'acme',
            'anthropic-beta': 'b1',
            accept: 'text/event-stream',
            'user-agent': 'claude-cli/2'
        })
    )
    expect([...h.keys()].sort()).toEqual(['accept', 'anthropic-beta', 'user-agent'])
})

it('external request carries only allowlisted headers plus provider auth', async () => {
    const fetchStub = stubFetch(() =>
        Response.json({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] })
    )
    await callWorker('/openai/api.openai.com/v1/messages', {
        method: 'POST',
        headers: {
            'x-proxy-key': 'test-key',
            authorization: 'Bearer sk-provider',
            'x-forwarded-for': '9.9.9.9',
            'content-type': 'application/json'
        },
        body: JSON.stringify({ model: 'gpt', messages: [{ role: 'user', content: 'hi' }] })
    })
    const sent = fetchStub.calls[0].headers
    expect(sent.get('authorization')).toBe('Bearer sk-provider')
    expect(sent.get('x-forwarded-for')).toBeNull()
    expect(sent.get('x-proxy-key')).toBeNull()
    fetchStub.restore()
})
```

Plus the same external-request assertion for `gemini` (expects `x-goog-api-key` set, no `authorization`) and `openai-responses`.

Review Focus 1, `claude code shaped request still streams`: POST `/v1/messages` with headers `x-api-key: test-key`, `anthropic-version: 2023-06-01`, `anthropic-beta: interleaved-thinking-2025-05-14`, `accept: text/event-stream`, body `{ model: '@cf/x', stream: true, max_tokens: 50, messages: [...] }`, with `fakeAI([{ response: 'he' }, { response: 'llo' }])`. Expect a 200 `text/event-stream`, and `readSse` events that start with `message_start` and end with `message_stop` and whose text deltas join to `hello`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/security/upstream-headers.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement and swap the three call sites**

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS, including the ported `stream`/`nonstream` tests.

- [ ] **Step 5: Commit**

```bash
git add src/upstream-headers.ts src/providers test/security/upstream-headers.test.ts
git commit -m "fix: forward only allowlisted headers upstream"
```

---

### Task 6: Request body size limit

**Files:**

- Create: `src/body-limit.ts`, `test/security/body-limit.test.ts`
- Modify: `src/errors.ts` (add `'request_too_large'` to `ClaudeErrorType`), `src/index.ts` (apply to every POST route before parsing or dispatch)

**Interfaces:**

- Consumes: `ProxyConfig.maxBodyBytes`.
- Produces: `readLimitedBody(request: Request, maxBytes: number): Promise<{ ok: true; text: string } | { ok: false }>`.
    - Rejects at once when `content-length` > `maxBytes`, without reading.
    - Otherwise reads the stream counting bytes, and cancels the reader and returns `{ ok: false }` once it passes `maxBytes`.
- Router behavior:
    - Over the limit: `413 request_too_large` `request body exceeds MAX_BODY_BYTES (<n> bytes)`.
    - Under the limit: rebuild the request as `new Request(request.url, { method: 'POST', headers: request.headers, body: text })` and hand that to the existing handlers.
    - `count_tokens` parses `text` directly.

- [ ] **Step 1: Write failing tests**

Use `makeEnv({ MAX_BODY_BYTES: '1000' })`:

- `content-length: 5000` with a 5000-byte body: `413`, `error.type === 'request_too_large'`. The AI stub records zero calls (`fakeAI` with a function that increments a counter).
- A chunked body (a `ReadableStream` request body with no `content-length`, 3 × 400-byte chunks): `413`.
- A 900-byte chunked JSON body: passes through, `200`.
- Default config: a ~20 MB body (`'{"model":"m","messages":[{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"' + 'A'.repeat(20_000_000) + '"}}]}]}'`) gets `200` from `/v1/messages/count_tokens` (Review Focus 2).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/security/body-limit.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement and wire for `/v1/messages`, `/v1/messages/count_tokens` and external routes**

Rate-limit and auth checks still run first. Body reading comes after auth, so unauthenticated callers can't make the Worker read 32 MiB.

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/body-limit.ts src/errors.ts src/index.ts test/security/body-limit.test.ts
git commit -m "feat: enforce MAX_BODY_BYTES on POST routes"
```

---

### Task 7: Upstream timeouts and error scrubbing

**Files:**

- Create: `src/upstream.ts`, `test/security/upstream.test.ts`
- Modify: `src/index.ts`. Delete `fetchWithRetry`. `handleExternal` reads `stream` from the parsed body text (Task 6), calls `fetchUpstream`, then `scrubUpstreamError(res, [apiKey])` before `convertToClaudeResponse`.

**Interfaces:**

- Consumes: `ProxyConfig.upstreamTtfbMs`, `upstreamTotalMs`.
- Produces:

```ts
export class UpstreamTimeoutError extends Error {
    readonly timeoutMs: number
}
export function fetchUpstream(
    request: Request,
    opts: { stream: boolean; ttfbMs: number; totalMs: number; retries?: number }
): Promise<Response>
export function scrubUpstreamError(response: Response, secrets: string[]): Promise<Response>
```

`fetchUpstream`:

- Keeps the old retry policy: retry statuses `429, 500, 502, 503, 504`, default `retries = 2`, `retry-after` honored and capped at 5 s, otherwise `500 * attempt` ms.
- Each attempt gets its own `AbortController`.
- `stream: true`: the timer is `ttfbMs` and is cleared when `fetch` resolves (headers received); the body is then streamed with no limit.
- `stream: false`: the timer is `totalMs` and covers `fetch` plus `await response.arrayBuffer()`. It returns a new `Response(buffer, { status, statusText, headers })`.
- A timeout throws `UpstreamTimeoutError` and is not retried.

`scrubUpstreamError`:

- Returns `response` unchanged when `response.ok`.
- Otherwise reads the text, replaces each non-empty secret and every `/Bearer\s+[A-Za-z0-9._~+\/=-]+/g` match with `[redacted]`, and returns a new Response with the same status and headers (minus `content-length`).

Router: `UpstreamTimeoutError` maps to `504 api_error` `upstream timed out after <n> ms`.

- [ ] **Step 1: Write failing tests**

- **`times out waiting for first byte`:** a fetch stub that never resolves until its signal aborts (`new Promise((_, rej) => req.signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))))`). With `makeEnv({ UPSTREAM_TTFB_MS: '50' })` and `stream: true` on the external route: `504`, message `upstream timed out after 50 ms`.
- **`non-streaming total timeout covers the body`:** the stub resolves headers at once with a body stream that enqueues one chunk then stalls. With `UPSTREAM_TOTAL_MS: '50'` and `stream: false`: `504`.
- **`streaming body may outlast ttfb`** (Review Focus 3): the stub returns headers at once with an OpenAI-style SSE body that sends 3 chunks 40 ms apart, then `[DONE]`. With `UPSTREAM_TTFB_MS: '50'`: `200`, and `readSse` ends with `message_stop`.
- **`retries 503 then succeeds`:** the stub returns 503, then 200. Exactly 2 calls, final 200.
- **`scrubs key and bearer from provider errors`** (Review Focus 4): the stub returns `401` with body `{"error":{"message":"Incorrect API key provided: sk-provider-123. Header was Bearer sk-provider-123"}}`. Response status `401`; body text contains `Incorrect API key provided: [redacted]`; body text does not contain `sk-provider-123`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/security/upstream.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/upstream.ts` and rewire `handleExternal`**

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/upstream.ts src/index.ts test/security/upstream.test.ts
git commit -m "feat: upstream timeouts and key scrubbing in provider errors"
```

---

### Task 8: Config source of truth, smoke test, and docs

**Files:**

- Modify: `wrangler.jsonc`, `README.md`, `TESTING.md`, `scripts/self-test.sh`, `package.json`, `.gitignore`

**Interfaces:**

- Consumes: env var names and defaults from Task 2. Error messages from Tasks 3, 4, 6 and 7 are quoted verbatim in the README.

- [ ] **Step 1: `wrangler.jsonc`**

Keep `"vars": {}`, and add a JSONC comment above it listing every non-sensitive var (`ALLOWED_HOSTS`, `ALLOW_HTTP`, `ALLOW_ANONYMOUS`, `MAX_BODY_BYTES`, `UPSTREAM_TTFB_MS`, `UPSTREAM_TOTAL_MS`, `MODELS`, `VISION_MODELS`, `MULTI_TOOL_MODELS`) with its default, and stating: "this file is the source of truth; dashboard vars are deleted on deploy; secrets (`PROXY_KEY`) are not." Do not add `keep_vars`.

- [ ] **Step 2: Rewrite `scripts/self-test.sh` as the smoke test**

- Usage: `scripts/self-test.sh <base-url> <proxy-key> [model]`.
- Send `x-api-key` on internal routes.
- Assert:
    - health `200`
    - models `200`
    - `count_tokens` `200`
    - a non-streaming chat returns JSON with `"type":"message"`
    - a missing key gets `401`
    - `/openai/evil.example/v1/messages` with a valid `x-proxy-key` gets `403`
- Exit non-zero on the first failure.
- Add `"smoke": "bash scripts/self-test.sh"` to `package.json`.

- [ ] **Step 3: README**

- Replace every `wrangler vars put` with editing `wrangler.jsonc` vars, and use `wrangler secret put` for `PROXY_KEY`.
- Add "Security defaults (since Phase 1)": one row per default with its opt-out and the exact error text:
    - auth required
    - allowlist
    - https-only
    - body limit
    - timeouts
    - header allowlist
    - invalid config returns 500
- Add "Running Claude Code on open-source models" (spec §1.1 and §6 item 12):
    - WebSearch is expected not to work (server-side Anthropic tool).
    - There is no prompt caching, so long sessions resend full context.
    - Unknown models report a 24k context window and compact often; add them to `CONTEXT_TOKENS` in `src/models.ts`.
- Update "Test locally" to use `npm test` and `npm run smoke -- http://127.0.0.1:8080 <key>`.

- [ ] **Step 4: TESTING.md**

Add rows for the new 403/413/504/500-not-configured behaviors with curl commands, and note that the open-relay check (`/openai/evil.example/...`) must return 403.

- [ ] **Step 5: Verify**

Run: `npm test && npm run check && npx wrangler deploy --dry-run --outdir dist`
Expected:

- All tests pass.
- Type check and Prettier pass.
- The dry run bundles with no errors.

Then run the smoke test against `npx wrangler dev --port 8080`: start dev with `run_in_background`, then `npm run smoke -- http://127.0.0.1:8080 <a local PROXY_KEY from .dev.vars>`. Expected: all assertions pass. (`.dev.vars` is gitignored; create it with `PROXY_KEY=dev-key` if absent.)

- [ ] **Step 6: Commit**

```bash
git add wrangler.jsonc README.md TESTING.md scripts/self-test.sh package.json .gitignore
git commit -m "docs: security defaults, config source of truth, smoke test"
```

---

### Task 9: Branch review and ponytail pass

- [ ] **Step 1:** Run superpowers:requesting-code-review on the branch against the spec's Phase 1 items 1–12. Fix the findings, re-run `npm test && npm run check`, and commit.
- [ ] **Step 2:** Run ponytail-review on `$(git merge-base HEAD origin/main)..HEAD` (fetch first). Apply the cuts that keep behavior. Never cut tests, input validation or security checks. Re-run `npm test && npm run check`, commit the cuts as their own commit, and report each cut in one line.
- [ ] **Step 3:** Hand off to superpowers:finishing-a-development-branch. Remind the user that deploying is theirs, and that after deploy `npm run smoke -- <worker-url> <PROXY_KEY>` must pass, including the open-relay 403.
