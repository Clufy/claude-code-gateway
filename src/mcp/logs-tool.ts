import { z } from 'zod'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { redact } from '../guard/redact'
import { queryEvents, type LogFilter, type LogRow } from '../observability'
import { logged, type ToolRegistrar } from './tool-kit'

const MINUTE = 60_000
const UNIT_MS = { m: MINUTE, h: 60 * MINUTE, d: 24 * 60 * MINUTE }
const MAX_LOOKBACK = 7 * UNIT_MS.d
const DEFAULT_SINCE = 24 * UNIT_MS.h
const DEFAULT_LIMIT = 50
const MAX_BYTES = 32768
const MAX_EXCERPT = 300
const SEVERITIES = { low: ['low', 'medium', 'high'], medium: ['medium', 'high'], high: ['high'] } as const
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})?$/
const FINDING_FIELDS = ['ruleId', 'severity', 'engagement', 'requestId'] as const
const ACTIVITY_FIELDS = [
    'requestId',
    'model',
    'route',
    'backend',
    'status',
    'durationMs',
    'ttfbMs',
    'tools',
    'engagement',
    'mode',
    'streamError'
] as const

const ok = (payload: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(payload) }] })
const fail = (message: string): CallToolResult => ({ content: [{ type: 'text', text: message }], isError: true })
const bytes = (s: string) => new TextEncoder().encode(s).length

/** Lower bound in ms (clamped to 7 days back), or null when `since` is unparseable or in the future. */
export function parseSince(since: string | undefined, now: number): number | null {
    let from: number
    if (since === undefined) from = now - DEFAULT_SINCE
    else {
        const rel = /^(\d{1,4})([mhd])$/.exec(since)
        if (rel) from = now - Number(rel[1]) * UNIT_MS[rel[2] as 'm' | 'h' | 'd']
        else if (ISO_TIME.test(since)) from = Date.parse(since)
        else return null
    }
    if (Number.isNaN(from) || from > now) return null
    return Math.max(from, now - MAX_LOOKBACK)
}

function scalar(v: unknown): string | number | boolean | undefined {
    if (typeof v === 'string') return v.slice(0, MAX_EXCERPT)
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'boolean') return v
    return undefined
}

function pick(source: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const f of fields) {
        const v = source[f]
        if (f === 'tools') {
            if (Array.isArray(v)) {
                out.tools = v
                    .filter((t): t is string => typeof t === 'string')
                    .slice(0, 16)
                    .map((t) => t.slice(0, 64))
            }
            continue
        }
        const sv = scalar(v)
        if (sv !== undefined) out[f] = sv
    }
    return out
}

function mapRow(row: LogRow, action: 'findings' | 'activity'): Record<string, unknown> {
    const time = new Date(row.time).toISOString()
    if (action === 'activity') return { time, ...pick(row.source, ACTIVITY_FIELDS) }
    const out: Record<string, unknown> = { time, ...pick(row.source, FINDING_FIELDS) }
    if (typeof row.source.excerpt === 'string') out.excerpt = redact(row.source.excerpt).slice(0, MAX_EXCERPT)
    return out
}

export const registerLogsTool: ToolRegistrar = (server, ctx) => {
    server.registerTool(
        'logs',
        {
            description:
                "Query this proxy's Workers Logs: findings are guard detection lines and activity is request lines (model, tools, timings). Filter by engagement, time since, rule and minimum severity; logs are kept 3 days on Free and 7 on Paid.",
            inputSchema: {
                action: z.enum(['findings', 'activity']).describe('findings or activity'),
                since: z
                    .string()
                    .optional()
                    .describe('Look back, e.g. 30m, 24h, 7d, or an ISO time (default 24h, max 7d); both actions'),
                limit: z
                    .number()
                    .int()
                    .min(1)
                    .max(100)
                    .optional()
                    .describe('Max rows, 1 to 100 (default 50); both actions'),
                engagement: z.string().optional().describe('Engagement name, exact match; both actions'),
                rule: z
                    .string()
                    .optional()
                    .describe('Rule id, or a family prefix ending in a dot such as secret.; findings only'),
                severity: z.enum(['low', 'medium', 'high']).optional().describe('Minimum severity; findings only')
            }
        },
        ({ action, since, limit, engagement, rule, severity }) =>
            logged(ctx, 'logs', action, async () => {
                if (ctx.config.observabilityError) return fail(`logs misconfigured: ${ctx.config.observabilityError}`)
                const obs = ctx.config.observability
                if (!obs) {
                    return fail(
                        'logs not configured: set CF_ACCOUNT_ID and the CF_API_TOKEN secret, or use wrangler tail'
                    )
                }
                const now = ctx.now()
                const from = parseSince(since, now)
                if (from === null) return fail('invalid since: use e.g. 30m, 24h, 7d or an ISO time')

                const filters: LogFilter[] = []
                if (engagement !== undefined) {
                    filters.push({ key: 'engagement', operation: 'eq', type: 'string', value: engagement })
                }
                if (action === 'findings') {
                    if (rule !== undefined) {
                        filters.push({
                            key: 'ruleId',
                            operation: rule.endsWith('.') ? 'starts_with' : 'eq',
                            type: 'string',
                            value: rule
                        })
                    }
                    if (severity !== undefined) {
                        filters.push({
                            key: 'severity',
                            operation: 'in',
                            type: 'string',
                            value: [...SEVERITIES[severity]]
                        })
                    }
                }

                const result = await queryEvents(
                    obs,
                    action === 'findings' ? 'detection' : 'request',
                    from,
                    now,
                    filters,
                    limit ?? DEFAULT_LIMIT
                )
                if (!result.ok) return fail(result.error)

                const rows = result.rows
                    .filter((r) => !Number.isNaN(new Date(r.time).getTime()))
                    .slice(0, limit ?? DEFAULT_LIMIT)
                    .map((r) => mapRow(r, action))
                const build = (truncated: boolean) =>
                    JSON.stringify({
                        count: result.count,
                        returned: rows.length,
                        rows,
                        ...(truncated ? { truncated: true } : {})
                    })
                let text = build(false)
                if (bytes(text) > MAX_BYTES) {
                    do {
                        rows.pop()
                        text = build(true)
                    } while (bytes(text) > MAX_BYTES && rows.length > 0)
                }
                return { content: [{ type: 'text', text }] }
            })
    )
}
