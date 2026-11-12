import { tapSse } from './sse-tap'
import type { BackendStats } from './stats'
import type { ProxyMode } from './engagement'
import type { Guard } from './guard'

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
    streamError?: string // streamed response carried an error event (its error.type) or the stream broke ('error')
    cancelled?: boolean // the client cancelled the stream before it ended
    engagement?: string // x-engagement, when one was named
    mode?: ProxyMode // resolved mode, logged with the engagement
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
    engagement?: string
    mode?: ProxyMode
    /** The session guard: fed each response tool_use block, then onEnd before the request line. */
    guard?: Guard
    /** Request-side rule ids from guard.scanRequest; set as x-proxy-detections when non-empty. */
    detections?: string[]
}

const MAX_TOOL_JSON = 1024 * 1024 // per streamed tool_use block
const MAX_OPEN_TOOL_BLOCKS = 16 // P4-R30: further starts are ignored until one closes

/** Feeds a finished tool_use input to the guard; a guard failure is lost silently. */
function guardToolUse(guard: Guard | undefined, name: unknown, input: unknown): void {
    if (!guard) return
    try {
        guard.onToolUse(typeof name === 'string' ? name : '', input)
    } catch {
        // flag only: never break the response
    }
}

function guardEnd(guard: Guard | undefined, stats: BackendStats): void {
    try {
        guard?.onEnd(stats)
    } catch {
        // flag only: never break the response
    }
}

/** Streamed tool_use blocks by index: name and the input JSON so far (≤1 MB). */
function toolTracker(guard: Guard | undefined) {
    const blocks = new Map<number, { name: unknown; json: string }>()
    return (event: string, data: any): void => {
        if (!guard) return
        try {
            if (event === 'content_block_start' && data?.content_block?.type === 'tool_use') {
                if (blocks.size >= MAX_OPEN_TOOL_BLOCKS) return
                blocks.set(data.index, { name: data.content_block.name, json: '' })
            } else if (event === 'content_block_delta' && data?.delta?.type === 'input_json_delta') {
                const b = blocks.get(data.index)
                const part = data.delta.partial_json
                if (b && typeof part === 'string' && b.json.length < MAX_TOOL_JSON) {
                    b.json += part.slice(0, MAX_TOOL_JSON - b.json.length)
                }
            } else if (event === 'content_block_stop') {
                const b = blocks.get(data?.index)
                if (!b) return
                blocks.delete(data.index)
                let input: unknown = b.json
                try {
                    input = b.json === '' ? {} : JSON.parse(b.json)
                } catch {
                    // truncated or invalid JSON: the rules see the raw string
                }
                guardToolUse(guard, b.name, input)
            }
        } catch {
            // flag only: never break the stream
        }
    }
}

function withDetections(response: Response, detections: string[] | undefined): Response {
    if (!detections || detections.length === 0) return response
    const headers = new Headers(response.headers)
    headers.set('x-proxy-detections', detections.join(','))
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
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
        engagement: input.engagement,
        mode: input.mode,
        ...(input.keepalive ? { keepalive: true } : {}),
        ...extra
    })
    const proxyStats = () => ({
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
        let streamError: string | undefined
        const onGuardEvent = toolTracker(input.guard)
        out = tapSse(response, {
            onEvent(event, data) {
                onGuardEvent(event, data)
                if (event === 'error') streamError ??= data?.error?.type ?? 'error'
                else if (event === 'message_start') inputTokens = data?.message?.usage?.input_tokens ?? inputTokens
                else if (event === 'message_delta') {
                    inputTokens = data?.usage?.input_tokens ?? inputTokens
                    outputTokens = data?.usage?.output_tokens ?? outputTokens
                }
            },
            onEnd(reason) {
                if (reason === 'error') streamError ??= 'error'
                guardEnd(input.guard, stats)
                logRequest(
                    record({
                        streamed: true,
                        inputTokens,
                        outputTokens,
                        ...(streamError ? { streamError } : {}),
                        ...(reason === 'cancel' ? { cancelled: true } : {})
                    })
                )
                if (debug) return `: proxy-stats ${JSON.stringify(proxyStats())}\n\n`
            }
        })
    } else {
        let usage: { inputTokens?: number; outputTokens?: number } = {}
        if (response.ok) {
            try {
                const json: any = await response.clone().json()
                usage = { inputTokens: json?.usage?.input_tokens, outputTokens: json?.usage?.output_tokens }
                if (input.guard && Array.isArray(json?.content)) {
                    for (const b of json.content) {
                        if (b?.type === 'tool_use') guardToolUse(input.guard, b.name, b.input)
                    }
                }
            } catch {
                // not JSON: log without usage
            }
        }
        guardEnd(input.guard, stats)
        logRequest(record(usage))
        if (debug) {
            const headers = new Headers(response.headers)
            headers.set('x-proxy-stats', JSON.stringify(proxyStats()))
            out = new Response(response.body, { status: response.status, statusText: response.statusText, headers })
        } else {
            out = response
        }
    }
    out = withDetections(out, input.detections)
    finalized.add(out)
    return out
}
