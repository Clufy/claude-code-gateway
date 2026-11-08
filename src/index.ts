import { generateRequestId } from './request-id'
import { anthropicError, jsonResponse } from './errors'
import { checkProxyAuth, extractProviderKey } from './auth'
import { readLimitedBody } from './body-limit'
import { resolveProviderUrl } from './provider-url'
import { BackendType, ConfigError, loadConfig, ProxyConfig } from './config'
import { callTarget, dispatchWithFallback, PROVIDERS } from './dispatch'
import { planTargets, Target } from './routing'
import { newStats } from './stats'
import * as models from './models'
import * as tokens from './tokens'

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const requestId = generateRequestId()
        const url = new URL(request.url)
        const isMessages = url.pathname === '/v1/messages' || /\/v1\/messages$/.test(url.pathname)
        const start = Date.now()
        let config: ProxyConfig
        try {
            config = loadConfig(env)
        } catch (e) {
            if (e instanceof ConfigError) {
                console.error(e.message)
                return anthropicError(500, 'api_error', `invalid config: ${e.variable}`, requestId)
            }
            throw e
        }
        try {
            const response = await handleRequest(request, env, requestId, config)
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

async function handleRequest(request: Request, env: Env, requestId: string, config: ProxyConfig): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === 'GET' && url.pathname === '/') {
        return new Response('ok', { status: 200 })
    }

    if (request.method === 'GET' && url.pathname === '/v1/models') {
        const auth = await requireProxyKey(request, config, requestId)
        if (auth) return auth
        return models.listModels(env)
    }

    const modelMatch = url.pathname.match(/^\/v1\/models\/(.+)$/)
    if (request.method === 'GET' && modelMatch) {
        const auth = await requireProxyKey(request, config, requestId)
        if (auth) return auth
        return models.getModel(decodeURIComponent(modelMatch[1]), env, requestId)
    }

    if (request.method === 'POST' && url.pathname === '/v1/messages/count_tokens') {
        const auth = await requireProxyKey(request, config, requestId)
        if (auth) return auth
        const limitedBody = await readLimitedBody(request, config.maxBodyBytes)
        if (!limitedBody.ok) return bodyTooLarge(config, requestId)
        let body: any
        try {
            body = JSON.parse(limitedBody.text)
        } catch {
            return anthropicError(400, 'invalid_request_error', 'invalid JSON body', requestId)
        }
        return jsonResponse(tokens.countTokensForRequest(body), 200, requestId)
    }

    if (request.method === 'POST' && url.pathname === '/v1/messages') {
        const [limited, auth] = await Promise.all([
            enforceRateLimit(request, env, requestId),
            requireProxyKey(request, config, requestId)
        ])
        if (limited) return limited
        if (auth) return auth
        const limitedBody = await readLimitedBody(request, config.maxBodyBytes)
        if (!limitedBody.ok) return bodyTooLarge(config, requestId)
        const body = parseBodyObject(limitedBody.text)
        if (!body) return anthropicError(400, 'invalid_request_error', 'invalid JSON body', requestId)
        // A missing or non-string model is planned as-is so Workers AI keeps returning its 400.
        const model = body.model
        let targets: Target[]
        try {
            targets =
                typeof model === 'string' && model !== ''
                    ? planTargets(model, config, env as unknown as Record<string, unknown>)
                    : [{ backend: 'workers-ai', model: model as string, label: 'workers-ai:invalid' }]
        } catch (e) {
            if (e instanceof ConfigError) {
                console.error(e.message)
                return anthropicError(500, 'api_error', `invalid config: ${e.variable}`, requestId)
            }
            throw e
        }
        const ctx = { env, cfg: config, requestId, inboundHeaders: request.headers, stats: newStats() }
        return (await dispatchWithFallback(targets, body, ctx)).response
    }

    const externalMatch = url.pathname.match(/^\/([^/]+)\/(.+)\/v1\/messages$/)
    if (request.method === 'POST' && externalMatch) {
        const limited = await enforceRateLimit(request, env, requestId)
        if (limited) return limited
        return handleExternal(request, env, externalMatch[1], externalMatch[2], requestId, config)
    }

    return anthropicError(404, 'not_found_error', 'Not found', requestId)
}

async function requireProxyKey(
    request: Request,
    config: ProxyConfig,
    requestId: string,
    header = 'x-api-key'
): Promise<Response | null> {
    const result = await checkProxyAuth(request.headers.get(header), config)
    if (result === 'ok') return null
    if (result === 'not_configured') {
        return anthropicError(
            500,
            'api_error',
            'proxy not configured: set PROXY_KEY or ALLOW_ANONYMOUS=true',
            requestId
        )
    }
    return anthropicError(401, 'authentication_error', `invalid ${header}`, requestId)
}

function bodyTooLarge(config: ProxyConfig, requestId: string): Response {
    return anthropicError(
        413,
        'request_too_large',
        `request body exceeds MAX_BODY_BYTES (${config.maxBodyBytes} bytes)`,
        requestId
    )
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

async function handleExternal(
    request: Request,
    env: Env,
    rawType: string,
    rawProviderUrl: string,
    requestId: string,
    config: ProxyConfig
): Promise<Response> {
    const authError = await requireProxyKey(request, config, requestId, 'x-proxy-key')
    if (authError) return authError

    let type: string
    let providerUrl: string
    try {
        type = decodeURIComponent(rawType)
        providerUrl = decodeURIComponent(rawProviderUrl)
    } catch {
        return anthropicError(400, 'invalid_request_error', 'invalid provider URL', requestId)
    }

    const ProviderCtor = PROVIDERS[type]
    if (!ProviderCtor) {
        return anthropicError(404, 'not_found_error', `Provider type '${type}' not found`, requestId)
    }

    const urlResult = resolveProviderUrl(providerUrl, config)
    if (!urlResult.ok) {
        const errorType = urlResult.status === 403 ? 'permission_error' : 'invalid_request_error'
        return anthropicError(urlResult.status, errorType, urlResult.message, requestId)
    }
    const baseUrl = urlResult.baseUrl

    const keyResult = extractProviderKey(request.headers)
    if (!keyResult) {
        return anthropicError(401, 'authentication_error', 'missing provider api key', requestId)
    }

    const limitedBody = await readLimitedBody(request, config.maxBodyBytes)
    if (!limitedBody.ok) return bodyTooLarge(config, requestId)
    const body = parseBodyObject(limitedBody.text)
    if (!body) return anthropicError(400, 'invalid_request_error', 'invalid JSON body', requestId)
    const target: Target = {
        backend: type as BackendType,
        model: body.model as string,
        baseUrl,
        apiKey: keyResult.apiKey,
        label: type
    }
    const ctx = { env, cfg: config, requestId, inboundHeaders: keyResult.headers, stats: newStats() }
    return callTarget(target, body, ctx)
}

function parseBodyObject(text: string): Record<string, unknown> | null {
    try {
        const parsed = JSON.parse(text)
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : null
    } catch {
        return null
    }
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
