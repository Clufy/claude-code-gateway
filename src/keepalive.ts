export const KEEPALIVE_GRACE_MS = 5000
export const KEEPALIVE_INTERVAL_MS = 10000

/** Timing used by the worker; tests shrink it instead of adding config. */
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
            const fail = (message: string) => {
                send(sse('error', { type: 'error', error: { type: 'api_error', message } }))
                finish()
            }
            const run = async () => {
                let response: Response
                try {
                    response = await pending
                } catch (error) {
                    stop()
                    fail(error instanceof Error ? error.message : String(error))
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
                    let message = `HTTP ${response.status}`
                    try {
                        message = (await response.json<any>())?.error?.message ?? message
                    } catch {
                        // keep the status fallback
                    }
                    fail(message)
                    return
                }
                reader = response.body!.getReader()
                const decoder = new TextDecoder()
                let buffer = ''
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
                        buffer += decoder.decode(r.value, { stream: true }).replace(/\r\n/g, '\n')
                        let at: number
                        while (!stripped && (at = buffer.indexOf('\n\n')) !== -1) {
                            const block = buffer.slice(0, at + 2)
                            buffer = buffer.slice(at + 2)
                            if (/^event:\s*message_start\s*$/m.test(block)) stripped = true
                            else send(encoder.encode(block))
                        }
                        if (stripped && buffer) {
                            send(encoder.encode(buffer))
                            buffer = ''
                        }
                    }
                    if (buffer) send(encoder.encode(buffer))
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
