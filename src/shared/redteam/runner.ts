import type { Adapter, AdapterOpts } from './adapters.ts'
import { score } from './scorers.ts'
import type { AdapterResult, JudgeFn, RedteamCase } from './types.ts'

export type RunTarget = {
    label: string
    adapter: Adapter
    opts: Omit<AdapterOpts, 'fetch' | 'checkHop'> & { fetch: typeof fetch }
    gate?: (url: string) => string | null
    isSelf: boolean
}

export type RunControls = {
    concurrency: number
    delayMs: number
    maxCases: number
    stopOnErrors: number
    deadlineMs?: number
}

export type RunDeps = {
    now: () => number
    sleep: (ms: number) => Promise<void>
    recheck?: () => string | null
    judge?: JudgeFn
}

export type CaseResult = {
    case: RedteamCase
    outcome: 'attacked' | 'passed' | 'error' | 'skipped'
    detail: string
    detections: string[]
    reply: string
    judge?: { attackSucceeded: boolean | null; detail: string }
}

export type RunResult = { results: CaseResult[]; stopped?: string }

const TOO_MANY_ERRORS = 'too many errors'

function errMsg(e: unknown): string {
    return e instanceof Error ? e.message : String(e)
}

async function runOne(c: RedteamCase, target: RunTarget, deps: RunDeps): Promise<CaseResult> {
    let r: AdapterResult
    try {
        r = await target.adapter(c, { ...target.opts, checkHop: target.gate ?? (() => null) })
    } catch (e) {
        return { case: c, outcome: 'error', detail: `adapter threw: ${errMsg(e)}`, detections: [], reply: '' }
    }
    const base = { case: c, detections: r.detections, reply: r.text }
    // P6-R4: an errored reply is never scored or judged.
    if (r.error !== undefined) return { ...base, outcome: 'error', detail: r.error }

    if (c.scorer.type === 'judge') {
        if (!deps.judge) return { ...base, outcome: 'skipped', detail: 'no judge model' }
        let v: { attackSucceeded: boolean | null; detail: string }
        try {
            v = await deps.judge(c, r)
        } catch (e) {
            return { ...base, outcome: 'error', detail: `judge failed: ${errMsg(e)}` }
        }
        const outcome = v.attackSucceeded === null ? 'error' : v.attackSucceeded ? 'attacked' : 'passed'
        return { ...base, outcome, detail: v.detail, ...(v.attackSucceeded === null ? {} : { judge: v }) }
    }

    const s = score(c, r)
    if (s.attackSucceeded === null) return { ...base, outcome: 'error', detail: s.detail }
    return { ...base, outcome: s.attackSucceeded ? 'attacked' : 'passed', detail: s.detail }
}

export async function runCases(
    allCases: RedteamCase[],
    target: RunTarget,
    ctl: RunControls,
    deps: RunDeps
): Promise<RunResult> {
    const cases = Number.isFinite(ctl.maxCases) ? allCases.slice(0, Math.max(0, Math.floor(ctl.maxCases))) : allCases
    const concurrency = Math.min(8, Math.max(1, Math.floor(Number.isFinite(ctl.concurrency) ? ctl.concurrency : 2)))
    const stopOnErrors = Math.max(1, ctl.stopOnErrors)
    const deadline = ctl.deadlineMs === undefined ? undefined : deps.now() + ctl.deadlineMs

    const results: (CaseResult | undefined)[] = new Array(cases.length).fill(undefined)
    let next = 0
    let started = 0
    let consecutiveErrors = 0
    let stopped: string | undefined

    const skip = (i: number, detail: string): void => {
        results[i] = { case: cases[i], outcome: 'skipped', detail, detections: [], reply: '' }
    }

    // Starts are serialised so delay, deadline and recheck apply once per case start.
    let chain: Promise<unknown> = Promise.resolve()
    const claim = (): Promise<number> => {
        const p = chain.then(async (): Promise<number> => {
            if (stopped !== undefined || next >= cases.length) return -1
            if (started > 0 && ctl.delayMs > 0) {
                await deps.sleep(ctl.delayMs)
                if (stopped !== undefined) return -1
            }
            if (deadline !== undefined && deps.now() >= deadline) {
                for (; next < cases.length; next++) skip(next, 'deadline')
                return -1
            }
            const reason = deps.recheck?.() ?? null
            if (reason !== null) {
                stopped = reason
                return -1
            }
            started++
            return next++
        })
        chain = p.catch(() => undefined)
        return p
    }

    const worker = async (): Promise<void> => {
        for (;;) {
            const i = await claim()
            if (i < 0) return
            const r = await runOne(cases[i], target, deps)
            results[i] = r
            consecutiveErrors = r.outcome === 'error' ? consecutiveErrors + 1 : 0
            if (consecutiveErrors >= stopOnErrors && stopped === undefined) stopped = TOO_MANY_ERRORS
        }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, cases.length)) }, worker))

    for (let i = 0; i < cases.length; i++) {
        if (results[i] === undefined) skip(i, stopped !== undefined ? `stopped: ${stopped}` : 'not run')
    }
    return { results: results as CaseResult[], ...(stopped !== undefined ? { stopped } : {}) }
}
