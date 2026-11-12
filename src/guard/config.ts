import type { Severity } from '../audit'
import { ConfigError } from '../config'
import { BUILTIN_RULES, type RuleSide } from './ids'

export interface CustomRule {
    id: string
    side: RuleSide
    severity: Severity
    re: RegExp
}
export interface GuardConfig {
    disabled: ReadonlySet<string>
    severity: ReadonlyMap<string, Severity> // effective severity for every enabled built-in and custom id
    custom: readonly CustomRule[]
}

const MAX_PATTERN = 256
const MAX_BOUND = 100
const MAX_SLACK = 128
const MAX_CUSTOM = 32

interface Frame {
    quant: boolean // contains a quantifier (at any depth)
    alt: boolean // contains a `|` (at any depth)
}

const UNBOUNDED = 'unbounded quantifier (use {n,m}, m ≤ 100)'

interface Last {
    group?: Frame
}

/** D11. Returns why a custom pattern is unsafe, or null when it is safe. */
export function unsafePatternReason(source: string, flags: string): string | null {
    if (source.length < 1 || source.length > MAX_PATTERN) return 'length must be 1-256'
    if (!/^[imsu]*$/.test(flags) || new Set(flags).size !== flags.length) {
        return 'flags must be a subset of imsu, no repeats'
    }

    const stack: Frame[] = [{ quant: false, alt: false }]
    let slack = 1 // product of (max - min + 1) over every quantified atom
    let last: Last | null = null // the atom a following quantifier applies to
    const top = (): Frame => stack[stack.length - 1]!

    const atom = (group?: Frame): void => {
        last = { group }
    }

    let i = 0
    while (i < source.length) {
        const c = source[i]!
        if (c === '\\') {
            const n = source[i + 1]
            if (n === undefined) return 'dangling escape'
            if (/[1-9]/.test(n) || (n === 'k' && source[i + 2] === '<')) return 'backreference'
            if (n === 'b' || n === 'B') {
                last = null
                i += 2
                continue
            }
            i += 2
            if ((n === 'p' || n === 'P' || n === 'u') && source[i] === '{') {
                // without the u flag these braces are a quantifier on a letter
                if (!flags.includes('u')) return 'escape needs the u flag'
                const close = source.indexOf('}', i)
                if (close === -1) return 'unbalanced braces'
                i = close + 1
            }
            atom()
            continue
        }
        if (c === '[') {
            // JS semantics: the class ends at the first unescaped `]` ("[]" is empty, "[^]" is any)
            i++
            if (source[i] === '^') i++
            for (;;) {
                if (i >= source.length) return 'unterminated class'
                if (source[i] === '\\') i += 2
                else if (source[i] === ']') break
                else i++
            }
            i++
            atom()
            continue
        }
        if (c === '(') {
            if (source[i + 1] === '?') {
                const n = source[i + 2]
                if (n === ':') i += 3
                else if (n === '<' && source[i + 3] !== '=' && source[i + 3] !== '!') {
                    const close = source.indexOf('>', i)
                    if (close === -1) return 'unbalanced group'
                    i = close + 1
                } else if (n === '=' || n === '!' || n === '<') return 'lookaround'
                else return 'unsupported group'
            } else i++
            stack.push({ quant: false, alt: false })
            last = null
            continue
        }
        if (c === ')') {
            if (stack.length === 1) return 'unbalanced group'
            const f = stack.pop()!
            i++
            atom(f)
            continue
        }
        if (c === '|') {
            for (const f of stack) f.alt = true
            last = null
            i++
            continue
        }
        if (c === '^' || c === '$') {
            last = null
            i++
            continue
        }
        // a quantifier?
        let min = 0
        let max = 0 // -1: unbounded
        let len = 0
        if (c === '*') [min, max, len] = [0, -1, 1]
        else if (c === '+') [min, max, len] = [1, -1, 1]
        else if (c === '?') [min, max, len] = [0, 1, 1]
        else if (c === '{') {
            const re = /\{(\d+)(?:(,)(\d*))?\}/y
            re.lastIndex = i
            const m = re.exec(source)
            if (m) {
                min = Number(m[1])
                max = m[2] === undefined ? min : m[3] === '' ? -1 : Number(m[3])
                len = m[0].length
                if (max === -1) return UNBOUNDED
                if (min > max) return 'does not compile'
                if (max > MAX_BOUND) return 'repetition bound over 100'
            }
        }
        if (len === 0) {
            i++
            atom()
            continue
        }
        if (max === -1) return UNBOUNDED
        const prev = last as Last | null
        if (prev === null) return 'quantifier without an atom'
        if (prev.group && (prev.group.quant || prev.group.alt)) return 'nested quantifier'
        for (const f of stack) f.quant = true
        slack *= max - min + 1
        if (slack > MAX_SLACK) return 'too much backtracking slack'
        i += len
        if (source[i] === '?') i++ // lazy modifier
        last = null
    }
    if (stack.length !== 1) return 'unbalanced group'
    try {
        new RegExp(source, flags)
    } catch {
        return 'does not compile'
    }
    return null
}

const isSeverity = (v: unknown): v is Severity => v === 'low' || v === 'medium' || v === 'high'
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function parseGuardRules(raw: unknown): GuardConfig {
    const bad = (reason: string): never => {
        throw new ConfigError('GUARD_RULES', reason)
    }
    const severity = new Map<string, Severity>()
    for (const [id, r] of Object.entries(BUILTIN_RULES)) severity.set(id, r.severity)

    if (raw === undefined) return { disabled: new Set(), severity, custom: [] }
    if (typeof raw !== 'string') return bad('GUARD_RULES must be a JSON string')
    if (raw.trim() === '') return { disabled: new Set(), severity, custom: [] }
    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch {
        return bad('GUARD_RULES is not valid JSON')
    }
    if (!isObj(parsed)) return bad('GUARD_RULES must be a JSON object')
    const noUnknown = (o: Record<string, unknown>, allowed: string[], where: string): void => {
        for (const k of Object.keys(o)) if (!allowed.includes(k)) bad(`${where} has an unknown key`)
    }
    noUnknown(parsed, ['disable', 'severity', 'custom'], 'GUARD_RULES')

    // custom rules first, so disable and severity can name them
    const custom: CustomRule[] = []
    const customIds = new Set<string>()
    if (parsed.custom !== undefined) {
        if (!Array.isArray(parsed.custom)) return bad('custom must be an array')
        if (parsed.custom.length > MAX_CUSTOM) return bad('custom holds at most 32 rules')
        parsed.custom.forEach((c: unknown, i: number) => {
            const w = `custom[${i}]`
            if (!isObj(c)) return bad(`${w} must be an object`)
            noUnknown(c, ['id', 'side', 'severity', 'pattern', 'flags'], w)
            if (typeof c.id !== 'string' || !/^custom\.[a-z0-9_.-]{1,48}$/.test(c.id)) {
                return bad(`${w}.id must match /^custom\\.[a-z0-9_.-]{1,48}$/`)
            }
            if (customIds.has(c.id)) return bad(`${w}.id is a duplicate`)
            if (c.side !== 'request' && c.side !== 'response') {
                return bad(`${w}.side must be "request" or "response"`)
            }
            if (c.severity !== undefined && !isSeverity(c.severity)) {
                return bad(`${w}.severity must be low, medium or high`)
            }
            if (typeof c.pattern !== 'string') return bad(`${w}.pattern must be a string`)
            if (c.flags !== undefined && typeof c.flags !== 'string') return bad(`${w}.flags must be a string`)
            const flags = c.flags ?? ''
            const why = unsafePatternReason(c.pattern, flags)
            if (why !== null) return bad(`${w}.pattern: ${why}`)
            customIds.add(c.id)
            custom.push({ id: c.id, side: c.side, severity: c.severity ?? 'medium', re: new RegExp(c.pattern, flags) })
        })
    }
    const known = (id: string): boolean => Object.prototype.hasOwnProperty.call(BUILTIN_RULES, id) || customIds.has(id)

    const disabled = new Set<string>()
    if (parsed.disable !== undefined) {
        if (!Array.isArray(parsed.disable)) return bad('disable must be an array')
        parsed.disable.forEach((id: unknown, i: number) => {
            if (typeof id !== 'string' || !known(id)) return bad(`disable[${i}] is not a known rule id`)
            disabled.add(id)
        })
    }

    for (const c of custom) severity.set(c.id, c.severity)
    if (parsed.severity !== undefined) {
        if (!isObj(parsed.severity)) return bad('severity must be an object')
        for (const [id, v] of Object.entries(parsed.severity)) {
            if (!known(id)) return bad('severity names an unknown rule id')
            if (!isSeverity(v)) return bad('severity values must be low, medium or high')
            severity.set(id, v)
        }
    }
    for (const id of disabled) severity.delete(id)
    return { disabled, severity, custom: custom.filter((c) => !disabled.has(c.id)) }
}
