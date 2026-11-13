import { parseSigma, type Cond, type FieldMatch, type SigmaRule, type SigmaValue } from './sigma'

export interface RuleTest {
    passed: boolean | null // null when no expect was given
    matched: number[]
    missedExpected: number[]
    unexpectedMatches: number[]
    unsupported: string[]
    error?: string
}

export type Position = 'none' | 'contains' | 'startswith' | 'endswith'

const REGEX_META = /[\\^$.*+?()[\]{}|]/

/**
 * The one place a Sigma string value becomes a RegExp (flag `i`, never toLowerCase).
 * `*` -> any run, `?` -> one char; `\*`, `\?`, `\\` are literals; every other metachar is escaped.
 */
export function sigmaValueSource(value: string, position: Position): string {
    let out = ''
    for (let i = 0; i < value.length; i++) {
        const c = value[i]!
        const next = value[i + 1]
        if (c === '\\' && (next === '*' || next === '?' || next === '\\')) {
            out += `\\${next}`
            i++
        } else if (c === '*') out += '[\\s\\S]*'
        else if (c === '?') out += '[\\s\\S]'
        else out += REGEX_META.test(c) ? `\\${c}` : c
    }
    if (position === 'none') return `^${out}$`
    if (position === 'startswith') return `^${out}`
    if (position === 'endswith') return `${out}$`
    return out
}

export function sigmaValueRegex(value: string, position: Position): RegExp {
    return new RegExp(sigmaValueSource(value, position), 'i')
}

// Keyed on the FieldMatch objects a parse creates, so entries live and die with the rule.
const compiled = new WeakMap<FieldMatch, (RegExp | null)[]>()

function regexesFor(fm: FieldMatch): (RegExp | null)[] {
    let list = compiled.get(fm)
    if (list === undefined) {
        const position: Position = fm.modifiers.includes('contains')
            ? 'contains'
            : fm.modifiers.includes('startswith')
              ? 'startswith'
              : fm.modifiers.includes('endswith')
                ? 'endswith'
                : 'none'
        const re = fm.modifiers.includes('re')
        list = fm.values.map((v) =>
            v === null ? null : re ? new RegExp(String(v)) : sigmaValueRegex(String(v), position)
        )
        compiled.set(fm, list)
    }
    return list
}

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const own = (o: Record<string, unknown>, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)

/** Exact own key first, else a dotted path through nested plain objects. */
function lookup(event: Record<string, unknown>, field: string): unknown {
    if (own(event, field)) return event[field]
    let cur: unknown = event
    for (const part of field.split('.')) {
        if (!isPlain(cur) || !own(cur, part)) return undefined
        cur = cur[part]
    }
    return cur
}

function matchScalar(ev: unknown, sv: SigmaValue, re: RegExp | null): boolean {
    if (sv === null || re === null) return ev === null || ev === undefined
    if (typeof ev !== 'string' && typeof ev !== 'number' && typeof ev !== 'boolean') return false
    return re.test(String(ev))
}

function matchField(fm: FieldMatch, event: Record<string, unknown>): boolean {
    const ev = lookup(event, fm.field)
    const res = regexesFor(fm)
    const one = (i: number): boolean => {
        const sv = fm.values[i]!
        if (Array.isArray(ev)) return ev.some((e) => matchScalar(e, sv, res[i]!))
        return matchScalar(ev, sv, res[i]!)
    }
    const idx = fm.values.map((_, i) => i)
    return fm.modifiers.includes('all') ? idx.every(one) : idx.some(one)
}

function evalCond(rule: SigmaRule, c: Cond, event: Record<string, unknown>): boolean {
    const sel = (name: string): boolean =>
        Object.prototype.hasOwnProperty.call(rule.selections, name) &&
        rule.selections[name]!.some((map) => map.every((fm) => matchField(fm, event)))
    switch (c.op) {
        case 'and':
            return c.args.every((a) => evalCond(rule, a, event))
        case 'or':
            return c.args.some((a) => evalCond(rule, a, event))
        case 'not':
            return !evalCond(rule, c.arg, event)
        case 'sel':
            return sel(c.name)
        case 'of':
            return c.quant === 'all' ? c.names.every(sel) : c.names.some(sel)
    }
}

export function matchEvent(rule: SigmaRule, event: Record<string, unknown>): boolean {
    return evalCond(rule, rule.condition, event)
}

export function testRule(ruleText: string, events: Record<string, unknown>[], expect?: number[]): RuleTest {
    const parsed = parseSigma(ruleText)
    if (!parsed.ok) {
        return {
            passed: false,
            matched: [],
            missedExpected: [],
            unexpectedMatches: [],
            unsupported: parsed.unsupported,
            error: parsed.error
        }
    }
    const matched: number[] = []
    events.forEach((e, i) => {
        if (matchEvent(parsed.rule, e)) matched.push(i)
    })
    if (expect === undefined) {
        return { passed: null, matched, missedExpected: [], unexpectedMatches: [], unsupported: [] }
    }
    const bad = expect.find((i) => !Number.isInteger(i) || i < 0 || i >= events.length)
    if (bad !== undefined) {
        return {
            passed: false,
            matched,
            missedExpected: [],
            unexpectedMatches: [],
            unsupported: [],
            error: `expect index ${bad} is out of range`
        }
    }
    const want = new Set(expect)
    const missedExpected = [...want].filter((i) => !matched.includes(i)).sort((a, b) => a - b)
    const unexpectedMatches = matched.filter((i) => !want.has(i))
    return {
        passed: missedExpected.length === 0 && unexpectedMatches.length === 0,
        matched,
        missedExpected,
        unexpectedMatches,
        unsupported: []
    }
}
