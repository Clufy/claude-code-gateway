import { describe, expect, it, vi } from 'vitest'
import { WorkersAIProvider } from '../src/providers/workers-ai'
import type { WorkersAIOptions } from '../src/providers/workers-ai'
import { newStats } from '../src/stats'
import { fakeAI } from './helpers'

const OPEN = '<' + 'tool_call' + '>'
const CLOSE = '<' + '/tool_call' + '>'

function sseResponse(chunks: unknown[]): Response {
    const encoder = new TextEncoder()
    const body = new ReadableStream({
        start(c) {
            for (const chunk of chunks) c.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
            c.close()
        }
    })
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function send(run: (...args: any[]) => Promise<any>, opts: WorkersAIOptions, extra: Record<string, unknown> = {}) {
    const provider = new WorkersAIProvider({ AI: { run } }, opts)
    const body = JSON.stringify({
        model: 'm',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
        ...extra
    })
    return provider.handle(new Request('http://x/v1/messages', { method: 'POST', body }), 'req_test')
}

const weatherTools = [{ name: 'get_weather', description: 'd', input_schema: { type: 'object' } }]

describe('Workers AI policy', () => {
    it('retries transient error then succeeds', async () => {
        const run = vi
            .fn()
            .mockRejectedValueOnce(new Error('InferenceUpstreamError: 503'))
            .mockImplementation(async () => sseResponse([{ response: 'ok' }]))
        const res = await send(run, {})
        expect(res.status).toBe(200)
        expect(run).toHaveBeenCalledTimes(2)
    })

    it('does not retry invalid model', async () => {
        const run = vi.fn().mockRejectedValue(new Error('invalid model: x'))
        const res = await send(run, {})
        expect(res.status).toBe(502)
        expect(run).toHaveBeenCalledTimes(1)
    })

    it('stream start timeout', async () => {
        const run = vi.fn(() => new Promise<never>(() => {}))
        const res = await send(run, { ttfbMs: 50 }, { stream: true })
        expect(res.status).toBe(504)
        const body: any = await res.json()
        expect(body.error.message).toBe('upstream timed out after 50 ms')
        expect(run).toHaveBeenCalledTimes(1)
    })

    it('retries a 503 Response then streams the 200', async () => {
        const run = vi
            .fn()
            .mockResolvedValueOnce(new Response('{"errors":[{"message":"busy"}]}', { status: 503 }))
            .mockImplementation(async () => sseResponse([{ response: 'ok' }]))
        const res = await send(run, {}, { stream: true })
        expect(res.status).toBe(200)
        expect(await res.text()).toContain('"text":"ok"')
        expect(run).toHaveBeenCalledTimes(2)
    })

    it('returns 429 with the message when every attempt is a 429 Response', async () => {
        const run = vi.fn(
            async () =>
                new Response(JSON.stringify({ errors: [{ message: 'Capacity temporarily exceeded' }] }), {
                    status: 429
                })
        )
        const res = await send(run, { retries: 1 }, { stream: true })
        expect(res.status).toBe(429)
        const body: any = await res.json()
        expect(body.error).toEqual({ type: 'rate_limit_error', message: 'Capacity temporarily exceeded' })
        expect(run).toHaveBeenCalledTimes(2)
    })

    it('maps a 5xx Response to 502 after retries, message from error.message', async () => {
        const run = vi.fn(async () => Response.json({ error: { message: 'model crashed' } }, { status: 500 }))
        const res = await send(run, { retries: 1 })
        expect(res.status).toBe(502)
        expect(((await res.json()) as any).error).toEqual({ type: 'api_error', message: 'model crashed' })
        expect(run).toHaveBeenCalledTimes(2)
    })

    it('returns a 400 Response as 400 without retrying', async () => {
        const run = vi.fn(async () => new Response('not json', { status: 400 }))
        const res = await send(run, {})
        expect(res.status).toBe(400)
        expect(((await res.json()) as any).error).toEqual({ type: 'invalid_request_error', message: 'HTTP 400' })
        expect(run).toHaveBeenCalledTimes(1)
    })

    it('does not retry an unknown model', async () => {
        const run = vi.fn().mockRejectedValue(new Error('5007: No such model @cf/nope'))
        const res = await send(run, {})
        expect(res.status).toBe(502)
        expect(run).toHaveBeenCalledTimes(1)
    })

    it('counts hermes calls', async () => {
        const stats = newStats()
        const ai = fakeAI([
            { response: 'Sure! ' },
            { response: `${OPEN}{"name": "get_weather", "arguments": {"city": "Paris"}}${CLOSE}` }
        ])
        const res = await send(ai.run, { stats }, { tools: weatherTools })
        expect(res.status).toBe(200)
        expect(stats.toolCallsFromText).toBe(1)
        expect(stats.unparsedToolText).toBe(false)
    })

    it('flags unparsed tool text', async () => {
        const stats = newStats()
        const ai = fakeAI([{ response: '{"name": "get_weather", "arguments": {"city": "Paris"' }])
        const res = await send(ai.run, { stats })
        expect(res.status).toBe(200)
        expect(stats.toolCallsFromText).toBe(0)
        expect(stats.unparsedToolText).toBe(true)
    })

    it('flags unparsed tool text when streaming', async () => {
        const stats = newStats()
        const ai = fakeAI([{ response: '{"name": "get_weather", "arguments": {"city": "Paris"' }])
        const res = await send(ai.run, { stats }, { stream: true })
        await res.text()
        expect(stats.unparsedToolText).toBe(true)
    })
})
