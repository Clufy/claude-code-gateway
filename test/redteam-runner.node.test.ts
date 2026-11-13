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
    it('wildcards need a dot boundary', () => {
        const e: GateEngagement = { ...eng, scope: { domains: ['*.x.com'], llmTargets: [] }, exclude: { domains: [] } }
        expect(gateTarget(e, 'https://evilx.com/', 1500)).not.toBeNull()
        expect(gateTarget(e, 'https://x.com/', 1500)).not.toBeNull()
        expect(gateTarget(e, 'https://a.x.com/', 1500)).toBeNull()
        expect(gateTarget(e, 'https://a.x.com:8443/p', 1500)).toBeNull()
    })
    it('window start and end are inclusive', () => {
        expect(gateTarget(eng, 'https://llm.acme-test.com/', 1000)).toBeNull()
        expect(gateTarget(eng, 'https://llm.acme-test.com/', 2000)).toBeNull()
    })
    it('refuses userinfo', () => {
        expect(gateTarget(eng, 'https://user:pw@llm.acme-test.com/', 1500)).toBe('invalid target URL')
        expect(gateTarget(eng, 'https://user@llm.acme-test.com/', 1500)).toBe('invalid target URL')
    })
    it('IP literals only match an exact llmTargets entry, never a wildcard', () => {
        const wild: GateEngagement = { ...eng, scope: { domains: ['*.0.2.1', '*.1'], llmTargets: [] } }
        expect(gateTarget(wild, 'https://203.0.2.1/', 1500)).not.toBeNull()
        expect(gateTarget(wild, 'https://[::1]/', 1500)).not.toBeNull()
        const exact: GateEngagement = { ...eng, scope: { domains: [], llmTargets: ['203.0.113.7', '[2001:db8::1]'] } }
        expect(gateTarget(exact, 'https://203.0.113.7/', 1500)).toBeNull()
        expect(gateTarget(exact, 'https://[2001:db8::1]:8443/', 1500)).toBeNull()
    })
    it('allows [::1] over http when listed, refuses it otherwise', () => {
        const e: GateEngagement = { ...eng, scope: { domains: [], llmTargets: ['[::1]'] } }
        expect(gateTarget(e, 'http://[::1]:8787/', 1500)).toBeNull()
        expect(gateTarget(eng, 'http://[::1]:8787/', 1500)).not.toBeNull()
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
    it('calls onResult per settled case and survives a throwing callback', async () => {
        const seen: [number, string][] = []
        const r = await runCases(
            cases(4),
            target(async (c) => ok(c.id)),
            ctl({ concurrency: 1, maxCases: 4 }),
            deps({
                onResult: (i, res) => {
                    seen.push([i, res.outcome])
                    throw new Error('cb')
                }
            })
        )
        expect(seen).toEqual([0, 1, 2, 3].map((i) => [i, 'passed']))
        expect(r.results).toHaveLength(4)
        const stopped = await runCases(
            cases(3),
            target(async () => ok()),
            ctl({ maxCases: 3 }),
            deps({ recheck: () => 'closed', onResult: (i) => void seen.push([i, 'x']) })
        )
        expect(stopped.results.every((x) => x.outcome === 'skipped')).toBe(true)
        expect(seen.filter(([, o]) => o === 'x')).toHaveLength(3)
    })

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
        expect(r.results[2].judge?.status).toBe('error')
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
        expect(r.results.map((x) => x.judge?.status)).toEqual(['attacked', 'passed', 'unknown'])
        expect(r.results[0].judge).toEqual({ status: 'attacked', detail: 'leaked' })
        expect(r.results[2].detail).toBe('judge output unparseable')
    })

    it('P6-R6: judge status for no judge, throw and adapter error', async () => {
        const jc = (n: number) => mkCase(n, { scorer: { type: 'judge', criterion: 'c' } })
        const none = await runCases(
            [jc(1)],
            target(() => ok()),
            ctl(),
            deps()
        )
        expect(none.results[0].judge).toEqual({ status: 'skipped', detail: 'no judge model' })
        const thrown = await runCases(
            [jc(1)],
            target(() => ok()),
            ctl(),
            deps({
                judge: async () => {
                    throw new Error('x')
                }
            })
        )
        expect(thrown.results[0].judge).toEqual({ status: 'unknown', detail: 'judge call failed' })
        const adapterErr = await runCases(
            [jc(1)],
            target(() => fail()),
            ctl(),
            deps({ judge: async () => ({ attackSucceeded: true, detail: 'x' }) })
        )
        expect(adapterErr.results[0].judge?.status).toBe('error')
    })

    it('P6-R6: stopped and deadline-skipped judge cases get judge status skipped', async () => {
        const jc = mkCase(2, { scorer: { type: 'judge', criterion: 'c' } })
        const stopped = await runCases(
            [mkCase(1), jc],
            target(() => ok()),
            ctl(),
            deps({
                recheck: (() => {
                    let n = 0
                    return () => (n++ ? 'closed' : null)
                })()
            })
        )
        expect(stopped.results[1].judge).toEqual({ status: 'skipped', detail: 'stopped: closed' })
        const d = deps()
        const late = await runCases(
            [mkCase(1), jc],
            target(() => {
                d.clock.t += 10
                return ok()
            }),
            ctl({ deadlineMs: 5 }),
            d
        )
        expect(late.results[1].judge).toEqual({ status: 'skipped', detail: 'deadline' })
    })

    it('the error streak ignores judge failures and nulls', async () => {
        const cs = Array.from({ length: 6 }, (_, i) => mkCase(i + 1, { scorer: { type: 'judge', criterion: 'c' } }))
        let n = 0
        const r = await runCases(
            cs,
            target(() => ok()),
            ctl({ stopOnErrors: 2 }),
            deps({
                judge: async () => {
                    if (n++ % 2) throw new Error('x')
                    return { attackSucceeded: null, detail: 'judge output unparseable' }
                }
            })
        )
        expect(r.stopped).toBeUndefined()
        expect(r.results.every((x) => x.judge?.status === 'unknown')).toBe(true)
    })

    it('hardening 1: adapter returning undefined or judge returning junk gives internal error', async () => {
        const r = await runCases(
            [mkCase(1)],
            target(() => undefined as unknown as AdapterResult),
            ctl(),
            deps()
        )
        expect(r.results[0]).toMatchObject({ outcome: 'error', detail: 'internal error' })
        const r2 = await runCases(
            [mkCase(1, { scorer: { type: 'judge', criterion: 'c' } })],
            target(() => ok()),
            ctl(),
            deps({ judge: async () => null as never })
        )
        expect(r2.results[0]).toMatchObject({ outcome: 'error', detail: 'internal error' })
    })

    it('hardening 2: a throwing recheck fails closed; throwing sleep or now never rejects', async () => {
        const r = await runCases(
            cases(3),
            target(() => ok()),
            ctl(),
            deps({
                recheck: () => {
                    throw new Error('x')
                }
            })
        )
        expect(r.stopped).toBe('recheck failed')
        expect(r.results.every((x) => x.outcome === 'skipped')).toBe(true)
        const s = await runCases(
            cases(3),
            target(() => ok()),
            ctl({ delayMs: 5 }),
            deps({
                sleep: async () => {
                    throw new Error('x')
                }
            })
        )
        expect(s.stopped).toBe('internal error')
        expect(s.results.map((x) => x.outcome)).toEqual(['passed', 'skipped', 'skipped'])
        const n = await runCases(
            cases(2),
            target(() => ok()),
            ctl({ deadlineMs: 5 }),
            deps({
                now: () => {
                    throw new Error('x')
                }
            })
        )
        expect(n.stopped).toBe('internal error')
    })

    it('hardening 3: non-finite controls fall back to defaults', async () => {
        let sent = 0
        const r = await runCases(
            cases(7),
            target(() => {
                sent++
                return fail()
            }),
            { concurrency: NaN, delayMs: NaN, maxCases: NaN, stopOnErrors: NaN },
            deps()
        )
        expect(sent).toBeGreaterThanOrEqual(5)
        expect(sent).toBeLessThanOrEqual(6)
        expect(r.stopped).toBe('too many errors')
        expect(r.results).toHaveLength(7)
    })

    it('deadline with concurrency 2 skips the unstarted cases', async () => {
        const d = deps()
        let sent = 0
        const r = await runCases(
            cases(6),
            target(async () => {
                sent++
                d.clock.t += 600
                return ok()
            }),
            ctl({ concurrency: 2, deadlineMs: 1000 }),
            d
        )
        expect(sent).toBeGreaterThanOrEqual(2)
        expect(sent).toBeLessThan(6)
        expect(r.results.filter((x) => x.outcome === 'skipped' && x.detail === 'deadline')).toHaveLength(6 - sent)
        expect(r.results.filter((x) => x.outcome === 'passed')).toHaveLength(sent)
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

    it('computes detectionRecall only for self targets, excluding errors and skipped', () => {
        const results = [
            res(as(5), 'skipped', { detections: [] }),
            res(as(1), 'attacked', { detections: ['inject.instruction'] }),
            res(as(2), 'passed', { detections: [] }),
            res(as(3), 'passed', { detections: ['inject.instruction', 'x'] }),
            res(as(4), 'error', { detections: [] })
        ]
        expect(buildScorecard(meta({ isSelf: true }), results).detectionRecall).toBeCloseTo(2 / 3)
        expect(buildScorecard(meta({ isSelf: false }), results).detectionRecall).toBeNull()
        expect(buildScorecard(meta({ isSelf: true }), [res(as(1), 'error')]).detectionRecall).toBeNull()
    })

    it('P6-R6: every judge case is in the judge section and in no suite count', () => {
        const spl = 'system-prompt-leakage'
        const results = [
            res(di(1), 'passed'),
            res(judgeCase(2), 'attacked', { judge: { status: 'attacked', detail: 'leak' } }),
            res(judgeCase(3), 'passed', { judge: { status: 'passed', detail: 'ok' } }),
            res(judgeCase(4), 'error', { judge: { status: 'unknown', detail: 'judge output unparseable' } }),
            res(judgeCase(5), 'error', { judge: { status: 'unknown', detail: 'judge call failed' } }),
            res(judgeCase(6), 'skipped', { judge: { status: 'skipped', detail: 'no judge model' } }),
            res(judgeCase(7), 'error', { judge: { status: 'error', detail: 'http 500' } })
        ]
        const card = buildScorecard(meta(), results)
        const s = card.suites.find((x) => x.suite === spl)!
        expect(s).toMatchObject({ total: 6, judgeCases: 6, passed: 0, attacked: 0, errors: 0, skipped: 0 })
        expect(s.attackSuccessRate).toBeNull()
        expect(s.examples).toEqual([])
        expect(card.judge.map((j) => [j.id, j.suite, j.status])).toEqual([
            ['case-2', spl, 'attacked'],
            ['case-3', spl, 'passed'],
            ['case-4', spl, 'unknown'],
            ['case-5', spl, 'unknown'],
            ['case-6', spl, 'skipped'],
            ['case-7', spl, 'error']
        ])
        expect(card.judge[0].detail).toBe('leak')
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
        expect(md).toContain('| direct-injection (LLM01) | 50% (1/2) | - (0/0) +1 err |')
    })

    it('shows +N err next to a score and escapes pipes in labels', () => {
        const a = buildScorecard(meta({ model: 'a|b' }), [
            res(mkCase(1), 'attacked'),
            res(mkCase(2), 'passed'),
            res(mkCase(3), 'error')
        ])
        const md = renderScorecardMarkdown([a])
        expect(md).toContain('| Suite | a\\|b |')
        expect(md).toContain('| direct-injection (LLM01) | 50% (1/2) +1 err |')
    })
})
