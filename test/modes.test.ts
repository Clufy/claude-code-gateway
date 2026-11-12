import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { callWorker, fakeAI, makeEnv, stubFetch } from './helpers'
import { loadConfig } from '../src/config'
import { appendSystem, applyMode } from '../src/modes'

const ACME = {
    scope: {
        domains: ['*.acme-test.com'],
        cidrs: ['203.0.113.0/24'],
        llmTargets: ['https://chat.acme-test.com/api']
    },
    exclude: { domains: ['mail.acme-test.com'] },
    window: { start: '2026-11-10T00:00:00Z', end: '2026-11-21T23:59:59Z' },
    roe: 'No DoS.',
    defaultMode: 'redteam'
}
const ENGAGEMENTS = JSON.stringify({ 'acme-2026q4': ACME })
const START = Date.parse(ACME.window.start)
const END = Date.parse(ACME.window.end)
const INSIDE = Date.parse('2026-11-15T12:00:00Z')
const PACK = 'Engagement acme-2026q4'
const USER_SYSTEM = 'You are a helpful assistant.'

let logSpy: MockInstance<typeof console.log>
let stub: ReturnType<typeof stubFetch> | undefined
beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(INSIDE)
})
afterEach(() => {
    stub?.restore()
    stub = undefined
    logSpy.mockRestore()
    vi.useRealTimers()
})

function lines(event: string): any[] {
    return logSpy.mock.calls
        .map((c) => {
            try {
                return JSON.parse(String(c[0]))
            } catch {
                return null
            }
        })
        .filter((l) => l?.event === event)
}

/** Env whose AI records what reaches AI.run. */
function capture(extra: Record<string, unknown> = {}) {
    const seen: { model: string; options: any }[] = []
    const env = makeEnv({
        ENGAGEMENTS,
        AI: fakeAI((model, options) => {
            seen.push({ model, options })
            return fakeAI([{ response: 'ok' }]).run(model, options)
        }),
        ...extra
    })
    return { env, seen, systemSent: () => seen[0]?.options.messages.find((m: any) => m.role === 'system')?.content }
}

function post(env: Env, headers: Record<string, string> = {}, body: Record<string, unknown> = {}) {
    return callWorker(
        '/v1/messages',
        {
            method: 'POST',
            headers: { 'x-api-key': 'test-key', 'content-type': 'application/json', ...headers },
            body: JSON.stringify({
                model: '@cf/zai-org/glm-5.3',
                max_tokens: 10,
                system: USER_SYSTEM,
                messages: [{ role: 'user', content: 'hi' }],
                ...body
            })
        },
        env
    )
}

describe('modes on /v1/messages', () => {
    it('no headers: system reaches the AI byte-identical and the log has no engagement or mode', async () => {
        const { env, systemSent } = capture()
        const res = await post(env)
        expect(res.status).toBe(200)
        expect(systemSent()).toBe(USER_SYSTEM)
        const [line] = lines('request')
        expect(line).not.toHaveProperty('engagement')
        expect(line).not.toHaveProperty('mode')
    })

    it('engagement without a mode header uses defaultMode redteam and appends the pack', async () => {
        const { env, systemSent } = capture()
        const res = await post(env, { 'x-engagement': 'acme-2026q4' })
        expect(res.status).toBe(200)
        const system = systemSent()
        expect(system.startsWith(USER_SYSTEM + '\n\n')).toBe(true)
        expect(system).toContain(PACK + ': redteam mode')
        expect(lines('request')).toEqual([expect.objectContaining({ engagement: 'acme-2026q4', mode: 'redteam' })])
        expect(lines('detection')).toHaveLength(0)
    })

    it('x-proxy-mode off with an engagement adds no pack and logs mode off', async () => {
        const { env, systemSent } = capture()
        await post(env, { 'x-engagement': 'acme-2026q4', 'x-proxy-mode': 'off' })
        expect(systemSent()).toBe(USER_SYSTEM)
        expect(lines('request')[0]).toMatchObject({ engagement: 'acme-2026q4', mode: 'off' })
    })

    it('trims the engagement header and reads the mode case-insensitively', async () => {
        const { env, systemSent } = capture()
        const res = await post(env, { 'x-engagement': ' acme-2026q4 ', 'X-Proxy-Mode': 'RedTeam' })
        expect(res.status).toBe(200)
        expect(systemSent()).toContain(PACK + ': redteam mode')
        expect(lines('request')[0]).toMatchObject({ engagement: 'acme-2026q4', mode: 'redteam' })
    })

    it('purple header mode appends the purple pack', async () => {
        const { env, systemSent } = capture()
        await post(env, { 'x-engagement': 'acme-2026q4', 'x-proxy-mode': 'purple' })
        expect(systemSent()).toContain(PACK + ': purple mode')
        expect(lines('request')[0]).toMatchObject({ mode: 'purple' })
    })

    describe.each([
        [
            'unknown engagement (case-sensitive)',
            { 'x-engagement': 'acme-2026Q4' },
            {},
            "unknown engagement 'acme-2026Q4'"
        ],
        ['prototype key constructor', { 'x-engagement': 'constructor' }, {}, "unknown engagement 'constructor'"],
        ['prototype key __proto__', { 'x-engagement': '__proto__' }, {}, "unknown engagement '__proto__'"],
        [
            'invalid mode header',
            { 'x-engagement': 'acme-2026q4', 'x-proxy-mode': 'attack' },
            {},
            "invalid x-proxy-mode 'attack' (use redteam, purple or off)"
        ],
        [
            'redteam header without engagement',
            { 'x-proxy-mode': 'redteam' },
            {},
            'x-proxy-mode redteam needs an x-engagement header'
        ],
        [
            'redteam alias without engagement',
            {},
            { model: 'redteam/@cf/zai-org/glm-5.3' },
            'x-proxy-mode redteam needs an x-engagement header'
        ]
    ])('400: %s', (_name, headers, body, message) => {
        it('returns the error shape and logs exactly one line without calling the AI', async () => {
            const { env, seen } = capture()
            const res = await post(env, headers as Record<string, string>, body)
            expect(res.status).toBe(400)
            const json: any = await res.json()
            expect(json).toMatchObject({
                type: 'error',
                error: { type: 'invalid_request_error', message },
                request_id: res.headers.get('request-id')
            })
            expect(json.request_id).toMatch(/^req_/)
            expect(seen).toHaveLength(0)
            const reqLines = lines('request')
            expect(reqLines).toHaveLength(1)
            expect(reqLines[0]).toMatchObject({ status: 400, requestId: json.request_id })
        })
    })

    it('truncates a long unknown engagement name to 64 chars', async () => {
        const { env } = capture()
        const res = await post(env, { 'x-engagement': 'n'.repeat(200) })
        expect(res.status).toBe(400)
        const json: any = await res.json()
        expect(json.error.message).toBe(`unknown engagement '${'n'.repeat(64)}'`)
    })

    it('alias strips the prefix and routes the stripped model through MODEL_ROUTES', async () => {
        const { env, seen, systemSent } = capture({
            MODEL_ROUTES: JSON.stringify({
                'claude-sonnet-4-5': { provider: 'workers-ai', model: '@cf/zai-org/glm-5.3' }
            })
        })
        const res = await post(env, { 'x-engagement': 'acme-2026q4' }, { model: 'redteam/claude-sonnet-4-5' })
        expect(res.status).toBe(200)
        expect(seen.map((s) => s.model)).toEqual(['@cf/zai-org/glm-5.3'])
        expect(systemSent()).toContain(PACK + ': redteam mode')
        expect(lines('request')[0]).toMatchObject({
            model: 'claude-sonnet-4-5',
            route: 'claude-sonnet-4-5',
            mode: 'redteam',
            engagement: 'acme-2026q4'
        })
    })

    it('alias wins over the mode header', async () => {
        const { env, seen, systemSent } = capture()
        await post(
            env,
            { 'x-engagement': 'acme-2026q4', 'x-proxy-mode': 'off' },
            { model: 'PURPLE/@cf/zai-org/glm-5.3' }
        )
        expect(seen[0].model).toBe('@cf/zai-org/glm-5.3')
        expect(systemSent()).toContain(PACK + ': purple mode')
        expect(lines('request')[0]).toMatchObject({ mode: 'purple', model: '@cf/zai-org/glm-5.3' })
    })

    it('streaming keepalive and log use the stripped model', async () => {
        const { env, seen } = capture()
        const res = await post(
            env,
            { 'x-engagement': 'acme-2026q4' },
            { model: 'redteam/@cf/zai-org/glm-5.3', stream: true }
        )
        const text = await res.text()
        expect(seen.map((s) => s.model)).toEqual(['@cf/zai-org/glm-5.3'])
        expect(text).not.toContain('redteam/')
        expect(lines('request')[0]).toMatchObject({ model: '@cf/zai-org/glm-5.3', mode: 'redteam', streamed: true })
    })

    it('inside the window logs no detection', async () => {
        vi.setSystemTime(START)
        const { env } = capture()
        await post(env, { 'x-engagement': 'acme-2026q4' })
        vi.setSystemTime(END)
        await post(env, { 'x-engagement': 'acme-2026q4' })
        expect(lines('detection')).toHaveLength(0)
    })

    it('outside the window proceeds and logs exactly one out_of_window detection', async () => {
        vi.setSystemTime(END + 1)
        const { env, systemSent } = capture()
        const res = await post(env, { 'x-engagement': 'acme-2026q4' })
        expect(res.status).toBe(200)
        expect(systemSent()).toContain(PACK)
        const detections = lines('detection')
        expect(detections).toHaveLength(1)
        expect(detections[0]).toEqual({
            event: 'detection',
            ruleId: 'engagement.out_of_window',
            severity: 'medium',
            requestId: res.headers.get('request-id'),
            engagement: 'acme-2026q4',
            excerpt: `${new Date(END + 1).toISOString()} outside ${new Date(START).toISOString()}..${new Date(END).toISOString()}`
        })
        expect(lines('request')).toHaveLength(1)
    })
})

describe('modes on count_tokens', () => {
    function count(env: Env, headers: Record<string, string>, body: unknown) {
        return callWorker(
            '/v1/messages/count_tokens',
            {
                method: 'POST',
                headers: { 'x-api-key': 'test-key', 'content-type': 'application/json', ...headers },
                body: JSON.stringify(body)
            },
            env
        )
    }
    const BODY = { model: 'claude-sonnet-4-5', system: USER_SYSTEM, messages: [{ role: 'user', content: 'hi' }] }

    it('counts the pack when a redteam engagement is set', async () => {
        const env = makeEnv({ ENGAGEMENTS })
        const plain: any = await (await count(env, {}, BODY)).json()
        const withPack: any = await (await count(env, { 'x-engagement': 'acme-2026q4' }, BODY)).json()
        expect(withPack.input_tokens).toBeGreaterThan(plain.input_tokens)
    })

    it('rejects an unknown engagement', async () => {
        const res = await count(makeEnv({ ENGAGEMENTS }), { 'x-engagement': 'nope' }, BODY)
        expect(res.status).toBe(400)
        expect(((await res.json()) as any).error.message).toBe("unknown engagement 'nope'")
    })

    it('a non-object JSON body keeps counting without a pack', async () => {
        const env = makeEnv({ ENGAGEMENTS })
        const res = await count(env, { 'x-engagement': 'acme-2026q4' }, [1, 2])
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ input_tokens: expect.any(Number) })
    })
})

describe('modes on the path convention', () => {
    it('appends the pack upstream and logs engagement and mode', async () => {
        stub = stubFetch(() =>
            Response.json({ id: 'x', model: 'm', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] })
        )
        const res = await callWorker(
            '/openai/api.openai.com/v1/v1/messages',
            {
                method: 'POST',
                headers: {
                    'x-proxy-key': 'test-key',
                    'x-api-key': 'sk-provider',
                    'content-type': 'application/json',
                    'x-engagement': 'acme-2026q4',
                    'x-proxy-mode': 'purple'
                },
                body: JSON.stringify({
                    model: 'purple/gpt-x',
                    max_tokens: 5,
                    system: USER_SYSTEM,
                    messages: [{ role: 'user', content: 'hi' }]
                })
            },
            makeEnv({ ENGAGEMENTS })
        )
        expect(res.status).toBe(200)
        expect(stub.calls).toHaveLength(1)
        const upstream: any = await stub.calls[0].json()
        expect(upstream.model).toBe('gpt-x')
        expect(JSON.stringify(upstream)).toContain(PACK + ': purple mode')
        expect(lines('request')).toEqual([
            expect.objectContaining({ engagement: 'acme-2026q4', mode: 'purple', model: 'gpt-x', backend: 'openai' })
        ])
    })

    it('rejects an unknown engagement with one log line', async () => {
        stub = stubFetch(() => new Response('unreachable', { status: 500 }))
        const res = await callWorker(
            '/openai/api.openai.com/v1/v1/messages',
            {
                method: 'POST',
                headers: {
                    'x-proxy-key': 'test-key',
                    'x-api-key': 'sk-provider',
                    'content-type': 'application/json',
                    'x-engagement': 'constructor'
                },
                body: JSON.stringify({ model: 'gpt-x', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] })
            },
            makeEnv({ ENGAGEMENTS })
        )
        expect(res.status).toBe(400)
        expect(stub.calls).toHaveLength(0)
        expect(lines('request')).toHaveLength(1)
    })
})

describe('applyMode', () => {
    const cfg = loadConfig({ PROXY_KEY: 'k', ENGAGEMENTS })
    const h = (init: Record<string, string> = {}) => new Headers(init)

    it('no engagement and no mode leaves the body untouched', () => {
        const body = { model: 'm', system: [{ type: 'text', text: 's' }], messages: [] }
        const copy = structuredClone(body)
        expect(applyMode(h(), body, cfg, 'req_1')).toEqual({ ok: true, mode: 'off' })
        expect(body).toEqual(copy)
    })

    it('returns engagement and mode and strips a case-insensitive alias', () => {
        const body: any = { model: 'RedTeam/claude-x', messages: [] }
        expect(applyMode(h({ 'x-engagement': 'acme-2026q4' }), body, cfg, 'req_1', INSIDE)).toEqual({
            ok: true,
            engagement: 'acme-2026q4',
            mode: 'redteam'
        })
        expect(body.model).toBe('claude-x')
        expect(body.system).toContain(PACK + ': redteam mode')
    })

    it('rejects a non-text system when a pack must be appended', () => {
        const body: any = { model: 'm', system: 42, messages: [] }
        const r = applyMode(h({ 'x-engagement': 'acme-2026q4' }), body, cfg, 'req_1', INSIDE)
        expect(r.ok).toBe(false)
        expect(body.system).toBe(42)
    })

    it('logs out_of_window only outside the window (via now)', () => {
        const e = h({ 'x-engagement': 'acme-2026q4' })
        applyMode(e, { model: 'm' }, cfg, 'req_in', START)
        applyMode(e, { model: 'm' }, cfg, 'req_in', END)
        expect(lines('detection')).toHaveLength(0)
        applyMode(e, { model: 'm' }, cfg, 'req_early', START - 1)
        expect(lines('detection')).toEqual([
            expect.objectContaining({
                ruleId: 'engagement.out_of_window',
                severity: 'medium',
                requestId: 'req_early',
                engagement: 'acme-2026q4'
            })
        ])
    })

    it('logs out_of_window for mode off too, since the engagement is named', () => {
        applyMode(h({ 'x-engagement': 'acme-2026q4', 'x-proxy-mode': 'off' }), { model: 'm' }, cfg, 'req_1', END + 1)
        expect(lines('detection')).toHaveLength(1)
    })
})

describe('appendSystem', () => {
    const TEXT = 'PACK'

    it('appends to a string system with a blank line', () => {
        const body: any = { system: 'user prompt' }
        appendSystem(body, TEXT)
        expect(body.system).toBe('user prompt\n\nPACK')
    })

    it('pushes one block onto an array system and leaves earlier blocks deep-equal', () => {
        const blocks = [
            { type: 'text', text: 'one', cache_control: { type: 'ephemeral' } },
            { type: 'text', text: 'two', cache_control: { type: 'ephemeral', ttl: '1h' } }
        ]
        const copies = structuredClone(blocks)
        const body: any = { system: blocks }
        appendSystem(body, TEXT)
        expect(body.system).toHaveLength(copies.length + 1)
        expect(body.system.slice(0, copies.length)).toEqual(copies)
        expect(body.system[copies.length]).toEqual({ type: 'text', text: TEXT })
    })

    it.each([undefined, null])('a missing system (%s) becomes the text', (system) => {
        const body: any = { system }
        appendSystem(body, TEXT)
        expect(body.system).toBe(TEXT)
    })
})
