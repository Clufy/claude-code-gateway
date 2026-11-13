import { generateRequestId } from './request-id'
import { anthropicError, jsonResponse } from './errors'
import { checkProxyAuth, extractProviderKey } from './auth'
import { readLimitedBody } from './body-limit'
import { resolveProviderUrl } from './provider-url'
import { BackendType, ConfigError, loadConfig, ProxyConfig } from './config'
import { callTarget, dispatchWithFallback, PROVIDERS } from './dispatch'
import { findRouteEntry, planTargets, Target } from './routing'
import { finalized, finalizeMessagesResponse, logRequest, type FinalizeInput } from './request-log'
import { keepaliveTiming, withKeepalive } from './keepalive'
import { applyMode, type ModeOk } from './modes'
import { isObj } from './engagement'
import { handleGuardCheck } from './guard/check'
import { handleMcp } from './mcp/server'
import { createGuard } from './guard'
import { newStats } from './stats'
import * as models from './models'
import * as tokens from './tokens'

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const requestId = generateRequestId()
        const url = new URL(request.url)
        const isMessages = url.pathname === '/v1/messages' || /\/v1\/messages$/.test(url.pathname)
        const start = Date.now()
        const log = (status: number) => {
            if (!isMessages) return
            logRequest({
                requestId,
                method: request.method,
                path: url.pathname,
                status,
                durationMs: Date.now() - start
            })
        }
        try {
            const response = await handleRequest(request, env, requestId, loadConfig(env), start)
            if (!finalized.has(response)) log(response.status)
            return withRequestId(response, requestId)
        } catch (error) {
            // A ConfigError (from loadConfig or planTargets) names only the variable.
            let message: string
            if (error instanceof ConfigError) {
                console.error(error.message)
                message = `invalid config: ${error.variable}`
            } else {
                console.error(error)
                message = error instanceof Error ? error.message : String(error)
            }
            log(500)
            return anthropicError(500, 'api_error', message, requestId)
        }
    }
}

async function handleRequest(
    request: Request,
    env: Env,
    requestId: string,
    config: ProxyConfig,
    start: number
): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === 'GET' && url.pathname === '/') {
        return new Response('ok', { status: 200 })
    }

    if (request.method === 'GET' && url.pathname === '/v1/models') {
        const auth = await requireProxyKey(request, config, requestId)
        if (auth) return auth
        return models.listModels(env, config)
    }

    const modelMatch = url.pathname.match(/^\/v1\/models\/(.+)$/)
    if (request.method === 'GET' && modelMatch) {
        const auth = await requireProxyKey(request, config, requestId)
        if (auth) return auth
        return models.getModel(decodeURIComponent(modelMatch[1]), env, config, requestId)
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
        // Only an object body can carry a pack; any other JSON is counted as today.
        // No out-of-window detection here: the messages request that follows logs it.
        if (isObj(body)) {
            const mode = applyMode(request.headers, body, config, requestId, Date.now(), { detect: false })
            if (!mode.ok) return mode.response
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
        const mode = applyMode(request.headers, body, config, requestId)
        if (!mode.ok) return mode.response
        // Read after applyMode: routing, keepalive and the log all see the alias-stripped model.
        // A missing or non-string model is planned as-is so Workers AI keeps returning its 400.
        const model = body.model
        // A ConfigError (route secret not set) propagates to fetch's 500.
        const targets: Target[] =
            typeof model === 'string' && model !== ''
                ? planTargets(model, config, env as unknown as Record<string, unknown>)
                : [{ backend: 'workers-ai', model: model as string, label: 'workers-ai:invalid' }]
        const ctx = { env, cfg: config, requestId, inboundHeaders: request.headers, stats: newStats() }
        const input: FinalizeInput = {
            request,
            requestId,
            start,
            model: typeof model === 'string' ? model : undefined,
            route: typeof model === 'string' ? findRouteEntry(model, config.routes)?.pattern : undefined,
            backend: targets[0].label,
            fallbackUsed: false,
            stats: ctx.stats,
            ...auditFields(mode),
            ...guardFields(body, config, requestId, mode)
        }
        const inputTokens = body.stream ? tokens.countTokensForRequest(body).input_tokens : 0
        const dispatched = dispatchWithFallback(targets, body, ctx)
        // Lazy log metadata: filled from the dispatch outcome, read when the line is written.
        let settled: Response | undefined
        dispatched.then(
            (result) => {
                settled = result.response
                input.backend = result.target.label
                input.fallbackUsed = result.fallbackUsed
                input.ttfbMs = result.ttfbMs
                input.status = result.response.status
            },
            () => {
                input.status = 500
            }
        )
        if (!body.stream) {
            return finalizeMessagesResponse((await dispatched).response, input)
        }
        const response = await withKeepalive(
            dispatched.then((r) => r.response),
            {
                requestedModel: typeof model === 'string' ? model : '',
                inputTokens,
                ...keepaliveTiming
            }
        )
        if (response !== settled) input.keepalive = true
        return finalizeMessagesResponse(response, input)
    }

    if (request.method === 'POST' && url.pathname === '/v1/guard/check') {
        const auth = await requireProxyKey(request, config, requestId)
        if (auth) return auth
        return handleGuardCheck(request, config, requestId)
    }

    if (url.pathname === '/mcp') {
        if (request.method !== 'POST') {
            return new Response(null, { status: 405, headers: { allow: 'POST' } })
        }
        const limited = await enforceRateLimit(request, env, requestId)
        if (limited) return limited
        const token = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null
        const auth = await checkProxyAuth(token?.trim() ?? null, config)
        if (auth === 'not_configured') {
            return anthropicError(
                500,
                'api_error',
                'proxy not configured: set PROXY_KEY or ALLOW_ANONYMOUS=true',
                requestId
            )
        }
        if (auth === 'unauthorized') return jsonResponse({ error: 'invalid authorization' }, 401, requestId)
        return handleMcp(request, config, requestId)
    }

    const externalMatch = url.pathname.match(/^\/([^/]+)\/(.+)\/v1\/messages$/)
    if (request.method === 'POST' && externalMatch) {
        const limited = await enforceRateLimit(request, env, requestId)
        if (limited) return limited
        return handleExternal(request, env, externalMatch[1], externalMatch[2], requestId, config, start)
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
    config: ProxyConfig,
    start: number
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
    const mode = applyMode(request.headers, body, config, requestId)
    if (!mode.ok) return mode.response
    const guard = guardFields(body, config, requestId, mode)
    const target: Target = {
        backend: type as BackendType,
        model: body.model as string,
        baseUrl,
        apiKey: keyResult.apiKey,
        label: type
    }
    const ctx = { env, cfg: config, requestId, inboundHeaders: keyResult.headers, stats: newStats() }
    const callStart = Date.now()
    const response = await callTarget(target, body, ctx)
    return finalizeMessagesResponse(response, {
        request,
        requestId,
        start,
        model: typeof body.model === 'string' ? body.model : undefined,
        backend: target.label,
        fallbackUsed: false,
        ttfbMs: Date.now() - callStart,
        stats: ctx.stats,
        ...auditFields(mode),
        ...guard
    })
}

/** Log fields: engagement and mode appear only when an engagement was named. */
function auditFields(mode: ModeOk): Pick<FinalizeInput, 'engagement' | 'mode'> {
    return mode.engagement ? { engagement: mode.engagement, mode: mode.mode } : {}
}

/** Creates the session guard and scans the newest request turn before dispatch. Never throws. */
function guardFields(
    body: Record<string, unknown>,
    config: ProxyConfig,
    requestId: string,
    mode: ModeOk
): Pick<FinalizeInput, 'guard' | 'detections'> {
    try {
        const engagement = mode.engagement === undefined ? undefined : config.engagements.get(mode.engagement)
        const guard = createGuard(config, requestId, engagement, mode.outOfWindow === true)
        return { guard, detections: guard.scanRequest(body) }
    } catch {
        return {} // flag only: a guard failure never breaks the request
    }
}

function parseBodyObject(text: string): Record<string, unknown> | null {
    try {
        const parsed = JSON.parse(text)
        return isObj(parsed) ? parsed : null
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
