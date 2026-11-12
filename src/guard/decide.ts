import { checkScope, inWindow, parseCidr, parseIp, type Engagement } from '../engagement'
import { hostsInToolInput, INPUT_TOO_LARGE, TOO_MANY_TARGETS } from './hosts'

export interface HostDecision {
    decision: 'allow' | 'deny'
    hosts: string[]
    reasons: string[]
}

const MAX_TARGETS = 64

/** D7: 127.0.0.0/8, ::1, localhost and *.localhost, on a target normalized by checkScope. */
export function isLoopback(target: string): boolean {
    if (target === 'localhost' || target.endsWith('.localhost')) return true
    if (target.includes('/')) {
        const c = parseCidr(target)
        if (c === null) return false
        return c.family === 4 ? c.base >> 24n === 127n && c.bits >= 8 : c.base === 1n && c.bits === 128
    }
    const ip = parseIp(target)
    if (ip === null) return false
    return ip.family === 4 ? ip.value >> 24n === 127n : ip.value === 1n
}

/** D8: allow with no candidates; otherwise deny when any reason exists. Sentinels are never scope-checked. */
export function decideHosts(e: Engagement, raw: string[], now: number): HostDecision {
    if (raw.length === 0) return { decision: 'allow', hosts: [], reasons: [] }
    const reasons: string[] = []
    const candidates = raw.filter((r) => r !== INPUT_TOO_LARGE && r !== TOO_MANY_TARGETS)
    if (raw.includes(INPUT_TOO_LARGE)) reasons.push('tool input too large to check (over 1 MB)')
    if (raw.includes(TOO_MANY_TARGETS) || candidates.length > MAX_TARGETS) {
        reasons.push('too many targets to check (more than 64)')
    }
    const hosts: string[] = []
    let nonLoopback = false
    for (const r of candidates) {
        const res = checkScope(e, r, now)
        const shown = res.verdict === 'invalid_target' ? r : res.target
        if (!hosts.includes(shown)) hosts.push(shown)
        if (res.verdict === 'invalid_target') {
            nonLoopback = true
            reasons.push(`${r} is not a checkable target; write the literal host`)
        } else if (!isLoopback(res.target)) {
            nonLoopback = true
            if (res.verdict === 'out_of_scope') reasons.push(`${res.target} is out of scope for engagement ${e.name}`)
            else if (res.verdict === 'excluded') reasons.push(`${res.target} is excluded from engagement ${e.name}`)
        }
    }
    if (nonLoopback && !inWindow(e, now)) reasons.push(`engagement ${e.name} window is closed`)
    return { decision: reasons.length > 0 ? 'deny' : 'allow', hosts, reasons: [...new Set(reasons)] }
}

export function decideToolCall(e: Engagement, tool: string, input: unknown, now: number): HostDecision {
    return decideHosts(e, hostsInToolInput(tool, input, [...e.scope.domains, ...e.exclude.domains]), now)
}
