import type { ObservabilityConfig } from './config'

export interface LogFilter {
    key: string
    operation: 'eq' | 'starts_with' | 'in'
    type: 'string'
    value: string | string[]
}

export interface LogRow {
    time: number
    source: Record<string, unknown>
}

export type QueryResult = { ok: true; rows: LogRow[]; count: number } | { ok: false; error: string }

const TIMEOUT_MS = 10000
const MAX_ERROR_MESSAGE = 200
const UNEXPECTED = 'logs query returned an unexpected response'

function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Client-side re-check of a filter against a parsed log line. `$`-prefixed keys are server-side only. */
export function matches(source: Record<string, unknown>, f: LogFilter): boolean {
    if (f.key.startsWith('$')) return true
    if (!Object.prototype.hasOwnProperty.call(source, f.key)) return false
    const v = source[f.key]
    if (f.operation === 'eq') return String(v) === f.value
    if (f.operation === 'starts_with') {
        return typeof v === 'string' && typeof f.value === 'string' && v.startsWith(f.value)
    }
    return Array.isArray(f.value) && f.value.includes(String(v))
}

function parseSource(raw: unknown): Record<string, unknown> | null {
    if (isRecord(raw)) return raw
    if (typeof raw !== 'string') return null
    try {
        const parsed: unknown = JSON.parse(raw)
        return isRecord(parsed) ? parsed : null
    } catch {
        return null
    }
}

async function failure(res: Response, token: string): Promise<string> {
    let message = ''
    try {
        const body: unknown = await res.json()
        const first = isRecord(body) && Array.isArray(body.errors) ? body.errors[0] : undefined
        if (isRecord(first) && typeof first.message === 'string') {
            message = first.message.replaceAll(token, '[redacted]').slice(0, MAX_ERROR_MESSAGE)
        }
    } catch {
        // non-JSON body: status only
    }
    return `logs query failed: HTTP ${res.status}${message ? `: ${message}` : ''}`
}

export async function queryEvents(
    cfg: ObservabilityConfig,
    event: 'detection' | 'request',
    from: number,
    to: number,
    filters: LogFilter[],
    limit: number
): Promise<QueryResult> {
    const all: LogFilter[] = [
        { key: '$metadata.service', operation: 'eq', type: 'string', value: cfg.service },
        { key: 'event', operation: 'eq', type: 'string', value: event },
        ...filters
    ]
    const url = `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/workers/observability/telemetry/query`
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${cfg.apiToken}`,
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                queryId: 'proxy-mcp-logs',
                view: 'events',
                dry: true,
                limit,
                timeframe: { from, to },
                parameters: { filterCombination: 'and', filters: all }
            }),
            signal: AbortSignal.timeout(TIMEOUT_MS)
        })
        if (!res.ok) return { ok: false, error: await failure(res, cfg.apiToken) }

        const body: unknown = await res.json()
        const result = isRecord(body) ? body.result : undefined
        const events = isRecord(result) ? result.events : undefined
        const list = isRecord(events) ? events.events : undefined
        if (!Array.isArray(list)) return { ok: false, error: UNEXPECTED }

        const rows: LogRow[] = []
        for (const item of list) {
            if (!isRecord(item) || typeof item.timestamp !== 'number') continue
            const source = parseSource(item.source)
            if (source && all.every((f) => matches(source, f))) {
                rows.push({ time: item.timestamp, source })
            }
        }
        rows.sort((a, b) => b.time - a.time)
        // API total; may exceed rows.length after the client-side re-check.
        const count = isRecord(events) && typeof events.count === 'number' ? events.count : rows.length
        return { ok: true, rows, count }
    } catch (err) {
        if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
            return { ok: false, error: 'logs query timed out after 10 s' }
        }
        if (err instanceof SyntaxError) return { ok: false, error: UNEXPECTED }
        return { ok: false, error: 'logs query failed: network error' }
    }
}
