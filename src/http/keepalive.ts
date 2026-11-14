export const KEEPALIVE_GRACE_MS = 5000
export const KEEPALIVE_INTERVAL_MS = 10000

/** Timing used by the worker. Only tests may write to it (to shrink the delays); production code must not. */
export const keepaliveTiming = { graceMs: KEEPALIVE_GRACE_MS, intervalMs: KEEPALIVE_INTERVAL_MS }

export interface KeepaliveOptions {
    requestedModel: string
    inputTokens: number
    graceMs: number
    intervalMs: number
}

const encoder = new TextEncoder()
const sse = (event: string, data: unknown) => encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
const PING = sse('ping', { type: 'ping' })

/**
 * Wait for `pending`; if it takes longer than graceMs, commit to a 200 SSE stream
 * that sends message_start + pings until the backend answers, then relays it.
 */
export function withKeepalive(pending: Promise<Response>, opts: KeepaliveOptions): Promise<Response> {
    return new Promise<Response>((resolve, reject) => {
        let committed = false
        const timer = setTimeout(() => {
            committed = true
            resolve(commit(pending, opts))
        }, opts.graceMs)
        pending.then(
            (response) => {
                if (committed) return
                clearTimeout(timer)
                resolve(response)
            },
            (error) => {
                if (committed) return
                clearTimeout(timer)
                reject(error)
            }
        )
    })
}

function commit(pending: Promise<Response>, opts: KeepaliveOptions): Response {
    let cancelled = false
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let interval: ReturnType<typeof setInterval> | undefined
    const stop = () => {
        if (interval !== undefined) clearInterval(interval)
        interval = undefined
    }

    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            const send = (chunk: Uint8Array) => {
                if (!cancelled) controller.enqueue(chunk)
            }
            send(
                sse('message_start', {
                    type: 'message_start',
                    message: {
                        id: `msg_${crypto.randomUUID()}`,
                        type: 'message',
                        role: 'assistant',
                        model: opts.requestedModel,
                        content: [],
                        stop_reason: null,
                        stop_sequence: null,
                        usage: { input_tokens: opts.inputTokens, output_tokens: 0 }
                    }
                })
            )
            send(PING)
            interval = setInterval(() => send(PING), opts.intervalMs)

            const finish = () => {
                stop()
                if (!cancelled) controller.close()
            }
            const fail = (type: string, message: string) => {
                send(sse('error', { type: 'error', error: { type, message } }))
                finish()
            }
            const run = async () => {
                let response: Response
                try {
                    response = await pending
                } catch (error) {
                    stop()
                    console.error(error)
                    fail('api_error', error instanceof Error ? error.message : String(error))
                    return
                }
                stop()
                if (cancelled) {
                    await response.body?.cancel().catch(() => {})
                    return
                }
                const isSse =
                    response.ok && response.body && response.headers.get('content-type')?.includes('text/event-stream')
                if (!isSse) {
                    let message = response.ok ? 'backend returned a non-stream response' : `HTTP ${response.status}`
                    let type = 'api_error'
                    if (!response.ok) {
                        try {
                            const error = (await response.json<any>())?.error
                            if (typeof error?.message === 'string') message = error.message
                            if (typeof error?.type === 'string') type = error.type
                        } catch {
                            // keep the fallbacks
                        }
                    }
                    fail(type, message)
                    return
                }
                reader = response.body!.getReader()
                let buffer: Uint8Array = new Uint8Array(0)
                let stripped = false
                try {
                    for (;;) {
                        const r = await reader.read()
                        if (cancelled) return
                        if (r.done) break
                        if (stripped) {
                            send(r.value)
                            continue
                        }
                        buffer = concat(buffer, r.value)
                        for (;;) {
                            const end = findBlockEnd(buffer)
                            if (end === -1) break
                            const block = buffer.subarray(0, end)
                            const rest = buffer.subarray(end)
                            if (/^event:\s*message_start\s*$/m.test(new TextDecoder().decode(block))) {
                                stripped = true
                                if (rest.length) send(rest)
                                buffer = new Uint8Array(0)
                                break
                            }
                            send(block)
                            buffer = rest
                        }
                    }
                    if (buffer.length) send(buffer)
                    finish()
                } catch (error) {
                    stop()
                    if (!cancelled) controller.error(error)
                }
            }
            void run()
        },
        cancel(reason) {
            cancelled = true
            stop()
            // If pending settles later, run() cancels the backend body itself.
            return reader?.cancel(reason)
        }
    })
    return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' }
    })
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
    if (a.length === 0) return b
    const out = new Uint8Array(a.length + b.length)
    out.set(a)
    out.set(b, a.length)
    return out
}

/**
 * Byte offset just past the first complete SSE event (ending in a blank line), or -1.
 * Handles LF, CRLF and lone-CR line endings; a trailing CR is held back until the next byte is known.
 */
function findBlockEnd(buf: Uint8Array): number {
    let lineStart = 0
    for (let i = 0; i < buf.length; i++) {
        const c = buf[i]
        if (c !== 0x0a && c !== 0x0d) continue
        let eol = 1
        if (c === 0x0d) {
            if (i + 1 >= buf.length) return -1
            if (buf[i + 1] === 0x0a) eol = 2
        }
        if (i === lineStart) return i + eol
        i += eol - 1
        lineStart = i + 1
    }
    return -1
}
