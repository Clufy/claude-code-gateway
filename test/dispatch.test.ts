import { afterEach, describe, expect, it } from 'vitest'
import { callWorker, fakeAI, makeEnv, readSse, stubFetch } from './helpers'

const ROUTES = JSON.stringify({
    'claude-*': {
        provider: 'openai',
        baseUrl: 'https://api.openai.com',
        model: 'gpt-5.1',
        keySecret: 'OPENAI_API_KEY',
        fallback: ['@cf/zai-org/glm-5.3']
    }
})

const encoder = new TextEncoder()
const chunk = (text: string) =>
    encoder.encode(
        `data: ${JSON.stringify({ id: 'c', model: 'm', choices: [{ index: 0, delta: { content: text } }] })}\n\n`
    )
const sseResponse = (body: ReadableStream<Uint8Array>) =>
    new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })

function aiSpy() {
    const models: string[] = []
    const ai = fakeAI((model) => {
        models.push(model)
        return new Response(
            new ReadableStream({
                start(c) {
                    c.enqueue(encoder.encode(`data: ${JSON.stringify({ response: 'hi' })}\n\n`))
                    c.close()
                }
            }),
            { status: 200, headers: { 'content-type': 'text/event-stream' } }
        )
    })
    return { models, ai }
}

function post(env: Env, model = 'claude-opus-4-1', extra: Record<string, unknown> = {}) {
    return callWorker(
        '/v1/messages',
        {
            method: 'POST',
            headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
            body: JSON.stringify({ model, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }], ...extra })
        },
        env
    )
}

let stub: ReturnType<typeof stubFetch> | undefined
afterEach(() => stub?.restore())

describe('dispatch', () => {
    it('routes claude model to openai with server key', async () => {
        stub = stubFetch(() =>
            Response.json({
                id: 'x',
                model: 'gpt-5.1',
                choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }]
            })
        )
        const { ai } = aiSpy()
        const res = await post(makeEnv({ MODEL_ROUTES: ROUTES, OPENAI_API_KEY: 'sk-server', AI: ai }))
        expect(res.status).toBe(200)
        expect(stub.calls).toHaveLength(1)
        expect(stub.calls[0].url).toBe('https://api.openai.com/chat/completions')
        expect(((await stub.calls[0].clone().json()) as any).model).toBe('gpt-5.1')
        expect(stub.calls[0].headers.get('authorization')).toBe('Bearer sk-server')
        expect(JSON.stringify([...stub.calls[0].headers])).not.toContain('test-key')
    })

    it('falls back to workers ai on 503', async () => {
        stub = stubFetch(() => new Response('down', { status: 503 }))
        const { ai, models } = aiSpy()
        const res = await post(makeEnv({ MODEL_ROUTES: ROUTES, OPENAI_API_KEY: 'sk-server', AI: ai }))
        expect(res.status).toBe(200)
        expect(models).toEqual(['@cf/zai-org/glm-5.3'])
    })

    it('no fallback on 400', async () => {
        stub = stubFetch(() => new Response('bad', { status: 400 }))
        const { ai, models } = aiSpy()
        const res = await post(makeEnv({ MODEL_ROUTES: ROUTES, OPENAI_API_KEY: 'sk-server', AI: ai }))
        expect(res.status).toBe(400)
        expect(models).toHaveLength(0)
    })

    it('no fallback after streaming started', async () => {
        stub = stubFetch(() => {
            let sent = false
            return sseResponse(
                new ReadableStream({
                    async pull(c) {
                        if (!sent) {
                            sent = true
                            c.enqueue(chunk('a'))
                            return
                        }
                        await new Promise((r) => setTimeout(r, 10))
                        c.error(new Error('boom'))
                    }
                })
            )
        })
        const { ai, models } = aiSpy()
        const res = await post(makeEnv({ MODEL_ROUTES: ROUTES, OPENAI_API_KEY: 'sk-server', AI: ai }), 'claude-x', {
            stream: true
        })
        expect(res.status).toBe(200)
        const events = await readSse(res)
        expect(events.filter((e) => e.event === 'error')).toHaveLength(1)
        expect(models).toHaveLength(0)
    })

    it('unrouted model passes through to workers ai', async () => {
        stub = stubFetch(() => new Response('no', { status: 500 }))
        const { ai, models } = aiSpy()
        const res = await post(makeEnv({ AI: ai }), '@cf/meta/llama-3.1-8b-instruct-fast')
        expect(res.status).toBe(200)
        expect(models).toEqual(['@cf/meta/llama-3.1-8b-instruct-fast'])
        expect(stub.calls).toHaveLength(0)
    })

    it('missing route secret', async () => {
        stub = stubFetch(() => new Response('no', { status: 500 }))
        const { ai, models } = aiSpy()
        const res = await post(makeEnv({ MODEL_ROUTES: ROUTES, AI: ai }))
        expect(res.status).toBe(500)
        expect(((await res.json()) as any).error.message).toBe('invalid config: OPENAI_API_KEY')
        expect(stub.calls).toHaveLength(0)
        expect(models).toHaveLength(0)
    })

    it('invalid JSON body is a 400', async () => {
        const res = await callWorker(
            '/v1/messages',
            { method: 'POST', headers: { 'x-api-key': 'test-key' }, body: '{nope' },
            makeEnv()
        )
        expect(res.status).toBe(400)
    })

    it('missing model keeps the workers ai 400', async () => {
        const res = await callWorker(
            '/v1/messages',
            { method: 'POST', headers: { 'x-api-key': 'test-key' }, body: JSON.stringify({ messages: [] }) },
            makeEnv({ MODEL_ROUTES: JSON.stringify({ '*': { provider: 'workers-ai', model: 'x' } }) })
        )
        expect(res.status).toBe(400)
        expect(((await res.json()) as any).error.message).toContain("'model'")
    })

    it('stalled stream ends with idle error', async () => {
        stub = stubFetch(() =>
            sseResponse(
                new ReadableStream({
                    start(c) {
                        c.enqueue(chunk('a'))
                    }
                })
            )
        )
        const res = await post(
            makeEnv({ MODEL_ROUTES: ROUTES, OPENAI_API_KEY: 'sk-server', UPSTREAM_TTFB_MS: '50' }),
            'claude-x',
            { stream: true }
        )
        const events = await readSse(res)
        const last = events[events.length - 1]
        expect(last.event).toBe('error')
        expect(last.data.error.message).toBe('upstream stream idle for 50 ms')
    })

    it('slow but steady stream is not idle', async () => {
        stub = stubFetch(() => {
            let n = 0
            return sseResponse(
                new ReadableStream({
                    async pull(c) {
                        await new Promise((r) => setTimeout(r, 30))
                        if (n++ < 6) c.enqueue(chunk('a'))
                        else {
                            c.enqueue(encoder.encode('data: [DONE]\n\n'))
                            c.close()
                        }
                    }
                })
            )
        })
        const res = await post(
            makeEnv({ MODEL_ROUTES: ROUTES, OPENAI_API_KEY: 'sk-server', UPSTREAM_TTFB_MS: '50' }),
            'claude-x',
            { stream: true }
        )
        const events = await readSse(res)
        expect(events[events.length - 1].event).toBe('message_stop')
    })
})
