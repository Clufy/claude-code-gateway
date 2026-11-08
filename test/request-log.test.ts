import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { callWorker, fakeAI, makeEnv, readSse, stubFetch } from './helpers'
import { tapSse } from '../src/sse-tap'

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

    it('thrown exception logs one 500 line', async () => {
        const ai = {
            run: async () => {
                throw new Error('boom')
            }
        }
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        const res = await post(makeEnv({ AI: ai }))
        errSpy.mockRestore()
        expect(res.status).toBeGreaterThanOrEqual(500)
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
})
