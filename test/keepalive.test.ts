import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { keepaliveTiming, withKeepalive } from '../src/keepalive'
import { callWorker, fakeAI, makeEnv, readSse, stubFetch } from './helpers'

const opts = { requestedModel: 'm-req', inputTokens: 7, graceMs: 20, intervalMs: 30 }
const enc = new TextEncoder()
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

function sseBody(events: [string, unknown][]): ReadableStream<Uint8Array> {
    return new ReadableStream({
        start(c) {
            for (const [e, d] of events) c.enqueue(enc.encode(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`))
            c.close()
        }
    })
}
const backendEvents: [string, unknown][] = [
    [
        'message_start',
        {
            type: 'message_start',
            message: { id: 'msg_backend', model: 'backend', usage: { input_tokens: 1, output_tokens: 0 } }
        }
    ],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }],
    ['message_stop', { type: 'message_stop' }]
]
const sseResponse = (body = sseBody(backendEvents)) =>
    new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })

describe('withKeepalive', () => {
    it('fast success passes through', async () => {
        const res = sseResponse()
        expect(await withKeepalive(Promise.resolve(res), opts)).toBe(res)
    })

    it('fast failure keeps real status', async () => {
        const res = await withKeepalive(Promise.resolve(new Response('{}', { status: 429 })), opts)
        expect(res.status).toBe(429)
    })

    it('fast rejection rethrows', async () => {
        await expect(withKeepalive(Promise.reject(new Error('boom')), opts)).rejects.toThrow('boom')
    })

    it('slow success streams pings then backend', async () => {
        const res = await withKeepalive(
            delay(120).then(() => sseResponse()),
            opts
        )
        expect(res.status).toBe(200)
        const events = await readSse(res)
        const names = events.map((e) => e.event)
        expect(names.slice(0, 2)).toEqual(['message_start', 'ping'])
        const firstBlock = names.findIndex((n) => n.startsWith('content_block'))
        expect(names.slice(0, firstBlock).filter((n) => n === 'ping').length).toBeGreaterThanOrEqual(2)
        expect(names.filter((n) => n === 'message_start')).toHaveLength(1)
        expect(names[names.length - 1]).toBe('message_stop')
        expect(events[0].data.message.model).toBe('m-req')
        expect(events[0].data.message.usage.input_tokens).toBe(7)
    })

    it('slow failure becomes sse error', async () => {
        const body = '{"type":"error","error":{"type":"api_error","message":"down"}}'
        const res = await withKeepalive(
            delay(120).then(() => new Response(body, { status: 503 })),
            opts
        )
        const events = await readSse(res)
        expect(events[events.length - 1]).toMatchObject({ event: 'error', data: { error: { message: 'down' } } })
    })

    it('slow rejection becomes sse error', async () => {
        const res = await withKeepalive(
            delay(120).then(() => Promise.reject(new Error('kaput'))),
            opts
        )
        const events = await readSse(res)
        expect(events[events.length - 1]).toMatchObject({ event: 'error', data: { error: { message: 'kaput' } } })
    })

    it('slow failure keeps the backend error type; non-sse 200 gets a clear message', async () => {
        const body = '{"type":"error","error":{"type":"overloaded_error","message":"busy"}}'
        const res = await withKeepalive(
            delay(120).then(() => new Response(body, { status: 529 })),
            opts
        )
        const events = await readSse(res)
        expect(events[events.length - 1].data.error).toEqual({ type: 'overloaded_error', message: 'busy' })
        const res2 = await withKeepalive(
            delay(120).then(() => new Response('{}', { status: 200 })),
            opts
        )
        const events2 = await readSse(res2)
        expect(events2[events2.length - 1].data.error.message).toBe('backend returned a non-stream response')
    })

    it('clears the interval when the client cancels before pending settles', async () => {
        const clear = vi.spyOn(globalThis, 'clearInterval')
        try {
            const res = await withKeepalive(
                delay(300).then(() => sseResponse()),
                opts
            )
            const reader = res.body!.getReader()
            await reader.read()
            const before = clear.mock.calls.length
            await reader.cancel()
            expect(clear.mock.calls.length).toBeGreaterThan(before)
        } finally {
            clear.mockRestore()
        }
    })

    it('client cancel stops pings and cancels the backend body once pending resolves', async () => {
        const cancelled = vi.fn()
        const backend = new ReadableStream<Uint8Array>({ pull() {}, cancel: cancelled })
        const res = await withKeepalive(
            delay(120).then(() => sseResponse(backend)),
            opts
        )
        const reader = res.body!.getReader()
        await reader.read()
        await reader.cancel()
        expect(cancelled).not.toHaveBeenCalled()
        await vi.waitFor(() => expect(cancelled).toHaveBeenCalledTimes(1))
    })

    it('client cancel mid-stream cancels the backend body', async () => {
        const cancelled = vi.fn()
        const backend = new ReadableStream<Uint8Array>({
            start(c) {
                c.enqueue(enc.encode('event: message_start\ndata: {}\n\n'))
            },
            pull() {},
            cancel: cancelled
        })
        const res = await withKeepalive(
            delay(40).then(() => sseResponse(backend)),
            opts
        )
        const reader = res.body!.getReader()
        await delay(160)
        await reader.cancel()
        await vi.waitFor(() => expect(cancelled).toHaveBeenCalledTimes(1))
    })
})

describe('message_start stripping is byte exact', () => {
    const MS = 'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_backend"}}\n\n'
    async function run(chunks: (string | Uint8Array)[]): Promise<Uint8Array> {
        const body = new ReadableStream<Uint8Array>({
            start(c) {
                for (const chunk of chunks) c.enqueue(typeof chunk === 'string' ? enc.encode(chunk) : chunk)
                c.close()
            }
        })
        const res = await withKeepalive(
            delay(120).then(() => sseResponse(body)),
            opts
        )
        return new Uint8Array(await res.arrayBuffer())
    }
    const endsWith = (out: Uint8Array, tail: Uint8Array) =>
        out.length >= tail.length && out.slice(out.length - tail.length).every((b, i) => b === tail[i])
    const has = (out: Uint8Array, text: string) => new TextDecoder().decode(out).includes(text)

    it('message_start split mid-line across chunks', async () => {
        const tail = 'event: content_block_start\ndata: {"i":1}\n\n'
        const out = await run(['event: mess', 'age_start\ndata: {"id":"msg_backend"}\n\n' + tail])
        expect(endsWith(out, enc.encode(tail))).toBe(true)
        expect(has(out, 'msg_backend')).toBe(false)
    })

    it('CRLF blank line split as \\r | \\n', async () => {
        const tail = 'event: content_block_start\r\ndata: {"i":1}\r\n\r\n'
        const out = await run(['event: message_start\r\ndata: {"id":"msg_backend"}\r\n\r', '\n', tail])
        expect(endsWith(out, enc.encode(tail))).toBe(true)
        expect(has(out, 'msg_backend')).toBe(false)
    })

    it('forwards a leading ping before message_start', async () => {
        const ping = 'event: ping\ndata: {"type":"ping"}\n\n'
        const tail = 'event: content_block_start\ndata: {"i":1}\n\n'
        const out = await run([ping + MS + tail])
        expect(endsWith(out, enc.encode(ping + tail))).toBe(true)
        expect(has(out, 'msg_backend')).toBe(false)
    })

    it('message_start and the next event in the same chunk', async () => {
        const tail = 'event: content_block_delta\ndata: {"t":"x"}\n\nevent: message_stop\ndata: {}\n\n'
        const out = await run([MS + tail])
        expect(endsWith(out, enc.encode(tail))).toBe(true)
        expect(has(out, 'msg_backend')).toBe(false)
    })

    for (const ch of ['你', '\u{1F600}']) {
        it(`multibyte ${ch} split across chunks is preserved`, async () => {
            const tail = enc.encode(`event: content_block_delta\ndata: {"t":"${ch}${ch}"}\n\n`)
            const split = tail.indexOf(enc.encode(ch)[0]) + 1 // mid-character
            const first = new Uint8Array([...enc.encode(MS), ...tail.slice(0, split)])
            const out = await run([first, tail.slice(split)])
            expect(endsWith(out, tail)).toBe(true)
            expect(has(out, 'msg_backend')).toBe(false)
        })
    }
})

describe('worker keepalive log', () => {
    let logSpy: MockInstance<typeof console.log>
    let stub: ReturnType<typeof stubFetch> | undefined
    const saved = { ...keepaliveTiming }
    beforeEach(() => {
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
        keepaliveTiming.graceMs = 20
        keepaliveTiming.intervalMs = 30
    })
    afterEach(() => {
        Object.assign(keepaliveTiming, saved)
        stub?.restore()
        stub = undefined
        logSpy.mockRestore()
    })
    const lines = () =>
        logSpy.mock.calls
            .map((c) => {
                try {
                    return JSON.parse(String(c[0]))
                } catch {
                    return null
                }
            })
            .filter((l) => l?.event === 'request')
    const post = (env: Env, model: string) =>
        callWorker(
            '/v1/messages',
            {
                method: 'POST',
                headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
                body: JSON.stringify({
                    model,
                    stream: true,
                    max_tokens: 10,
                    messages: [{ role: 'user', content: 'hi' }]
                })
            },
            env
        )

    it('committed success logs one line with real status and keepalive', async () => {
        const ai = fakeAI(async () => {
            await delay(120)
            return new Response(
                new ReadableStream({
                    start(c) {
                        c.enqueue(enc.encode(`data: ${JSON.stringify({ response: 'hi' })}\n\n`))
                        c.close()
                    }
                }),
                { status: 200, headers: { 'content-type': 'text/event-stream' } }
            )
        })
        const res = await post(makeEnv({ AI: ai }), 'x-model')
        expect(res.status).toBe(200)
        const names = (await readSse(res)).map((e) => e.event)
        expect(names.filter((n) => n === 'ping').length).toBeGreaterThanOrEqual(2)
        expect(names[names.length - 1]).toBe('message_stop')
        expect(lines()).toHaveLength(1)
        expect(lines()[0]).toMatchObject({ status: 200, keepalive: true, streamed: true })
        expect(lines()[0].backend).toContain('workers-ai')
    })

    it('committed non-ok logs one line with the backend status', async () => {
        const routes = JSON.stringify({
            'claude-*': {
                provider: 'openai',
                baseUrl: 'https://api.openai.com',
                model: 'gpt-5.1',
                keySecret: 'OPENAI_API_KEY'
            }
        })
        stub = stubFetch(async () => {
            await delay(120)
            return new Response('{"error":{"message":"bad request"}}', {
                status: 400,
                headers: { 'content-type': 'application/json' }
            })
        })
        const res = await post(makeEnv({ MODEL_ROUTES: routes, OPENAI_API_KEY: 'sk-x' }), 'claude-opus-4-1')
        expect(res.status).toBe(200)
        const events = await readSse(res)
        expect(events[events.length - 1]?.event).toBe('error')
        expect(lines()).toHaveLength(1)
        expect(lines()[0]).toMatchObject({ status: 400, keepalive: true })
        expect(lines()[0].backend).toContain('openai')
    })

    it('committed rejection logs one 500 line with the first target and no ttfb', async () => {
        const routes = JSON.stringify({
            'claude-*': {
                provider: 'openai',
                baseUrl: 'https://api.openai.com',
                model: 'gpt-5.1',
                keySecret: 'OPENAI_API_KEY'
            }
        })
        stub = stubFetch(async () => {
            await delay(120)
            throw new TypeError('network down')
        })
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        try {
            const res = await post(makeEnv({ MODEL_ROUTES: routes, OPENAI_API_KEY: 'sk-x' }), 'claude-opus-4-1')
            expect(res.status).toBe(200)
            const events = await readSse(res)
            expect(events[events.length - 1]).toMatchObject({
                event: 'error',
                data: { error: { message: 'network down' } }
            })
            expect(errSpy).toHaveBeenCalled()
        } finally {
            errSpy.mockRestore()
        }
        expect(lines()).toHaveLength(1)
        expect(lines()[0]).toMatchObject({ status: 500, keepalive: true })
        expect(lines()[0].backend).toContain('openai')
        expect(lines()[0].ttfbMs).toBeUndefined()
    })

    it('slow non-stream request gets no keepalive', async () => {
        const ai = fakeAI(async () => {
            await delay(120)
            return Response.json({ response: 'hi' })
        })
        const res = await callWorker(
            '/v1/messages',
            {
                method: 'POST',
                headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
                body: JSON.stringify({ model: 'x-model', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] })
            },
            makeEnv({ AI: ai })
        )
        expect(res.headers.get('content-type')).toContain('application/json')
        const json: any = await res.json()
        expect(json.type).toBe('message')
        expect(lines()).toHaveLength(1)
        expect(lines()[0].keepalive).toBeUndefined()
    })

    it('fast failure does not set keepalive', async () => {
        const res = await post(makeEnv({ AI: fakeAI(() => new Response('{}', { status: 400 })) }), 'x-model')
        await res.text()
        expect(lines()).toHaveLength(1)
        expect(lines()[0].keepalive).toBeUndefined()
    })
})
