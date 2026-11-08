import { afterEach, describe, expect, it } from 'vitest'
import { upstreamHeaders } from '../../src/upstream-headers'
import { callWorker, fakeAI, makeEnv, readSse, stubFetch } from '../helpers'

let fetchStub: ReturnType<typeof stubFetch> | undefined
afterEach(() => {
    fetchStub?.restore()
    fetchStub = undefined
})

const claudeBody = JSON.stringify({ model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] })

describe('upstreamHeaders', () => {
    it('drops everything not allowlisted', () => {
        const h = upstreamHeaders(
            new Headers({
                'cf-connecting-ip': '1.2.3.4',
                'x-forwarded-for': '1.2.3.4',
                cookie: 'a=b',
                'x-proxy-key': 'p',
                'x-api-key': 'k',
                authorization: 'Bearer k',
                'x-engagement': 'acme',
                'anthropic-beta': 'b1',
                accept: 'text/event-stream',
                'user-agent': 'claude-cli/2'
            })
        )
        expect([...h.keys()].sort()).toEqual(['accept', 'anthropic-beta', 'user-agent'])
    })
})

describe('external requests', () => {
    const noisy = {
        'x-proxy-key': 'test-key',
        'x-forwarded-for': '9.9.9.9',
        'cf-connecting-ip': '9.9.9.9',
        cookie: 'a=b',
        'x-engagement': 'acme',
        'content-type': 'application/json'
    }

    it('openai carries only allowlisted headers plus provider auth', async () => {
        fetchStub = stubFetch(() => Response.json({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }))
        await callWorker('/openai/api.openai.com/v1/messages', {
            method: 'POST',
            headers: { ...noisy, authorization: 'Bearer sk-provider' },
            body: JSON.stringify({ model: 'gpt', messages: [{ role: 'user', content: 'hi' }] })
        })
        const sent = fetchStub.calls[0].headers
        expect(sent.get('authorization')).toBe('Bearer sk-provider')
        for (const h of ['x-forwarded-for', 'x-proxy-key', 'cf-connecting-ip', 'cookie', 'x-engagement'])
            expect(sent.get(h)).toBeNull()
    })

    it('gemini carries only allowlisted headers plus x-goog-api-key', async () => {
        fetchStub = stubFetch(() =>
            Response.json({
                candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }]
            })
        )
        await callWorker('/gemini/generativelanguage.googleapis.com/v1beta/v1/messages', {
            method: 'POST',
            headers: { ...noisy, 'x-api-key': 'gk' },
            body: claudeBody
        })
        const sent = fetchStub.calls[0].headers
        expect(sent.get('x-goog-api-key')).toBe('gk')
        expect(sent.get('authorization')).toBeNull()
        for (const h of ['x-forwarded-for', 'x-proxy-key', 'x-api-key', 'cf-connecting-ip', 'cookie', 'x-engagement'])
            expect(sent.get(h)).toBeNull()
    })

    it('openai-responses carries only allowlisted headers plus provider auth', async () => {
        fetchStub = stubFetch(() =>
            Response.json({
                status: 'completed',
                output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }]
            })
        )
        await callWorker('/openai-responses/api.openai.com/v1/messages', {
            method: 'POST',
            headers: { ...noisy, authorization: 'Bearer sk-provider' },
            body: claudeBody
        })
        const sent = fetchStub.calls[0].headers
        expect(sent.get('authorization')).toBe('Bearer sk-provider')
        for (const h of ['x-forwarded-for', 'x-proxy-key', 'cf-connecting-ip', 'cookie', 'x-engagement'])
            expect(sent.get(h)).toBeNull()
    })
})

describe('internal route', () => {
    it('claude code shaped request still streams', async () => {
        const res = await callWorker(
            '/v1/messages',
            {
                method: 'POST',
                headers: {
                    'x-api-key': 'test-key',
                    'anthropic-version': '2023-06-01',
                    'anthropic-beta': 'interleaved-thinking-2025-05-14',
                    accept: 'text/event-stream',
                    'content-type': 'application/json'
                },
                body: JSON.stringify({
                    model: '@cf/x',
                    stream: true,
                    max_tokens: 50,
                    messages: [{ role: 'user', content: 'hi' }]
                })
            },
            makeEnv({ AI: fakeAI([{ response: 'he' }, { response: 'llo' }]) })
        )
        expect(res.status).toBe(200)
        expect(res.headers.get('content-type')).toContain('text/event-stream')
        const events = await readSse(res)
        expect(events[0].event).toBe('message_start')
        expect(events[events.length - 1].event).toBe('message_stop')
        const text = events
            .filter((e) => e.event === 'content_block_delta' && e.data.delta.type === 'text_delta')
            .map((e) => e.data.delta.text)
            .join('')
        expect(text).toBe('hello')
    })
})
