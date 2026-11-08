import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { renderMarkdown } from './report.ts'
import type { ScenarioRun } from './report.ts'
import { keyFromCustomHeaders, runQualification } from './run.ts'
import { SCENARIOS } from './scenarios.ts'

function usageError(message: string): never {
    console.error(`qualify: ${message}`)
    process.exit(2)
}

function stamp(d: Date): string {
    const p = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

const csv = (s: string) =>
    s
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)

let values
try {
    ;({ values } = parseArgs({
        options: {
            base: { type: 'string' },
            key: { type: 'string' },
            models: { type: 'string' },
            runs: { type: 'string', default: '3' },
            only: { type: 'string' },
            'skip-long': { type: 'boolean', default: false },
            fixture: { type: 'string' },
            out: { type: 'string', default: 'qualify-results' }
        }
    }))
} catch (e) {
    usageError(e instanceof Error ? e.message : String(e))
}

const base = values.base ?? process.env.ANTHROPIC_BASE_URL
if (!base) usageError('--base is required (or set ANTHROPIC_BASE_URL)')
const key = values.key ?? keyFromCustomHeaders(process.env.ANTHROPIC_CUSTOM_HEADERS) ?? process.env.PROXY_KEY
if (!key) usageError('--key is required (or x-api-key in ANTHROPIC_CUSTOM_HEADERS, or PROXY_KEY)')
const models = csv(values.models ?? '')
if (models.length === 0) usageError('--models is required (comma-separated)')
if (!/^[1-9][0-9]*$/.test(values.runs)) usageError(`--runs must be a positive integer, got "${values.runs}"`)
const runs = Number(values.runs)
const only = values.only === undefined ? undefined : csv(values.only)
if (only) {
    const known = SCENARIOS.map((s) => s.id)
    const unknown = only.filter((id) => !known.includes(id))
    if (unknown.length > 0) usageError(`unknown scenario id(s): ${unknown.join(', ')}. Known: ${known.join(', ')}`)
}

const startedAt = new Date()
const rawRuns: { model: string; run: ScenarioRun }[] = []
const reports = await runQualification({
    base,
    key,
    models,
    runs,
    only,
    skipLong: values['skip-long'],
    fixturePath: values.fixture,
    onRun: (model, run) => {
        rawRuns.push({ model, run })
        console.error(
            `${model} ${run.scenarioId} #${run.run}: ${run.skipped ? 'skipped' : run.pass ? 'pass' : `FAIL (${run.detail})`}`
        )
    }
})

const markdown = renderMarkdown(reports, {
    base,
    runs,
    fixture: values.fixture ?? 'default (local capture, else synthetic)',
    startedAt: startedAt.toISOString()
})
mkdirSync(values.out, { recursive: true })
const file = join(values.out, stamp(startedAt))
writeFileSync(`${file}.json`, JSON.stringify({ startedAt: startedAt.toISOString(), reports, runs: rawRuns }, null, 2))
writeFileSync(`${file}.md`, markdown)
console.log(markdown)
console.log(`Wrote ${file}.json and ${file}.md`)
