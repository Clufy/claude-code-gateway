import { describe, expect, it } from 'vitest'
import { ConfigError, loadConfig } from '../../src/config'
import { unsafePatternReason } from '../../src/guard/config'
import { makeEnv } from '../helpers'

const UNBOUNDED = 'unbounded quantifier (use {n,m}, m ≤ 100)'

const guard = (g: unknown) =>
    loadConfig(makeEnv({ GUARD_RULES: typeof g === 'string' ? g : JSON.stringify(g) } as never)).guard
const rule = (pattern: string, flags?: string) => ({
    custom: [{ id: 'custom.x', side: 'request', pattern, ...(flags === undefined ? {} : { flags }) }]
})

function rejects(raw: unknown): ConfigError {
    try {
        guard(raw)
    } catch (e) {
        expect(e).toBeInstanceOf(ConfigError)
        expect((e as ConfigError).variable).toBe('GUARD_RULES')
        return e as ConfigError
    }
    throw new Error('expected a ConfigError')
}

describe('GUARD_RULES', () => {
    it('defaults to the D10 severities', () => {
        const g = loadConfig(makeEnv()).guard
        expect(g.severity.get('secret.egress')).toBe('high')
        expect(g.severity.get('inject.exfil_markup')).toBe('medium')
        expect(g.severity.size).toBe(7)
        expect(g.disabled.size).toBe(0)
        expect(g.custom).toEqual([])
        expect(guard('').custom).toEqual([])
    })

    it('parses disable, severity overrides and custom rules', () => {
        const g = guard({
            disable: ['cmd.risky'],
            severity: { 'toolcall.unparsed': 'high' },
            custom: [{ id: 'custom.mimikatz', side: 'response', pattern: 'sekurlsa::', flags: 'i' }]
        })
        expect(g.disabled.has('cmd.risky')).toBe(true)
        expect(g.severity.has('cmd.risky')).toBe(false)
        expect(g.severity.get('toolcall.unparsed')).toBe('high')
        expect(g.severity.get('custom.mimikatz')).toBe('medium')
        expect(g.custom[0]!.side).toBe('response')
        expect(g.custom[0]!.re.test('SEKURLSA::logonpasswords')).toBe(true)
    })

    it.each<[string, string]>([
        ['(a+)+$', UNBOUNDED],
        ['(a|aa)+', UNBOUNDED],
        ['(.*a){10}', UNBOUNDED],
        ['(\\w+\\s?)+$', UNBOUNDED],
        ['^(a|a?)+$', UNBOUNDED],
        ['a*a*b', UNBOUNDED],
        ['a+?b', UNBOUNDED],
        ['a{2,}b', UNBOUNDED],
        ['\\s+$', UNBOUNDED],
        ['.*secret', UNBOUNDED],
        ['^\\s+x', UNBOUNDED],
        ['[)(]+x', UNBOUNDED],
        ['a[)(]+x', UNBOUNDED],
        ['certutil\\s+-urlcache', UNBOUNDED],
        ['a.*.{0,100}b', UNBOUNDED],
        ['a\\w*\\d?\\w?b', UNBOUNDED],
        ['(a{1,2}){1,2}', 'nested quantifier'],
        ['(a|aa){1,5}', 'nested quantifier'],
        ['(\\d)\\1', 'backreference'],
        ['(?<n>a)\\k<n>', 'backreference'],
        ['(?<=x)y', 'lookaround'],
        ['(?<!x)y', 'lookaround'],
        ['(?=x)y', 'lookaround'],
        ['(?!x)y', 'lookaround'],
        ['a{1,500}', 'repetition bound over 100'],
        ['a{500}', 'repetition bound over 100'],
        ['', 'length must be 1-256'],
        ['a'.repeat(257), 'length must be 1-256'],
        ['(', 'unbalanced group'],
        ['a)', 'unbalanced group'],
        ['a.{0,100}.{0,100}b', 'too much backtracking slack'],
        ['a{0000000000000000,100}b{0000000000000000,100}c', 'too much backtracking slack'],
        ['a{0000000000000000,}', UNBOUNDED],
        ['a{0000000000000000101}', 'repetition bound over 100'],
        ['a?'.repeat(40) + 'a{40}', 'too much backtracking slack'],
        ['x\\u{0,100}\\u{0,100}y', 'escape needs the u flag'],
        ['\\p{L}', 'escape needs the u flag'],
        ['\\P{L}', 'escape needs the u flag']
    ])('rejects pattern %s with its reason, without echoing it', (pattern, reason) => {
        const e = rejects(rule(pattern))
        expect(e.message).toBe(`custom[0].pattern: ${reason}`)
        if (pattern.length > 0) expect(e.message).not.toContain(pattern)
    })

    it('allows \\p{...} with the u flag', () => {
        expect(unsafePatternReason('\\p{L}{1,3}x', 'u')).toBeNull()
    })

    it('rejects flags g', () => {
        expect(rejects(rule('abc', 'g')).message).toMatch(/custom\[0\]\.pattern/)
        expect(unsafePatternReason('abc', 'ii')).not.toBeNull()
    })

    it.each([
        ['sekurlsa::'],
        ['(?:Invoke-Mimikatz|sekurlsa)'],
        ['(?<n>a|b)c'],
        ['[A-Z]{3}-\\d{4}'],
        ['procdump[^\\n]{0,80}lsass'],
        ['certutil\\s{1,10}-urlcache'],
        ['a.{0,100}b'],
        ['a{0000000000000000,100}'],
        ['a[+*]x'],
        ['a?b{2,3}c']
    ])('accepts pattern %s', (pattern) => {
        expect(unsafePatternReason(pattern, 'i')).toBeNull()
        expect(guard(rule(pattern)).custom).toHaveLength(1)
    })

    it('names the index in messages', () => {
        const e = rejects({
            custom: [
                { id: 'custom.a', side: 'request', pattern: 'ok' },
                { id: 'custom.b', side: 'request', pattern: 'ok' },
                { id: 'custom.c', side: 'request', pattern: '(a{1,2}){1,2}' }
            ]
        })
        expect(e.message).toBe('custom[2].pattern: nested quantifier')
    })

    it('rejects other malformed configs', () => {
        rejects({ nope: 1 })
        rejects({ disable: ['nope'] })
        rejects({ severity: { nope: 'low' } })
        rejects({ severity: { 'cmd.risky': 'critical' } })
        rejects({
            custom: [
                { id: 'custom.a', side: 'request', pattern: 'a' },
                { id: 'custom.a', side: 'request', pattern: 'b' }
            ]
        })
        rejects({ custom: [{ id: 'mimikatz', side: 'request', pattern: 'a' }] })
        rejects({ custom: [{ id: 'custom.a', side: 'both', pattern: 'a' }] })
        rejects({ custom: [{ id: 'custom.a', side: 'request', pattern: 'a', extra: 1 }] })
        rejects({ custom: [{ id: 'custom.a', side: 'request', severity: 'critical', pattern: 'a' }] })
        rejects({
            custom: Array.from({ length: 33 }, (_, i) => ({ id: `custom.r${i}`, side: 'request', pattern: 'a' }))
        })
        rejects('not json')
        rejects('[]')
        rejects({ custom: 'x' })
    })

    it('drops a disabled custom rule and ignores its severity override', () => {
        const g = guard({
            disable: ['custom.a', 'cmd.risky'],
            severity: { 'custom.a': 'high', 'cmd.risky': 'low' },
            custom: [
                { id: 'custom.a', side: 'request', pattern: 'a' },
                { id: 'custom.b', side: 'request', pattern: 'b' }
            ]
        })
        expect(g.custom.map((c) => c.id)).toEqual(['custom.b'])
        expect(g.disabled.has('custom.a')).toBe(true)
        expect(g.severity.has('custom.a')).toBe(false)
        expect(g.severity.has('cmd.risky')).toBe(false)
    })

    it('does not echo client values in messages', () => {
        expect(rejects({ 'secret-key-zz': 1 }).message).not.toContain('secret-key-zz')
        expect(rejects({ disable: ['secret-id-zz'] }).message).not.toContain('secret-id-zz')
        const dup = rejects({
            custom: [
                { id: 'custom.dupzz', side: 'request', pattern: 'a' },
                { id: 'custom.dupzz', side: 'request', pattern: 'b' }
            ]
        })
        expect(dup.message).toBe('custom[1].id is a duplicate')
        expect(
            rejects({ custom: [{ id: 'custom.a', side: 'request', pattern: 'a', zzkey: 1 }] }).message
        ).not.toContain('zzkey')
    })

    it('rejects a non-object custom entry', () => {
        expect(rejects({ custom: ['x'] }).message).toBe('custom[0] must be an object')
        expect(rejects({ custom: [null] }).message).toBe('custom[0] must be an object')
    })

    it('accepts 32 custom rules', () => {
        const custom = Array.from({ length: 32 }, (_, i) => ({ id: `custom.r${i}`, side: 'request', pattern: 'a' }))
        expect(guard({ custom }).custom).toHaveLength(32)
    })

    it('rejects a non-string GUARD_RULES', () => {
        expect(() => loadConfig(makeEnv({ GUARD_RULES: 5 } as never))).toThrow(ConfigError)
    })
})
