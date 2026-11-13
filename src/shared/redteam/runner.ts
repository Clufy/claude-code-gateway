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
    /** Called as each case settles (P6-R12); a throwing callback never breaks the run. */
    onResult?: (index: number, result: CaseResult) => void
}

export type JudgeStatus = 'attacked' | 'passed' | 'unknown' | 'skipped' | 'error'

export type CaseResult = {
    case: RedteamCase
    outcome: 'attacked' | 'passed' | 'error' | 'skipped'
    detail: string
    detections: string[]
    reply: string
    /** The adapter's tool calls, when it returned any (examples show the first when the reply is empty). */
    toolCalls?: AdapterResult['toolCalls']
    /** Set on every judge case (P6-R6); `outcome` stays for display. */
    judge?: { status: JudgeStatus; detail: string }
}

export type RunResult = { results: CaseResult[]; stopped?: string }

const isJudge = (c: RedteamCase): boolean => c.scorer.type === 'judge'

function make(
    c: RedteamCase,
    outcome: CaseResult['outcome'],
    detail: string,
    judgeStatus: JudgeStatus,
    extra: { detections?: string[]; reply?: string; toolCalls?: AdapterResult['toolCalls'] } = {}
): CaseResult {
    return {
        case: c,
        outcome,
        detail,
        detections: extra.detections ?? [],
        reply: extra.reply ?? '',
        ...(extra.toolCalls?.length ? { toolCalls: extra.toolCalls } : {}),
        ...(isJudge(c) ? { judge: { status: judgeStatus, detail } } : {})
    }
}

function skipped(c: RedteamCase, detail: string): CaseResult {
    return make(c, 'skipped', detail, 'skipped')
}

type Done = { result: CaseResult; adapterError: boolean }

async function runOneInner(c: RedteamCase, target: RunTarget, deps: RunDeps, deadline?: number): Promise<Done> {
    let r: AdapterResult
    let timeoutMs = target.opts.timeoutMs
    if (deadline !== undefined) {
        const remaining = deadline - deps.now()
        if (remaining <= 0) return { adapterError: false, result: skipped(c, 'deadline') }
        timeoutMs = Math.min(timeoutMs, remaining)
    }
    try {
        r = await target.adapter(c, { ...target.opts, timeoutMs, checkHop: target.gate ?? (() => null) })
    } catch (e) {
        return {
            adapterError: true,
            result: make(c, 'error', `adapter threw: ${e instanceof Error ? e.message : String(e)}`, 'error')
        }
    }
    const extra = { detections: r.detections, reply: r.text, toolCalls: r.toolCalls }
    // P6-R4: an errored reply is never scored or judged.
    if (r.error !== undefined) return { adapterError: true, result: make(c, 'error', r.error, 'error', extra) }

    if (isJudge(c)) {
        if (!deps.judge) return { adapterError: false, result: make(c, 'skipped', 'no judge model', 'skipped', extra) }
        let v: { attackSucceeded: boolean | null; detail: string }
        try {
            v = await deps.judge(c, r)
        } catch {
            return { adapterError: false, result: make(c, 'error', 'judge call failed', 'unknown', extra) }
        }
        if (v.attackSucceeded === null) {
            return { adapterError: false, result: make(c, 'error', v.detail, 'unknown', extra) }
        }
        const status = v.attackSucceeded ? 'attacked' : 'passed'
        return { adapterError: false, result: make(c, status, v.detail, status, extra) }
    }

    const s = score(c, r)
    if (s.attackSucceeded === null) return { adapterError: false, result: make(c, 'error', s.detail, 'error', extra) }
    return {
        adapterError: false,
        result: make(c, s.attackSucceeded ? 'attacked' : 'passed', s.detail, 'error', extra)
    }
}

async function runOne(c: RedteamCase, target: RunTarget, deps: RunDeps, deadline?: number): Promise<Done> {
    try {
        return await runOneInner(c, target, deps, deadline)
    } catch {
        return { adapterError: false, result: make(c, 'error', 'internal error', 'error') }
    }
}

const finiteOr = (n: number, d: number): number => (Number.isFinite(n) ? n : d)

export async function runCases(
    allCases: RedteamCase[],
    target: RunTarget,
    ctl: RunControls,
    deps: RunDeps
): Promise<RunResult> {
    const cases = Number.isFinite(ctl.maxCases) ? allCases.slice(0, Math.max(0, Math.floor(ctl.maxCases))) : allCases
    const concurrency = Math.min(8, Math.max(1, Math.floor(finiteOr(ctl.concurrency, 2))))
    const stopOnErrors = Math.max(1, finiteOr(ctl.stopOnErrors, 5))
    const delayMs = Math.max(0, finiteOr(ctl.delayMs, 0))

    const results: (CaseResult | undefined)[] = new Array(cases.length).fill(undefined)
    const set = (i: number, r: CaseResult): void => {
        results[i] = r
        try {
            deps.onResult?.(i, r)
        } catch {
            // ignore
        }
    }
    let next = 0
    let started = 0
    let consecutiveErrors = 0
    let stopped: string | undefined

    let deadline: number | undefined
    try {
        if (ctl.deadlineMs !== undefined) deadline = deps.now() + ctl.deadlineMs
    } catch {
        stopped = 'internal error'
    }

    // Starts are serialised so delay, deadline and recheck apply once per case start.
    let chain: Promise<unknown> = Promise.resolve()
    const claim = (): Promise<number> => {
        const p = chain.then(async (): Promise<number> => {
            if (stopped !== undefined || next >= cases.length) return -1
            try {
                if (started > 0 && delayMs > 0) {
                    await deps.sleep(delayMs)
                    if (stopped !== undefined) return -1
                }
                if (deadline !== undefined && deps.now() >= deadline) {
                    for (; next < cases.length; next++) set(next, skipped(cases[next], 'deadline'))
                    return -1
                }
            } catch {
                stopped = 'internal error'
                return -1
            }
            let reason: string | null
            try {
                reason = deps.recheck?.() ?? null
            } catch {
                reason = 'recheck failed' // fail closed
            }
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
            const { result, adapterError } = await runOne(cases[i], target, deps, deadline)
            set(i, result)
            // The streak counts adapter errors (target health) only, in completion order.
            consecutiveErrors = adapterError ? consecutiveErrors + 1 : 0
            if (consecutiveErrors >= stopOnErrors && stopped === undefined) stopped = 'too many errors'
        }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, cases.length)) }, worker))

    for (let i = 0; i < cases.length; i++) {
        if (results[i] === undefined) {
            set(i, skipped(cases[i], stopped !== undefined ? `stopped: ${stopped}` : 'not run'))
        }
    }
    return { results: results as CaseResult[], ...(stopped !== undefined ? { stopped } : {}) }
}
