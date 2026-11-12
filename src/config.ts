import { resolveProviderUrl } from './provider-url'
import { parseEngagements, type Engagement } from './engagement'

export type BackendType = 'workers-ai' | 'openai' | 'openai-responses' | 'gemini'
export interface Route {
    provider: BackendType
    model: string
    baseUrl?: string
    keySecret?: string
    fallback: string[]
    contextTokens?: number
}
export interface RouteEntry {
    pattern: string
    route: Route
}

export interface ProxyConfig {
    proxyKey: string | null
    allowAnonymous: boolean
    allowedHosts: ReadonlySet<string> | '*'
    allowHttp: boolean
    maxBodyBytes: number
    upstreamTtfbMs: number
    upstreamTotalMs: number
    routes: RouteEntry[]
    engagements: ReadonlyMap<string, Engagement>
}

export class ConfigError extends Error {
    readonly variable: string
    constructor(variable: string, reason: string) {
        super(reason)
        this.name = 'ConfigError'
        this.variable = variable
    }
}

export const DEFAULT_ALLOWED_HOSTS: readonly string[] = [
    'api.openai.com',
    'generativelanguage.googleapis.com',
    'api.anthropic.com',
    'openrouter.ai',
    'api.groq.com',
    'api.deepseek.com',
    'api.mistral.ai',
    'api.x.ai'
]
export const DEFAULT_MAX_BODY_BYTES = 33554432 // 32 MiB
export const DEFAULT_UPSTREAM_TTFB_MS = 120000
export const DEFAULT_UPSTREAM_TOTAL_MS = 600000

type Raw = Record<string, unknown>

function str(raw: Raw, name: string): string | undefined {
    const v = raw[name]
    return typeof v === 'string' ? v : undefined
}

function parseBool(raw: Raw, name: string): boolean {
    const v = str(raw, name)
    if (v === undefined) return false
    const s = v.trim().toLowerCase()
    if (s === 'true') return true
    if (s === 'false') return false
    throw new ConfigError(name, `${name} must be "true" or "false"`)
}

function parseInt10(raw: Raw, name: string, fallback: number): number {
    const v = str(raw, name)
    if (v === undefined) return fallback
    const s = v.trim()
    const n = Number(s)
    if (!/^[1-9][0-9]*$/.test(s) || !Number.isSafeInteger(n)) {
        throw new ConfigError(name, `${name} must be a positive integer, got "${v}"`)
    }
    return n
}

function parseHosts(raw: Raw): ReadonlySet<string> | '*' {
    const v = str(raw, 'ALLOWED_HOSTS')
    const entries = (v ?? '')
        .split(',')
        .map((h) => h.trim().toLowerCase().replace(/\.$/, ''))
        .filter(Boolean)
    if (entries.length === 0) return new Set(DEFAULT_ALLOWED_HOSTS)
    if (entries.includes('*')) {
        if (entries.length > 1) {
            throw new ConfigError('ALLOWED_HOSTS', 'ALLOWED_HOSTS "*" cannot be mixed with other hosts')
        }
        return '*'
    }
    for (const e of entries) {
        if (/[/:@\s]/.test(e)) {
            throw new ConfigError('ALLOWED_HOSTS', `ALLOWED_HOSTS entry "${e}" is not a hostname`)
        }
    }
    return new Set(entries)
}

const BACKENDS: readonly string[] = ['workers-ai', 'openai', 'openai-responses', 'gemini']
const ROUTE_KEYS = new Set(['provider', 'model', 'baseUrl', 'keySecret', 'fallback', 'contextTokens'])

function parseRoutes(raw: Raw, urlCfg: Pick<ProxyConfig, 'allowedHosts' | 'allowHttp'>): RouteEntry[] {
    const text = str(raw, 'MODEL_ROUTES')
    if (text === undefined || text.trim() === '') return []
    const bad = (reason: string): never => {
        throw new ConfigError('MODEL_ROUTES', reason)
    }
    let parsed: unknown
    try {
        parsed = JSON.parse(text)
    } catch {
        return bad('MODEL_ROUTES is not valid JSON')
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return bad('MODEL_ROUTES must be a JSON object')
    }
    const entries: RouteEntry[] = []
    for (const [pattern, value] of Object.entries(parsed)) {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            return bad(`route "${pattern}" must be an object`)
        }
        const r = value as Record<string, unknown>
        for (const k of Object.keys(r)) {
            if (!ROUTE_KEYS.has(k)) return bad(`route "${pattern}" has unknown key "${k}"`)
        }
        if (typeof r.provider !== 'string' || !BACKENDS.includes(r.provider)) {
            return bad(`route "${pattern}" has invalid provider`)
        }
        const provider = r.provider as BackendType
        if (typeof r.model !== 'string' || r.model === '') {
            return bad(`route "${pattern}" requires a non-empty model`)
        }
        const route: Route = { provider, model: r.model, fallback: [] }
        if (provider !== 'workers-ai' && (r.baseUrl === undefined || r.keySecret === undefined)) {
            return bad(`route "${pattern}" requires baseUrl and keySecret`)
        }
        if (r.baseUrl !== undefined) {
            if (typeof r.baseUrl !== 'string') return bad(`route "${pattern}" baseUrl must be a string`)
            const u = resolveProviderUrl(r.baseUrl, urlCfg)
            if (!u.ok) return bad(`route "${pattern}" baseUrl rejected: ${u.message}`)
            route.baseUrl = u.baseUrl
        }
        if (r.keySecret !== undefined) {
            if (typeof r.keySecret !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(r.keySecret)) {
                return bad(`route "${pattern}" keySecret must match /^[A-Z][A-Z0-9_]*$/`)
            }
            if (r.keySecret === 'PROXY_KEY') {
                return bad(`route "${pattern}" keySecret must not be PROXY_KEY`)
            }
            route.keySecret = r.keySecret
        }
        if (r.fallback !== undefined) {
            if (
                !Array.isArray(r.fallback) ||
                r.fallback.length > 3 ||
                !r.fallback.every((f) => typeof f === 'string' && f !== '')
            ) {
                return bad(`route "${pattern}" fallback must be an array of at most 3 non-empty strings`)
            }
            route.fallback = r.fallback as string[]
        }
        if (r.contextTokens !== undefined) {
            if (typeof r.contextTokens !== 'number' || !Number.isSafeInteger(r.contextTokens) || r.contextTokens < 1) {
                return bad(`route "${pattern}" contextTokens must be a positive integer`)
            }
            route.contextTokens = r.contextTokens
        }
        entries.push({ pattern, route })
    }
    return entries
}

export function loadConfig(env: unknown): ProxyConfig {
    const raw: Raw = typeof env === 'object' && env !== null ? (env as Raw) : {}
    const allowedHosts = parseHosts(raw)
    const allowHttp = parseBool(raw, 'ALLOW_HTTP')
    return {
        proxyKey: str(raw, 'PROXY_KEY') || null,
        allowAnonymous: parseBool(raw, 'ALLOW_ANONYMOUS'),
        allowedHosts,
        allowHttp,
        maxBodyBytes: parseInt10(raw, 'MAX_BODY_BYTES', DEFAULT_MAX_BODY_BYTES),
        upstreamTtfbMs: parseInt10(raw, 'UPSTREAM_TTFB_MS', DEFAULT_UPSTREAM_TTFB_MS),
        upstreamTotalMs: parseInt10(raw, 'UPSTREAM_TOTAL_MS', DEFAULT_UPSTREAM_TOTAL_MS),
        routes: parseRoutes(raw, { allowedHosts, allowHttp }),
        engagements: parseEngagements(raw.ENGAGEMENTS)
    }
}
