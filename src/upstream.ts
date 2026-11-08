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

export async function scrubUpstreamError(response: Response, secrets: string[]): Promise<Response> {
    if (response.ok) return response
    let text = await response.text()
    for (const secret of secrets) {
        if (secret) text = text.split(secret).join('[redacted]')
    }
    text = text.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, '[redacted]')
    const headers = new Headers(response.headers)
    headers.delete('content-length')
    return new Response(text, { status: response.status, statusText: response.statusText, headers })
}
