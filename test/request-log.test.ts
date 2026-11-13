import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { callWorker, fakeAI, makeEnv, readSse, stubFetch } from './helpers'
import { tapSse } from '../src/sse-tap'
import { finalizeMessagesResponse } from '../src/request-log'
import { newStats } from '../src/stats'

const ROUTES = JSON.stringify({
    'claude-*': {
        provider: 'openai',
        baseUrl: 'https://api.openai.com',
        model: 'gpt-5.1',
        keySecret: 'OPENAI_API_KEY',
        fallback: ['@cf/zai-org/glm-5.3']
    }
})

let logSpy: MockInstance<typeof console.log>
let stub: ReturnType<typeof stubFetch> | undefined
beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
    stub?.restore()
    stub = undefined
    logSpy.mockRestore()
})

function requestLines(): any[] {
    return logSpy.mock.calls
        .map((c) => {
            try {
                return JSON.parse(String(c[0]))
            } catch {
                return null
            }
        })
        .filter((l) => l?.event === 'request')
}

const USAGE_CHUNKS = [{ response: 'hi' }, { usage: { prompt_tokens: 12, completion_tokens: 5 } }]

function post(env: Env, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}, model = 'x-model') {
    return callWorker(
        '/v1/messages',
        {
            method: 'POST',
            headers: { 'x-api-key': 'test-key', 'content-type': 'application/json', ...headers },
            body: JSON.stringify({ model, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }], ...extra })
        },
        env
    )
}

describe('request log', () => {
    it('streaming request logs usage after stream ends', async () => {
        const res = await post(makeEnv({ AI: fakeAI(USAGE_CHUNKS) }), { stream: true })
        expect(requestLines()).toHaveLength(0)
        await res.text()
        const lines = requestLines()
        expect(lines).toHaveLength(1)
        expect(lines[0]).toMatchObject({
            streamed: true,
            backend: 'workers-ai:x-model',
            outputTokens: 5,
            inputTokens: 12,
            status: 200,
            model: 'x-model',
            method: 'POST',
            path: '/v1/messages'
        })
        expect(typeof lines[0].ttfbMs).toBe('number')
        expect(lines[0].route).toBeUndefined()
        expect(lines[0].fallbackUsed).toBe(false)
        expect(lines[0].streamError).toBeUndefined()
        expect(lines[0].cancelled).toBeUndefined()
    })

    it('non-streaming success logs exactly one line with usage', async () => {
        const res = await post(makeEnv({ AI: fakeAI(USAGE_CHUNKS) }))
        expect(res.status).toBe(200)
        await res.text()
        const lines = requestLines()
        expect(lines).toHaveLength(1)
        expect(lines[0]).toMatchObject({ status: 200, outputTokens: 5, backend: 'workers-ai:x-model' })
        expect(lines[0].streamed).toBeFalsy()
    })

    it('error response logs exactly one line', async () => {
        const res = await post(makeEnv(), {}, { 'x-api-key': 'wrong' })
        expect(res.status).toBe(401)
        await res.text()
        const lines = requestLines()
        expect(lines).toHaveLength(1)
        expect(lines[0]).toMatchObject({ status: 401, path: '/v1/messages' })
    })

    it('fallback recorded', async () => {
        stub = stubFetch(() => new Response('down', { status: 503 }))
        const env = makeEnv({
            MODEL_ROUTES: ROUTES,
            OPENAI_API_KEY: 'sk-server',
            AI: fakeAI(USAGE_CHUNKS)
        })
        const res = await post(env, { stream: true }, {}, 'claude-opus-4-1')
        await res.text()
        const lines = requestLines()
        expect(lines).toHaveLength(1)
        expect(lines[0]).toMatchObject({
            fallbackUsed: true,
            route: 'claude-*',
            backend: 'workers-ai:@cf/zai-org/glm-5.3'
        })
    })

    it('path-convention route logs one line with backend label', async () => {
        stub = stubFetch(() =>
            Response.json({ id: 'x', model: 'm', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] })
        )
        const res = await callWorker('/openai/api.openai.com/v1/messages', {
            method: 'POST',
            headers: { 'x-proxy-key': 'test-key', 'x-api-key': 'sk-provider', 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'gpt-x', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] })
        })
        expect(res.status).toBe(200)
        const lines = requestLines()
        expect(lines).toHaveLength(1)
        expect(lines[0]).toMatchObject({ backend: 'openai', fallbackUsed: false, status: 200, model: 'gpt-x' })
        expect(lines[0].route).toBeUndefined()
    })

    it('thrown exception hits the catch and logs one 500 line', async () => {
        const env = makeEnv()
        Object.defineProperty(env, 'MODEL_ROUTES', {
            get() {
                throw new Error('boom')
            }
        })
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        const res = await post(env)
        errSpy.mockRestore()
        expect(res.status).toBe(500)
        expect((await res.json<any>()).error.message).toBe('boom')
        expect(requestLines()).toHaveLength(1)
        expect(requestLines()[0].status).toBe(500)
    })

    it('config error from loadConfig logs one line', async () => {
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        const res = await post(makeEnv({ MODEL_ROUTES: '{not json' }))
        errSpy.mockRestore()
        expect(res.status).toBe(500)
        expect(requestLines()).toHaveLength(1)
        expect(requestLines()[0]).toMatchObject({ status: 500, path: '/v1/messages' })
    })

    it('planTargets config error logs one line', async () => {
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        const res = await post(makeEnv({ MODEL_ROUTES: ROUTES }), {}, {}, 'claude-opus-4-1')
        errSpy.mockRestore()
        expect(res.status).toBe(500)
        expect(requestLines()).toHaveLength(1)
        expect(requestLines()[0].status).toBe(500)
    })

    it('rate limited request logs one line', async () => {
        const res = await post(makeEnv({ RATE_LIMITER: { limit: async () => ({ success: false }) } }))
        expect(res.status).toBe(429)
        expect(requestLines()).toHaveLength(1)
        expect(requestLines()[0].status).toBe(429)
    })

    it('413 over body limit logs one line', async () => {
        const res = await post(makeEnv({ MAX_BODY_BYTES: '10' }))
        expect(res.status).toBe(413)
        expect(requestLines()).toHaveLength(1)
        expect(requestLines()[0].status).toBe(413)
    })

    it('client cancel logs one line after the cancel', async () => {
        const enc = new TextEncoder()
        let sent = false
        const ai = fakeAI(
            () =>
                new Response(
                    new ReadableStream({
                        pull(c) {
                            if (sent) return new Promise(() => {})
                            sent = true
                            c.enqueue(enc.encode(`data: ${JSON.stringify({ response: 'hi' })}\n\n`))
                        }
                    }),
                    { status: 200, headers: { 'content-type': 'text/event-stream' } }
                )
        )
        const res = await post(makeEnv({ AI: ai }), { stream: true })
        const reader = res.body!.getReader()
        await reader.read()
        expect(requestLines()).toHaveLength(0)
        await reader.cancel()
        expect(requestLines()).toHaveLength(1)
        expect(requestLines()[0]).toMatchObject({ streamed: true, status: 200, cancelled: true })
        expect(requestLines()[0].streamError).toBeUndefined()
    })

    it('idle-timeout error event is recorded as streamError', async () => {
        const enc = new TextEncoder()
        const ai = fakeAI(
            () =>
                new Response(
                    new ReadableStream({
                        start(c) {
                            c.enqueue(
                                enc.encode(`data: ${JSON.stringify({ response: 'hi' })}

`)
                            )
                        }
                    }),
                    { status: 200, headers: { 'content-type': 'text/event-stream' } }
                )
        )
        const res = await post(makeEnv({ AI: ai, UPSTREAM_TTFB_MS: '50' }), { stream: true })
        const events = await readSse(res)
        expect(events[events.length - 1].event).toBe('error')
        expect(requestLines()).toHaveLength(1)
        expect(requestLines()[0]).toMatchObject({ streamed: true, status: 200, streamError: 'api_error' })
        expect(requestLines()[0].cancelled).toBeUndefined()
    })

    it('upstream source error mid-stream logs one line', async () => {
        const enc = new TextEncoder()
        let sent = false
        const ai = fakeAI(
            () =>
                new Response(
                    new ReadableStream({
                        pull(c) {
                            if (!sent) {
                                sent = true
                                c.enqueue(enc.encode(`data: ${JSON.stringify({ response: 'hi' })}\n\n`))
                                return
                            }
                            c.error(new Error('source died'))
                        }
                    }),
                    { status: 200, headers: { 'content-type': 'text/event-stream' } }
                )
        )
        const res = await post(makeEnv({ AI: ai }), { stream: true })
        await res.text().catch(() => {})
        expect(requestLines()).toHaveLength(1)
        expect(requestLines()[0]).toMatchObject({ streamed: true, status: 200, streamError: 'error' })
    })

    it('SSE 200 with a null body still logs one line', async () => {
        const res = new Response(null, { status: 200, headers: { 'content-type': 'text/event-stream' } })
        const out = await finalizeMessagesResponse(res, {
            request: new Request('https://proxy.test/v1/messages', { method: 'POST' }),
            requestId: 'r',
            start: Date.now(),
            backend: 'b',
            fallbackUsed: false,
            ttfbMs: 1,
            stats: newStats()
        })
        expect(out.status).toBe(200)
        expect(requestLines()).toHaveLength(1)
    })
})

describe('x-proxy-debug', () => {
    it('debug comment only when asked', async () => {
        const run = async (headers: Record<string, string>) => {
            const res = await post(makeEnv({ AI: fakeAI(USAGE_CHUNKS) }), { stream: true }, headers)
            const text = await res.clone().text()
            return { text, events: await readSse(res) }
        }
        const on = await run({ 'x-proxy-debug': '1' })
        const off = await run({})
        expect(on.text).toContain(': proxy-stats {')
        expect(off.text).not.toContain('proxy-stats')
        const strip = (evs: any[]) => JSON.parse(JSON.stringify(evs).replace(/msg_[0-9a-f-]+/g, 'msg_ID'))
        expect(strip(on.events)).toEqual(strip(off.events))
        const json = JSON.parse(on.text.split(': proxy-stats ')[1].trim())
        expect(Object.keys(json).sort()).toEqual(
            ['backend', 'fallbackUsed', 'model', 'toolCallsFromText', 'ttfbMs', 'unparsedToolText'].sort()
        )
        expect(json).toMatchObject({ backend: 'workers-ai:x-model', model: 'x-model', fallbackUsed: false })
    })

    it('non-streaming sets x-proxy-stats header only when asked', async () => {
        const on = await post(makeEnv({ AI: fakeAI(USAGE_CHUNKS) }), {}, { 'x-proxy-debug': '1' })
        expect(JSON.parse(on.headers.get('x-proxy-stats')!)).toMatchObject({ model: 'x-model', fallbackUsed: false })
        const off = await post(makeEnv({ AI: fakeAI(USAGE_CHUNKS) }))
        expect(off.headers.get('x-proxy-stats')).toBeNull()
    })

    it('still requires auth', async () => {
        const res = await post(makeEnv(), {}, { 'x-api-key': 'wrong', 'x-proxy-debug': '1' })
        expect(res.status).toBe(401)
        expect(res.headers.get('x-proxy-stats')).toBeNull()
    })
})

describe('tapSse', () => {
    const enc = new TextEncoder()
    const body = 'event: a\ndata: {"n":1}\n\n' + 'event: b\ndata: {"n":2}\n\n' + 'event: c\ndata: {"n":3}\n\n'
    const make = (chunks: string[]) =>
        new Response(
            new ReadableStream({
                start(c) {
                    for (const ch of chunks) c.enqueue(enc.encode(ch))
                    c.close()
                }
            }),
            { headers: { 'content-type': 'text/event-stream' } }
        )

    it('tap does not alter bytes', async () => {
        const events: string[] = []
        const out = tapSse(make([body]), { onEvent: (e) => events.push(e), onEnd() {} })
        expect(await out.text()).toBe(body)
        expect(events).toEqual(['a', 'b', 'c'])
        expect(out.headers.get('content-type')).toBe('text/event-stream')
    })

    it('parses events split across chunks and appends onEnd string', async () => {
        const seen: any[] = []
        const out = tapSse(make([body.slice(0, 13), body.slice(13, 40), body.slice(40)]), {
            onEvent: (e, d) => seen.push([e, d.n]),
            onEnd: () => ': done\n\n'
        })
        expect(await out.text()).toBe(body + ': done\n\n')
        expect(seen).toEqual([
            ['a', 1],
            ['b', 2],
            ['c', 3]
        ])
    })

    it('calls onEnd once with partial data when the client cancels', async () => {
        let ends = 0
        const seen: string[] = []
        let sent = false
        const open = new Response(
            new ReadableStream({
                pull(c) {
                    if (sent) return new Promise(() => {})
                    sent = true
                    c.enqueue(enc.encode('event: a\ndata: {"n":1}\n\nevent: b\ndata: {"n"'))
                }
            })
        )
        const out = tapSse(open, {
            onEvent: (e) => seen.push(e),
            onEnd() {
                ends++
            }
        })
        const reader = out.body!.getReader()
        await reader.read()
        await reader.cancel()
        expect(ends).toBe(1)
        expect(seen).toEqual(['a'])
    })

    it('throwing hooks never break the stream', async () => {
        const out = tapSse(make([body]), {
            onEvent() {
                throw new Error('hook')
            },
            onEnd() {
                throw new Error('end')
            }
        })
        expect(await out.text()).toBe(body)
    })
})

describe('tools on the request line (D13)', () => {
    const sse = (events: [string, unknown][]) =>
        events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('')
    const start = (index: number, name: string) =>
        [
            'content_block_start',
            {
                type: 'content_block_start',
                index,
                content_block: { type: 'tool_use', id: `t${index}`, name, input: {} }
            }
        ] as [string, unknown]
    const stop = (index: number) => ['content_block_stop', { type: 'content_block_stop', index }] as [string, unknown]

    async function streamTools(
        events: [string, unknown][],
        extra: Partial<Parameters<typeof finalizeMessagesResponse>[1]> = {}
    ) {
        const res = await finalizeMessagesResponse(
            new Response(sse(events), { headers: { 'content-type': 'text/event-stream' } }),
            {
                request: new Request('https://proxy.test/v1/messages', { method: 'POST' }),
                requestId: 'r',
                start: Date.now(),
                backend: 'b',
                fallbackUsed: false,
                stats: newStats(),
                ...extra
            }
        )
        await res.text()
        const l = requestLines()
        expect(l).toHaveLength(1)
        return l[0]
    }

    it('streamed: unique names in first-seen order', async () => {
        const line = await streamTools([
            start(0, 'Bash'),
            stop(0),
            start(1, 'Read'),
            stop(1),
            start(2, 'Bash'),
            stop(2)
        ])
        expect(line.tools).toEqual(['Bash', 'Read'])
    })

    it('streamed: 20 distinct names keep 16', async () => {
        const evs = Array.from({ length: 20 }, (_, i) => [start(i, `T${i}`), stop(i)]).flat()
        const line = await streamTools(evs)
        expect(line.tools).toEqual(Array.from({ length: 16 }, (_, i) => `T${i}`))
    })

    it('cuts a 100-char name to 64', async () => {
        const line = await streamTools([start(0, 'x'.repeat(100)), stop(0)])
        expect(line.tools).toEqual(['x'.repeat(64)])
    })

    it('collects with no guard and past 16 open blocks', async () => {
        const evs = Array.from({ length: 17 }, (_, i) => start(i, `T${i}`))
        const line = await streamTools(evs)
        expect(line.tools).toHaveLength(16)
        expect(line.tools[0]).toBe('T0')
    })

    it('collects when the guard is disabled via GUARD_RULES', async () => {
        const env = makeEnv({
            GUARD_RULES: '{"disable":["cmd.risky","inject.instruction","engagement.out_of_window"]}',
            AI: fakeAI([
                {
                    choices: [
                        {
                            index: 0,
                            delta: {
                                tool_calls: [
                                    { index: 0, id: 'c1', function: { name: 'Bash', arguments: '{"command":"ls"}' } }
                                ]
                            }
                        }
                    ]
                },
                { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }
            ])
        })
        const res = await post(env, { stream: true })
        await res.text()
        expect(requestLines()[0].tools).toEqual(['Bash'])
    })

    it('non-streamed response with tool_use blocks gets tools', async () => {
        const env = makeEnv({
            AI: fakeAI([
                {
                    choices: [
                        {
                            index: 0,
                            delta: {
                                tool_calls: [
                                    { index: 0, id: 'c1', function: { name: 'Bash', arguments: '{"command":"ls"}' } }
                                ]
                            }
                        }
                    ]
                },
                { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }
            ])
        })
        const res = await post(env)
        await res.text()
        expect(requestLines()[0].tools).toEqual(['Bash'])
    })

    it('non-streamed body: dedupe, caps and name cut', async () => {
        const content = [
            ...Array.from({ length: 20 }, (_, i) => ({ type: 'tool_use', id: `a${i}`, name: `T${i}`, input: {} })),
            { type: 'tool_use', id: 'z', name: 'T0', input: {} }
        ]
        content[1].name = 'y'.repeat(100)
        const res = await finalizeMessagesResponse(
            new Response(JSON.stringify({ content }), { headers: { 'content-type': 'application/json' } }),
            {
                request: new Request('https://proxy.test/v1/messages', { method: 'POST' }),
                requestId: 'r',
                start: Date.now(),
                backend: 'b',
                fallbackUsed: false,
                stats: newStats()
            }
        )
        await res.text()
        const tools = requestLines()[0].tools
        expect(tools).toHaveLength(16)
        expect(tools[1]).toBe('y'.repeat(64))
    })

    it('text-only response has no tools key', async () => {
        const res = await post(makeEnv({ AI: fakeAI(USAGE_CHUNKS) }))
        await res.text()
        expect('tools' in requestLines()[0]).toBe(false)
        const s = await post(makeEnv({ AI: fakeAI(USAGE_CHUNKS) }), { stream: true })
        await s.text()
        expect('tools' in requestLines()[1]).toBe(false)
    })

    it('x-proxy-debug streamed still logs tools', async () => {
        const res = await post(
            makeEnv({
                AI: fakeAI([
                    {
                        choices: [
                            {
                                index: 0,
                                delta: {
                                    tool_calls: [{ index: 0, id: 'c1', function: { name: 'Read', arguments: '{}' } }]
                                }
                            }
                        ]
                    },
                    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }
                ])
            }),
            { stream: true },
            { 'x-proxy-debug': '1' }
        )
        await res.text()
        expect(requestLines()[0].tools).toEqual(['Read'])
    })
})
