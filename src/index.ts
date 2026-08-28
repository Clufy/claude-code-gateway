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
        try {
            const response = await handleRequest(request, env, requestId)
            return withRequestId(response, requestId)
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            console.error(error)
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
        const auth = await requireProxyKey(request, env, requestId)
        if (auth) return auth
        return new WorkersAIProvider(env).handle(request, requestId)
    }

    const externalMatch = url.pathname.match(/^\/([^/]+)\/(.+)\/v1\/messages$/)
    if (request.method === 'POST' && externalMatch) {
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
    const provider = new ProviderCtor()

    if (provider.handle) {
        return provider.handle(inboundRequest, baseUrl, keyResult.apiKey)
    }

    const providerRequest = await provider.convertToProviderRequest(inboundRequest, baseUrl, keyResult.apiKey)
    const providerResponse = await fetch(providerRequest)
    return provider.convertToClaudeResponse(providerResponse)
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