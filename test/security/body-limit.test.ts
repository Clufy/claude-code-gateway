import { describe, expect, it } from 'vitest'
import { callWorker, fakeAI, makeEnv } from '../helpers'

const encoder = new TextEncoder()
const headers = { 'x-api-key': 'test-key', 'content-type': 'application/json' }

function chunkedBody(chunks: string[]): ReadableStream<Uint8Array> {
    return new ReadableStream({
        start(c) {
            for (const chunk of chunks) c.enqueue(encoder.encode(chunk))
            c.close()
        }
    })
}

function streamingInit(chunks: string[]): RequestInit {
    return { method: 'POST', headers, body: chunkedBody(chunks), duplex: 'half' } as RequestInit
}

describe('request body limit', () => {
    it('rejects an oversized content-length with 413 and never calls the AI', async () => {
        let calls = 0
        const env = makeEnv({
            MAX_BODY_BYTES: '1000',
            AI: fakeAI(() => {
                calls++
                return new Response('')
            })
        })
        const res = await callWorker(
            '/v1/messages',
            { method: 'POST', headers: { ...headers, 'content-length': '5000' }, body: 'x'.repeat(5000) },
            env
        )
        expect(res.status).toBe(413)
        const body: any = await res.json()
        expect(body.error.type).toBe('request_too_large')
        expect(body.error.message).toBe('request body exceeds MAX_BODY_BYTES (1000 bytes)')
        expect(calls).toBe(0)
    })

    it('rejects an oversized chunked body with 413', async () => {
        const env = makeEnv({ MAX_BODY_BYTES: '1000' })
        const chunk = 'a'.repeat(400)
        const res = await callWorker('/v1/messages', streamingInit([chunk, chunk, chunk]), env)
        expect(res.status).toBe(413)
        const body: any = await res.json()
        expect(body.error.type).toBe('request_too_large')
    })

    it('lets a chunked body under the limit through', async () => {
        const env = makeEnv({ MAX_BODY_BYTES: '1000' })
        const json = JSON.stringify({
            model: 'm',
            max_tokens: 10,
            messages: [{ role: 'user', content: 'x'.repeat(800) }]
        })
        expect(json.length).toBeLessThan(1000)
        const res = await callWorker('/v1/messages', streamingInit([json.slice(0, 450), json.slice(450)]), env)
        expect(res.status).toBe(200)
    })

    it('still returns 400 for malformed JSON on count_tokens', async () => {
        const res = await callWorker('/v1/messages/count_tokens', { method: 'POST', headers, body: '{nope' })
        expect(res.status).toBe(400)
        const body: any = await res.json()
        expect(body.error.message).toBe('invalid JSON body')
    })

    // The 20 MB body is built, uploaded, decoded and parsed in the Workers runtime; allow more than the default 5 s.
    it('accepts a ~20 MB body under the default limit', { timeout: 30_000 }, async () => {
        const big =
            '{"model":"m","messages":[{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"' +
            'A'.repeat(20_000_000) +
            '"}}]}]}'
        const res = await callWorker('/v1/messages/count_tokens', { method: 'POST', headers, body: big })
        expect(res.status).toBe(200)
    })
})
