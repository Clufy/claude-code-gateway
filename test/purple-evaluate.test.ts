import { describe, expect, it } from 'vitest'
import { matchEvent, sigmaValueRegex, testRule } from '../src/purple/evaluate'
import { parseSigma, type SigmaRule } from '../src/purple/sigma'

const HEAD = 'title: Test rule\nlogsource:\n  product: claude-proxy\n  category: prompt\n'

function ok(text: string): SigmaRule {
    const r = parseSigma(text)
    if (!r.ok) throw new Error(`expected ok, got ${r.error}`)
    return r.rule
}
/** Rule with one selection `s` built from YAML lines (indented under `s:`). */
const one = (lines: string[]) =>
    ok(`${HEAD}detection:\n  s:\n${lines.map((l) => `    ${l}`).join('\n')}\n  condition: s\n`)
const hit = (r: SigmaRule, e: Record<string, unknown>) => matchEvent(r, e)

describe('matchEvent', () => {
    it('looks up an exact own key first, else a dotted path through plain objects', () => {
        const r = one(['a.b: x'])
        expect(hit(r, { 'a.b': 'x' })).toBe(true)
        expect(hit(r, { a: { b: 'x' } })).toBe(true)
        expect(hit(r, { 'a.b': 'y', a: { b: 'x' } })).toBe(false)
        expect(hit(r, { a: ['x'] })).toBe(false)
        expect(hit(one(['toString: null']), {})).toBe(true)
        expect(hit(one(['toString: x']), {})).toBe(false)
    })

    it('compares strings case-insensitively with each position modifier', () => {
        expect(hit(one(['t: Hello']), { t: 'hELLO' })).toBe(true)
        expect(hit(one(['t: Hello']), { t: 'hello world' })).toBe(false)
        expect(hit(one(['t|contains: ell']), { t: 'HELLO' })).toBe(true)
        expect(hit(one(['t|startswith: he']), { t: 'HELLO' })).toBe(true)
        expect(hit(one(['t|startswith: lo']), { t: 'HELLO' })).toBe(false)
        expect(hit(one(['t|endswith: LO']), { t: 'hello' })).toBe(true)
        expect(hit(one(['t|endswith: he']), { t: 'hello' })).toBe(false)
    })

    it('matches wildcards and treats other regex metachars literally', () => {
        const r = one(["t: '*ignore*previous*'"])
        expect(hit(r, { t: 'Please IGNORE all previous text' })).toBe(true)
        expect(hit(r, { t: 'previous then ignore' })).toBe(false)
        expect(hit(one(["t: 'a?c'"]), { t: 'abc' })).toBe(true)
        expect(hit(one(["t: 'a?c'"]), { t: 'ac' })).toBe(false)
        expect(hit(one(["t: 'a.c'"]), { t: 'abc' })).toBe(false)
        expect(hit(one(["t: 'a*'"]), { t: 'a\nb' })).toBe(true)
    })

    it('escaped \\* and \\? match only literals', () => {
        const star = one(["t: 'a\\*b'"])
        expect(hit(star, { t: 'a*b' })).toBe(true)
        expect(hit(star, { t: 'axb' })).toBe(false)
        expect(hit(one(["t: 'a\\?b'"]), { t: 'a?b' })).toBe(true)
        expect(hit(one(["t: 'a\\?b'"]), { t: 'axb' })).toBe(false)
        expect(hit(one(["t: 'a\\\\b'"]), { t: 'a\\b' })).toBe(true)
    })

    it('re is case-sensitive with no flags', () => {
        const r = one(["t|re: '^ab{1,5}c$'"])
        expect(hit(r, { t: 'abbc' })).toBe(true)
        expect(hit(r, { t: 'ABBC' })).toBe(false)
        expect(hit(one(["t|re: 'b{2}'"]), { t: 'xabbc' })).toBe(true)
    })

    it('compares number and boolean event values as String(v)', () => {
        expect(hit(one(['n: 42']), { n: 42 })).toBe(true)
        expect(hit(one(['n: 42']), { n: '42' })).toBe(true)
        expect(hit(one(['n: 42']), { n: 43 })).toBe(false)
        expect(hit(one(['b: true']), { b: true })).toBe(true)
        expect(hit(one(['b: true']), { b: false })).toBe(false)
        expect(hit(one(['n|startswith: 4']), { n: 42 })).toBe(true)
    })

    it('matches an array event value when any element matches', () => {
        const r = one(['t: x'])
        expect(hit(r, { t: ['a', 'X'] })).toBe(true)
        expect(hit(r, { t: ['a', 'b'] })).toBe(false)
        expect(hit(one(['n: 5']), { n: [1, 5] })).toBe(true)
        expect(hit(one(['b: false']), { b: [true, false] })).toBe(true)
        expect(hit(r, { t: [] })).toBe(false)
    })

    it('never matches an object event value', () => {
        expect(hit(one(['t|contains: o']), { t: { o: 'o' } })).toBe(false)
        expect(hit(one(['t: null']), { t: { o: 1 } })).toBe(false)
    })

    it('Sigma null matches a missing or null field; other values never match missing', () => {
        const r = one(['t: null'])
        expect(hit(r, {})).toBe(true)
        expect(hit(r, { t: null })).toBe(true)
        expect(hit(r, { t: '' })).toBe(false)
        expect(hit(one(['t: x']), {})).toBe(false)
        expect(hit(one(['t: x']), { t: null })).toBe(false)
        expect(hit(one(["t|contains: ''"]), {})).toBe(false)
    })

    it('ORs a list of values; all requires every value', () => {
        const any = one(['t|contains: [foo, bar]'])
        expect(hit(any, { t: 'a bar' })).toBe(true)
        expect(hit(any, { t: 'baz' })).toBe(false)
        const all = one(['t|contains|all: [foo, bar]'])
        expect(hit(all, { t: 'foo bar' })).toBe(true)
        expect(hit(all, { t: 'foo' })).toBe(false)
        expect(hit(all, { t: ['foo', 'bar'] })).toBe(true)
    })

    it('ORs maps in a selection list and ANDs fields inside a map', () => {
        const r = one(['- a: 1', '  b: 2', '- c: 3'])
        expect(hit(r, { a: 1, b: 2 })).toBe(true)
        expect(hit(r, { a: 1 })).toBe(false)
        expect(hit(r, { c: 3 })).toBe(true)
    })

    it('evaluates conditions: and, or, not, 1 of, all of', () => {
        const d = (cond: string) => ok(`${HEAD}detection:\n  s1:\n    a: 1\n  s2:\n    b: 2\n  condition: ${cond}\n`)
        expect(hit(d('s1 and s2'), { a: 1, b: 2 })).toBe(true)
        expect(hit(d('s1 and s2'), { a: 1 })).toBe(false)
        expect(hit(d('s1 or s2'), { b: 2 })).toBe(true)
        expect(hit(d('s1 and not s2'), { a: 1 })).toBe(true)
        expect(hit(d('s1 and not s2'), { a: 1, b: 2 })).toBe(false)
        expect(hit(d('1 of them'), { b: 2 })).toBe(true)
        expect(hit(d('all of them'), { b: 2 })).toBe(false)
        expect(hit(d('all of s*'), { a: 1, b: 2 })).toBe(true)
    })
})

describe('sigmaValueRegex', () => {
    it('builds a deterministic case-insensitive regex', () => {
        expect(sigmaValueRegex('a.b*', 'none').source).toBe('^a\\.b[\\s\\S]*$')
        expect(sigmaValueRegex('a.b*', 'none').flags).toBe('i')
        expect(sigmaValueRegex('x\\*', 'contains').source).toBe('x\\*')
        expect(sigmaValueRegex('x?', 'startswith').source).toBe('^x[\\s\\S]')
        expect(sigmaValueRegex('x', 'endswith').source).toBe('x$')
    })
})

describe('testRule', () => {
    const text = `${HEAD}detection:\n  s:\n    t|contains: bad\n  condition: s\n`
    const events = [{ t: 'bad one' }, { t: 'fine' }, { t: 'BAD two' }]

    it('passes when matches equal expect', () => {
        expect(testRule(text, events, [0, 2])).toEqual({
            passed: true,
            matched: [0, 2],
            missedExpected: [],
            unexpectedMatches: [],
            unsupported: []
        })
    })

    it('reports missed expected events', () => {
        const r = testRule(text, events, [0, 1, 2])
        expect(r.passed).toBe(false)
        expect(r.missedExpected).toEqual([1])
        expect(r.unexpectedMatches).toEqual([])
    })

    it('reports unexpected matches', () => {
        const r = testRule(text, events, [0])
        expect(r.passed).toBe(false)
        expect(r.missedExpected).toEqual([])
        expect(r.unexpectedMatches).toEqual([2])
    })

    it('gives passed null without expect', () => {
        const r = testRule(text, events)
        expect(r.passed).toBeNull()
        expect(r.matched).toEqual([0, 2])
    })

    it('copies a failed parse', () => {
        const r = testRule(`${HEAD}detection:\n  s:\n    t|base64: x\n  condition: s\n`, events, [0])
        expect(r.passed).toBe(false)
        expect(r.matched).toEqual([])
        expect(r.error).toBe('unsupported Sigma features')
        expect(r.unsupported).toEqual(['modifier:base64'])
        const hard = testRule('- not a map', events)
        expect(hard.unsupported).toEqual([])
        expect(hard.error).toBe('rule must be a YAML map')
    })

    it('rejects an out-of-range expect index', () => {
        const r = testRule(text, events, [0, 3])
        expect(r.passed).toBe(false)
        expect(r.error).toBe('expect index 3 is out of range')
        expect(testRule(text, events, [-1]).error).toBe('expect index -1 is out of range')
    })
})
