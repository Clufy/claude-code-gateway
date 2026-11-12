import { collectResponse, type Collected } from './collect.ts'
import { loadFixture } from './fixture.ts'
import { buildModelReport, type ModelReport, type ScenarioRun } from './report.ts'
import { judge, SCENARIOS } from './scenarios.ts'

export interface QualifyOptions {
    base: string
    key: string
    models: string[]
    runs: number
    only?: string[]
    skipLong?: boolean
    /** Engagement name: enables the mode.* scenarios, sent as x-engagement with x-proxy-mode: redteam. */
    engagement?: string
    fixturePath?: string
    /** Called after every scenario run (progress output, raw result capture). */
    onRun?: (model: string, run: ScenarioRun) => void
}

function failed(error: string): Collected {
    return {
        status: 0,
        ttfbMs: null,
        totalMs: 0,
        blocks: [],
        stopReason: null,
        usage: {},
        proxyStats: null,
        error
    }
}

export async function runQualification(opts: QualifyOptions, fetchImpl: typeof fetch = fetch): Promise<ModelReport[]> {
    const fx = loadFixture(opts.fixturePath)
    const url = `${opts.base.replace(/\/+$/, '')}/v1/messages`
    const scenarios = SCENARIOS.filter((s) => !opts.only || opts.only.includes(s.id))
    const reports: ModelReport[] = []

    for (const model of opts.models) {
        const runs: ScenarioRun[] = []
        for (const scenario of scenarios) {
            for (let n = 1; n <= opts.runs; n++) {
                const skipped =
                    (scenario.requires !== undefined && opts.engagement === undefined) ||
                    (opts.skipLong === true && scenario.id === 'context.long')
                const collected: Collected[] = []
                if (!skipped) {
                    for (const request of scenario.requests(fx)) {
                        const startedAt = Date.now()
                        try {
                            const res = await fetchImpl(url, {
                                method: 'POST',
                                headers: {
                                    'content-type': 'application/json',
                                    'anthropic-version': '2023-06-01',
                                    'x-api-key': opts.key,
                                    'x-proxy-debug': '1',
                                    ...(scenario.requires !== undefined && opts.engagement !== undefined
                                        ? { 'x-engagement': opts.engagement, 'x-proxy-mode': 'redteam' }
                                        : {})
                                },
                                body: JSON.stringify({ ...request, model })
                            })
                            collected.push(await collectResponse(res, startedAt))
                        } catch (e) {
                            collected.push(failed(`request failed: ${e instanceof Error ? e.message : String(e)}`))
                        }
                    }
                }
                const check = skipped ? { pass: false, detail: 'skipped' } : judge(scenario, collected, fx)
                const result: ScenarioRun = { scenarioId: scenario.id, run: n, skipped, ...check, collected }
                runs.push(result)
                opts.onRun?.(model, result)
            }
        }
        reports.push(buildModelReport(model, runs, fx.tools))
    }
    return reports
}

/** The x-api-key value from ANTHROPIC_CUSTOM_HEADERS (newline-separated `Name: value` lines). */
export function keyFromCustomHeaders(headers: string | undefined): string | undefined {
    for (const line of (headers ?? '').split(/\r?\n/)) {
        const i = line.indexOf(':')
        if (i > 0 && line.slice(0, i).trim().toLowerCase() === 'x-api-key') return line.slice(i + 1).trim()
    }
    return undefined
}
