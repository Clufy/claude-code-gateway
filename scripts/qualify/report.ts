import type { Collected } from './collect.ts'
import type { Fixture } from './fixture.ts'
import { isValidToolCall } from './validate.ts'

export interface ScenarioRun {
    scenarioId: string
    run: number
    skipped: boolean
    pass: boolean
    detail: string
    collected: Collected[]
}

export type Verdict = 'fit' | 'subagent-only' | 'unfit'

export interface ModelReport {
    model: string
    scenarios: Record<string, { passRate: number | null; runs: number; details: string[] }>
    validToolCallRate: number
    toolCallsFromTextRate: number
    unparsedCount: number
    ttfbP50: number
    ttfbP95: number
    totalP50: number
    totalP95: number
    outputTokens: number
    errors: number
    verdict: Verdict
    verdictReasons: string[]
}

export const THRESHOLDS = {
    fit: { validToolCallRate: 0.95, toolScenarioPassRate: 0.9, modeScopePassRate: 1 },
    subagentOnly: { validToolCallRate: 0.85, toolScenarioPassRate: 0.7 }
} as const

// tool.parallel is reported but not gating: parallel calls are an optimization.
const GATING_TOOL_SCENARIOS = ['tool.single', 'tool.args_complex', 'tool.choice', 'tool.after_result', 'context.long']
const MODE_SCOPE_NOTE = 'mode.scope not measurable before Phase 3'
const EPS = 1e-9

const num = (n: number) => String(Math.round(n * 100) / 100)

function percentile(values: number[], p: number): number {
    if (values.length === 0) return 0
    const sorted = [...values].sort((a, b) => a - b)
    return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)]
}

export function buildModelReport(model: string, runs: ScenarioRun[], tools: Fixture['tools']): ModelReport {
    const scenarios: ModelReport['scenarios'] = {}
    const ids = [...new Set(runs.map((r) => r.scenarioId))]
    for (const id of ids) {
        const measured = runs.filter((r) => r.scenarioId === id && !r.skipped)
        scenarios[id] = {
            passRate: measured.length ? measured.filter((r) => r.pass).length / measured.length : null,
            runs: measured.length,
            details: [...new Set(measured.filter((r) => !r.pass).map((r) => r.detail))]
        }
    }

    const collected = runs.filter((r) => !r.skipped).flatMap((r) => r.collected)
    const calls = collected.flatMap((c) => c.blocks.filter((b) => b.type === 'tool_use'))
    const validToolCallRate = calls.length ? calls.filter((b) => isValidToolCall(b, tools)).length / calls.length : 1
    const fromText = collected.reduce((n, c) => n + (c.proxyStats?.toolCallsFromText ?? 0), 0)
    const clean = collected.filter((c) => !c.error)

    const gating = GATING_TOOL_SCENARIOS.map((id) => scenarios[id]?.passRate).filter((r): r is number => r != null)
    const toolScenarioPassRate = gating.length ? gating.reduce((a, b) => a + b, 0) / gating.length : 1
    const modeScope = scenarios['mode.scope']?.passRate ?? null

    const fitFailures: string[] = []
    const subagentFailures: string[] = []
    const t = THRESHOLDS
    if (validToolCallRate + EPS < t.fit.validToolCallRate)
        fitFailures.push(`validToolCallRate ${num(validToolCallRate)} < ${t.fit.validToolCallRate}`)
    if (toolScenarioPassRate + EPS < t.fit.toolScenarioPassRate)
        fitFailures.push(`toolScenarioPassRate ${num(toolScenarioPassRate)} < ${t.fit.toolScenarioPassRate}`)
    if (modeScope !== null && modeScope + EPS < t.fit.modeScopePassRate)
        fitFailures.push(`mode.scope passRate ${num(modeScope)} < ${t.fit.modeScopePassRate}`)
    if (validToolCallRate + EPS < t.subagentOnly.validToolCallRate)
        subagentFailures.push(`validToolCallRate ${num(validToolCallRate)} < ${t.subagentOnly.validToolCallRate}`)
    if (toolScenarioPassRate + EPS < t.subagentOnly.toolScenarioPassRate)
        subagentFailures.push(
            `toolScenarioPassRate ${num(toolScenarioPassRate)} < ${t.subagentOnly.toolScenarioPassRate}`
        )

    const verdict: Verdict =
        fitFailures.length === 0 ? 'fit' : subagentFailures.length === 0 ? 'subagent-only' : 'unfit'
    const verdictReasons = [...fitFailures, ...subagentFailures]
    if (modeScope === null) verdictReasons.push(MODE_SCOPE_NOTE)
    if (gating.length === 0) verdictReasons.push('no tool scenarios were measured')

    return {
        model,
        scenarios,
        validToolCallRate,
        toolCallsFromTextRate: calls.length ? Math.min(1, fromText / calls.length) : 0,
        unparsedCount: collected.filter((c) => c.proxyStats?.unparsedToolText).length,
        ttfbP50: percentile(
            clean.map((c) => c.ttfbMs),
            50
        ),
        ttfbP95: percentile(
            clean.map((c) => c.ttfbMs),
            95
        ),
        totalP50: percentile(
            clean.map((c) => c.totalMs),
            50
        ),
        totalP95: percentile(
            clean.map((c) => c.totalMs),
            95
        ),
        outputTokens: collected.reduce((n, c) => n + (c.usage.output_tokens ?? 0), 0),
        errors: runs.filter((r) => r.collected.some((c) => c.error)).length,
        verdict,
        verdictReasons
    }
}

const pct = (n: number) => `${Math.round(n * 100)}%`
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ')

export function renderMarkdown(
    reports: ModelReport[],
    meta: { base: string; runs: number; fixture: string; startedAt: string }
): string {
    const out: string[] = [
        '# Model qualification',
        '',
        `- Base: ${meta.base}`,
        `- Runs per scenario: ${meta.runs}`,
        `- Fixture: ${meta.fixture}`,
        `- Started: ${meta.startedAt}`,
        '',
        '| Model | Verdict | Valid tool calls | From text | Unparsed | Errors | TTFB p50/p95 (ms) | Total p50/p95 (ms) | Output tokens |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- |'
    ]
    for (const r of reports)
        out.push(
            `| ${cell(r.model)} | ${r.verdict} | ${pct(r.validToolCallRate)} | ${pct(r.toolCallsFromTextRate)} | ${r.unparsedCount} | ${r.errors} | ${r.ttfbP50}/${r.ttfbP95} | ${r.totalP50}/${r.totalP95} | ${r.outputTokens} |`
        )
    for (const r of reports) {
        out.push('', `## ${r.model}: ${r.verdict}`, '')
        for (const reason of r.verdictReasons) out.push(`- ${reason}`)
        out.push('', '| Scenario | Pass rate | Runs | Failures |', '| --- | --- | --- | --- |')
        for (const [id, s] of Object.entries(r.scenarios))
            out.push(
                `| ${id} | ${s.passRate === null ? 'skipped' : pct(s.passRate)} | ${s.runs} | ${cell(s.details.join('; '))} |`
            )
    }
    return out.join('\n') + '\n'
}
