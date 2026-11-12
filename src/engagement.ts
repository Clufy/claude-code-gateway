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

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-](\d{2}):(\d{2}))$/

/** Epoch ms for a strict ISO 8601 date-time, or NaN. Rejects values Date.parse would roll over (Feb 30, T24:00). */
function parseIsoInstant(v: unknown): number {
    const m = typeof v === 'string' ? ISO_RE.exec(v) : null
    if (m === null) return NaN
    const [y, mo, d, h, mi, sec = 0, oh = 0, om = 0] = m.slice(1).map((x) => (x === undefined ? 0 : Number(x)))
    const probe = new Date(Date.UTC(y, mo - 1, d))
    if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return NaN
    if (h > 23 || mi > 59 || sec > 59 || oh > 23 || om > 59) return NaN
    return Date.parse(v as string)
}
// IDNA deviation characters resolve differently across clients (ß, ς, ZWNJ, ZWJ), so they are refused
const DEVIATION_RE = /[ßς‌‍]/
/** Deviation check on decoded, NFKC-normalized, lowercased text, so U+1E9E and %C3%9F cannot slip past. */
function hasDeviation(s: string): boolean {
    let t = s
    try {
        t = decodeURIComponent(s)
    } catch {
        // keep the raw text
    }
    return DEVIATION_RE.test(t.normalize('NFKC').toLowerCase())
}
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
    if (!/^[A-Za-z0-9.\u0080-￿-]+$/.test(h) || /\s/.test(h) || hasDeviation(h)) return null
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
            const p = parseCidr(c)
            if (p === null) return bad(`${where} entry "${c}" is not a valid CIDR or IP`)
            // a short IPv6 prefix covering ::ffff:0:0/96 would never match the IPv4-collapsed targets
            if (p.family === 6 && p.bits < 96) {
                const h = BigInt(128 - p.bits)
                if (p.base >> h === (0xffffn << 32n) >> h) {
                    return bad(
                        `${where} entry "${c}" overlaps the IPv4-mapped range; write IPv4-mapped ranges as IPv4 CIDRs`
                    )
                }
            }
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
            const n = parseIsoInstant(v)
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

export type ScopeVerdict = 'in_scope' | 'excluded' | 'out_of_scope' | 'invalid_target'
export interface ScopeResult {
    verdict: ScopeVerdict
    target: string // normalized host or IP ('' when invalid)
    inWindow: boolean
}

const SCHEME_RE = /^([a-z][a-z0-9+.-]*):\/\//i
const BARE_V6_RE = /^[0-9a-fA-F:.]+$/

function dottedV4(v: bigint): string {
    return [24n, 16n, 8n, 0n].map((s) => String((v >> s) & 0xffn)).join('.')
}

/**
 * Parse a host, IP or scheme://URL into a URL whose host is canonicalized. Any scheme is accepted: its host is
 * read by swapping the scheme to http://. Null when unusable. A backslash is refused, since the URL parser reads
 * it as "/" while curl and urlsplit treat "a\@b" as userinfo.
 */
function parseTargetUrl(input: string): URL | null {
    if (input === '' || /[\s\\]/.test(input)) return null
    const scheme = SCHEME_RE.exec(input)
    const rest = scheme === null ? input : input.slice(scheme[0].length)
    if (scheme !== null && rest.startsWith('/')) return null // empty authority
    if (hasDeviation(rest.split(/[/?#]/)[0])) return null
    // a bare IPv6 address has no brackets, and http://2001:db8::1 does not parse
    const bareV6 = rest.split(':').length > 2 && BARE_V6_RE.test(rest)
    try {
        return new URL(`http://${bareV6 ? `[${rest}]` : rest}`)
    } catch {
        return null
    }
}

function hostOf(url: URL): string | null {
    let host = url.hostname
    const v6 = host.startsWith('[') && host.endsWith(']')
    if (v6) host = host.slice(1, -1)
    else host = host.replace(/\.$/, '')
    if (host === '' || host.startsWith('.') || host.endsWith('.') || host.includes('..')) return null
    if (v6) {
        const ip = parseIp(host)
        if (ip === null) return null
        // IPv4-mapped ::ffff:a.b.c.d (the parser emits ::ffff:hhhh:hhhh) is the IPv4 address
        return ip.value >> 32n === 0xffffn ? dottedV4(ip.value & 0xffffffffn) : host
    }
    return host
}

/** Host, IP or URL to its canonical lowercase punycoded host, or dotted IPv4 / compressed IPv6 (no brackets). Null when unusable. */
export function normalizeTarget(input: string): string | null {
    const url = parseTargetUrl(input)
    return url === null ? null : hostOf(url)
}

export function inWindow(e: Engagement, now: number): boolean {
    return e.window.start <= now && now <= e.window.end
}

interface ParsedLists {
    scope: ParsedCidr[]
    exclude: ParsedCidr[]
}
const cidrCache = new WeakMap<Engagement, ParsedLists>()

/** A ::ffff:a.b.c.d/n CIDR (n >= 96) is the IPv4 CIDR /(n-96), matching how mapped inputs are collapsed. */
function mappedToV4(c: ParsedCidr): ParsedCidr {
    if (c.family !== 6 || c.bits < 96 || c.base >> 32n !== 0xffffn) return c
    return { family: 4, base: c.base & 0xffffffffn, bits: c.bits - 96 }
}

function cidrsOf(e: Engagement): ParsedLists {
    let c = cidrCache.get(e)
    if (c === undefined) {
        const parse = (l: string[]) =>
            l
                .map(parseCidr)
                .filter((x): x is ParsedCidr => x !== null)
                .map(mappedToV4)
        c = { scope: parse(e.scope.cidrs), exclude: parse(e.exclude.cidrs) }
        cidrCache.set(e, c)
    }
    return c
}

function domainMatches(host: string, entries: string[]): boolean {
    return entries.some((d) => (d.startsWith('*.') ? host.endsWith(d.slice(1)) : host === d))
}

function cidrMatches(ip: ParsedIp | null, list: ParsedCidr[]): boolean {
    if (ip === null) return false
    return list.some((c) => {
        if (c.family !== ip.family) return false
        const hostBits = BigInt((c.family === 4 ? 32 : 128) - c.bits)
        return ip.value >> hostBits === c.base >> hostBits
    })
}

function effectivePort(u: URL): string {
    return u.port || (u.protocol === 'https:' ? '443' : '80')
}

/** Compare protocol, normalized host and effective port (not url.origin), then the path boundary. */
function llmTargetMatches(url: URL, targets: string[]): boolean {
    const host = hostOf(url)
    return targets.some((t) => {
        const u = new URL(t)
        const path = u.pathname.replace(/\/$/, '')
        return (
            u.protocol === url.protocol &&
            hostOf(u) === host &&
            effectivePort(u) === effectivePort(url) &&
            (url.pathname === path || url.pathname.startsWith(`${path}/`))
        )
    })
}

function realHttpUrl(input: string): URL | null {
    if (!/^https?:\/\//i.test(input)) return null
    try {
        return new URL(input)
    } catch {
        return null
    }
}

function llmMatches(input: string, e: Engagement): boolean {
    const real = realHttpUrl(input)
    return real !== null && llmTargetMatches(real, e.scope.llmTargets)
}

export function checkScope(e: Engagement, input: string, now: number = Date.now()): ScopeResult {
    const url = parseTargetUrl(input)
    const target = url === null ? null : hostOf(url)
    if (url === null || target === null) return { verdict: 'invalid_target', target: '', inWindow: inWindow(e, now) }
    const ip = parseIp(target)
    const c = cidrsOf(e)
    let verdict: ScopeVerdict = 'out_of_scope'
    if (domainMatches(target, e.exclude.domains) || cidrMatches(ip, c.exclude)) verdict = 'excluded'
    else if (domainMatches(target, e.scope.domains) || cidrMatches(ip, c.scope) || llmMatches(input, e)) {
        verdict = 'in_scope'
    }
    return { verdict, target, inWindow: inWindow(e, now) }
}
