export class UpstreamTimeoutError extends Error {
    constructor(timeoutMs: number) {
        super(`upstream timed out after ${timeoutMs} ms`)
        this.name = 'UpstreamTimeoutError'
    }
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])

export async function fetchUpstream(
    request: Request,
    opts: { stream: boolean; ttfbMs: number; totalMs: number; retries?: number }
): Promise<Response> {
    const retries = opts.retries ?? 2
    const timeoutMs = opts.stream ? opts.ttfbMs : opts.totalMs
    let lastResponse: Response | null = null
    for (let attempt = 0; attempt <= retries; attempt++) {
        if (lastResponse) {
            const retryAfter = Number(lastResponse.headers.get('retry-after'))
            const delay =
                Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 5000) : 500 * attempt
            await new Promise((resolve) => setTimeout(resolve, delay))
        }
        const controller = new AbortController()
        let timedOut = false
        const timer = setTimeout(() => {
            timedOut = true
            controller.abort()
        }, timeoutMs)
        let response: Response
        try {
            const raw = await fetch(new Request(request.clone(), { signal: controller.signal }))
            if (opts.stream && raw.ok) {
                clearTimeout(timer)
                response = raw
            } else {
                const aborted = new Promise<never>((_, reject) =>
                    controller.signal.addEventListener('abort', () => reject(new Error('aborted')))
                )
                const buffer = await Promise.race([raw.arrayBuffer(), aborted])
                clearTimeout(timer)
                response = new Response(buffer, {
                    status: raw.status,
                    statusText: raw.statusText,
                    headers: raw.headers
                })
            }
        } catch (error) {
            clearTimeout(timer)
            if (timedOut) throw new UpstreamTimeoutError(timeoutMs)
            throw error
        }
        if (response.ok || !RETRYABLE_STATUS.has(response.status)) {
            return response
        }
        lastResponse = response
    }
    return lastResponse as Response
}

/** Longest end of `text` that is a proper prefix of a secret, so it may complete in the next chunk. */
function pendingPrefix(text: string, secrets: string[]): number {
    let keep = 0
    for (const s of secrets) {
        for (let j = Math.min(s.length - 1, text.length); j > keep; j--) {
            if (text.endsWith(s.slice(0, j))) {
                keep = j
                break
            }
        }
    }
    return keep
}

/**
 * Replaces each secret in a streamed body with [redacted], including one split across chunks.
 * Only a possible secret prefix at a chunk's end is held back, so ordinary chunks pass at once.
 */
export function scrubStream(body: ReadableStream<Uint8Array>, secrets: string[]): ReadableStream<Uint8Array> {
    const keys = secrets.filter(Boolean)
    const decoder = new TextDecoder()
    const encoder = new TextEncoder()
    const redact = (t: string) => keys.reduce((acc, k) => acc.split(k).join('[redacted]'), t)
    let tail = ''
    return body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
                const text = redact(tail + decoder.decode(chunk, { stream: true }))
                const cut = text.length - pendingPrefix(text, keys)
                tail = text.slice(cut)
                if (cut > 0) controller.enqueue(encoder.encode(text.slice(0, cut)))
            },
            flush(controller) {
                const text = redact(tail + decoder.decode())
                if (text) controller.enqueue(encoder.encode(text))
            }
        })
    )
}

/** Secrets never reach the client: error bodies are scrubbed whole, 2xx bodies as they stream. */
export async function scrubUpstreamError(response: Response, secrets: string[]): Promise<Response> {
    if (response.ok) {
        if (!response.body) return response
        const headers = new Headers(response.headers)
        headers.delete('content-length')
        return new Response(scrubStream(response.body, secrets), {
            status: response.status,
            statusText: response.statusText,
            headers
        })
    }
    let text = await response.text()
    for (const secret of secrets) {
        if (secret) text = text.split(secret).join('[redacted]')
    }
    text = text.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, '[redacted]')
    const headers = new Headers(response.headers)
    headers.delete('content-length')
    return new Response(text, { status: response.status, statusText: response.statusText, headers })
}
