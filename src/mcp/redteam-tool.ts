import { z } from 'zod'
import { ADAPTERS } from '../shared/redteam/adapters.ts'
import { CORPUS, SUITE_OWASP, SUITES } from '../shared/redteam/corpus.ts'
import { gateTarget } from '../shared/redteam/gate.ts'
import { judgeViaAnthropic, makeJudge } from '../shared/redteam/judge.ts'
import { runCases, type RunControls, type RunTarget } from '../shared/redteam/runner.ts'
import { buildScorecard, type Scorecard } from '../shared/redteam/scorecard.ts'
import { fail, logged, ok, type McpContext, type ToolRegistrar } from './tool-kit'

const MAX_BYTES = 32768
export const SELF_ORIGIN = 'https://self.internal'
const TIMEOUT_MS = 50000
const DEADLINE_MS = 55000
const DEFAULT_CASES = 10
const bytes = (s: string) => new TextEncoder().encode(s).length

/** Serialise within MAX_BYTES: drop examples first, then truncate judge details, then judge rows. */
export function capCard(card: Scorecard): string {
    let text = JSON.stringify(card)
    if (bytes(text) <= MAX_BYTES) return text
    const slim: Scorecard = { ...card, suites: card.suites.map((s) => ({ ...s, examples: [] })) }
    text = JSON.stringify(slim)
    if (bytes(text) <= MAX_BYTES) return text
    slim.judge = slim.judge.map((j) => ({ ...j, detail: j.detail.slice(0, 80) }))
    text = JSON.stringify(slim)
    while (bytes(text) > MAX_BYTES && slim.judge.length > 0) {
        slim.judge = slim.judge.slice(0, Math.floor(slim.judge.length / 2))
        text = JSON.stringify({ ...slim, judgeTruncated: true })
    }
    return text
}

/**
 * P6-R17: selfFetch calls the Worker directly and ignores the request signal, so race it. Rejects with the
 * signal's reason (a TimeoutError for AbortSignal.timeout) when it aborts, including when already aborted.
 */
export function race<T>(p: Promise<T>, signal: AbortSignal | null | undefined): Promise<T> {
    if (!signal) return p
    const reason = (): unknown => signal.reason ?? new DOMException('timeout', 'TimeoutError')
    if (signal.aborted) return Promise.reject(reason())
    return new Promise<T>((resolve, reject) => {
        const onAbort = (): void => reject(reason())
        signal.addEventListener('abort', onAbort, { once: true })
        p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
    })
}

async function run(
    ctx: McpContext,
    a: { suite?: string; target?: string; engagement?: string; maxCases?: number; model?: string; judgeModel?: string }
) {
    if (!a.suite || !a.target) return fail('run needs suite and target')
    const cases = CORPUS[a.suite]
    if (!cases) return fail(`unknown suite ${a.suite}; known: ${SUITES.join(', ')}`)

    const selfFetch: typeof fetch = (input, init) => race(ctx.selfFetch(new Request(input, init)), init?.signal)
    const key = ctx.config.proxyKey ?? ''
    const isSelf = a.target.startsWith('self:')
    let target: RunTarget
    let recheck: (() => string | null) | undefined

    if (isSelf) {
        const model = a.target.slice(5)
        if (!model || model === 'all')
            return fail('self target needs a model, e.g. self:@cf/meta/llama-3.1-8b-instruct')
        target = {
            label: `self:${model}`,
            adapter: ADAPTERS.anthropic,
            opts: {
                url: `${SELF_ORIGIN}/v1/messages`,
                model,
                headers: { 'x-api-key': key },
                fetch: selfFetch,
                timeoutMs: TIMEOUT_MS
            },
            gate: (u) =>
                new URL(u).origin + new URL(u).pathname === SELF_ORIGIN + '/v1/messages'
                    ? null
                    : `redirect blocked: self target must stay on ${SELF_ORIGIN}/v1/messages`,
            isSelf: true
        }
    } else {
        const m = /^(anthropic|openai):(https?:\/\/.+)$/.exec(a.target)
        if (!m) return fail('target must be self:<model>, anthropic:<url> or openai:<url>')
        if (!a.engagement) return fail('engagement is required for external targets')
        const eng = ctx.config.engagements.get(a.engagement)
        if (!eng) return fail(`unknown engagement ${a.engagement}`)
        const url = m[2]
        const reason = gateTarget(eng, url, ctx.now())
        if (reason !== null) return fail(reason)
        recheck = () => gateTarget(eng, url, ctx.now())
        target = {
            label: `${m[1]}:${new URL(url).host}`,
            adapter: ADAPTERS[m[1] as 'anthropic' | 'openai'],
            // The Worker holds no target credentials, so no auth headers are sent; authenticated targets need the CLI.
            opts: {
                url,
                ...(a.model ? { model: a.model } : {}),
                headers: {},
                fetch: (input, init) => globalThis.fetch(input, init),
                timeoutMs: TIMEOUT_MS
            },
            gate: (u) => gateTarget(eng, u, ctx.now()),
            isSelf: false
        }
    }

    const controls: RunControls = {
        concurrency: 2,
        delayMs: 0,
        maxCases: a.maxCases ?? DEFAULT_CASES,
        stopOnErrors: 5,
        deadlineMs: DEADLINE_MS
    }
    const startedAt = ctx.now()
    // The judge's timeout is clamped to the time left before the run deadline.
    const remaining = () => startedAt + DEADLINE_MS - ctx.now()
    const judge = a.judgeModel
        ? makeJudge(judgeViaAnthropic(selfFetch, SELF_ORIGIN, key, a.judgeModel, remaining))
        : undefined
    const res = await runCases(cases, target, controls, {
        now: ctx.now,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        ...(recheck ? { recheck } : {}),
        ...(judge ? { judge } : {})
    })
    const card = buildScorecard(
        {
            target: target.label,
            ...(a.engagement ? { engagement: a.engagement } : {}),
            ...(isSelf ? { model: a.target.slice(5) } : a.model ? { model: a.model } : {}),
            corpusSha: 'bundled',
            startedAt,
            finishedAt: ctx.now(),
            controls,
            isSelf
        },
        res.results,
        res.stopped
    )
    return { content: [{ type: 'text' as const, text: capCard(card) }] }
}

export const registerRedteamTool: ToolRegistrar = (server, ctx) => {
    server.registerTool(
        'redteam',
        {
            description:
                'Run bounded canary-based LLM red-team batches. suites lists the corpus; run attacks self:<model> (this Worker) or an in-scope external anthropic:/openai: URL and returns a scorecard.',
            inputSchema: {
                action: z.enum(['suites', 'run']).describe('suites or run'),
                suite: z.string().optional().describe('Suite name; run only'),
                target: z
                    .string()
                    .max(200)
                    .optional()
                    .describe('self:<model>, anthropic:<url> or openai:<url>; run only'),
                engagement: z.string().optional().describe('Engagement name; required for external targets'),
                maxCases: z
                    .number()
                    .int()
                    .min(1)
                    .max(25)
                    .optional()
                    .describe('Max cases, 1 to 25 (default 10); run only'),
                model: z
                    .string()
                    .max(200)
                    .optional()
                    .describe(
                        'Model name for external targets; run only. External targets get no credentials, so authenticated targets need the CLI'
                    ),
                judgeModel: z.string().optional().describe('Routed model that scores judge cases; run only')
            }
        },
        (args) =>
            logged(ctx, 'redteam', args.action, async () => {
                if (args.action === 'suites') {
                    return ok({
                        suites: SUITES.map((name) => ({
                            name,
                            owasp: SUITE_OWASP[name],
                            cases: CORPUS[name].length
                        }))
                    })
                }
                return run(ctx, args)
            })
    )
}
