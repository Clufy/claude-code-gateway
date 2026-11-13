import { parse } from 'yaml'
import { isObj } from '../engagement'
import { unsafePatternReason } from '../guard/config'

export type Modifier = 'contains' | 'startswith' | 'endswith' | 're' | 'all'
export type SigmaValue = string | number | boolean | null
export interface FieldMatch {
    field: string
    modifiers: Modifier[]
    values: SigmaValue[]
}
/** OR over maps; each map is an AND over its FieldMatches. */
export type Selection = FieldMatch[][]
export type Cond =
    | { op: 'and' | 'or'; args: Cond[] }
    | { op: 'not'; arg: Cond }
    | { op: 'sel'; name: string }
    | { op: 'of'; quant: 'one' | 'all'; names: string[] }
export interface SigmaRule {
    title: string
    id?: string
    level?: string
    logsource: Record<string, string>
    selections: Record<string, Selection>
    condition: Cond
}
export type SigmaParse = { ok: true; rule: SigmaRule } | { ok: false; error: string; unsupported: string[] }
export const MAX_RULE_BYTES = 16384
/** logsource.product for this proxy; category → guard side for session traffic. */
export const PROXY_PRODUCT = 'claude-proxy'
export const SESSION_CATEGORIES = { prompt: 'request', tool_use: 'response' } as const

const MODIFIERS: readonly string[] = ['contains', 'startswith', 'endswith', 're', 'all']
const POSITION: readonly Modifier[] = ['contains', 'startswith', 'endswith']
const KEYWORDS = new Set(['and', 'or', 'not', 'of', 'them', 'near'])
const NAME = /^[A-Za-z0-9_]+$/
const MAX_DEPTH = 32 // nested parentheses plus `not`s in one condition

/** Thrown inside the parser for a hard error; never escapes parseSigma. */
class RuleError extends Error {}

const clip = (s: string, n = 60): string => (s.length > n ? s.slice(0, n) : s)
const isScalar = (v: unknown): v is SigmaValue =>
    v === null || typeof v === 'string' || Number.isFinite(v) || typeof v === 'boolean'

export function parseSigma(text: string): SigmaParse {
    const fail = (error: string, unsupported: string[] = []): SigmaParse => ({ ok: false, error, unsupported })
    if (new TextEncoder().encode(text).length > MAX_RULE_BYTES) return fail(`rule exceeds ${MAX_RULE_BYTES} bytes`)

    let doc: unknown
    try {
        // logLevel 'error' still throws on errors but keeps warnings (and the untrusted text in them) out of logs
        doc = parse(text, { maxAliasCount: 50, uniqueKeys: true, logLevel: 'error' })
    } catch (e) {
        if ((e as { code?: unknown }).code === 'MULTIPLE_DOCS')
            return fail('unsupported Sigma features', ['multi-document'])
        const msg = e instanceof Error ? e.message : String(e)
        return fail(`invalid YAML: ${clip(msg.split('\n')[0] ?? '', 200)}`)
    }
    if (!isObj(doc)) return fail('rule must be a YAML map')

    const unsupported: string[] = []
    const flag = (u: string): void => {
        if (!unsupported.includes(u)) unsupported.push(u)
    }
    try {
        const rule = build(doc, flag)
        return unsupported.length > 0 ? fail('unsupported Sigma features', unsupported) : { ok: true, rule }
    } catch (e) {
        if (e instanceof RuleError) return fail(e.message)
        throw e
    }
}

function build(doc: Record<string, unknown>, flag: (u: string) => void): SigmaRule {
    const { title, id, level, logsource, detection } = doc
    if (typeof title !== 'string' || title.trim() === '') throw new RuleError('title must be a non-empty string')
    if (id !== undefined && typeof id !== 'string') throw new RuleError('id must be a string')
    if (level !== undefined && typeof level !== 'string') throw new RuleError('level must be a string')
    if (!isObj(logsource) || !Object.values(logsource).every((v) => typeof v === 'string')) {
        throw new RuleError('logsource must be a map of strings')
    }
    if (!isObj(detection)) throw new RuleError('detection must be a map')
    if (detection.condition === undefined) throw new RuleError('detection.condition is required')
    const conds = typeof detection.condition === 'string' ? [detection.condition] : detection.condition
    if (!Array.isArray(conds) || conds.length === 0 || !conds.every((c) => typeof c === 'string')) {
        throw new RuleError('detection.condition must be a string or a list of strings')
    }

    const names: string[] = []
    const selections: Record<string, Selection> = {}
    for (const [name, value] of Object.entries(detection)) {
        if (name === 'condition' || name === 'timeframe') continue
        names.push(name)
        const sel = selection(`detection.${clip(name)}`, value, flag)
        // defineProperty: a selection named `__proto__` must stay an own key, not replace the prototype
        if (sel !== null) Object.defineProperty(selections, name, { value: sel, enumerable: true, writable: true })
    }

    const parsed = (conds as string[]).map((c) => condition(c, names, flag))
    if (detection.timeframe !== undefined || doc.timeframe !== undefined) flag('timeframe')
    if (doc.correlation !== undefined) flag('correlation')

    return {
        title,
        ...(id === undefined ? {} : { id }),
        ...(level === undefined ? {} : { level }),
        logsource: logsource as Record<string, string>,
        selections,
        condition: parsed.length === 1 ? parsed[0]! : { op: 'or', args: parsed }
    }
}

/** A selection, or null for a keyword selection (flagged unsupported). */
function selection(where: string, value: unknown, flag: (u: string) => void): Selection | null {
    const shape = `${where} must be a map, a list of maps, or keywords`
    if (isScalar(value) && value !== null) {
        flag('keywords')
        return null
    }
    if (isObj(value)) return [fieldMap(where, value, flag)]
    if (!Array.isArray(value) || value.length === 0) throw new RuleError(shape)
    if (value.every((v) => isScalar(v) && v !== null)) {
        flag('keywords')
        return null
    }
    if (!value.every(isObj)) throw new RuleError(shape)
    return value.map((m) => fieldMap(where, m, flag))
}

function fieldMap(where: string, map: Record<string, unknown>, flag: (u: string) => void): FieldMatch[] {
    const entries = Object.entries(map)
    if (entries.length === 0) throw new RuleError(`${where} must not be an empty map`)
    return entries.map(([key, raw]) => {
        const [field = '', ...mods] = key.split('|')
        if (field === '') throw new RuleError(`${where}.${clip(key)} needs a field name`)
        const at = `${where}.${clip(field)}`
        const modifiers: Modifier[] = []
        for (const m of mods) {
            if (m === '') throw new RuleError(`${at} has an empty modifier`)
            if (MODIFIERS.includes(m)) modifiers.push(m as Modifier)
            else flag(`modifier:${clip(m, 40)}`)
        }
        const position = POSITION.filter((m) => modifiers.includes(m))
        if (modifiers.includes('re') && position.length > 0) {
            throw new RuleError(`${at}: re cannot be combined with ${position.join(', ')}`)
        }
        if (position.length > 1) throw new RuleError(`${at}: conflicting modifiers ${position.join(', ')}`)

        const values = Array.isArray(raw) ? raw : [raw]
        if (values.length === 0 || !values.every(isScalar)) {
            throw new RuleError(`${at} must be a scalar or a non-empty list of scalars`)
        }
        if (modifiers.includes('re')) {
            for (const v of values) {
                const why = typeof v === 'string' ? unsafePatternReason(v, '') : 'must be a string'
                if (why !== null) throw new RuleError(`re pattern "${clip(String(v))}": ${why}`)
            }
        }
        return { field, modifiers, values }
    })
}

/** Recursive descent over `or` < `and` < `not` < atom; `|` and `near` are flagged, never evaluated. */
function condition(text: string, names: readonly string[], flag: (u: string) => void): Cond {
    const pipe = text.indexOf('|')
    if (pipe >= 0) {
        flag('aggregation')
        if (/(^|[\s()])near([\s()]|$)/.test(text.slice(pipe + 1))) flag('near')
    }
    const tokens = (pipe >= 0 ? text.slice(0, pipe) : text)
        .replace(/[()]/g, ' $& ')
        .split(/\s+/)
        .filter((t) => t !== '')
    let pos = 0
    const peek = (): string | undefined => tokens[pos]
    const bad = (why: string): RuleError => new RuleError(`condition: ${why}`)
    const unexpected = (t: string | undefined): RuleError =>
        bad(t === undefined ? 'unexpected end' : `unexpected token "${clip(t)}"`)
    const deeper = (depth: number): number => {
        if (depth >= MAX_DEPTH) throw bad(`nests deeper than ${MAX_DEPTH}`)
        return depth + 1
    }

    const or = (depth: number): Cond => {
        const args = [and(depth)]
        while (peek() === 'or') {
            pos++
            args.push(and(depth))
        }
        return args.length === 1 ? args[0]! : { op: 'or', args }
    }
    const and = (depth: number): Cond => {
        const args = [not(depth)]
        while (peek() === 'and' || peek() === 'near') {
            if (tokens[pos++] === 'near') flag('near')
            args.push(not(depth))
        }
        return args.length === 1 ? args[0]! : { op: 'and', args }
    }
    const not = (depth: number): Cond => {
        if (peek() !== 'not') return atom(depth)
        pos++
        return { op: 'not', arg: not(deeper(depth)) }
    }
    const atom = (depth: number): Cond => {
        const t = tokens[pos++]
        if (t === '(') {
            const inner = or(deeper(depth))
            if (tokens[pos++] !== ')') throw unexpected(tokens[pos - 1])
            return inner
        }
        if (t !== undefined && (t === 'all' || /^\d+$/.test(t)) && peek() === 'of') {
            pos++
            if (t !== 'all' && t !== '1') flag(`of:${clip(t, 10)}`)
            return { op: 'of', quant: t === 'all' ? 'all' : 'one', names: target(tokens[pos++]) }
        }
        if (t === undefined || KEYWORDS.has(t) || !NAME.test(t)) throw unexpected(t)
        if (!names.includes(t)) throw bad(`unknown selection "${clip(t)}"`)
        return { op: 'sel', name: t }
    }
    const target = (t: string | undefined): string[] => {
        if (t === 'them' || t === '*') {
            // Sigma: names starting with `_` are helpers, left out of `them`
            const all = names.filter((n) => !n.startsWith('_'))
            if (all.length === 0) throw bad(`"${t}" matches no selection`)
            return all
        }
        if (t !== undefined && t.endsWith('*') && NAME.test(t.slice(0, -1))) {
            const prefix = t.slice(0, -1)
            const hits = names.filter((n) => n.startsWith(prefix))
            if (hits.length === 0) throw bad(`no selection matches "${clip(t)}"`)
            return hits
        }
        if (t === undefined || KEYWORDS.has(t) || !NAME.test(t)) throw unexpected(t)
        if (!names.includes(t)) throw bad(`unknown selection "${clip(t)}"`)
        return [t]
    }

    const cond = or(0)
    if (pos < tokens.length) throw unexpected(peek())
    return cond
}
