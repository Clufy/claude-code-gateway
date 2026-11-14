// Node project: reads redteam/purple/*.yml and README.md from disk.
import { readdirSync, readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../../src/config'
import { createGuard } from '../../src/guard'
import { parseGuardRules } from '../../src/guard/config'
import { injectInstruction } from '../../src/guard/request-rules'
import { testRule } from '../../src/purple/evaluate'
import { promoteRule, type GuardEntry, type Promotion } from '../../src/purple/promote'
import { parseSigma } from '../../src/purple/sigma'
import { CORPUS } from '../../src/shared/redteam/corpus.ts'

const DIR = 'redteam/purple'
const cases = CORPUS['agent-session']!.map((c) => {
    const t = c.turns.filter((x) => x.role === 'tool_result').pop()
    if (!t) throw new Error(`${c.id} has no tool_result turn`)
    return { id: c.id, text: t.content }
})
const benign = JSON.parse(readFileSync(`${DIR}/benign-tool-results.json`, 'utf8')) as string[]
const events = [...cases, ...benign.map((text) => ({ text }))].map(({ text }) => ({ text }))
const CASES = cases.map((_, i) => i)
const BENIGN = benign.map((_, i) => cases.length + i)
const ruleFiles = readdirSync(DIR, { withFileTypes: true })
    .filter((e) => !e.isDirectory() && e.name.endsWith('.yml'))
    .map((e) => e.name)
    .sort()
const rules = ruleFiles.map((name) => ({ name, text: readFileSync(`${DIR}/${name}`, 'utf8') }))
// Built at module scope so any single test can run alone under -t.
const promotions = rules.map(({ name, text }) => {
    const parsed = parseSigma(text)
    const promotion: Promotion = parsed.ok ? promoteRule(parsed.rule, events) : { ok: false, reason: parsed.error }
    return { name, promotion }
})
const entries: GuardEntry[] = promotions.flatMap(({ promotion: p }) => (p.ok ? [p.entry] : []))

const toolResultBody = (text: string) => ({
    messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: text }] }]
})

beforeAll(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {}) // the guard logs one detection line per hit
})
afterAll(() => vi.restoreAllMocks())

describe('purple dogfood: agent-session indirect injections', () => {
    it('has 10 agent-session cases and at least 20 benign tool results', () => {
        expect(cases).toHaveLength(10)
        expect(benign.length).toBeGreaterThanOrEqual(20)
        expect(benign.every((b) => typeof b === 'string' && b.length > 0)).toBe(true)
        const tricky = benign.filter((b) => /ignore|instructions|\bAI\b|agent|assistant/i.test(b))
        expect(tricky.length).toBeGreaterThanOrEqual(5)
    })

    it('baseline: the built-in inject.instruction catches at most 1 of the 10 (the gap this closes)', () => {
        const caught = cases.filter((c) => injectInstruction({ kind: 'tool_result', text: c.text }) !== null)
        expect(caught.length).toBeLessThanOrEqual(1)
    })

    it('has 1-6 rule files', () => {
        expect(ruleFiles.length).toBeGreaterThanOrEqual(1)
        expect(ruleFiles.length).toBeLessThanOrEqual(6)
    })

    it.each(rules)('$name parses and matches no benign tool result', ({ text }) => {
        const parsed = parseSigma(text)
        expect(parsed.ok, JSON.stringify(parsed)).toBe(true)
        const r = testRule(text, events)
        expect(r.error).toBeUndefined()
        expect(r.matched.filter((i) => i >= cases.length)).toEqual([])
        expect(r.matched.length).toBeGreaterThan(0)
    })

    it('the rules together catch all 10 cases', () => {
        const union = new Set(rules.flatMap(({ text }) => testRule(text, events).matched))
        expect(CASES.filter((i) => !union.has(i)).map((i) => cases[i]!.id)).toEqual([])
    })

    it.each(promotions)('$name promotes to a GUARD_RULES entry', ({ promotion }) => {
        expect(promotion.ok, JSON.stringify(promotion)).toBe(true)
    })

    const snippet = () => JSON.stringify({ custom: entries })

    it('the merged snippet is a valid GUARD_RULES value', () => {
        expect(entries).toHaveLength(rules.length)
        expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length)
        expect(parseGuardRules(snippet()).custom).toHaveLength(entries.length)
    })

    it('the real guard flags every case with a custom id and no benign tool result', () => {
        const base = loadConfig({ PROXY_KEY: 'k' })
        const cfg = { ...base, guard: parseGuardRules(snippet()) }
        const customIds = (text: string) =>
            createGuard(cfg, 'req_dogfood')
                .scanRequest(toolResultBody(text))
                .filter((id) => id.startsWith('custom.'))
        const missed = cases.filter((c) => customIds(c.text).length === 0).map((c) => c.id)
        expect(missed).toEqual([])
        const noisy = BENIGN.filter((i) => customIds(events[i]!.text).length > 0)
        expect(noisy).toEqual([])
    })

    it('README.md carries the merged snippet exactly', () => {
        expect(entries.length).toBeGreaterThan(0)
        // a boolean, so a failure prints the expected snippet rather than the whole README
        expect(readFileSync('README.md', 'utf8').includes(snippet()), `README.md lacks ${snippet()}`).toBe(true)
    })
})
