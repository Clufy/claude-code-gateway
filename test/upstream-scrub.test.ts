import { describe, expect, it } from 'vitest'
import { scrubStream, scrubUpstreamError } from '../src/upstream'

const KEY = 'sk-ant-secret-key-123'
const enc = new TextEncoder()

/** A body whose chunks are exactly `parts` (as UTF-8 bytes, or raw bytes). */
function bodyOf(parts: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
    return new ReadableStream({
        start(c) {
            for (const p of parts) c.enqueue(typeof p === 'string' ? enc.encode(p) : p)
            c.close()
        }
    })
}

const read = (s: ReadableStream<Uint8Array>) => new Response(s).text()

describe('scrubStream (2xx bodies, P8 follow-up)', () => {
    it('redacts a key inside an SSE error event', async () => {
        const sse = `event: error\ndata: {"type":"error","error":{"message":"bad key ${KEY}"}}\n\n`
        const out = await read(scrubStream(bodyOf([sse]), [KEY]))
        expect(out).not.toContain(KEY)
        expect(out).toBe(sse.replace(KEY, '[redacted]'))
    })

    it('redacts a key split across chunks at every position', async () => {
        const text = `data: a ${KEY} b ${KEY}\n\n`
        for (let i = 1; i < text.length; i++) {
            const out = await read(scrubStream(bodyOf([text.slice(0, i), text.slice(i)]), [KEY]))
            expect(out).toBe(text.split(KEY).join('[redacted]'))
        }
    })

    it('redacts a key spread over many one-character chunks', async () => {
        const text = `x${KEY}y`
        const out = await read(scrubStream(bodyOf([...text]), [KEY]))
        expect(out).toBe('x[redacted]y')
    })

    it('keeps a multibyte character split across chunks', async () => {
        const bytes = enc.encode('price €5 ✓')
        const out = await read(scrubStream(bodyOf([bytes.slice(0, 7), bytes.slice(7)]), [KEY]))
        expect(out).toBe('price €5 ✓')
    })

    it('emits a chunk at once when its end cannot start a key', async () => {
        let push!: (s: string) => void
        let close!: () => void
        const src = new ReadableStream<Uint8Array>({
            start(c) {
                push = (s) => c.enqueue(enc.encode(s))
                close = () => c.close()
            }
        })
        const reader = scrubStream(src, [KEY]).getReader()
        push('data: {"delta":"hello"}\n\n')
        const first = await reader.read()
        expect(new TextDecoder().decode(first.value)).toBe('data: {"delta":"hello"}\n\n')
        close()
        expect((await reader.read()).done).toBe(true)
    })

    it('holds back a possible key prefix only until it is resolved', async () => {
        const out = await read(scrubStream(bodyOf(['abc sk-an', 't-other']), [KEY]))
        expect(out).toBe('abc sk-ant-other')
    })

    it('ignores empty secrets', async () => {
        expect(await read(scrubStream(bodyOf(['abc']), ['', KEY]))).toBe('abc')
    })
})

describe('scrubUpstreamError on a 2xx response', () => {
    it('scrubs the streamed body and drops content-length', async () => {
        const body = `data: ${KEY}\n\n`
        const res = await scrubUpstreamError(
            new Response(body, {
                status: 200,
                headers: { 'content-type': 'text/event-stream', 'content-length': String(body.length) }
            }),
            [KEY]
        )
        expect(res.status).toBe(200)
        expect(res.headers.get('content-type')).toBe('text/event-stream')
        expect(res.headers.get('content-length')).toBeNull()
        expect(await res.text()).toBe('data: [redacted]\n\n')
    })

    it('leaves a bodyless 2xx response alone', async () => {
        const res = new Response(null, { status: 204 })
        expect(await scrubUpstreamError(res, [KEY])).toBe(res)
    })
})
