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

/** One run between unescaped stars: its regex source and its fixed length in UTF-16 code units. */
interface Segment {
    src: string
    len: number
}

/** Split on unescaped `*`. `?` -> one char; `\*`, `\?`, `\\` are literals; every other metachar is escaped. */
function segmentsOf(value: string): Segment[] {
    const segs: Segment[] = [{ src: '', len: 0 }]
    for (let i = 0; i < value.length; i++) {
        const seg = segs[segs.length - 1]!
        const c = value[i]!
        const next = value[i + 1]
        if (c === '\\' && (next === '*' || next === '?' || next === '\\')) {
            seg.src += `\\${next}`
            seg.len++
            i++
        } else if (c === '*') segs.push({ src: '', len: 0 })
        else {
            seg.src += c === '?' ? '[\\s\\S]' : REGEX_META.test(c) ? `\\${c}` : c
            seg.len++
        }
    }
    return segs
}

/**
 * The one place a Sigma string value becomes a RegExp (flag `i`, never toLowerCase).
 * `*` -> any run, `?` -> one char; `\*`, `\?`, `\\` are literals; every other metachar is escaped.
 */
export function sigmaValueSource(value: string, position: Position): string {
    const out = segmentsOf(value)
        .map((s) => s.src)
        .join('[\\s\\S]*')
    if (position === 'none') return `^${out}$`
    if (position === 'startswith') return `^${out}`
    if (position === 'endswith') return `${out}$`
    return out
}

// Literal `[` is always escaped, so only a wildcard emits an unescaped `[\s\S]`.
export const hasWildcard = (value: string): boolean => sigmaValueSource(value, 'contains').includes('[\\s\\S]')

export function sigmaValueRegex(value: string, position: Position): RegExp {
    return new RegExp(sigmaValueSource(value, position), 'i')
}

/**
 * Glob match with no backtracking across stars: every segment has a fixed length, so taking the leftmost
 * occurrence of each in turn is correct and costs O(n·m). Flag `i` without `u` keeps lengths in code units.
 */
function globMatcher(segs: Segment[], position: Position): (text: string) => boolean {
    const last = segs.length - 1
    const anchorStart = position === 'none' || position === 'startswith'
    const anchorEnd = position === 'none' || position === 'endswith'
    const steps = segs.map((s, i) => {
        const sticky = (i === 0 && anchorStart) || (i === last && anchorEnd)
        return { len: s.len, re: s.len === 0 ? null : new RegExp(s.src, sticky ? 'iy' : 'ig') }
    })
    return (text) => {
        let pos = 0
        for (let i = 0; i <= last; i++) {
            const { len, re } = steps[i]!
            const at = i === last && anchorEnd ? text.length - len : pos
            if (at < pos) return false
            if (re === null) continue
            re.lastIndex = at
            const m = re.exec(text)
            if (m === null) return false
            pos = m.index + len
        }
        return true
    }
}

/** A Sigma string value as a predicate: values with an unescaped `*` use the linear glob matcher, others one regex. */
export function sigmaValueMatcher(value: string, position: Position): (text: string) => boolean {
    const segs = segmentsOf(value)
    if (segs.length > 1) return globMatcher(segs, position)
    const re = sigmaValueRegex(value, position)
    return (text) => re.test(text)
}

type Matcher = ((text: string) => boolean) | null

// Keyed on the FieldMatch objects a parse creates, so entries live and die with the rule.
const compiled = new WeakMap<FieldMatch, Matcher[]>()

function matchersFor(fm: FieldMatch): Matcher[] {
    let list = compiled.get(fm)
    if (list === undefined) {
        const position: Position = fm.modifiers.includes('contains')
            ? 'contains'
            : fm.modifiers.includes('startswith')
              ? 'startswith'
              : fm.modifiers.includes('endswith')
                ? 'endswith'
                : 'none'
        const isRe = fm.modifiers.includes('re')
        list = fm.values.map((v): Matcher => {
            if (v === null) return null
            if (!isRe) return sigmaValueMatcher(String(v), position)
            const re = new RegExp(String(v))
            return (text) => re.test(text)
        })
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

function matchScalar(ev: unknown, sv: SigmaValue, match: Matcher): boolean {
    if (sv === null || match === null) return ev === null || ev === undefined
    if (typeof ev !== 'string' && typeof ev !== 'number' && typeof ev !== 'boolean') return false
    return match(String(ev))
}

function matchField(fm: FieldMatch, event: Record<string, unknown>): boolean {
    const ev = lookup(event, fm.field)
    const res = matchersFor(fm)
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
