import { describe, expect, it } from 'vitest'
import type { Engagement } from '../src/engagement'
import { buildModeBlock, FINDING_FORMAT } from '../src/modes/block'
import { estimateTokens } from '../src/tokens'

const eng: Engagement = {
    name: 'acme-q4',
    scope: {
        domains: ['acme.example', '*.corp.acme.example'],
        cidrs: ['10.20.0.0/16'],
        llmTargets: ['chat.acme.example']
    },
    exclude: { domains: ['hr.acme.example'], cidrs: ['10.20.5.0/24'] },
    window: { start: Date.UTC(2026, 10, 1), end: Date.UTC(2026, 10, 30, 23, 59) },
    roe: 'No denial of service. Stop on production data exposure.',
    defaultMode: 'redteam'
}
const big: Engagement = {
    ...eng,
    scope: {
        domains: Array.from({ length: 10 }, (_, i) => `*.host-number-${i}.subsidiary.example.com`),
        cidrs: Array.from({ length: 5 }, (_, i) => `10.${i}.0.0/16`),
        llmTargets: ['llm-a.example.com', 'llm-b.example.com', 'llm-c.example.com']
    },
    roe: 'x'.repeat(300)
}
const ANTI =
    /ignore (all|any|previous|prior)|jailbreak|no (restrictions|limits)|bypass|override|unfiltered|regardless of (policy|safety)|do anything now/i

describe.each(['redteam', 'purple'] as const)('%s block', (mode) => {
    const block = buildModeBlock(mode, eng)
    it('contains engagement facts', () => {
        expect(block).toContain('Engagement acme-q4: ' + mode + ' mode')
        for (const s of [
            ...eng.scope.domains,
            ...eng.scope.cidrs,
            ...eng.scope.llmTargets,
            ...eng.exclude.domains,
            ...eng.exclude.cidrs,
            eng.roe,
            FINDING_FORMAT
        ]) {
            expect(block).toContain(s)
        }
        expect(block).toContain(new Date(eng.window.start).toISOString())
        expect(block).toContain(new Date(eng.window.end).toISOString())
    })
    it('repeats scope and exclusions as the last line', () => {
        // Scope-only entries (no other entry contains them): exactly the scope line and the repeat.
        expect(block.split('*.corp.acme.example').length - 1).toBe(2)
        expect(block.split('10.20.0.0/16').length - 1).toBe(2)
        const lines = block.split('\n')
        const last = lines[lines.length - 1]
        expect(last.startsWith('Scope (repeat):')).toBe(true)
        expect(last).toContain('*.corp.acme.example')
        expect(last.endsWith('; excluded: hr.acme.example, 10.20.5.0/24')).toBe(true)
    })
    it('stays within 600 tokens, also for a large engagement', () => {
        expect(estimateTokens(block)).toBeLessThanOrEqual(600)
        expect(estimateTokens(buildModeBlock(mode, big))).toBeLessThanOrEqual(600)
    })
    it('adds no safety-stripping language', () => {
        expect(block).not.toMatch(ANTI)
        expect(buildModeBlock(mode, big)).not.toMatch(ANTI)
    })
    it('renders empty scope and exclude lists as none', () => {
        const sparse = buildModeBlock(mode, {
            ...eng,
            scope: { domains: ['acme.example'], cidrs: [], llmTargets: [] },
            exclude: { domains: [], cidrs: [] }
        })
        expect(sparse).toContain('In scope: domains: acme.example; cidrs: none; llm targets: none')
        expect(sparse).toContain('Excluded: domains: none; cidrs: none')
        expect(sparse.split('\n').pop()).toBe(
            'Scope (repeat): domains: acme.example; cidrs: none; llm targets: none; excluded: none'
        )
    })
    it('omits an empty RoE', () => {
        expect(buildModeBlock(mode, { ...eng, roe: '' })).not.toContain('Rules of engagement')
    })
})

it('only purple mentions Sigma', () => {
    expect(buildModeBlock('purple', eng)).toContain('Sigma')
    expect(buildModeBlock('redteam', eng)).not.toContain('Sigma')
})
