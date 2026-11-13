import { describe, expect, it } from 'vitest'
import { gateTarget, type GateEngagement } from '../src/shared/redteam/gate.ts'
import {
    runCases,
    type CaseResult,
    type RunControls,
    type RunDeps,
    type RunTarget
} from '../src/shared/redteam/runner.ts'
import { buildScorecard, renderScorecardMarkdown, type ScorecardMeta } from '../src/shared/redteam/scorecard.ts'
import type { AdapterResult, RedteamCase } from '../src/shared/redteam/types.ts'

const eng: GateEngagement = {
    name: 'acme',
    scope: { domains: ['*.acme-test.com'], llmTargets: ['LLM.Acme-Test.com', 'api.other.test'] },
    exclude: { domains: ['prod.acme-test.com', '*.secret.acme-test.com'] },
    window: { start: 1000, end: 2000 }
}

describe('gateTarget', () => {
    it('allows an exact llmTargets host, case-insensitively', () => {
        expect(gateTarget(eng, 'https://llm.acme-test.com/v1', 1500)).toBeNull()
        expect(gateTarget(eng, 'https://LLM.ACME-TEST.COM./v1', 1500)).toBeNull()
        expect(gateTarget(eng, 'https://API.other.test/x', 1500)).toBeNull()
    })
    it('allows a wildcard subdomain but not the apex', () => {
        expect(gateTarget(eng, 'https://chat.acme-test.com/', 1500)).toBeNull()
        expect(gateTarget(eng, 'https://acme-test.com/', 1500)).toBe(
            'target acme-test.com is not in engagement acme scope'
        )
    })
    it('refuses unknown hosts', () => {
        expect(gateTarget(eng, 'https://evil.example.org/', 1500)).toBe(
            'target evil.example.org is not in engagement acme scope'
        )
    })
    it('refuses excluded hosts', () => {
        expect(gateTarget(eng, 'https://prod.acme-test.com/', 1500)).toBe(
            'target prod.acme-test.com is excluded from engagement acme'
        )
        expect(gateTarget(eng, 'https://a.secret.acme-test.com/', 1500)).toBe(
            'target a.secret.acme-test.com is excluded from engagement acme'
        )
    })
    it('refuses http to a non-loopback host', () => {
        expect(gateTarget(eng, 'http://llm.acme-test.com/', 1500)).not.toBeNull()
    })
    it('allows http to loopback only when in scope', () => {
        const loop: GateEngagement = { ...eng, scope: { domains: [], llmTargets: ['localhost', '127.0.0.5', '[::1]'] } }
        expect(gateTarget(loop, 'http://localhost:8787/', 1500)).toBeNull()
        expect(gateTarget(loop, 'http://127.0.0.5/', 1500)).toBeNull()
        expect(gateTarget(loop, 'http://[::1]:1/', 1500)).toBeNull()
        expect(gateTarget(eng, 'http://localhost:8787/', 1500)).not.toBeNull()
    })
    it('refuses outside the window with the window reason', () => {
        expect(gateTarget(eng, 'https://llm.acme-test.com/', 999)).toBe('engagement acme window is closed')
        expect(gateTarget(eng, 'https://llm.acme-test.com/', 2001)).toBe('engagement acme window is closed')
    })
    it('refuses invalid URLs and other schemes', () => {
        expect(gateTarget(eng, 'not a url', 1500)).toBe('invalid target URL')
        expect(gateTarget(eng, 'ftp://llm.acme-test.com/', 1500)).not.toBeNull()
    })
})

const mkCase = (n: number, over: Partial<RedteamCase> = {}): RedteamCase => ({
    id: `case-${n}`,
    suite: 'direct-injection',
    owasp: 'LLM01',
    title: `Case ${n}`,
    turns: [{ role: 'user', content: `hi ${n}` }],
    scorer: { type: 'regex', pattern: 'PWNED' },
    ...over
})
const cases = (n: number) => Array.from({ length: n }, (_, i) => mkCase(i + 1))
const ok = (text = 'fine', extra: Partial<AdapterResult> = {}): AdapterResult => ({
    text,
    toolCalls: [],
    detections: [],
    status: 200,
    ...extra
})
const fail = (text = 'boom'): AdapterResult => ({ text, toolCalls: [], detections: [], status: 500, error: 'http 500' })

function target(
    adapter: (c: RedteamCase) => Promise<AdapterResult> | AdapterResult,
    extra: Partial<RunTarget> = {}
): RunTarget {
    return {
        label: 't',
        adapter: async (c) => adapter(c),
        opts: { url: 'https://t.test/', headers: {}, timeoutMs: 1000, fetch: fetch },
        isSelf: false,
        ...extra
    }
}

const ctl = (over: Partial<RunControls> = {}): RunControls => ({
    concurrency: 1,
    delayMs: 0,
    maxCases: 100,
    stopOnErrors: 5,
    ...over
})

function deps(over: Partial<RunDeps> = {}): RunDeps & { clock: { t: number }; slept: number[] } {
    const clock = { t: 0 }
    const slept: number[] = []
    return {
        clock,
        slept,
        now: () => clock.t,
        sleep: async (ms) => {
            slept.push(ms)
            clock.t += ms
        },
        ...over
    }
}

const tick = async () => {
    for (let i = 0; i < 50; i++) await Promise.resolve()
}

describe('runCases', () => {
    it('never exceeds the concurrency and returns results in case order', async () => {
        let inflight = 0
        let peak = 0
        const t = target(async (c) => {
            inflight++
            peak = Math.max(peak, inflight)
            // earlier cases finish later
            const n = Number(c.id.split('-')[1])
            for (let i = 0; i < 10 - n; i++) await tick()
            inflight--
            return ok(c.id)
        })
        const r = await runCases(cases(8), t, ctl({ concurrency: 2 }), deps())
        expect(peak).toBe(2)
        expect(r.results.map((x) => x.case.id)).toEqual(cases(8).map((c) => c.id))
        expect(r.results.every((x) => x.outcome === 'passed')).toBe(true)
        expect(r.stopped).toBeUndefined()
    })

    it('clamps concurrency to 1..8', async () => {
        let inflight = 0
        let peak = 0
        const t = target(async () => {
            inflight++
            peak = Math.max(peak, inflight)
            await tick()
            await tick()
            inflight--
            return ok()
        })
        await runCases(cases(20), t, ctl({ concurrency: 50 }), deps())
        expect(peak).toBe(8)
        peak = 0
        await runCases(cases(5), t, ctl({ concurrency: 0 }), deps())
        expect(peak).toBe(1)
    })

    it('sleeps delayMs between starts, not before the first', async () => {
        const d = deps()
        await runCases(
            cases(3),
            target(() => ok()),
            ctl({ delayMs: 250 }),
            d
        )
        expect(d.slept).toEqual([250, 250])
    })

    it('runs only the first maxCases cases', async () => {
        const seen: string[] = []
        const r = await runCases(
            cases(6),
            target((c) => {
                seen.push(c.id)
                return ok()
            }),
            ctl({ maxCases: 3 }),
            deps()
        )
        expect(seen).toEqual(['case-1', 'case-2', 'case-3'])
        expect(r.results).toHaveLength(3)
    })

    it('stops after consecutive errors and skips the rest', async () => {
        let sent = 0
        const r = await runCases(
            cases(9),
            target(() => {
                sent++
                return fail()
            }),
            ctl({ stopOnErrors: 5 }),
            deps()
        )
        expect(sent).toBe(5)
        expect(r.stopped).toBe('too many errors')
        expect(r.results.slice(0, 5).every((x) => x.outcome === 'error')).toBe(true)
        const rest = r.results.slice(5)
        expect(rest).toHaveLength(4)
        expect(rest.every((x) => x.outcome === 'skipped' && x.detail === 'stopped: too many errors')).toBe(true)
    })

    it('resets the error streak on a non-error outcome', async () => {
        const pattern = [true, true, false, true, true, false, true, true]
        const r = await runCases(
            cases(8),
            target((c) => (pattern[Number(c.id.split('-')[1]) - 1] ? fail() : ok())),
            ctl({ stopOnErrors: 3 }),
            deps()
        )
        expect(r.stopped).toBeUndefined()
        expect(r.results).toHaveLength(8)
    })

    it('under concurrency, in-flight cases keep real outcomes after the threshold trips', async () => {
        const release: (() => void)[] = []
        let sent = 0
        const t = target((c) => {
            sent++
            const n = Number(c.id.split('-')[1])
            return new Promise<AdapterResult>((res) => release.push(() => res(n <= 2 ? fail() : ok('real'))))
        })
        const p = runCases(cases(6), t, ctl({ concurrency: 4, stopOnErrors: 2 }), deps())
        for (let i = 0; i < 20; i++) await tick()
        expect(sent).toBe(4)
        release.forEach((f) => f())
        const r = await p
        expect(r.stopped).toBe('too many errors')
        expect(r.results.map((x) => x.outcome)).toEqual(['error', 'error', 'passed', 'passed', 'skipped', 'skipped'])
        expect(r.results[4].detail).toBe('stopped: too many errors')
    })

    it('stops when recheck returns a reason, calling it before every start', async () => {
        let calls = 0
        let sent = 0
        const reason = 'engagement acme window is closed'
        const r = await runCases(
            cases(7),
            target(() => {
                sent++
                return ok()
            }),
            ctl(),
            deps({
                recheck: () => {
                    calls++
                    return calls > 3 ? reason : null
                }
            })
        )
        expect(sent).toBe(3)
        expect(calls).toBe(4)
        expect(r.stopped).toBe(reason)
        expect(r.results.slice(3).every((x) => x.outcome === 'skipped' && x.detail === `stopped: ${reason}`)).toBe(true)
    })

    it('skips unstarted cases once the deadline passes', async () => {
        const d = deps()
        let sent = 0
        const r = await runCases(
            cases(5),
            target(() => {
                sent++
                d.clock.t += 400
                return ok()
            }),
            ctl({ deadlineMs: 1000 }),
            d
        )
        expect(sent).toBe(3)
        expect(r.results.map((x) => x.outcome)).toEqual(['passed', 'passed', 'passed', 'skipped', 'skipped'])
        expect(r.results[3].detail).toBe('deadline')
    })

    it('passes the target gate as the adapter checkHop, defaulting to allow', async () => {
        let hop: ((u: string) => string | null) | undefined
        const t = target(() => ok())
        t.adapter = async (_c, o) => {
            hop = o.checkHop
            return ok()
        }
        await runCases(cases(1), t, ctl(), deps())
        expect(hop!('https://x.test/')).toBeNull()
        const gate = (u: string) => `no ${u}`
        await runCases(cases(1), { ...t, gate }, ctl(), deps())
        expect(hop).toBe(gate)
    })

    it('maps scorer outcomes: attacked, passed', async () => {
        const r = await runCases(
            cases(2),
            target((c) => ok(c.id === 'case-1' ? 'PWNED' : 'nope', { detections: ['inject.instruction'] })),
            ctl(),
            deps()
        )
        expect(r.results.map((x) => x.outcome)).toEqual(['attacked', 'passed'])
        expect(r.results[0].reply).toBe('PWNED')
        expect(r.results[0].detections).toEqual(['inject.instruction'])
    })

    it('P6-R4: an adapter error is an error outcome and is never scored or judged', async () => {
        let judged = 0
        const judge = async () => {
            judged++
            return { attackSucceeded: true, detail: 'x' }
        }
        // error body contains the attack string and a refusal_expected case would otherwise "attack"
        const cs = [
            mkCase(1),
            mkCase(2, { scorer: { type: 'refusal_expected' } }),
            mkCase(3, { scorer: { type: 'judge', criterion: 'c' } })
        ]
        const r = await runCases(
            cs,
            target(() => fail('PWNED')),
            ctl({ stopOnErrors: 10 }),
            deps({ judge })
        )
        expect(r.results.map((x) => x.outcome)).toEqual(['error', 'error', 'error'])
        expect(r.results[0].detail).toContain('http 500')
        expect(judged).toBe(0)
        expect(r.results[2].judge).toBeUndefined()
    })

    it('an invalid pattern on a non-judge case is an error with the scorer detail', async () => {
        const r = await runCases(
            [mkCase(1, { scorer: { type: 'regex', pattern: '(a+)+' } })],
            target(() => ok()),
            ctl(),
            deps()
        )
        expect(r.results[0].outcome).toBe('error')
        expect(r.results[0].detail).toMatch(/^invalid pattern/)
    })

    it('judge cases without a judge are skipped with "no judge model"', async () => {
        const r = await runCases(
            [mkCase(1, { scorer: { type: 'judge', criterion: 'c' } })],
            target(() => ok()),
            ctl(),
            deps()
        )
        expect(r.results[0]).toMatchObject({ outcome: 'skipped', detail: 'no judge model' })
    })

    it('with a judge, the outcome comes from the judge and judge is set', async () => {
        const verdicts = [
            { attackSucceeded: true, detail: 'leaked' },
            { attackSucceeded: false, detail: 'held' },
            { attackSucceeded: null, detail: 'judge output unparseable' }
        ]
        let i = 0
        const cs = [1, 2, 3].map((n) => mkCase(n, { scorer: { type: 'judge', criterion: 'c' } }))
        const r = await runCases(
            cs,
            target(() => ok('PWNED')),
            ctl(),
            deps({ judge: async () => verdicts[i++] })
        )
        expect(r.results.map((x) => x.outcome)).toEqual(['attacked', 'passed', 'error'])
        expect(r.results[0].judge).toEqual(verdicts[0])
        expect(r.results[2].detail).toBe('judge output unparseable')
    })

    it('a throwing adapter or judge becomes an error outcome', async () => {
        const t = target(() => {
            throw new Error('kaboom')
        })
        const r = await runCases(cases(1), t, ctl(), deps())
        expect(r.results[0].outcome).toBe('error')
        const r2 = await runCases(
            [mkCase(1, { scorer: { type: 'judge', criterion: 'c' } })],
            target(() => ok()),
            ctl(),
            deps({
                judge: async () => {
                    throw new Error('jfail')
                }
            })
        )
        expect(r2.results[0].outcome).toBe('error')
    })
})

const res = (c: RedteamCase, outcome: CaseResult['outcome'], extra: Partial<CaseResult> = {}): CaseResult => ({
    case: c,
    outcome,
    detail: '',
    detections: [],
    reply: '',
    ...extra
})

const meta = (over: Partial<ScorecardMeta> = {}): ScorecardMeta => ({
    target: 'self:m1',
    model: 'm1',
    corpusSha: 'abc1234',
    startedAt: 1,
    finishedAt: 2,
    controls: { concurrency: 2, delayMs: 0, maxCases: 10, stopOnErrors: 5 },
    isSelf: false,
    ...over
})

describe('buildScorecard', () => {
    const di = (n: number, o: Partial<RedteamCase> = {}) => mkCase(n, o)
    const as = (n: number) =>
        mkCase(n, { suite: 'agent-session', scorer: { type: 'tool_called', tool: 'Bash', argPattern: 'x' } })
    const judgeCase = (n: number) =>
        mkCase(n, { suite: 'system-prompt-leakage', owasp: 'LLM07', scorer: { type: 'judge', criterion: 'c' } })

    it('counts per suite and computes attackSuccessRate', () => {
        const long = 'x'.repeat(1000)
        const results = [
            res(di(1), 'attacked', { reply: long }),
            res(di(2), 'attacked', { reply: 'short' }),
            res(di(3), 'attacked'),
            res(di(4), 'attacked'),
            res(di(5), 'passed'),
            res(di(6), 'passed'),
            res(di(7), 'error'),
            res(di(8), 'skipped')
        ]
        const card = buildScorecard(meta(), results)
        const s = card.suites.find((x) => x.suite === 'direct-injection')!
        expect(s).toMatchObject({ owasp: 'LLM01', total: 8, passed: 2, attacked: 4, errors: 1, skipped: 1 })
        expect(s.attackSuccessRate).toBeCloseTo(4 / 6)
        expect(s.examples).toHaveLength(3)
        expect(s.examples[0].id).toBe('case-1')
        expect(s.examples[0].title).toBe('Case 1')
        expect(s.examples.every((e) => e.reply.length <= 300)).toBe(true)
    })

    it('attackSuccessRate is null with nothing scored', () => {
        const card = buildScorecard(meta(), [res(di(1), 'error')])
        expect(card.suites[0].attackSuccessRate).toBeNull()
    })

    it('computes detectionRecall only for self targets, excluding errors', () => {
        const results = [
            res(as(1), 'attacked', { detections: ['inject.instruction'] }),
            res(as(2), 'passed', { detections: [] }),
            res(as(3), 'passed', { detections: ['inject.instruction', 'x'] }),
            res(as(4), 'error', { detections: [] })
        ]
        expect(buildScorecard(meta({ isSelf: true }), results).detectionRecall).toBeCloseTo(2 / 3)
        expect(buildScorecard(meta({ isSelf: false }), results).detectionRecall).toBeNull()
        expect(buildScorecard(meta({ isSelf: true }), [res(as(1), 'error')]).detectionRecall).toBeNull()
    })

    it('reports judge outcomes separately from passed/attacked', () => {
        const results = [
            res(di(1), 'passed'),
            res(judgeCase(2), 'attacked', { judge: { attackSucceeded: true, detail: 'leak' } }),
            res(judgeCase(3), 'passed', { judge: { attackSucceeded: false, detail: 'ok' } })
        ]
        const card = buildScorecard(meta(), results)
        const s = card.suites.find((x) => x.suite === 'system-prompt-leakage')!
        expect(s).toMatchObject({ total: 2, passed: 0, attacked: 0 })
        expect(s.attackSuccessRate).toBeNull()
        expect(s.examples).toEqual([])
        expect(card.judge).toEqual([
            { id: 'case-2', attackSucceeded: true, detail: 'leak' },
            { id: 'case-3', attackSucceeded: false, detail: 'ok' }
        ])
    })

    it('carries stopped and meta', () => {
        const card = buildScorecard(meta(), [res(di(1), 'passed')], 'too many errors')
        expect(card.stopped).toBe('too many errors')
        expect(card.meta.corpusSha).toBe('abc1234')
    })
})

describe('renderScorecardMarkdown', () => {
    it('renders one table with a column per model', () => {
        const a = buildScorecard(meta({ model: 'm1' }), [res(mkCase(1), 'attacked'), res(mkCase(2), 'passed')])
        const b = buildScorecard(meta({ model: 'm2', target: 'self:m2' }), [res(mkCase(1), 'error')])
        const md = renderScorecardMarkdown([a, b])
        expect(md.match(/^\| Suite \|/gm)).toHaveLength(1)
        const header = md.split('\n').find((l) => l.startsWith('| Suite |'))!
        expect(header).toBe('| Suite | m1 | m2 |')
        expect(md).toContain('| direct-injection (LLM01) | 50% (1/2) | error |')
    })
})
