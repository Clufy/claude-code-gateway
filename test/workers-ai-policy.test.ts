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
