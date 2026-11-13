import { hostInCidrs } from './cidr.ts'

export type GateEngagement = {
    name: string
    scope: { domains: string[]; llmTargets: string[] }
    exclude: { domains: string[]; cidrs: string[] }
    window: { start: number; end: number }
}

function normHost(h: string): string {
    const lower = h.toLowerCase()
    return lower.endsWith('.') ? lower.slice(0, -1) : lower
}

function isLoopback(host: string): boolean {
    return host === 'localhost' || host === '[::1]' || /^127(\.\d{1,3}){3}$/.test(host)
}

/** `*.x` matches any subdomain of x, never x itself; anything else is an exact match. */
function matches(host: string, pattern: string): boolean {
    const p = normHost(pattern.trim())
    if (p.startsWith('*.')) return host.endsWith(p.slice(1)) && host.length > p.length - 1
    return host === p
}

function isIpLiteral(host: string): boolean {
    return host.startsWith('[') || /^\d+(\.\d+){3}$/.test(host)
}

function effectivePort(u: URL): string {
    return u.port || (u.protocol === 'https:' ? '443' : '80')
}

/**
 * P6-R15, same semantics as llmTargetMatches in src/engagement.ts: a URL entry matches on protocol, normalized
 * host, effective port and a path boundary; an encoded slash or backslash never matches an entry with a path.
 * A bare-host entry matches by host. Unparseable entries are skipped.
 */
function llmTargetMatches(u: URL, host: string, entry: string): boolean {
    const t = entry.trim()
    if (!t.includes('://')) return normHost(t) !== '' && normHost(t) === host
    const e = URL.parse(t)
    if (e === null) return false
    const path = e.pathname.replace(/\/$/, '')
    const encodedSlash = /%(2f|5c)/i.test(u.pathname)
    return (
        e.protocol === u.protocol &&
        normHost(e.hostname) === host &&
        effectivePort(e) === effectivePort(u) &&
        (path === '' || (!encodedSlash && (u.pathname === path || u.pathname.startsWith(`${path}/`))))
    )
}

/** Lexical authorization check for an external target. Returns null when allowed, else a reason. */
export function gateTarget(e: GateEngagement, url: string, now: number): string | null {
    let u: URL
    try {
        u = new URL(url)
    } catch {
        return 'invalid target URL'
    }
    if (u.username !== '' || u.password !== '') return 'invalid target URL'
    const host = normHost(u.hostname)
    if (host === '') return 'invalid target URL'
    if (u.protocol === 'http:') {
        if (!isLoopback(host)) return 'target URL must use https (http is allowed for loopback only)'
    } else if (u.protocol !== 'https:') {
        return 'invalid target URL'
    }
    if (!(e.window.start <= now && now <= e.window.end)) return `engagement ${e.name} window is closed`
    // Exclusions always win.
    if (e.exclude.domains.some((d) => matches(host, d)) || hostInCidrs(host, e.exclude.cidrs)) {
        return `target ${host} is excluded from engagement ${e.name}`
    }
    const inScope =
        e.scope.llmTargets.some((t) => llmTargetMatches(u, host, t)) ||
        (!isIpLiteral(host) && e.scope.domains.some((d) => matches(host, d)))
    if (!inScope) return `target ${host} is not in engagement ${e.name} scope`
    return null
}
