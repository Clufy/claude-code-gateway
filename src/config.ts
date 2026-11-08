export interface ProxyConfig {
    proxyKey: string | null
    allowAnonymous: boolean
    allowedHosts: ReadonlySet<string> | '*'
    allowHttp: boolean
    maxBodyBytes: number
    upstreamTtfbMs: number
    upstreamTotalMs: number
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

export function loadConfig(env: unknown): ProxyConfig {
    const raw: Raw = typeof env === 'object' && env !== null ? (env as Raw) : {}
    return {
        proxyKey: str(raw, 'PROXY_KEY') || null,
        allowAnonymous: parseBool(raw, 'ALLOW_ANONYMOUS'),
        allowedHosts: parseHosts(raw),
        allowHttp: parseBool(raw, 'ALLOW_HTTP'),
        maxBodyBytes: parseInt10(raw, 'MAX_BODY_BYTES', DEFAULT_MAX_BODY_BYTES),
        upstreamTtfbMs: parseInt10(raw, 'UPSTREAM_TTFB_MS', DEFAULT_UPSTREAM_TTFB_MS),
        upstreamTotalMs: parseInt10(raw, 'UPSTREAM_TOTAL_MS', DEFAULT_UPSTREAM_TOTAL_MS)
    }
}
