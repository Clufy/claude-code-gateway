import { unsafePatternReason } from './regex-safety.ts'

const OWASP = new Set(['LLM01', 'LLM02', 'LLM03', 'LLM04', 'LLM05', 'LLM06', 'LLM07', 'LLM08', 'LLM09', 'LLM10'])
const ID_RE = /^[a-z0-9-]{3,64}$/
const CANARY_RE = /^CANARY-[a-z0-9]{4,12}$/

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'

function checkPattern(errs: string[], field: string, source: unknown, flags: unknown): void {
    if (!isStr(source)) return void errs.push(`${field} must be a string`)
    if (flags !== undefined && !isStr(flags)) return void errs.push(`${field}: flags must be a string`)
    const why = unsafePatternReason(source, flags ?? '')
    if (why) errs.push(`${field}: ${why}`)
}

/** Returns validation errors, each naming the field. Empty means valid. */
export function validateCase(x: unknown): string[] {
    if (!isObj(x)) return ['case must be an object']
    const errs: string[] = []
    if (!isStr(x.id) || !ID_RE.test(x.id)) errs.push('id must match /^[a-z0-9-]{3,64}$/')
    if (!isStr(x.suite) || x.suite === '') errs.push('suite must be a non-empty string')
    if (!isStr(x.owasp) || !OWASP.has(x.owasp)) errs.push('owasp must be LLM01..LLM10')
    if (!isStr(x.title) || x.title === '') errs.push('title must be a non-empty string')
    if (x.system !== undefined && !isStr(x.system)) errs.push('system must be a string')

    const hasTools = Array.isArray(x.tools) && x.tools.length > 0
    if (x.tools !== undefined) {
        if (!Array.isArray(x.tools)) errs.push('tools must be an array')
        else
            x.tools.forEach((t, i) => {
                if (!isObj(t) || !isStr(t.name) || !isStr(t.description) || !isObj(t.input_schema)) {
                    errs.push(`tools[${i}] needs name, description and input_schema`)
                }
            })
    }

    if (!Array.isArray(x.turns) || x.turns.length < 1 || x.turns.length > 12) {
        errs.push('turns must hold 1-12 turns')
    } else {
        x.turns.forEach((t, i) => {
            if (!isObj(t) || !isStr(t.content)) return void errs.push(`turns[${i}] needs string content`)
            if (t.role === 'tool_result') {
                if (!isStr(t.tool)) errs.push(`turns[${i}].tool must be a string`)
                if (!hasTools) errs.push(`turns[${i}] is a tool_result but tools is not declared`)
            } else if (t.role !== 'user' && t.role !== 'assistant') errs.push(`turns[${i}].role is invalid`)
        })
        const last = x.turns[x.turns.length - 1]
        if (isObj(last) && last.role === 'assistant') errs.push('turns: last turn must be user or tool_result')
    }

    if (x.systemCanary !== undefined && (!isStr(x.systemCanary) || !CANARY_RE.test(x.systemCanary))) {
        errs.push('systemCanary must match /^CANARY-[a-z0-9]{4,12}$/')
    }

    const s = x.scorer
    if (!isObj(s)) errs.push('scorer must be an object')
    else if (s.type === 'contains_canary') {
        if (!isStr(s.canary) || !CANARY_RE.test(s.canary))
            errs.push('scorer.canary must match /^CANARY-[a-z0-9]{4,12}$/')
    } else if (s.type === 'regex') checkPattern(errs, 'scorer.pattern', s.pattern, s.flags)
    else if (s.type === 'tool_called') {
        if (!isStr(s.tool) || s.tool === '') errs.push('scorer.tool must be a non-empty string')
        checkPattern(errs, 'scorer.argPattern', s.argPattern, '')
    } else if (s.type === 'judge') {
        if (!isStr(s.criterion) || s.criterion === '') errs.push('scorer.criterion must be a non-empty string')
    } else if (s.type !== 'refusal_expected') errs.push('scorer.type is unknown')
    return errs
}
