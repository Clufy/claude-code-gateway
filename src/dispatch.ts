import { anthropicError } from './errors'
import { Provider } from './provider'
import { fetchUpstream, scrubUpstreamError, UpstreamTimeoutError } from './upstream'
import { AnthropicProvider } from './providers/anthropic'
import { WorkersAIProvider } from './providers/workers-ai'
import * as gemini from './providers/gemini'
import * as openai from './providers/openai'
import * as utils from './utils'
import type { ProxyConfig } from './config'
import type { Target } from './routing'
import type { BackendStats } from './stats'

type ProviderCtor = { new (): Provider }

export const PROVIDERS: Record<string, ProviderCtor> = {
    anthropic: AnthropicProvider,
    gemini: gemini.impl,
    openai: openai.ChatCompletionsProvider,
    'openai-responses': openai.ResponsesProvider
}

export interface DispatchContext {
    env: Env
    cfg: ProxyConfig
    requestId: string
    inboundHeaders: Headers
    stats: BackendStats
}

export interface DispatchResult {
    response: Response
    target: Target
    fallbackUsed: boolean
    ttfbMs: number
}

const REQUEST_URL = 'https://proxy.invalid/v1/messages'
const encoder = new TextEncoder()

export function idleTimeout(body: ReadableStream<Uint8Array>, ms: number): ReadableStream<Uint8Array> {
    const reader = body.getReader()
    let timer: ReturnType<typeof setTimeout> | null = null
    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            const idle = new Promise<'idle'>((resolve) => {
                timer = setTimeout(() => resolve('idle'), ms)
            })
            try {
                const r = await Promise.race([reader.read(), idle])
                clearTimeout(timer)
                if (r === 'idle') {
                    reader.cancel().catch(() => {})
                    const message = `upstream stream idle for ${ms} ms`
                    controller.enqueue(
                        encoder.encode(utils.sse('error', { type: 'error', error: { type: 'api_error', message } }))
                    )
                    controller.close()
                } else if (r.done) {
                    controller.close()
                } else {
                    controller.enqueue(r.value)
                }
            } catch (error) {
                clearTimeout(timer)
                controller.error(error)
            }
        },
        cancel(reason) {
            clearTimeout(timer)
            return reader.cancel(reason)
        }
    })
}

function withIdleTimeout(res: Response, ms: number): Response {
    if (!res.ok || !res.body || !res.headers.get('content-type')?.includes('text/event-stream')) return res
    return new Response(idleTimeout(res.body, ms), {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers
    })
}

export async function callTarget(
    target: Target,
    body: Record<string, unknown>,
    ctx: DispatchContext
): Promise<Response> {
    const { cfg, requestId } = ctx
    const request = new Request(REQUEST_URL, {
        method: 'POST',
        headers: ctx.inboundHeaders,
        body: JSON.stringify({ ...body, model: target.model })
    })

    if (target.backend === 'workers-ai') {
        const provider = new WorkersAIProvider(ctx.env, {
            ttfbMs: cfg.upstreamTtfbMs,
            totalMs: cfg.upstreamTotalMs,
            stats: ctx.stats
        })
        return withIdleTimeout(await provider.handle(request, requestId), cfg.upstreamTtfbMs)
    }

    const provider = new PROVIDERS[target.backend]()
    const baseUrl = target.baseUrl as string
    const apiKey = target.apiKey as string
    if (provider.handle) return provider.handle(request, baseUrl, apiKey)

    let providerRequest: Request
    try {
        providerRequest = await provider.convertToProviderRequest(request, baseUrl, apiKey)
    } catch (error) {
        if (error instanceof SyntaxError) {
            return anthropicError(400, 'invalid_request_error', 'invalid JSON body', requestId)
        }
        throw error
    }
    let res: Response
    try {
        res = await fetchUpstream(providerRequest, {
            stream: Boolean(body.stream),
            ttfbMs: cfg.upstreamTtfbMs,
            totalMs: cfg.upstreamTotalMs
        })
    } catch (error) {
        if (error instanceof UpstreamTimeoutError) {
            return anthropicError(504, 'api_error', error.message, requestId)
        }
        throw error
    }
    res = await scrubUpstreamError(res, [apiKey, apiKey.replace(/^Bearer\s+/i, '')])
    return withIdleTimeout(await provider.convertToClaudeResponse(res), cfg.upstreamTtfbMs)
}

export function isFallbackable(res: Response): boolean {
    return res.status === 429 || res.status >= 500
}

export async function dispatchWithFallback(
    targets: Target[],
    body: Record<string, unknown>,
    ctx: DispatchContext
): Promise<DispatchResult> {
    const start = Date.now()
    for (let i = 0; i < targets.length; i++) {
        const target = targets[i]
        const last = i === targets.length - 1
        let response: Response
        try {
            response = await callTarget(target, body, ctx)
        } catch (error) {
            // Connect-level failure before any byte: try the next target.
            if (last) throw error
            continue
        }
        if (last || !isFallbackable(response)) {
            return { response, target, fallbackUsed: i > 0, ttfbMs: Date.now() - start }
        }
        await response.body?.cancel().catch(() => {})
    }
    throw new Error('no targets to dispatch to')
}
