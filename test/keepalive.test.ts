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
            delay(80).then(() => sseResponse()),
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
            delay(80).then(() => new Response(body, { status: 503 })),
            opts
        )
        const events = await readSse(res)
        expect(events[events.length - 1]).toMatchObject({ event: 'error', data: { error: { message: 'down' } } })
    })

    it('slow rejection becomes sse error', async () => {
        const res = await withKeepalive(
            delay(80).then(() => Promise.reject(new Error('kaput'))),
            opts
        )
        const events = await readSse(res)
        expect(events[events.length - 1]).toMatchObject({ event: 'error', data: { error: { message: 'kaput' } } })
    })

    it('client cancel stops pings and cancels the backend body once pending resolves', async () => {
        const cancelled = vi.fn()
        const backend = new ReadableStream<Uint8Array>({ pull() {}, cancel: cancelled })
        const res = await withKeepalive(
            delay(80).then(() => sseResponse(backend)),
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
        await delay(100)
        await reader.cancel()
        await vi.waitFor(() => expect(cancelled).toHaveBeenCalledTimes(1))
    })
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
            await delay(80)
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
            await delay(80)
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

    it('fast failure does not set keepalive', async () => {
        const res = await post(makeEnv({ AI: fakeAI(() => new Response('{}', { status: 400 })) }), 'x-model')
        await res.text()
        expect(lines()).toHaveLength(1)
        expect(lines()[0].keepalive).toBeUndefined()
    })
})
