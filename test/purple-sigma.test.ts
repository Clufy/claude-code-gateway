import { describe, expect, it } from 'vitest'
import { MAX_RULE_BYTES, parseSigma, type SigmaParse, type SigmaRule } from '../src/purple/sigma'

const HEAD = 'title: Test rule\nlogsource:\n  product: claude-proxy\n  category: prompt\n'

function ok(text: string): SigmaRule {
    const r = parseSigma(text)
    if (!r.ok) throw new Error(`expected ok, got ${r.error} [${r.unsupported.join(', ')}]`)
    return r.rule
}
function bad(text: string): Extract<SigmaParse, { ok: false }> {
    const r = parseSigma(text)
    if (r.ok) throw new Error('expected a failed parse')
    return r
}
const rule = (detection: string, extra = '') => `${HEAD}${extra}detection:\n${detection}`

describe('parseSigma', () => {
    it('parses a full rule into selections and an exact Cond tree', () => {
        const r = ok(
            [
                'title: Prompt injection marker',
                'id: 5d2c7e1a-0000-4000-8000-000000000001',
                'level: high',
                'logsource:',
                '  product: claude-proxy',
                '  category: prompt',
                'detection:',
                '  sel1:',
                '    text|contains|all:',
                "      - 'ignore'",
                "      - 'previous'",
                '    role: user',
                '  sel2:',
                '    - tool: [Read, Grep]',
                '    - path|endswith: .md',
                '  condition: sel1 and not sel2',
                ''
            ].join('\n')
        )
        expect(r).toEqual({
            title: 'Prompt injection marker',
            id: '5d2c7e1a-0000-4000-8000-000000000001',
            level: 'high',
            logsource: { product: 'claude-proxy', category: 'prompt' },
            selections: {
                sel1: [
                    [
                        { field: 'text', modifiers: ['contains', 'all'], values: ['ignore', 'previous'] },
                        { field: 'role', modifiers: [], values: ['user'] }
                    ]
                ],
                sel2: [
                    [{ field: 'tool', modifiers: [], values: ['Read', 'Grep'] }],
                    [{ field: 'path', modifiers: ['endswith'], values: ['.md'] }]
                ]
            },
            condition: {
                op: 'and',
                args: [
                    { op: 'sel', name: 'sel1' },
                    { op: 'not', arg: { op: 'sel', name: 'sel2' } }
                ]
            }
        })
    })

    it('keeps scalar types and null values', () => {
        const r = ok(rule('  sel:\n    n: 5\n    b: true\n    z: null\n  condition: sel\n'))
        expect(r.selections.sel).toEqual([
            [
                { field: 'n', modifiers: [], values: [5] },
                { field: 'b', modifiers: [], values: [true] },
                { field: 'z', modifiers: [], values: [null] }
            ]
        ])
        expect(r.id).toBeUndefined()
        expect(r.level).toBeUndefined()
    })

    it('expands 1 of sel_* to the matching names in key order', () => {
        const r = ok(
            rule('  sel_b:\n    a: 1\n  other:\n    a: 2\n  sel_a:\n    a: 3\n  condition: 1 of sel_* or other\n')
        )
        expect(r.condition).toEqual({
            op: 'or',
            args: [
                { op: 'of', quant: 'one', names: ['sel_b', 'sel_a'] },
                { op: 'sel', name: 'other' }
            ]
        })
    })

    it('keeps a selection named __proto__ as an own key', () => {
        const r = ok(rule('  __proto__:\n    x: 1\n  condition: __proto__\n'))
        expect(Object.getPrototypeOf(r.selections)).toBe(Object.prototype)
        expect(Object.keys(r.selections)).toEqual(['__proto__'])
        expect(r.condition).toEqual({ op: 'sel', name: '__proto__' })
    })

    it('expands all of them to every selection', () => {
        const r = ok(rule('  a:\n    x: 1\n  b:\n    x: 2\n  condition: all of them\n'))
        expect(r.condition).toEqual({ op: 'of', quant: 'all', names: ['a', 'b'] })
    })

    it('leaves names starting with _ out of them', () => {
        const sels = '  _helper:\n    x: 0\n  a:\n    x: 1\n  b:\n    x: 2\n'
        expect(ok(rule(`${sels}  condition: 1 of them and not _helper\n`)).condition).toEqual({
            op: 'and',
            args: [
                { op: 'of', quant: 'one', names: ['a', 'b'] },
                { op: 'not', arg: { op: 'sel', name: '_helper' } }
            ]
        })
        expect(ok(rule(`${sels}  condition: all of them\n`)).condition).toEqual({
            op: 'of',
            quant: 'all',
            names: ['a', 'b']
        })
        expect(bad(rule('  _only:\n    x: 1\n  condition: all of them\n')).error).toBe(
            'condition: "them" matches no selection'
        )
    })

    it('treats a bare * like them', () => {
        const sels = '  _helper:\n    x: 0\n  a:\n    x: 1\n  b:\n    x: 2\n'
        expect(ok(rule(`${sels}  condition: 1 of *\n`)).condition).toEqual({
            op: 'of',
            quant: 'one',
            names: ['a', 'b']
        })
        expect(ok(rule(`${sels}  condition: all of *\n`)).condition).toEqual({
            op: 'of',
            quant: 'all',
            names: ['a', 'b']
        })
        expect(bad(rule('  _only:\n    x: 1\n  condition: 1 of *\n')).error).toBe('condition: "*" matches no selection')
        // an explicit _ prefix still reaches _ names
        expect(ok(rule(`${sels}  condition: 1 of _h*\n`)).condition).toEqual({
            op: 'of',
            quant: 'one',
            names: ['_helper']
        })
    })

    it('accepts all of / 1 of a single name', () => {
        expect(ok(rule('  a:\n    x: 1\n  condition: all of a\n')).condition).toEqual({
            op: 'of',
            quant: 'all',
            names: ['a']
        })
    })

    it('turns a list condition into or', () => {
        const r = ok(rule('  a:\n    x: 1\n  b:\n    x: 2\n  condition:\n    - a\n    - b and a\n'))
        expect(r.condition).toEqual({
            op: 'or',
            args: [
                { op: 'sel', name: 'a' },
                {
                    op: 'and',
                    args: [
                        { op: 'sel', name: 'b' },
                        { op: 'sel', name: 'a' }
                    ]
                }
            ]
        })
    })

    it('honours precedence: or < and < not, with parentheses', () => {
        const r = ok(rule('  a:\n    x: 1\n  b:\n    x: 2\n  c:\n    x: 3\n  condition: a or b and not c\n'))
        expect(r.condition).toEqual({
            op: 'or',
            args: [
                { op: 'sel', name: 'a' },
                {
                    op: 'and',
                    args: [
                        { op: 'sel', name: 'b' },
                        { op: 'not', arg: { op: 'sel', name: 'c' } }
                    ]
                }
            ]
        })
        const p = ok(rule('  a:\n    x: 1\n  b:\n    x: 2\n  c:\n    x: 3\n  condition: (a or b) and c and a\n'))
        expect(p.condition).toEqual({
            op: 'and',
            args: [
                {
                    op: 'or',
                    args: [
                        { op: 'sel', name: 'a' },
                        { op: 'sel', name: 'b' }
                    ]
                },
                { op: 'sel', name: 'c' },
                { op: 'sel', name: 'a' }
            ]
        })
    })

    it('rejects a scalar YAML document', () => {
        expect(bad('"hello"')).toEqual({ ok: false, error: 'rule must be a YAML map', unsupported: [] })
    })

    it('rejects a YAML list', () => {
        expect(bad('- a\n- b\n').error).toBe('rule must be a YAML map')
    })

    it('rejects an empty document', () => {
        expect(bad('').error).toBe('rule must be a YAML map')
    })

    it('turns an alias bomb into an invalid YAML error without throwing', () => {
        const text = `a: &a x\nb: [${Array(100).fill('*a').join(', ')}]\n`
        const r = bad(text)
        expect(r.error.startsWith('invalid YAML: ')).toBe(true)
        expect(r.error.length).toBeLessThanOrEqual('invalid YAML: '.length + 200)
        expect(r.error).not.toContain('\n')
    })

    it('reports YAML syntax errors and duplicate keys as invalid YAML', () => {
        expect(bad('title: [unclosed\n').error).toMatch(/^invalid YAML: /)
        expect(bad('title: a\ntitle: b\n').error).toMatch(/^invalid YAML: /)
    })

    it('reports deep nesting without throwing', () => {
        expect(bad('a: ' + '['.repeat(8000) + ']'.repeat(8000)).error).toMatch(/^invalid YAML: /)
    })

    it('marks two documents as unsupported', () => {
        expect(bad(rule('  a:\n    x: 1\n  condition: a\n') + '---\ntitle: second\n')).toEqual({
            ok: false,
            error: 'unsupported Sigma features',
            unsupported: ['multi-document']
        })
    })

    it('lists every unsupported feature in the order encountered', () => {
        const text = rule(
            '  selection:\n    payload|base64offset|contains: abc\n  condition: selection | count() > 5\n'
        )
        expect(bad(text + 'timeframe: 5m\n')).toEqual({
            ok: false,
            error: 'unsupported Sigma features',
            unsupported: ['modifier:base64offset', 'aggregation', 'timeframe']
        })
    })

    it('marks correlation, detection.timeframe, near and N of as unsupported', () => {
        expect(bad(rule('  a:\n    x: 1\n  timeframe: 1h\n  condition: a\n')).unsupported).toEqual(['timeframe'])
        expect(
            bad(rule('  a:\n    x: 1\n  condition: a\n') + 'correlation:\n  type: event_count\n').unsupported
        ).toEqual(['correlation'])
        expect(bad(rule('  a:\n    x: 1\n  b:\n    x: 2\n  condition: a near b\n')).unsupported).toEqual(['near'])
        expect(bad(rule('  a:\n    x: 1\n  b:\n    x: 2\n  condition: 2 of them\n')).unsupported).toEqual(['of:2'])
    })

    it('lists repeated unsupported features once', () => {
        const r = bad(rule('  a:\n    x|utf16|base64: 1\n    y|utf16: 2\n  condition: a\n'))
        expect(r.unsupported).toEqual(['modifier:utf16', 'modifier:base64'])
    })

    it('marks keyword selections as unsupported', () => {
        expect(bad(rule('  kw:\n    - ignore previous\n    - jailbreak\n  condition: kw\n'))).toEqual({
            ok: false,
            error: 'unsupported Sigma features',
            unsupported: ['keywords']
        })
        expect(bad(rule('  kw: jailbreak\n  condition: kw\n')).unsupported).toEqual(['keywords'])
    })

    it('rejects a catastrophic re pattern with the guard reason', () => {
        const r = bad(rule("  a:\n    x|re: '(a+)+$'\n  condition: a\n"))
        expect(r.error).toContain('re pattern "(a+)+$": ')
        expect(r.unsupported).toEqual([])
    })

    it('truncates the re pattern in the error to 60 chars', () => {
        const long = 'a'.repeat(300)
        expect(bad(rule(`  a:\n    x|re: '${long}'\n  condition: a\n`)).error).toBe(
            `re pattern "${'a'.repeat(60)}": length must be 1-256`
        )
    })

    it('rejects an unsafe re pattern that is not the first value', () => {
        expect(bad(rule("  a:\n    x|re: ['^a$', '(a+)+$']\n  condition: a\n")).error).toContain(
            're pattern "(a+)+$": '
        )
    })

    it('rejects non-finite numbers as values', () => {
        for (const v of ['.nan', '.inf', '-.inf', '[1, .nan]']) {
            expect(bad(rule(`  a:\n    x: ${v}\n  condition: a\n`)).error, v).toBe(
                'detection.a.x must be a scalar or a non-empty list of scalars'
            )
        }
    })

    it('rejects a non-string re value', () => {
        expect(bad(rule('  a:\n    x|re: 5\n  condition: a\n')).error).toMatch(/^re pattern "5": /)
    })

    it('accepts a safe re pattern', () => {
        expect(ok(rule("  a:\n    x|re: '^ab{1,5}c$'\n  condition: a\n")).selections.a).toEqual([
            [{ field: 'x', modifiers: ['re'], values: ['^ab{1,5}c$'] }]
        ])
    })

    it('rejects re combined with contains, startswith or endswith', () => {
        for (const m of ['contains', 'startswith', 'endswith']) {
            expect(bad(rule(`  a:\n    x|re|${m}: abc\n  condition: a\n`)).error).toBe(
                `detection.a.x: re cannot be combined with ${m}`
            )
        }
    })

    it('names an unknown selection in the condition', () => {
        expect(bad(rule('  sel:\n    x: 1\n  condition: sel and missing\n')).error).toContain('missing')
    })

    it('rejects a prefix that matches no selection', () => {
        expect(bad(rule('  sel:\n    x: 1\n  condition: 1 of nope_*\n')).error).toContain('nope_*')
    })

    it('rejects malformed conditions', () => {
        const sel = '  a:\n    x: 1\n'
        for (const c of ['a and', '(a', 'a)', 'not', 'a b', '1 of', 'and a', '"a"', 'AND']) {
            const r = parseSigma(rule(`${sel}  condition: '${c}'\n`))
            expect(r.ok, c).toBe(false)
            if (!r.ok) expect(r.unsupported, c).toEqual([])
        }
    })

    it('rejects deeply nested conditions without throwing', () => {
        const r = bad(rule(`  a:\n    x: 1\n  condition: '${'('.repeat(2000)}a${')'.repeat(2000)}'\n`))
        expect(r.error).toMatch(/condition/)
        const n = bad(rule(`  a:\n    x: 1\n  condition: '${'not '.repeat(2000)}a'\n`))
        expect(n.error).toMatch(/condition/)
    })

    it('rejects input over MAX_RULE_BYTES before parsing', () => {
        expect(MAX_RULE_BYTES).toBe(16384)
        const text = '#'.repeat(16385)
        expect(bad(text)).toEqual({ ok: false, error: 'rule exceeds 16384 bytes', unsupported: [] })
        // counted in UTF-8 bytes, not chars
        expect(bad('#' + 'é'.repeat(8192)).error).toBe('rule exceeds 16384 bytes')
        expect(parseSigma('#'.repeat(16384)).ok).toBe(false)
        expect(bad('#'.repeat(16384)).error).toBe('rule must be a YAML map')
    })

    it('names the missing or malformed required key', () => {
        const det = 'detection:\n  a:\n    x: 1\n  condition: a\n'
        const log = 'logsource:\n  product: claude-proxy\n'
        expect(bad(`${log}${det}`).error).toBe('title must be a non-empty string')
        expect(bad(`title: '  '\n${log}${det}`).error).toBe('title must be a non-empty string')
        expect(bad(`title: t\n${det}`).error).toBe('logsource must be a map of strings')
        expect(bad(`title: t\nlogsource:\n  product: 5\n${det}`).error).toBe('logsource must be a map of strings')
        expect(bad(`title: t\n${log}`).error).toBe('detection must be a map')
        expect(bad(`title: t\n${log}detection: [a]\n`).error).toBe('detection must be a map')
        expect(bad(`title: t\n${log}detection:\n  a:\n    x: 1\n`).error).toBe('detection.condition is required')
        expect(bad(`title: t\n${log}detection:\n  a:\n    x: 1\n  condition: 5\n`).error).toBe(
            'detection.condition must be a string or a list of strings'
        )
        expect(bad(`title: t\n${log}detection:\n  a:\n    x: 1\n  condition: []\n`).error).toBe(
            'detection.condition must be a string or a list of strings'
        )
        expect(bad(`title: t\nid: 5\n${log}${det}`).error).toBe('id must be a string')
        expect(bad(`title: t\nlevel: [x]\n${log}${det}`).error).toBe('level must be a string')
    })

    it('rejects malformed selections', () => {
        expect(bad(rule('  a:\n  condition: a\n')).error).toMatch(/^detection\.a /)
        expect(bad(rule('  a: {}\n  condition: a\n')).error).toMatch(/^detection\.a /)
        expect(bad(rule('  a: []\n  condition: a\n')).error).toMatch(/^detection\.a /)
        expect(bad(rule('  a:\n    - x: 1\n    - kw\n  condition: a\n')).error).toMatch(/^detection\.a /)
        expect(bad(rule('  a:\n    x:\n      y: 1\n  condition: a\n')).error).toMatch(/^detection\.a\.x /)
        expect(bad(rule('  a:\n    x: [[1]]\n  condition: a\n')).error).toMatch(/^detection\.a\.x /)
        expect(bad(rule('  a:\n    x: []\n  condition: a\n')).error).toMatch(/^detection\.a\.x /)
        expect(bad(rule("  a:\n    '|contains': 1\n  condition: a\n")).error).toMatch(/field/)
        expect(bad(rule('  a:\n    x||contains: 1\n  condition: a\n')).error).toMatch(/modifier/)
    })

    it('rejects conflicting position modifiers', () => {
        expect(bad(rule('  a:\n    x|startswith|endswith: 1\n  condition: a\n')).error).toMatch(/modifiers/)
    })
})
