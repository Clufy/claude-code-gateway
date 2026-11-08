import { tapSse } from './sse-tap'
import type { BackendStats } from './stats'

export interface RequestLog {
    requestId: string
    method: string
    path: string
    status: number
    durationMs: number
    streamed?: boolean
    model?: string // requested model
    route?: string // matched MODEL_ROUTES pattern, if any
    backend?: string // final target label
    fallbackUsed?: boolean
    ttfbMs?: number
    inputTokens?: number
    outputTokens?: number
    toolCallsFromText?: number
    unparsedToolText?: boolean
    keepalive?: boolean // keepalive committed: client saw 200 before the backend answered
}

export interface ProxyStats {
    backend: string
    model: string
    fallbackUsed: boolean
    ttfbMs: number
    toolCallsFromText: number
    unparsedToolText: boolean
}

export function logRequest(record: RequestLog): void {
    console.log(JSON.stringify({ event: 'request', ...record }))
}

/** Responses already logged by finalizeMessagesResponse; fetch must not log them again. */
export const finalized = new WeakSet<Response>()

export interface FinalizeInput {
    request: Request
    requestId: string
    start: number
    model?: string
    route?: string
    backend: string
    fallbackUsed: boolean
    ttfbMs?: number
    stats: BackendStats
    /** Real backend status when it differs from the response (committed keepalive). Read at log time. */
    status?: number
    keepalive?: boolean
}

/** Log (once) and optionally attach debug stats to a dispatched messages response. */
export async function finalizeMessagesResponse(response: Response, input: FinalizeInput): Promise<Response> {
    const { request, stats } = input
    const debug = request.headers.get('x-proxy-debug') === '1'
    const record = (extra: Partial<RequestLog>): RequestLog => ({
        requestId: input.requestId,
        method: request.method,
        path: new URL(request.url).pathname,
        status: input.status ?? response.status,
        durationMs: Date.now() - input.start,
        model: input.model,
        route: input.route,
        backend: input.backend,
        fallbackUsed: input.fallbackUsed,
        ttfbMs: input.ttfbMs,
        toolCallsFromText: stats.toolCallsFromText,
        unparsedToolText: stats.unparsedToolText,
        ...(input.keepalive ? { keepalive: true } : {}),
        ...extra
    })
    const proxyStats = (): ProxyStats => ({
        backend: input.backend,
        model: input.model ?? '',
        fallbackUsed: input.fallbackUsed,
        ttfbMs: input.ttfbMs ?? 0,
        toolCallsFromText: stats.toolCallsFromText,
        unparsedToolText: stats.unparsedToolText
    })

    let out: Response
    const isStream = response.ok && response.body && response.headers.get('content-type')?.includes('text/event-stream')
    if (isStream) {
        let inputTokens: number | undefined
        let outputTokens: number | undefined
        out = tapSse(response, {
            onEvent(event, data) {
                if (event === 'message_start') inputTokens = data?.message?.usage?.input_tokens ?? inputTokens
                else if (event === 'message_delta') {
                    inputTokens = data?.usage?.input_tokens ?? inputTokens
                    outputTokens = data?.usage?.output_tokens ?? outputTokens
                }
            },
            onEnd() {
                logRequest(record({ streamed: true, inputTokens, outputTokens }))
                if (debug) return `: proxy-stats ${JSON.stringify(proxyStats())}\n\n`
            }
        })
    } else {
        let usage: { inputTokens?: number; outputTokens?: number } = {}
        if (response.ok) {
            try {
                const json: any = await response.clone().json()
                usage = { inputTokens: json?.usage?.input_tokens, outputTokens: json?.usage?.output_tokens }
            } catch {
                // not JSON: log without usage
            }
        }
        logRequest(record(usage))
        if (debug) {
            const headers = new Headers(response.headers)
            headers.set('x-proxy-stats', JSON.stringify(proxyStats()))
            out = new Response(response.body, { status: response.status, statusText: response.statusText, headers })
        } else {
            out = response
        }
    }
    finalized.add(out)
    return out
}
