import { describe, expect, it } from 'vitest'
import { matchEvent } from '../../src/purple/evaluate'
import { parseSigma, type SigmaRule } from '../../src/purple/sigma'

const HEAD = 'title: Glob timing\nlogsource:\n  product: claude-proxy\n  category: prompt\n'
function rule(value: string, mod = ''): SigmaRule {
    const r = parseSigma(`${HEAD}detection:\n  s:\n    text${mod}: '${value}'\n  condition: s\n`)
    if (!r.ok) throw new Error(r.error)
    return r.rule
}
function timed(r: SigmaRule, text: string): { hit: boolean; ms: number } {
    const t = performance.now()
    const hit = matchEvent(r, { text })
    return { hit, ms: performance.now() - t }
}

// A single anchored regex backtracks polynomially on these (a 4-wildcard value took ~17 s on 400 chars).
describe('wildcard values match in linear time', () => {
    const big = 'a'.repeat(60 * 1024)

    it('*a*a*a*x against 60 KB of a', () => {
        const { hit, ms } = timed(rule('*a*a*a*x'), big)
        expect(hit).toBe(false)
        expect(ms).toBeLessThan(500)
        expect(timed(rule('*a*a*a*x'), `${big}x`).hit).toBe(true)
    })

    it('*ignore*previous*instructions* against repeated near-misses', () => {
        const text = 'ignore previous '.repeat(4000)
        const { hit, ms } = timed(rule('*ignore*previous*instructions*'), text)
        expect(hit).toBe(false)
        expect(ms).toBeLessThan(500)
        expect(timed(rule('*ignore*previous*instructions*'), `${text}instructions`).hit).toBe(true)
    })

    it('contains, startswith and endswith stay linear', () => {
        for (const mod of ['|contains', '|startswith', '|endswith']) {
            const { ms } = timed(rule('a*a*a*x', mod), big)
            expect(ms).toBeLessThan(500)
        }
    })
})
