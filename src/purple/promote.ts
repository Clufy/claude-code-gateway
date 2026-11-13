import { ConfigError } from '../config'
import { parseGuardRules } from '../guard/config'
import { hasWildcard, matchEvent, sigmaValueSource, type Position } from './evaluate'
import { PROXY_PRODUCT, SESSION_CATEGORIES, type SigmaRule } from './sigma'

export interface GuardEntry {
    id: string
    side: 'request' | 'response'
    severity: 'low' | 'medium' | 'high'
    pattern: string
    flags: string
}
export type Promotion = { ok: true; entry: GuardEntry; snippet: string } | { ok: false; reason: string }

const POSITIONS = ['contains', 'startswith', 'endswith', 're']

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)
const fail = (reason: string): Promotion => ({ ok: false, reason })

/** Index of the first event with a string `text` where the entry's regex and matchEvent disagree, else null. */
export function firstDisagreement(
    rule: SigmaRule,
    entry: GuardEntry,
    events: Record<string, unknown>[]
): number | null {
    const re = new RegExp(entry.pattern, entry.flags)
    for (let i = 0; i < events.length; i++) {
        const e = events[i]!
        if (typeof e.text === 'string' && re.test(e.text) !== matchEvent(rule, e)) return i
    }
    return null
}

export function promoteRule(rule: SigmaRule, events: Record<string, unknown>[], idSuffix?: string): Promotion {
    const { product, category } = rule.logsource
    if (product !== PROXY_PRODUCT || category === undefined || !hasOwn(SESSION_CATEGORIES, category)) {
        return fail('logsource is not session traffic (need product claude-proxy, category prompt or tool_use)')
    }
    const side = SESSION_CATEGORIES[category as keyof typeof SESSION_CATEGORIES]

    const c = rule.condition
    const name = c.op === 'sel' ? c.name : c.op === 'of' && c.names.length === 1 ? c.names[0]! : undefined
    if (name === undefined) return fail('condition must reference exactly one selection')

    const maps = hasOwn(rule.selections, name) ? rule.selections[name]! : []
    const fm = maps.length === 1 && maps[0]!.length === 1 ? maps[0]![0]! : undefined
    const position = fm?.modifiers.find((m) => POSITIONS.includes(m))
    const shapeOk =
        fm !== undefined &&
        fm.field === 'text' &&
        fm.values.length > 0 &&
        fm.values.every((v) => typeof v === 'string') &&
        fm.modifiers.length === (position === undefined ? 0 : 1)
    if (!shapeOk) return fail('selection must be one text field with contains, startswith, endswith or re and no all')
    const values = fm.values as string[]

    if (position !== 're' && values.some(hasWildcard)) return fail('wildcard values are not promotable')
    const parts = position === 're' ? values : values.map((v) => sigmaValueSource(v, (position ?? 'none') as Position))
    const pattern = parts.length === 1 ? parts[0]! : `(?:${parts.join('|')})`

    const slug = (idSuffix ?? rule.title)
        .toLowerCase()
        .replace(/[^a-z0-9_.-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48)
    const lvl = rule.level
    const entry: GuardEntry = {
        id: `custom.${slug}`,
        side,
        severity:
            lvl === 'informational' || lvl === 'low' ? 'low' : lvl === 'high' || lvl === 'critical' ? 'high' : 'medium',
        pattern,
        flags: position === 're' ? '' : 'i'
    }

    const snippet = JSON.stringify({ custom: [entry] })
    try {
        parseGuardRules(snippet)
    } catch (e) {
        if (e instanceof ConfigError) return fail(`GUARD_RULES rejects it: ${e.message}`)
        throw e
    }

    const bad = firstDisagreement(rule, entry, events)
    if (bad !== null) return fail(`regex disagrees with the Sigma rule on event ${bad}`)
    return { ok: true, entry, snippet }
}
