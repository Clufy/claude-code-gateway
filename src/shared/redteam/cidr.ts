/** Pure IP/CIDR matching for the red-team gate (P6-R15). Same semantics as src/engagement.ts, without its imports. */

type Ip = { family: 4 | 6; value: bigint }

const V4_RE = /^(0|[1-9][0-9]{0,2})(\.(0|[1-9][0-9]{0,2})){3}$/

function parseV4(s: string): bigint | null {
    if (!V4_RE.test(s)) return null
    let v = 0n
    for (const p of s.split('.')) {
        if (Number(p) > 255) return null
        v = (v << 8n) | BigInt(p)
    }
    return v
}

/** The URL parser validates and compresses the address (embedded IPv4 becomes hex), so only `::` needs expanding. */
function parseV6(s: string): bigint | null {
    if (!/^[0-9a-fA-F:.]+$/.test(s)) return null
    const h = URL.parse(`http://[${s}]`)?.hostname.slice(1, -1)
    if (h === undefined) return null
    const [left, right] = h.split('::')
    const groups = (x: string | undefined): bigint[] => (x ? x.split(':').map((g) => BigInt(`0x${g}`)) : [])
    const l = groups(left)
    const r = groups(right)
    const all = right === undefined ? l : [...l, ...new Array<bigint>(8 - l.length - r.length).fill(0n), ...r]
    return all.reduce((acc, g) => (acc << 16n) | g, 0n)
}

function parseIp(s: string): Ip | null {
    if (s.includes(':')) {
        const value = parseV6(s)
        return value === null ? null : { family: 6, value }
    }
    const value = parseV4(s)
    return value === null ? null : { family: 4, value }
}

const isMapped = (v: bigint): boolean => v >> 32n === 0xffffn

type Cidr = { family: 4 | 6; base: bigint; bits: number }

/** "a.b.c.d/n", "x::y/n" or a bare IP. An IPv4-mapped prefix (/96 or longer) becomes the IPv4 CIDR. Null when invalid. */
function parseCidr(s: string): Cidr | null {
    const slash = s.indexOf('/')
    const ip = parseIp(slash === -1 ? s : s.slice(0, slash))
    if (ip === null) return null
    const total = ip.family === 4 ? 32 : 128
    let bits = total
    if (slash !== -1) {
        const p = s.slice(slash + 1)
        if (!/^(0|[1-9][0-9]{0,2})$/.test(p) || Number(p) > total) return null
        bits = Number(p)
    }
    if (ip.family === 6 && bits >= 96 && isMapped(ip.value)) {
        return { family: 4, base: ip.value & 0xffffffffn, bits: bits - 96 }
    }
    return { family: ip.family, base: ip.value, bits }
}

/**
 * True when `host` (a URL hostname: dotted IPv4 or bracketed IPv6) is an IP inside any of `cidrs`. Unparseable
 * CIDRs are skipped. An IPv4-mapped IPv6 host is checked as itself and as its IPv4 address, so exclusions win.
 */
export function hostInCidrs(host: string, cidrs: readonly string[]): boolean {
    const ip = parseIp(host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host)
    if (ip === null) return false
    const forms: Ip[] = [ip]
    if (ip.family === 6 && isMapped(ip.value)) forms.push({ family: 4, value: ip.value & 0xffffffffn })
    return cidrs.some((s) => {
        const c = parseCidr(s.trim())
        if (c === null) return false
        const hostBits = BigInt((c.family === 4 ? 32 : 128) - c.bits)
        return forms.some((f) => f.family === c.family && f.value >> hostBits === c.base >> hostBits)
    })
}
