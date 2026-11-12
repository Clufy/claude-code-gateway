import { ConfigError } from './config'

export type ProxyMode = 'redteam' | 'purple' | 'off'
export interface Engagement {
    name: string
    scope: { domains: string[]; cidrs: string[]; llmTargets: string[] }
    exclude: { domains: string[]; cidrs: string[] }
    window: { start: number; end: number } // epoch ms, inclusive
    roe: string
    defaultMode: ProxyMode
}

export interface ParsedIp {
    family: 4 | 6
    value: bigint
}
export interface ParsedCidr {
    family: 4 | 6
    base: bigint // network address, host bits cleared
    bits: number // prefix length
}

function parseIpv4(s: string): bigint | null {
    const parts = s.split('.')
    if (parts.length !== 4) return null
    let v = 0n
    for (const p of parts) {
        if (!/^(0|[1-9][0-9]{0,2})$/.test(p) || Number(p) > 255) return null
        v = (v << 8n) | BigInt(p)
    }
    return v
}

function parseIpv6(s: string): bigint | null {
    if (!/^[0-9a-fA-F:.]+$/.test(s)) return null
    let head = s
    let tail: number[] = []
    // an embedded IPv4 tail (::ffff:1.2.3.4) counts as two groups
    const lastColon = s.lastIndexOf(':')
    if (s.includes('.')) {
        const v4 = parseIpv4(s.slice(lastColon + 1))
        if (v4 === null) return null
        tail = [Number(v4 >> 16n), Number(v4 & 0xffffn)]
        head = s.slice(0, lastColon + 1)
        // "::1.2.3.4" leaves head "::", "a:b:1.2.3.4" leaves "a:b:"; drop a single trailing colon unless it is "::"
        if (!head.endsWith('::')) head = head.slice(0, -1)
    }
    const halves = head.split('::')
    if (halves.length > 2) return null
    const groups = (h: string): number[] | null => {
        if (h === '') return []
        const out: number[] = []
        for (const g of h.split(':')) {
            if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null
            out.push(parseInt(g, 16))
        }
        return out
    }
    const left = groups(halves[0])
    const right = halves.length === 2 ? groups(halves[1]) : []
    if (left === null || right === null) return null
    const explicit = left.length + right.length + tail.length
    let all: number[]
    if (halves.length === 2) {
        if (explicit > 7) return null
        all = [...left, ...new Array<number>(8 - explicit).fill(0), ...right, ...tail]
    } else {
        all = [...left, ...tail]
        if (all.length !== 8) return null
    }
    return all.reduce((acc, g) => (acc << 16n) | BigInt(g), 0n)
}

/** Strict IP literal parse (dotted-decimal IPv4 or IPv6, no brackets or zone). Null when not an IP. */
export function parseIp(s: string): ParsedIp | null {
    if (s.includes(':')) {
        const value = parseIpv6(s)
        return value === null ? null : { family: 6, value }
    }
    const value = parseIpv4(s)
    return value === null ? null : { family: 4, value }
}

/** Parse "a.b.c.d/n", "x::y/n" or a bare IP (host prefix). Host bits are cleared. Null when invalid. */
export function parseCidr(s: string): ParsedCidr | null {
    const slash = s.indexOf('/')
    const ip = parseIp(slash === -1 ? s : s.slice(0, slash))
    if (ip === null) return null
    const total = ip.family === 4 ? 32 : 128
    let bits = total
    if (slash !== -1) {
        const p = s.slice(slash + 1)
        if (!/^(0|[1-9][0-9]{0,2})$/.test(p)) return null
        bits = Number(p)
        if (bits > total) return null
    }
    const hostBits = BigInt(total - bits)
    return { family: ip.family, base: (ip.value >> hostBits) << hostBits, bits }
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const LABEL_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/
const MODES: readonly string[] = ['redteam', 'purple', 'off']
const TOP_KEYS = new Set(['scope', 'exclude', 'window', 'roe', 'defaultMode'])
const SCOPE_KEYS = new Set(['domains', 'cidrs', 'llmTargets'])
const EXCLUDE_KEYS = new Set(['domains', 'cidrs'])
const WINDOW_KEYS = new Set(['start', 'end'])

type Obj = Record<string, unknown>

function isObj(v: unknown): v is Obj {
    return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Lowercase, drop a trailing dot, punycode via the URL parser. Null when not a plain hostname. */
function normalizeHostname(h: string): string | null {
    if (!/^[A-Za-z0-9.\u0080-￿-]+$/.test(h) || /\s/.test(h)) return null
    let host: string
    try {
        host = new URL(`http://${h}`).hostname
    } catch {
        return null
    }
    host = host.replace(/\.$/, '')
    const labels = host.split('.')
    if (!labels.every((l) => LABEL_RE.test(l))) return null
    if (/^[0-9]+$/.test(labels[labels.length - 1])) return null // IP-looking, not a domain
    return host
}

/**
 * Parse the ENGAGEMENTS value (the raw JSON string, or undefined). Fail closed: any problem throws
 * ConfigError('ENGAGEMENTS', ...). Returns a Map so a name like "constructor" is an ordinary key.
 */
export function parseEngagements(raw: unknown): ReadonlyMap<string, Engagement> {
    const out = new Map<string, Engagement>()
    if (raw === undefined) return out
    const bad = (reason: string): never => {
        throw new ConfigError('ENGAGEMENTS', reason)
    }
    if (typeof raw !== 'string') return bad('ENGAGEMENTS must be a JSON string')
    if (raw.trim() === '') return out
    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch {
        return bad('ENGAGEMENTS is not valid JSON')
    }
    if (!isObj(parsed)) return bad('ENGAGEMENTS must be a JSON object')

    const noUnknown = (o: Obj, allowed: Set<string>, where: string): void => {
        for (const k of Object.keys(o)) {
            if (!allowed.has(k)) bad(`${where} has unknown key "${k}"`)
        }
    }
    const list = (v: unknown, where: string): string[] => {
        if (v === undefined) return []
        if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
            return bad(`${where} must be an array of strings`)
        }
        return v as string[]
    }
    const domains = (v: unknown, where: string): string[] =>
        list(v, where).map((d) => {
            const wild = d.startsWith('*.')
            const host = normalizeHostname(wild ? d.slice(2) : d)
            if (host === null) return bad(`${where} entry "${d}" is not a hostname or *.hostname`)
            if (wild && !host.includes('.'))
                return bad(`${where} entry "${d}" is too broad (a wildcard needs a domain)`)
            return wild ? `*.${host}` : host
        })
    const cidrs = (v: unknown, where: string): string[] =>
        list(v, where).map((c) => {
            if (parseCidr(c) === null) return bad(`${where} entry "${c}" is not a valid CIDR or IP`)
            return c
        })

    for (const [name, value] of Object.entries(parsed)) {
        if (!NAME_RE.test(name)) return bad(`engagement name "${name}" must match ${NAME_RE}`)
        const at = `engagement "${name}"`
        if (!isObj(value)) return bad(`${at} must be an object`)
        noUnknown(value, TOP_KEYS, at)

        if (!isObj(value.scope)) return bad(`${at} requires a scope object`)
        noUnknown(value.scope, SCOPE_KEYS, `${at} scope`)
        const scope = {
            domains: domains(value.scope.domains, `${at} scope.domains`),
            cidrs: cidrs(value.scope.cidrs, `${at} scope.cidrs`),
            llmTargets: list(value.scope.llmTargets, `${at} scope.llmTargets`).map((u) => {
                let proto: string
                try {
                    proto = new URL(u).protocol
                } catch {
                    return bad(`${at} scope.llmTargets entry "${u}" is not a URL`)
                }
                if (proto !== 'http:' && proto !== 'https:') {
                    return bad(`${at} scope.llmTargets entry "${u}" must be http(s)`)
                }
                return u
            })
        }
        if (scope.domains.length + scope.cidrs.length + scope.llmTargets.length === 0) {
            return bad(`${at} scope must contain at least one non-empty list`)
        }

        let exclude = { domains: [] as string[], cidrs: [] as string[] }
        if (value.exclude !== undefined) {
            if (!isObj(value.exclude)) return bad(`${at} exclude must be an object`)
            noUnknown(value.exclude, EXCLUDE_KEYS, `${at} exclude`)
            exclude = {
                domains: domains(value.exclude.domains, `${at} exclude.domains`),
                cidrs: cidrs(value.exclude.cidrs, `${at} exclude.cidrs`)
            }
        }

        if (!isObj(value.window)) return bad(`${at} requires a window object`)
        noUnknown(value.window, WINDOW_KEYS, `${at} window`)
        const time = (k: 'start' | 'end'): number => {
            const t = value.window as Obj
            const v = t[k]
            const n = typeof v === 'string' && ISO_RE.test(v) ? Date.parse(v) : NaN
            return Number.isNaN(n) ? bad(`${at} window.${k} must be an ISO 8601 date-time with Z or an offset`) : n
        }
        const start = time('start')
        const end = time('end')
        if (start >= end) return bad(`${at} window.start must be before window.end`)

        if (value.roe !== undefined && typeof value.roe !== 'string') return bad(`${at} roe must be a string`)
        let defaultMode: ProxyMode = 'off'
        if (value.defaultMode !== undefined) {
            if (typeof value.defaultMode !== 'string' || !MODES.includes(value.defaultMode)) {
                return bad(`${at} defaultMode must be one of ${MODES.join(', ')}`)
            }
            defaultMode = value.defaultMode as ProxyMode
        }

        out.set(name, { name, scope, exclude, window: { start, end }, roe: value.roe ?? '', defaultMode })
    }
    return out
}
