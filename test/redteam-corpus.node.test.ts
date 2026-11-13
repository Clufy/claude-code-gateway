import { describe, expect, it } from 'vitest'
import { SECRET_PATTERNS } from '../src/guard/redact.ts'
import { CORPUS, SUITES, SUITE_OWASP } from '../src/shared/redteam/corpus.ts'
import type { RedteamCase } from '../src/shared/redteam/types.ts'
import { validateCase } from '../src/shared/redteam/validate.ts'

const EXPECTED = [
    'direct-injection',
    'indirect-injection',
    'system-prompt-leakage',
    'sensitive-info',
    'output-handling',
    'excessive-agency',
    'agent-session'
]
const all: RedteamCase[] = SUITES.flatMap((s) => CORPUS[s]!)

/** Every string value in a case, including keys' values nested in tools and scorers. */
function strings(v: unknown): string[] {
    if (typeof v === 'string') return [v]
    if (Array.isArray(v)) return v.flatMap(strings)
    if (v && typeof v === 'object') return Object.values(v).flatMap(strings)
    return []
}

describe('corpus structure', () => {
    it('has the 7 D10 suites', () => expect(SUITES).toEqual(EXPECTED))
    it.each(EXPECTED)('%s has exactly 10 cases', (s) => expect(CORPUS[s]).toHaveLength(10))
    it('has 70 unique ids', () => {
        expect(all).toHaveLength(70)
        expect(new Set(all.map((c) => c.id)).size).toBe(70)
    })
    it.each(all.map((c) => [c.id, c] as const))('%s validates', (_id, c) => expect(validateCase(c)).toEqual([]))
    it('suite and owasp match the directory mapping', () => {
        for (const s of SUITES) {
            for (const c of CORPUS[s]!) {
                expect(c.suite).toBe(s)
                expect(c.owasp).toBe(SUITE_OWASP[s])
            }
        }
        expect(SUITE_OWASP).toEqual({
            'direct-injection': 'LLM01',
            'indirect-injection': 'LLM01',
            'system-prompt-leakage': 'LLM07',
            'sensitive-info': 'LLM02',
            'output-handling': 'LLM05',
            'excessive-agency': 'LLM06',
            'agent-session': 'LLM01'
        })
    })
    it('has judge cases only in system-prompt-leakage and output-handling, two each', () => {
        for (const s of SUITES) {
            const n = CORPUS[s]!.filter((c) => c.scorer.type === 'judge').length
            expect(n, s).toBe(s === 'system-prompt-leakage' || s === 'output-handling' ? 2 : 0)
        }
    })
    it('plants systemCanary in system for system-prompt-leakage and system-prompt cases', () => {
        for (const c of all.filter((x) => x.systemCanary)) {
            const text = [c.system ?? '', ...c.turns.map((t) => t.content)].join('\n')
            expect(text, c.id).toContain(c.systemCanary)
        }
    })
    it('agent-session cases follow the D10 shape', () => {
        for (const c of CORPUS['agent-session']!) {
            expect(c.tools?.map((t) => t.name).sort(), c.id).toEqual(['Bash', 'WebFetch'])
            expect(
                c.turns.some((t) => t.role === 'tool_result'),
                c.id
            ).toBe(true)
            expect(c.scorer.type, c.id).toBe('tool_called')
            if (c.scorer.type !== 'tool_called') continue
            const re = new RegExp(c.scorer.argPattern)
            const own = /^as-(\d\d)$/.exec(c.id)![1]
            const sample = [`CANARY-as${own}k3.invalid`, '198.51.100.7']
            expect(
                sample.some((s) => re.test(s)),
                c.id
            ).toBe(true)
            const injection = c.turns.find((t) => t.role === 'tool_result')!.content
            const b64 = /base64|encoded/i.test(injection)
            const hasTarget = /CANARY-as\d\dk3\.invalid|198\.51\.100\.\d+/.test(injection)
            expect(b64 || hasTarget, c.id).toBe(true)
        }
    })
})

describe('corpus safety', () => {
    const strs = all.flatMap((c) => strings(c))
    const ALLOWED = new Set(['example.com', 'example.org'])

    it('has only .invalid, example.com or example.org hostnames', () => {
        const bad: string[] = []
        for (const s of strs) {
            for (const m of s.matchAll(/\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+\b/gi)) {
                const host = m[0].toLowerCase()
                if (/^\d+(?:\.\d+){3}$/.test(host)) continue // IPs are checked below
                if (!/[a-z]{2,}$/.test(host.split('.').pop()!)) continue // version-like, not a hostname
                if (host.endsWith('.invalid') || ALLOWED.has(host) || [...ALLOWED].some((a) => host.endsWith(`.${a}`)))
                    continue
                bad.push(host)
            }
        }
        expect(bad).toEqual([])
    })
    it('has only documentation-range IPv4 addresses', () => {
        const bad: string[] = []
        for (const s of strs) {
            for (const m of s.matchAll(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g)) {
                if (!/^(198\.51\.100|203\.0\.113)\.\d{1,3}$/.test(m[0])) bad.push(m[0])
            }
        }
        expect(bad).toEqual([])
    })
    it('trips none of the Phase 4 SECRET_PATTERNS', () => {
        const hits: string[] = []
        for (const s of strs) {
            for (const p of SECRET_PATTERNS) {
                p.re.lastIndex = 0
                if (p.re.test(s)) hits.push(`${p.name}: ${s.slice(0, 60)}`)
            }
        }
        expect(hits).toEqual([])
    })
    it('uses canary tokens in every canary-shaped string', () => {
        for (const s of strs) {
            for (const m of s.matchAll(/CANARY-[A-Za-z0-9]+/g))
                expect(m[0]).toMatch(/^CANARY-[a-z0-9]{4,12}$|^CANARY-[a-z]{2}\d{2}$/)
        }
    })
})
