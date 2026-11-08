import { afterEach, describe, expect, it } from 'vitest'
import { callWorker, makeEnv, readSse, stubFetch } from '../helpers'

let fetchStub: ReturnType<typeof stubFetch> | undefined
afterEach(() => {
    fetchStub?.restore()
    fetchStub = undefined
})

const encoder = new TextEncoder()
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function post(stream: boolean, env: Env) {
    return callWorker(
        '/openai/api.openai.com/v1/messages',
        {
            method: 'POST',
            headers: { 'x-proxy-key': 'test-key', authorization: 'Bearer sk-provider-123' },
            body: JSON.stringify({ model: 'gpt', stream, messages: [{ role: 'user', content: 'hi' }] })
        },
        env
    )
}

describe('upstream timeouts', () => {
    it('times out waiting for first byte', async () => {
        fetchStub = stubFetch(
            (req) =>
                new Promise((_, rej) =>
                    req.signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))
                )
        )
        const res = await post(true, makeEnv({ UPSTREAM_TTFB_MS: '50' }))
        expect(res.status).toBe(504)
        const body: any = await res.json()
        expect(body.error.message).toBe('upstream timed out after 50 ms')
    })

    it('non-streaming total timeout covers the body', async () => {
        fetchStub = stubFetch(
            () =>
                new Response(
                    new ReadableStream({
                        start(c) {
                            c.enqueue(encoder.encode('{"choices":'))
                        }
                    }),
                    { status: 200 }
                )
        )
        const res = await post(false, makeEnv({ UPSTREAM_TOTAL_MS: '50' }))
        expect(res.status).toBe(504)
    })

    it('streaming body may outlast ttfb', async () => {
        fetchStub = stubFetch(
            () =>
                new Response(
                    new ReadableStream({
                        async start(c) {
                            for (let i = 0; i < 3; i++) {
                                c.enqueue(
                                    encoder.encode(
                                        `data: ${JSON.stringify({ choices: [{ delta: { content: `x${i}` } }] })}\n\n`
                                    )
                                )
                                await sleep(40)
                            }
                            c.enqueue(encoder.encode('data: [DONE]\n\n'))
                            c.close()
                        }
                    }),
                    { status: 200, headers: { 'content-type': 'text/event-stream' } }
                )
        )
        const res = await post(true, makeEnv({ UPSTREAM_TTFB_MS: '50' }))
        expect(res.status).toBe(200)
        const events = await readSse(res)
        expect(events[events.length - 1].event).toBe('message_stop')
    })
})

describe('upstream retries and scrubbing', () => {
    it('retries 503 then succeeds', async () => {
        let n = 0
        fetchStub = stubFetch(() =>
            ++n === 1
                ? new Response('busy', { status: 503 })
                : Response.json({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] })
        )
        const res = await post(false, makeEnv())
        expect(fetchStub.calls).toHaveLength(2)
        expect(res.status).toBe(200)
    })

    it('scrubs key and bearer from provider errors', async () => {
        fetchStub = stubFetch(
            () =>
                new Response(
                    '{"error":{"message":"Incorrect API key provided: sk-provider-123. Header was Bearer sk-provider-123"}}',
                    { status: 401 }
                )
        )
        const res = await post(false, makeEnv())
        expect(res.status).toBe(401)
        const text = await res.text()
        expect(text).toContain('Incorrect API key provided: [redacted]')
        expect(text).not.toContain('sk-provider-123')
    })
})
