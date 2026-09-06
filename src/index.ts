import { generateRequestId } from './request-id'
import { anthropicError, jsonResponse } from './errors'
import { verifyProxyKey, extractProviderKey } from './auth'
import { Provider } from './provider'
import * as models from './models'
import * as tokens from './tokens'
import { WorkersAIProvider } from './providers/workers-ai'
import * as gemini from './providers/gemini'
import * as openai from './providers/openai'

type ProviderCtor = { new (): Provider }

const PROVIDERS: Record<string, ProviderCtor> = {
    gemini: gemini.impl,
    openai: openai.ChatCompletionsProvider,
    'openai-responses': openai.ResponsesProvider
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const requestId = generateRequestId()
        const url = new URL(request.url)
        const isMessages = url.pathname === '/v1/messages' || /\/v1\/messages$/.test(url.pathname)
        const start = Date.now()
        try {
            const response = await handleRequest(request, env, requestId)
            if (isMessages) {
                console.log(
                    JSON.stringify({
                        requestId,
                        method: request.method,
                        path: url.pathname,
                        status: response.status,
                        durationMs: Date.now() - start
                    })
                )
            }
            return withRequestId(response, requestId)
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            console.error(error)
            if (isMessages) {
                console.log(
                    JSON.stringify({
                        requestId,
                        method: request.method,
                        path: url.pathname,
                        status: 500,
                        durationMs: Date.now() - start
                    })
                )
            }
            return anthropicError(500, 'api_error', message, requestId)
        }
    }
}

async function handleRequest(request: Request, env: Env, requestId: string): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === 'GET' && url.pathname === '/') {
        return new Response('ok', { status: 200 })
    }

    if (request.method === 'GET' && url.pathname === '/v1/models') {
        const auth = await requireProxyKey(request, env, requestId)
        if (auth) return auth
        return models.listModels(env)
    }

    const modelMatch = url.pathname.match(/^\/v1\/models\/(.+)$/)
    if (request.method === 'GET' && modelMatch) {
        const auth = await requireProxyKey(request, env, requestId)
        if (auth) return auth
        return models.getModel(decodeURIComponent(modelMatch[1]), env, requestId)
    }

    if (request.method === 'POST' && url.pathname === '/v1/messages/count_tokens') {
        const auth = await requireProxyKey(request, env, requestId)
        if (auth) return auth
        const body = await request.json()
        return jsonResponse(tokens.countTokensForRequest(body), 200, requestId)
    }

    if (request.method === 'POST' && url.pathname === '/v1/messages') {
        const [limited, auth] = await Promise.all([
            enforceRateLimit(request, env, requestId),
            requireProxyKey(request, env, requestId)
        ])
        if (limited) return limited
        if (auth) return auth
        return new WorkersAIProvider(env).handle(request, requestId)
    }

    const externalMatch = url.pathname.match(/^\/([^/]+)\/(.+)\/v1\/messages$/)
    if (request.method === 'POST' && externalMatch) {
        const limited = await enforceRateLimit(request, env, requestId)
        if (limited) return limited
        return handleExternal(
            request,
            env,
            decodeURIComponent(externalMatch[1]),
            decodeURIComponent(externalMatch[2]),
            requestId
        )
    }

    return anthropicError(404, 'not_found_error', 'Not found', requestId)
}

async function requireProxyKey(request: Request, env: Env, requestId: string): Promise<Response | null> {
    const proxyKey = (env as { PROXY_KEY?: string }).PROXY_KEY
    if (!proxyKey) return null
    const provided = request.headers.get('x-api-key')
    if (!(await verifyProxyKey(provided, proxyKey))) {
        return anthropicError(401, 'authentication_error', 'invalid x-api-key', requestId)
    }
    return null
}

async function enforceRateLimit(request: Request, env: Env, requestId: string): Promise<Response | null> {
    const limiter = env.RATE_LIMITER
    if (!limiter) return null
    const ip = request.headers.get('cf-connecting-ip') ?? 'unknown'
    const { success } = await limiter.limit({ key: ip })
    if (success) return null
    const response = anthropicError(429, 'rate_limit_error', 'Too many requests', requestId)
    const headers = new Headers(response.headers)
    headers.set('retry-after', '60')
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers
    })
}

function providerHostAllowed(providerUrl: string, env: Env): boolean {
    const raw = (env as { ALLOWED_HOSTS?: string }).ALLOWED_HOSTS
    if (!raw) return true
    const allowed = raw
        .split(',')
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean)
    return allowed.includes(new URL(providerUrl).hostname.toLowerCase())
}

async function handleExternal(
    request: Request,
    env: Env,
    type: string,
    providerUrl: string,
    requestId: string
): Promise<Response> {
    const ProviderCtor = PROVIDERS[type]
    if (!ProviderCtor) {
        return anthropicError(404, 'not_found_error', `Provider type '${type}' not found`, requestId)
    }

    const proxyKey = (env as { PROXY_KEY?: string }).PROXY_KEY
    if (proxyKey) {
        const provided = request.headers.get('x-proxy-key')
        if (!(await verifyProxyKey(provided, proxyKey))) {
            return anthropicError(401, 'authentication_error', 'invalid x-proxy-key', requestId)
        }
    }

    const keyResult = extractProviderKey(request.headers)
    if (!keyResult) {
        return anthropicError(401, 'authentication_error', 'missing provider api key', requestId)
    }

    const inboundRequest = new Request(request, { headers: keyResult.headers })
    const baseUrl = normalizeProviderUrl(providerUrl)
    if (!providerHostAllowed(baseUrl, env)) {
        return anthropicError(403, 'permission_error', 'Provider host not allowed by ALLOWED_HOSTS', requestId)
    }
    const provider = new ProviderCtor()

    if (provider.handle) {
        return provider.handle(inboundRequest, baseUrl, keyResult.apiKey)
    }

    const providerRequest = await provider.convertToProviderRequest(inboundRequest, baseUrl, keyResult.apiKey)
    const providerResponse = await fetchWithRetry(providerRequest)
    return provider.convertToClaudeResponse(providerResponse)
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])

async function fetchWithRetry(providerRequest: Request, retries = 2): Promise<Response> {
    let lastResponse: Response | null = null
    for (let attempt = 0; attempt <= retries; attempt++) {
        if (lastResponse) {
            const retryAfter = Number(lastResponse.headers.get('retry-after'))
            const delay =
                Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 5000) : 500 * attempt
            await new Promise((resolve) => setTimeout(resolve, delay))
        }
        const response = await fetch(providerRequest.clone())
        if (response.ok || !RETRYABLE_STATUS.has(response.status)) {
            return response
        }
        try {
            await response.body?.cancel()
        } catch {
            // ignore drain errors
        }
        lastResponse = response
    }
    return lastResponse as Response
}

function normalizeProviderUrl(raw: string): string {
    let url = raw.replace(/^(https?):\/(?!\/)/, '$1://')
    if (!/^(https?):\/\//i.test(url)) {
        url = `https://${url}`
    }
    return url.replace(/\/$/, '')
}

function withRequestId(response: Response, requestId: string): Response {
    const headers = new Headers(response.headers)
    if (!headers.has('request-id')) {
        headers.set('request-id', requestId)
    }
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers
    })
}
