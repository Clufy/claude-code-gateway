import { spawn } from 'node:child_process'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const script = fileURLToPath(new URL('./scope-guard.mjs', import.meta.url))
const UNAVAILABLE = 'scope check unavailable; set PROXY_SCOPE_HOOK=off to bypass'

interface Seen {
    headers: http.IncomingHttpHeaders
    url: string | undefined
    body: unknown
}
type Reply = (req: http.IncomingMessage, res: http.ServerResponse) => void

let server: http.Server
let seen: Seen[]
let reply: Reply

beforeEach(async () => {
    seen = []
    reply = (_req, res) => {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ decision: 'allow', hosts: [], reasons: [] }))
    }
    server = http.createServer((req, res) => {
        const chunks: Buffer[] = []
        req.on('data', (c: Buffer) => chunks.push(c))
        req.on('end', () => {
            let body: unknown
            try {
                body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            } catch {
                body = null
            }
            seen.push({ headers: req.headers, url: req.url, body })
            reply(req, res)
        })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
})

afterEach(async () => {
    server.closeAllConnections()
    if (server.listening) await new Promise<void>((r) => server.close(() => r()))
})

const baseUrl = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`

const toolInput = JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'nmap a' }
})

function run(
    env: Record<string, string>,
    stdin: string = toolInput
): Promise<{ code: number | null; stdout: string; ms: number }> {
    const full: Record<string, string> = { ...env }
    if (process.env.SystemRoot) full.SystemRoot = process.env.SystemRoot
    const start = Date.now()
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [script], { env: full, stdio: ['pipe', 'pipe', 'ignore'] })
        let stdout = ''
        child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')))
        child.on('error', reject)
        child.on('close', (code) => resolve({ code, stdout, ms: Date.now() - start }))
        child.stdin.on('error', () => {})
        child.stdin.end(stdin)
    })
}

const engaged = (extra: Record<string, string> = {}) => ({
    ANTHROPIC_BASE_URL: server.listening ? baseUrl() : 'http://127.0.0.1:1',
    ANTHROPIC_CUSTOM_HEADERS: 'x-engagement: acme\nx-api-key: k',
    ...extra
})

function expectDeny(stdout: string, reason?: string) {
    const out = JSON.parse(stdout)
    expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse')
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny')
    if (reason !== undefined) expect(out.hookSpecificOutput.permissionDecisionReason).toBe(reason)
}

describe('scope-guard hook', () => {
    it('allow: silent exit 0 and relays the request', async () => {
        const r = await run(engaged())
        expect(r.code).toBe(0)
        expect(r.stdout).toBe('')
        expect(seen).toHaveLength(1)
        expect(seen[0].url).toBe('/v1/guard/check')
        expect(seen[0].headers['x-api-key']).toBe('k')
        expect(seen[0].body).toEqual({ engagement: 'acme', tool: 'Bash', input: { command: 'nmap a' } })
    })

    it('deny: emits the hookSpecificOutput deny with engagement and reasons', async () => {
        reply = (_req, res) => {
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ decision: 'deny', hosts: ['x'], reasons: ['x is out of scope', 'second'] }))
        }
        const r = await run(engaged())
        expect(r.code).toBe(0)
        expectDeny(r.stdout, 'scope-guard (acme): x is out of scope; second')
    })

    it('no engagement: silent, no network call', async () => {
        const r = await run(engaged({ ANTHROPIC_CUSTOM_HEADERS: 'x-api-key: k' }))
        expect(r.code).toBe(0)
        expect(r.stdout).toBe('')
        expect(seen).toHaveLength(0)
    })

    it('off: silent, no network call', async () => {
        const r = await run(engaged({ PROXY_SCOPE_HOOK: 'OFF' }))
        expect(r.code).toBe(0)
        expect(r.stdout).toBe('')
        expect(seen).toHaveLength(0)
    })

    it('timeout: denies as unavailable within 6 s', async () => {
        reply = () => {}
        const r = await run(engaged())
        expect(r.code).toBe(0)
        expectDeny(r.stdout, UNAVAILABLE)
        expect(r.ms).toBeLessThan(6000)
    }, 10_000)

    it('non-200: denies as unavailable', async () => {
        reply = (_req, res) => {
            res.statusCode = 500
            res.end('{"decision":"allow"}')
        }
        const r = await run(engaged())
        expectDeny(r.stdout, UNAVAILABLE)
    })

    it('200 with a malformed decision: denies as unavailable', async () => {
        reply = (_req, res) => res.end('{"decision":"maybe"}')
        const r = await run(engaged())
        expectDeny(r.stdout, UNAVAILABLE)
    })

    it('unreachable: denies as unavailable', async () => {
        await new Promise<void>((r) => server.close(() => r()))
        const r = await run(engaged())
        expect(r.code).toBe(0)
        expectDeny(r.stdout, UNAVAILABLE)
    })

    it('unset base URL: denies as unavailable', async () => {
        const r = await run({ ANTHROPIC_CUSTOM_HEADERS: 'x-engagement: acme' })
        expectDeny(r.stdout, UNAVAILABLE)
    })

    it('bad stdin: denies', async () => {
        const r = await run(engaged(), 'not json')
        expect(r.code).toBe(0)
        expectDeny(r.stdout, UNAVAILABLE)
        expect(seen).toHaveLength(0)
    })

    it('key precedence: x-proxy-key, then x-api-key, then ANTHROPIC_API_KEY, then auth token', async () => {
        await run(
            engaged({
                ANTHROPIC_CUSTOM_HEADERS: 'X-Engagement: acme\nx-api-key: k\nX-Proxy-Key: p',
                ANTHROPIC_API_KEY: 'env'
            })
        )
        await run(engaged({ ANTHROPIC_API_KEY: 'env', ANTHROPIC_AUTH_TOKEN: 'tok' }))
        await run(
            engaged({
                ANTHROPIC_CUSTOM_HEADERS: 'x-engagement: acme',
                ANTHROPIC_API_KEY: 'env',
                ANTHROPIC_AUTH_TOKEN: 'tok'
            })
        )
        await run(engaged({ ANTHROPIC_CUSTOM_HEADERS: 'x-engagement: acme', ANTHROPIC_AUTH_TOKEN: 'tok' }))
        expect(seen.map((s) => s.headers['x-api-key'])).toEqual(['p', 'k', 'env', 'tok'])
    })

    it('splits a header line on the first colon only and trims values', async () => {
        await run(engaged({ ANTHROPIC_CUSTOM_HEADERS: 'x-engagement:   acme  \nx-api-key: a:b:c' }))
        expect(seen[0].headers['x-api-key']).toBe('a:b:c')
        expect((seen[0].body as { engagement: string }).engagement).toBe('acme')
    })

    it('handles Windows line endings in ANTHROPIC_CUSTOM_HEADERS', async () => {
        const r = await run(engaged({ ANTHROPIC_CUSTOM_HEADERS: 'x-api-key: k\r\nX-Engagement: acme\r\n' }))
        expect(r.stdout).toBe('')
        expect(seen).toHaveLength(1)
        expect(seen[0].headers['x-api-key']).toBe('k')
    })

    it('ignores any path in the base URL', async () => {
        await run(engaged({ ANTHROPIC_BASE_URL: baseUrl() + '/some/prefix' }))
        expect(seen[0].url).toBe('/v1/guard/check')
    })
})
