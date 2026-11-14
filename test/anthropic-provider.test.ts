import { afterEach, describe, expect, it, vi } from 'vitest'
import { callWorker, fakeAI, makeEnv, stubFetch } from './helpers'
import { stripUnsignedThinking } from '../src/providers/anthropic'

const ANTHROPIC_ROUTE = {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    baseUrl: 'https://api.anthropic.com/v1',
    keySecret: 'ANTHROPIC_KEY'
}
const ROUTES = JSON.stringify({ 'claude-*': ANTHROPIC_ROUTE })
const ENGAGEMENTS = JSON.stringify({
    'acme-test': {
        scope: { domains: ['*.acme-test.com'] },
        window: { start: '2020-01-01T00:00:00Z', end: '2099-12-31T23:59:59Z' }
    }
})
const KEY = 'sk-ant-test'
const PROXY_KEY = 'test-key'

const okMessage = () =>
    Response.json({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 }
    })

function env(extra: Record<string, unknown> = {}): Env {
    return makeEnv({ MODEL_ROUTES: ROUTES, ANTHROPIC_KEY: KEY, ENGAGEMENTS, ...extra })
}

function post(body: Record<string, unknown>, headers: Record<string, string> = {}, e: Env = env()) {
    return callWorker(
        '/v1/messages',
        {
            method: 'POST',
            headers: {
                'x-api-key': PROXY_KEY,
                'content-type': 'application/json',
                'x-engagement': 'acme-test',
                cookie: 'session=secret-cookie',
                ...headers
            },
            body: JSON.stringify(body)
        },
        e
    )
}

const baseBody = () => ({
    model: 'claude-opus-4-1',
    max_tokens: 10,
    system: 'be brief',
    metadata: { user_id: 'u1' },
    messages: [{ role: 'user', content: 'hi' }]
})

const headerNames = (req: Request) => [...req.headers.keys()].sort()

let stub: ReturnType<typeof stubFetch> | undefined
afterEach(() => {
    stub?.restore()
    stub = undefined
})

describe('anthropic provider via MODEL_ROUTES', () => {
    it('sends the exact URL, fresh headers with the server key, and the client body with the target model', async () => {
        stub = stubFetch(() => okMessage())
        const body = baseBody()
        const res = await post(body)
        expect(res.status).toBe(200)
        expect(stub.calls).toHaveLength(1)
        const req = stub.calls[0]
        expect(req.url).toBe('https://api.anthropic.com/v1/messages')
        expect(headerNames(req)).toEqual(['anthropic-version', 'content-type', 'x-api-key'])
        expect(req.headers.get('x-api-key')).toBe(KEY)
        expect(req.headers.get('x-api-key')).not.toBe(PROXY_KEY)
        expect(req.headers.get('anthropic-version')).toBe('2023-06-01')
        expect(req.headers.get('content-type')).toBe('application/json')
        expect(JSON.stringify([...req.headers])).not.toContain(PROXY_KEY)
        expect(JSON.stringify([...req.headers])).not.toContain('secret-cookie')
        expect(await req.clone().json()).toEqual({ ...body, model: 'claude-sonnet-4-5' })
    })

    it('forwards anthropic-beta only when the client sent it, and nothing else extra', async () => {
        stub = stubFetch(() => okMessage())
        const res = await post(baseBody(), {
            'anthropic-beta': 'interleaved-thinking-2025-05-14',
            authorization: `Bearer ${PROXY_KEY}`,
            'x-proxy-mode': 'off',
            'user-agent': 'claude-cli/1.0'
        })
        expect(res.status).toBe(200)
        const req = stub.calls[0]
        expect(headerNames(req)).toEqual(['anthropic-beta', 'anthropic-version', 'content-type', 'x-api-key'])
        expect(req.headers.get('anthropic-beta')).toBe('interleaved-thinking-2025-05-14')
        expect(req.headers.get('x-api-key')).toBe(KEY)
    })

    it('removes a Bearer prefix from the route key', async () => {
        stub = stubFetch(() => okMessage())
        const res = await post(baseBody(), {}, env({ ANTHROPIC_KEY: `Bearer ${KEY}` }))
        expect(res.status).toBe(200)
        expect(stub.calls[0].headers.get('x-api-key')).toBe(KEY)
    })

    it('strips unsigned thinking from assistant turns before sending', async () => {
        stub = stubFetch(() => okMessage())
        const body = {
            ...baseBody(),
            messages: [
                { role: 'user', content: 'hi' },
                {
                    role: 'assistant',
                    content: [
                        { type: 'thinking', thinking: 't' },
                        { type: 'thinking', thinking: 'signed', signature: 's' },
                        { type: 'redacted_thinking', data: 'x' },
                        { type: 'text', text: 'a' }
                    ]
                },
                { role: 'user', content: 'again' }
            ]
        }
        await post(body)
        const sent = (await stub.calls[0].clone().json()) as any
        expect(sent.messages[1].content).toEqual([
            { type: 'thinking', thinking: 'signed', signature: 's' },
            { type: 'redacted_thinking', data: 'x' },
            { type: 'text', text: 'a' }
        ])
        expect(sent.messages[0]).toEqual({ role: 'user', content: 'hi' })
    })

    it('passes a streamed SSE body through byte for byte', async () => {
        const sseText =
            'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-5","usage":{"input_tokens":1,"output_tokens":0}}}\n\n' +
            'event: message_stop\ndata: {"type":"message_stop"}\n\n'
        stub = stubFetch(() => new Response(sseText, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
        const res = await post({ ...baseBody(), stream: true })
        expect(res.status).toBe(200)
        expect(res.headers.get('content-type')).toContain('text/event-stream')
        expect(await res.text()).toBe(sseText)
    })

    it('allowlists response headers to content-type and retry-after, and keeps the proxy request-id', async () => {
        stub = stubFetch(
            () =>
                new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow' } }), {
                    status: 400,
                    headers: {
                        'content-type': 'application/json',
                        'request-id': 'up-1',
                        'anthropic-organization-id': 'org',
                        'anthropic-ratelimit-requests-remaining': '5',
                        'set-cookie': 'a=b',
                        'retry-after': '3'
                    }
                })
        )
        const res = await post(baseBody())
        expect(res.status).toBe(400)
        expect(res.headers.get('retry-after')).toBe('3')
        expect(res.headers.get('content-type')).toContain('application/json')
        expect(res.headers.get('request-id')).toBeTruthy()
        expect(res.headers.get('request-id')).not.toBe('up-1')
        expect(res.headers.get('anthropic-organization-id')).toBeNull()
        expect(res.headers.get('anthropic-ratelimit-requests-remaining')).toBeNull()
        expect(res.headers.get('set-cookie')).toBeNull()
    })

    it('passes retry-after through on an upstream 429 (P8-R1)', async () => {
        stub = stubFetch(
            () =>
                new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow' } }), {
                    status: 429,
                    headers: { 'content-type': 'application/json', 'retry-after': '0.01', 'request-id': 'up-429' }
                })
        )
        const res = await post(baseBody())
        expect(res.status).toBe(429)
        expect(res.headers.get('retry-after')).toBe('0.01')
        expect(res.headers.get('request-id')).not.toBe('up-429')
        expect(((await res.json()) as any).error.type).toBe('rate_limit_error')
    })

    it('drops upstream credentials headers on a successful response too', async () => {
        stub = stubFetch(() => {
            const r = okMessage()
            r.headers.set('request-id', 'up-2')
            r.headers.set('anthropic-organization-id', 'org')
            r.headers.set('set-cookie', 'a=b')
            return r
        })
        const res = await post(baseBody())
        expect(res.status).toBe(200)
        expect(res.headers.get('request-id')).not.toBe('up-2')
        expect(res.headers.get('anthropic-organization-id')).toBeNull()
        expect(res.headers.get('set-cookie')).toBeNull()
        expect(((await res.json()) as any).content[0].text).toBe('ok')
    })

    it('scrubs the key from an upstream 401 body', async () => {
        stub = stubFetch((req) =>
            Response.json(
                {
                    type: 'error',
                    error: {
                        type: 'authentication_error',
                        message: `invalid x-api-key ${req.headers.get('x-api-key')}`
                    }
                },
                { status: 401 }
            )
        )
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
        try {
            const res = await post(baseBody())
            const text = await res.text()
            expect(res.status).toBe(401)
            expect(text).toContain('[redacted]')
            expect(text).not.toContain(KEY)
            expect(JSON.stringify(logSpy.mock.calls)).not.toContain(KEY)
        } finally {
            logSpy.mockRestore()
        }
    })
})

describe('anthropic provider via the path convention', () => {
    it('sends the client key upstream and never forwards x-proxy-key', async () => {
        stub = stubFetch(() => okMessage())
        const body = baseBody()
        const res = await callWorker(
            '/anthropic/api.anthropic.com/v1/v1/messages',
            {
                method: 'POST',
                headers: {
                    'x-proxy-key': PROXY_KEY,
                    'x-api-key': 'sk-client',
                    'content-type': 'application/json',
                    cookie: 'session=secret-cookie'
                },
                body: JSON.stringify(body)
            },
            makeEnv()
        )
        expect(res.status).toBe(200)
        const req = stub.calls[0]
        expect(req.url).toBe('https://api.anthropic.com/v1/messages')
        expect(headerNames(req)).toEqual(['anthropic-version', 'content-type', 'x-api-key'])
        expect(req.headers.get('x-api-key')).toBe('sk-client')
        expect(req.headers.get('x-proxy-key')).toBeNull()
        expect(JSON.stringify([...req.headers])).not.toContain(PROXY_KEY)
        expect(await req.clone().json()).toEqual(body)
    })
})

describe('fallback onto an anthropic route', () => {
    it('applies the thinking strip so the upstream sees no unsigned thinking', async () => {
        stub = stubFetch(() => okMessage())
        const ai = fakeAI(() => Response.json({ errors: [{ message: 'down' }] }, { status: 503 }))
        const routes = JSON.stringify({
            'claude-a': { provider: 'workers-ai', model: '@cf/busy', fallback: ['claude-direct'] },
            'claude-direct': ANTHROPIC_ROUTE
        })
        const body = {
            ...baseBody(),
            model: 'claude-a',
            messages: [
                { role: 'user', content: 'hi' },
                {
                    role: 'assistant',
                    content: [
                        { type: 'thinking', thinking: 'from workers ai' },
                        { type: 'text', text: 'a' }
                    ]
                },
                { role: 'user', content: 'again' }
            ]
        }
        const res = await post(body, {}, env({ MODEL_ROUTES: routes, AI: ai }))
        expect(res.status).toBe(200)
        expect(stub.calls).toHaveLength(1)
        const sent = (await stub.calls[0].clone().json()) as any
        expect(sent.model).toBe('claude-sonnet-4-5')
        expect(sent.messages[1].content).toEqual([{ type: 'text', text: 'a' }])
        expect(JSON.stringify(sent)).not.toContain('thinking')
    })
})

describe('stripUnsignedThinking', () => {
    it('drops an unsigned thinking block from an assistant turn', () => {
        const messages = [
            {
                role: 'assistant',
                content: [
                    { type: 'thinking', thinking: 't' },
                    { type: 'text', text: 'a' }
                ]
            }
        ]
        expect(stripUnsignedThinking(messages)).toEqual([{ role: 'assistant', content: [{ type: 'text', text: 'a' }] }])
    })

    it('keeps a signed thinking block', () => {
        const block = { type: 'thinking', thinking: 't', signature: 's' }
        expect(stripUnsignedThinking([{ role: 'assistant', content: [block] }])).toEqual([
            { role: 'assistant', content: [block] }
        ])
    })

    it('keeps redacted_thinking, which never carries a signature (P8-D2a)', () => {
        const messages = [
            {
                role: 'assistant',
                content: [
                    { type: 'redacted_thinking', data: 'x' },
                    { type: 'redacted_thinking', data: 'y', signature: 42 },
                    { type: 'text', text: 'a' }
                ]
            }
        ]
        expect(stripUnsignedThinking(messages)).toEqual(messages)
    })

    it('drops a thinking block with an empty or non-string signature', () => {
        const messages = [
            {
                role: 'assistant',
                content: [
                    { type: 'thinking', thinking: 't', signature: '' },
                    { type: 'thinking', thinking: 'u', signature: 42 },
                    { type: 'text', text: 'a' }
                ]
            }
        ]
        expect(stripUnsignedThinking(messages)).toEqual([{ role: 'assistant', content: [{ type: 'text', text: 'a' }] }])
    })

    it('drops an assistant turn that the strip empties (I2)', () => {
        const messages = [
            { role: 'user', content: 'a' },
            { role: 'assistant', content: [{ type: 'thinking', thinking: 't' }] },
            { role: 'user', content: 'b' }
        ]
        expect(stripUnsignedThinking(messages)).toEqual([
            { role: 'user', content: 'a' },
            { role: 'user', content: 'b' }
        ])
    })

    it('keeps an assistant turn whose content was already empty', () => {
        const messages = [{ role: 'assistant', content: [] }]
        expect(stripUnsignedThinking(messages)).toEqual(messages)
    })

    it('leaves a user message with a thinking-like block untouched', () => {
        const messages = [{ role: 'user', content: [{ type: 'thinking', thinking: 't' }] }]
        expect(stripUnsignedThinking(messages)).toEqual(messages)
    })

    it('leaves string content untouched', () => {
        const messages = [{ role: 'assistant', content: 'plain' }]
        expect(stripUnsignedThinking(messages)).toEqual(messages)
    })

    it('returns non-array input as is and does not mutate its input', () => {
        expect(stripUnsignedThinking('x')).toBe('x')
        expect(stripUnsignedThinking(undefined)).toBe(undefined)
        const messages = [{ role: 'assistant', content: [{ type: 'thinking', thinking: 't' }] }]
        const copy = structuredClone(messages)
        const out = stripUnsignedThinking(messages)
        expect(messages).toEqual(copy)
        expect(out).not.toBe(messages)
    })
})
