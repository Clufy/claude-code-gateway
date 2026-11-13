import { execFileSync } from 'node:child_process'
import { ADAPTERS, type Adapter } from '../../src/shared/redteam/adapters.ts'
import { CORPUS, SUITES } from '../../src/shared/redteam/corpus.ts'
import { gateTarget, type GateEngagement } from '../../src/shared/redteam/gate.ts'
import { judgeViaAnthropic, makeJudge } from '../../src/shared/redteam/judge.ts'
import { runCases, type RunControls, type RunTarget } from '../../src/shared/redteam/runner.ts'
import { buildScorecard, renderScorecardMarkdown, type Scorecard } from '../../src/shared/redteam/scorecard.ts'
import { fetchEngagement } from './engagement.ts'
import { parseTarget } from './targets.ts'

export interface RedteamOptions {
    target: string
    engagement?: string
    suites?: string[]
    maxCases?: number
    concurrency: number
    delayMs: number
    stopOnErrors: number
    model?: string
    template?: string
    replyPath?: string
    /** Comma list of Header-Name=ENV_VAR; values come from io.env. */
    headerEnv?: string
    judgeModel?: string
    base: string
    key: string
    out: string
}

export interface RedteamIo {
    write(path: string, text: string): void
    progress(line: string): void
    now(): number
    env: Record<string, string | undefined>
}

const TIMEOUT_MS = 60000

const runGit = (args: string[]): string => execFileSync('git', args, { stdio: ['ignore', 'pipe', 'ignore'] }).toString()

/** Short HEAD sha, with `-dirty` when the corpus has uncommitted changes (P6-R18). */
export function corpusSha(git: (args: string[]) => string = runGit): string {
    try {
        const sha = git(['rev-parse', '--short', 'HEAD']).trim()
        const dirty = git(['status', '--porcelain', '--', 'redteam/corpus']).trim() !== ''
        return dirty ? `${sha}-dirty` : sha
    } catch {
        return 'unknown'
    }
}

/** P6-R18: replaces every non-empty --header-env value in the reply text and tool args before scoring. */
function scrubbing(adapter: Adapter, values: string[]): Adapter {
    const secrets = values.filter((v) => v !== '').sort((a, b) => b.length - a.length)
    if (secrets.length === 0) return adapter
    const scrub = (s: string): string => secrets.reduce((t, v) => t.split(v).join('[redacted]'), s)
    return async (c, o) => {
        const r = await adapter(c, o)
        return { ...r, text: scrub(r.text), toolCalls: r.toolCalls.map((t) => ({ ...t, args: scrub(t.args) })) }
    }
}

/** Drops userinfo and the query string from an external URL for display. */
export function safeLabel(target: string): string {
    const i = target.indexOf(':')
    try {
        const u = new URL(target.slice(i + 1))
        u.username = ''
        u.password = ''
        u.search = ''
        u.hash = ''
        return `${target.slice(0, i)}:${u.toString()}`
    } catch {
        return target
    }
}

function stamp(ms: number): string {
    const d = new Date(ms)
    const p = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function parseHeaderEnv(spec: string | undefined, env: RedteamIo['env']): Record<string, string> {
    const headers: Record<string, string> = {}
    for (const part of (spec ?? '').split(',').map((x) => x.trim())) {
        if (!part) continue
        const i = part.indexOf('=')
        if (i <= 0 || i === part.length - 1) throw new Error(`--header-env entry "${part}" must be Header-Name=ENV_VAR`)
        const value = env[part.slice(i + 1)]
        if (value === undefined) throw new Error(`--header-env: env var ${part.slice(i + 1)} is not set`)
        headers[part.slice(0, i)] = value
    }
    return headers
}

export async function runRedteam(
    opts: RedteamOptions,
    fetchFn: typeof fetch,
    io: RedteamIo
): Promise<{ files: string[] }> {
    const target = parseTarget(opts.target)
    const base = opts.base.replace(/\/+$/, '')
    const suites = opts.suites ?? SUITES
    const unknown = suites.filter((s) => !SUITES.includes(s))
    if (unknown.length > 0) throw new Error(`unknown suite(s): ${unknown.join(', ')}. Known: ${SUITES.join(', ')}`)
    const cases = suites.flatMap((s) => CORPUS[s])
    const extHeaders = parseHeaderEnv(opts.headerEnv, io.env)

    let engagement: GateEngagement | undefined
    if (target.kind === 'external') {
        if (!opts.engagement) throw new Error('--engagement is required for external targets')
        engagement = await fetchEngagement(base, opts.key, opts.engagement, fetchFn)
        const reason = gateTarget(engagement, target.url, io.now())
        if (reason !== null) throw new Error(reason)
    }

    let models: (string | undefined)[]
    if (target.kind === 'self') {
        if (target.model === 'all') {
            const res = await fetchFn(`${base}/v1/models`, { headers: { 'x-api-key': opts.key } })
            if (!res.ok) throw new Error(`GET /v1/models returned ${res.status}`)
            const j = (await res.json()) as { data?: { id?: unknown }[] }
            models = (j.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string')
            if (models.length === 0) throw new Error('/v1/models returned no models')
        } else models = [target.model]
    } else models = [opts.model]

    const judge = opts.judgeModel ? makeJudge(judgeViaAnthropic(fetchFn, base, opts.key, opts.judgeModel)) : undefined
    const controls: RunControls = {
        concurrency: opts.concurrency,
        delayMs: opts.delayMs,
        maxCases: opts.maxCases ?? Infinity,
        stopOnErrors: opts.stopOnErrors
    }
    // Infinity would serialise to null; omit the field when unlimited.
    const metaControls = (opts.maxCases === undefined ? { ...controls, maxCases: undefined } : controls) as RunControls
    const selfOrigin = new URL(base).origin
    const sha = corpusSha()
    const cards: Scorecard[] = []

    for (const model of models) {
        const runTarget: RunTarget =
            target.kind === 'self'
                ? {
                      label: `self:${model}`,
                      adapter: ADAPTERS.anthropic,
                      opts: {
                          url: `${base}/v1/messages`,
                          model,
                          headers: { 'x-api-key': opts.key },
                          fetch: fetchFn,
                          timeoutMs: TIMEOUT_MS
                      },
                      gate: (u) =>
                          new URL(u).origin === selfOrigin
                              ? null
                              : `redirect blocked: self target must stay on ${selfOrigin}`,
                      isSelf: true
                  }
                : {
                      label: safeLabel(opts.target),
                      adapter: scrubbing(ADAPTERS[target.adapter], Object.values(extHeaders)),
                      opts: {
                          url: target.url,
                          ...(model !== undefined ? { model } : {}),
                          headers: extHeaders,
                          fetch: fetchFn,
                          timeoutMs: TIMEOUT_MS,
                          ...(opts.template !== undefined ? { template: opts.template } : {}),
                          ...(opts.replyPath !== undefined ? { replyPath: opts.replyPath } : {})
                      },
                      gate: (u) => gateTarget(engagement!, u, io.now()),
                      isSelf: false
                  }
        const startedAt = io.now()
        const total = Number.isFinite(controls.maxCases) ? Math.min(cases.length, controls.maxCases) : cases.length
        io.progress(`${runTarget.label} starting (${total} cases)`)
        let done = 0
        const run = await runCases(cases, runTarget, controls, {
            now: io.now,
            onResult: (_i, r) => io.progress(`[${++done}/${total}] ${r.case.id} ${r.outcome}`),
            sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
            ...(engagement && target.kind === 'external'
                ? { recheck: () => gateTarget(engagement!, target.url, io.now()) }
                : {}),
            ...(judge ? { judge } : {})
        })
        cards.push(
            buildScorecard(
                {
                    target: runTarget.label,
                    ...(opts.engagement ? { engagement: opts.engagement } : {}),
                    ...(model !== undefined ? { model } : {}),
                    corpusSha: sha,
                    startedAt,
                    finishedAt: io.now(),
                    controls: metaControls,
                    isSelf: runTarget.isSelf
                },
                run.results,
                run.stopped
            )
        )
    }

    const dir = `${opts.out.replace(/[\\/]+$/, '')}/${opts.engagement ?? 'self'}`
    const file = `${dir}/${stamp(io.now())}`
    const files = [`${file}.json`, `${file}.md`]
    io.write(files[0], JSON.stringify({ cards }, null, 2))
    io.write(files[1], renderScorecardMarkdown(cards))
    return { files }
}
