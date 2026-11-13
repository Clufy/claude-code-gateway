import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { parseArgs } from 'node:util'
import { keyFromCustomHeaders } from '../qualify/run.ts'
import { runRedteam } from './run.ts'

function usageError(message: string): never {
    console.error(`redteam: ${message}`)
    process.exit(2)
}

const int = (name: string, v: string | undefined, d: number): number => {
    if (v === undefined) return d
    if (!/^[0-9]+$/.test(v)) usageError(`--${name} must be a non-negative integer, got "${v}"`)
    return Number(v)
}

let values
try {
    ;({ values } = parseArgs({
        options: {
            target: { type: 'string' },
            engagement: { type: 'string' },
            suite: { type: 'string' },
            'max-cases': { type: 'string' },
            concurrency: { type: 'string' },
            'delay-ms': { type: 'string' },
            'stop-on-errors': { type: 'string' },
            model: { type: 'string' },
            template: { type: 'string' },
            'reply-path': { type: 'string' },
            'header-env': { type: 'string' },
            'judge-model': { type: 'string' },
            base: { type: 'string' },
            key: { type: 'string' },
            out: { type: 'string', default: 'redteam-results' }
        }
    }))
} catch (e) {
    usageError(e instanceof Error ? e.message : String(e))
}

if (!values.target) usageError('--target is required')
const base = values.base ?? process.env.ANTHROPIC_BASE_URL
if (!base) usageError('--base is required (or set ANTHROPIC_BASE_URL)')
const key = values.key ?? keyFromCustomHeaders(process.env.ANTHROPIC_CUSTOM_HEADERS) ?? process.env.PROXY_KEY
if (!key) usageError('--key is required (or x-api-key in ANTHROPIC_CUSTOM_HEADERS, or PROXY_KEY)')

try {
    const { files } = await runRedteam(
        {
            target: values.target,
            engagement: values.engagement,
            suites: values.suite
                ?.split(',')
                .map((s) => s.trim())
                .filter(Boolean),
            maxCases: values['max-cases'] === undefined ? undefined : int('max-cases', values['max-cases'], 0),
            concurrency: int('concurrency', values.concurrency, 2),
            delayMs: int('delay-ms', values['delay-ms'], 0),
            stopOnErrors: int('stop-on-errors', values['stop-on-errors'], 5),
            model: values.model,
            template: values.template,
            replyPath: values['reply-path'],
            headerEnv: values['header-env'],
            judgeModel: values['judge-model'],
            base,
            key,
            out: values.out
        },
        fetch,
        {
            write: (path, text) => {
                mkdirSync(dirname(path), { recursive: true })
                writeFileSync(path, text)
            },
            progress: (line) => console.error(line),
            now: () => Date.now(),
            env: process.env
        }
    )
    console.log(`Wrote ${files.join(' and ')}`)
} catch (e) {
    usageError(e instanceof Error ? e.message : String(e))
}
