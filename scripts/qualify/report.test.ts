import { describe, expect, it, vi } from 'vitest'
import type { Collected } from './collect.ts'
import { loadFixture } from './fixture.ts'
import { buildModelReport, renderMarkdown, type ScenarioRun } from './report.ts'
import { SCENARIOS } from './scenarios.ts'
import { keyFromCustomHeaders, runQualification } from './run.ts'

const fx = loadFixture('test/fixtures/claude-code-request.synthetic.json')

const readCall = (valid: boolean): Collected['blocks'][number] => ({
    type: 'tool_use',
    name: 'Read',
    input: valid ? { file_path: '/a' } : {}
})
const collected = (blocks: Collected['blocks'] = []): Collected => ({
    status: 200,
    ttfbMs: 10,
    totalMs: 20,
    blocks,
    stopReason: null,
    usage: { output_tokens: 3 },
    proxyStats: null,
    error: null
})
const run = (scenarioId: string, i: number, pass: boolean): ScenarioRun => ({
    scenarioId,
    run: i,
    skipped: false,
    pass,
    detail: pass ? 'ok' : 'nope',
    collected: [collected()]
})

const TOOL_IDS = ['tool.single', 'tool.args_complex', 'tool.choice', 'tool.after_result', 'context.long']
const modeSkips = (): ScenarioRun[] =>
    ['mode.format', 'mode.scope'].map((id) => ({
        scenarioId: id,
        run: 0,
        skipped: true,
        pass: false,
        detail: 'skipped',
        collected: []
    }))

/** 10 runs per tool scenario, `passes` of them pass; `calls` tool_use blocks (of which `valid` are valid) on run 0. */
function make(passes: number, calls = 20, valid = 20, parallelPass = true): ScenarioRun[] {
    const runs: ScenarioRun[] = []
    for (const id of TOOL_IDS) for (let i = 0; i < 10; i++) runs.push(run(id, i, i < passes))
    for (let i = 0; i < 10; i++) runs.push(run('tool.parallel', i, parallelPass))
    runs[0].collected = [collected(Array.from({ length: calls }, (_, i) => readCall(i < valid)))]
    return [...runs, ...modeSkips()]
}

describe('buildModelReport', () => {
    it('fit at thresholds', () => {
        const r = buildModelReport('m', make(9, 20, 19), fx.tools)
        expect(r.validToolCallRate).toBe(0.95)
        expect(r.verdict).toBe('fit')
        expect(r.verdictReasons).toContain('mode.scope not measurable before Phase 3')
        expect(r.scenarios['tool.single'].passRate).toBe(0.9)
        expect(r.scenarios['mode.scope'].passRate).toBeNull()
    })

    it('subagent-only just below fit', () => {
        const r = buildModelReport('m', make(10, 50, 47), fx.tools)
        expect(r.validToolCallRate).toBe(0.94)
        expect(r.verdict).toBe('subagent-only')
        expect(r.verdictReasons.join(' ')).toContain('0.94')
    })

    it('unfit', () => {
        const r = buildModelReport('m', make(10, 10, 8), fx.tools)
        expect(r.validToolCallRate).toBe(0.8)
        expect(r.verdict).toBe('unfit')
    })

    it('low tool scenario pass rate gates', () => {
        expect(buildModelReport('m', make(8), fx.tools).verdict).toBe('subagent-only')
        expect(buildModelReport('m', make(6), fx.tools).verdict).toBe('unfit')
    })

    it('tool.parallel does not gate', () => {
        const r = buildModelReport('m', make(10, 20, 20, false), fx.tools)
        expect(r.scenarios['tool.parallel'].passRate).toBe(0)
        expect(r.verdict).toBe('fit')
    })

    it('a failing mode.scope blocks fit when measured', () => {
        const runs = make(10).filter((x) => x.scenarioId !== 'mode.scope')
        runs.push(run('mode.scope', 0, false))
        const r = buildModelReport('m', runs, fx.tools)
        expect(r.verdict).toBe('subagent-only')
        expect(r.verdictReasons.join(' ')).toContain('mode.scope')
    })

    it('is unfit when no gating tool scenario was measured', () => {
        const runs = [run('turn.stop', 0, true), ...modeSkips()]
        const r = buildModelReport('m', runs, fx.tools)
        expect(r.verdict).toBe('unfit')
        expect(r.verdictReasons).toContain('no tool scenarios were measured')
    })

    it('counts fallback runs without changing the verdict', () => {
        const runs = make(10)
        const stats = {
            backend: 'b',
            model: 'm',
            fallbackUsed: true,
            ttfbMs: 1,
            toolCallsFromText: 0,
            unparsedToolText: false
        }
        runs[0].collected = [
            { ...collected(), proxyStats: stats },
            { ...collected(), proxyStats: stats }
        ]
        runs[1].collected = [{ ...collected(), proxyStats: stats }]
        const r = buildModelReport('m', runs, fx.tools)
        expect(r.fallbackRuns).toBe(2)
        expect(r.verdict).toBe('fit')
        expect(r.verdictReasons).toContain('2 runs answered by a fallback backend')
        const md = renderMarkdown([r], { base: 'b', runs: 1, fixture: 'f', startedAt: 's' })
        expect(md).toContain('Fallback runs')
        expect(md).toContain('2 runs answered by a fallback backend')
    })

    it('uses nearest-rank percentiles', () => {
        const runs = make(10)
        runs.forEach((r) => {
            r.collected = []
        })
        runs[0].collected = Array.from({ length: 20 }, (_, i) => ({
            ...collected(),
            ttfbMs: i + 1,
            totalMs: (i + 1) * 10
        }))
        const r = buildModelReport('m', runs, fx.tools)
        expect([r.ttfbP50, r.ttfbP95, r.totalP50, r.totalP95]).toEqual([10, 19, 100, 190])
    })

    it('counts errors, unparsed text and percentiles', () => {
        const runs = make(10)
        runs[0].collected = [{ ...collected(), error: 'boom', ttfbMs: 1000, totalMs: 2000 }]
        runs[1].collected = [
            {
                ...collected(),
                proxyStats: {
                    backend: 'b',
                    model: 'm',
                    fallbackUsed: false,
                    ttfbMs: 1,
                    toolCallsFromText: 1,
                    unparsedToolText: true
                }
            }
        ]
        const r = buildModelReport('m', runs, fx.tools)
        expect(r.errors).toBe(1)
        expect(r.unparsedCount).toBe(1)
        expect(r.ttfbP50).toBe(10)
        expect(r.ttfbP95).toBe(10)
        expect(r.outputTokens).toBeGreaterThan(0)
    })

    it('renders markdown with the verdict', () => {
        const md = renderMarkdown([buildModelReport('m', make(10), fx.tools)], {
            base: 'http://x',
            runs: 10,
            fixture: 'synthetic',
            startedAt: '2026-11-08T00:00:00Z'
        })
        expect(md).toContain('## m: fit')
        expect(md).toContain('tool.single')
        expect(md).toContain('mode.scope not measurable before Phase 3')
    })
})

const sseBody = (frames: [string, unknown][]) =>
    frames.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('')
const json = (body: string, status = 200) =>
    new Response(body, { status, headers: { 'content-type': 'application/json' } })

describe('runQualification', () => {
    it('tolerates garbage responses', async () => {
        const responses = [
            () => json(JSON.stringify({ error: { message: 'boom' } }), 500),
            () => new Response('oops', { status: 200, headers: { 'content-type': 'text/plain' } }),
            () =>
                new Response(
                    sseBody([
                        [
                            'content_block_start',
                            {
                                type: 'content_block_start',
                                index: 0,
                                content_block: { type: 'tool_use', id: 't', name: 'Read', input: {} }
                            }
                        ],
                        [
                            'content_block_delta',
                            {
                                type: 'content_block_delta',
                                index: 0,
                                delta: { type: 'input_json_delta', partial_json: '{"file_path": ' }
                            }
                        ]
                    ]),
                    { status: 200, headers: { 'content-type': 'text/event-stream' } }
                )
        ]
        let n = 0
        const fetchImpl = (async () => responses[n++ % responses.length]()) as unknown as typeof fetch
        const [report] = await runQualification(
            {
                base: 'http://x',
                key: 'k',
                models: ['m'],
                runs: 1,
                only: ['tool.single', 'turn.stop', 'tool.choice'],
                fixturePath: 'test/fixtures/claude-code-request.synthetic.json'
            },
            fetchImpl
        )
        expect(report.errors).toBeGreaterThanOrEqual(2)
        expect(report.validToolCallRate).toBeLessThan(1)
        expect(report.verdict).toBe('unfit')
    })

    it('records a throwing check as a failed run', async () => {
        const fetchImpl = (async () => json('{}')) as unknown as typeof fetch
        const spy = vi
            .spyOn(
                SCENARIOS.find((s) => s.id === 'turn.stop')!,
                'check'
            )
            .mockImplementation(() => {
                throw new Error('kaboom')
            })
        try {
            const runs: ScenarioRun[] = []
            await runQualification(
                {
                    base: 'http://x',
                    key: 'k',
                    models: ['m'],
                    runs: 1,
                    only: ['turn.stop'],
                    onRun: (_m, r) => runs.push(r)
                },
                fetchImpl
            )
            expect(runs[0]).toMatchObject({ pass: false, detail: 'check threw: kaboom' })
        } finally {
            spy.mockRestore()
        }
    })

    it('survives a network failure', async () => {
        const fetchImpl = (async () => {
            throw new Error('connect refused')
        }) as unknown as typeof fetch
        const [report] = await runQualification(
            { base: 'http://x', key: 'k', models: ['m'], runs: 1, only: ['turn.stop'] },
            fetchImpl
        )
        expect(report.errors).toBe(1)
    })

    it('sends auth and debug headers and the model under test', async () => {
        const seen: { url: string; headers: Headers; body: any }[] = []
        const fetchImpl = (async (url: string, init: RequestInit) => {
            seen.push({ url, headers: new Headers(init.headers), body: JSON.parse(init.body as string) })
            return json('{}')
        }) as unknown as typeof fetch
        await runQualification(
            { base: 'http://x/', key: 'secret', models: ['m1', 'm2'], runs: 2, only: ['tool.single', 'stream.parity'] },
            fetchImpl
        )
        // per model per run: 1 (tool.single) + 2 (stream.parity)
        expect(seen).toHaveLength(2 * 2 * 3)
        for (const s of seen) {
            expect(s.url).toBe('http://x/v1/messages')
            expect(s.headers.get('x-api-key')).toBe('secret')
            expect(s.headers.get('x-proxy-debug')).toBe('1')
            expect(['m1', 'm2']).toContain(s.body.model)
        }
        expect(seen.filter((s) => s.body.model === 'm1')).toHaveLength(6)
    })

    it('marks skipped scenarios and honours skipLong', async () => {
        const runs: ScenarioRun[] = []
        const fetchImpl = (async () => json('{}')) as unknown as typeof fetch
        const [report] = await runQualification(
            {
                base: 'http://x',
                key: 'k',
                models: ['m'],
                runs: 1,
                only: ['context.long', 'mode.scope'],
                skipLong: true,
                onRun: (_m, r) => runs.push(r)
            },
            fetchImpl
        )
        expect(runs.length).toBe(2)
        expect(runs.every((r) => r.skipped)).toBe(true)
        expect(report.scenarios['context.long'].passRate).toBeNull()
        expect(report.verdictReasons).toContain('mode.scope not measurable before Phase 3')
    })
})

describe('keyFromCustomHeaders', () => {
    it('finds x-api-key among several lines, case-insensitively', () => {
        const headers = ['X-Other: a', 'X-API-Key:  secret ', 'x-more: b'].join('\r\n')
        expect(keyFromCustomHeaders(headers)).toBe('secret')
    })
    it('returns undefined when absent', () => {
        expect(keyFromCustomHeaders('x-other: a')).toBeUndefined()
        expect(keyFromCustomHeaders(undefined)).toBeUndefined()
    })
})
