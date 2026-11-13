export type GateEngagement = {
    name: string
    scope: { domains: string[]; llmTargets: string[] }
    exclude: { domains: string[] }
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

/** Lexical authorization check for an external target. Returns null when allowed, else a reason. */
export function gateTarget(e: GateEngagement, url: string, now: number): string | null {
    let u: URL
    try {
        u = new URL(url)
    } catch {
        return 'invalid target URL'
    }
    const host = normHost(u.hostname)
    if (host === '') return 'invalid target URL'
    if (u.protocol === 'http:') {
        if (!isLoopback(host)) return 'target URL must use https (http is allowed for loopback only)'
    } else if (u.protocol !== 'https:') {
        return 'invalid target URL'
    }
    if (!(e.window.start <= now && now <= e.window.end)) return `engagement ${e.name} window is closed`
    if (e.exclude.domains.some((d) => matches(host, d))) return `target ${host} is excluded from engagement ${e.name}`
    const inScope =
        e.scope.llmTargets.some((t) => normHost(t.trim()) === host) || e.scope.domains.some((d) => matches(host, d))
    if (!inScope) return `target ${host} is not in engagement ${e.name} scope`
    return null
}
