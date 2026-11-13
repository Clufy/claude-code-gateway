import { z } from 'zod'
import { judgeViaAnthropic } from '../shared/redteam/judge.ts'
import { queryEvents, type LogFilter } from '../observability'
import { DRAFT_MAX_TOKENS, draftRule, type DraftLogsource } from '../purple/draft'
import { testRule } from '../purple/evaluate'
import { promoteRule } from '../purple/promote'
import { parseSigma } from '../purple/sigma'
import { parseSince } from './logs-tool'
import { race, SELF_ORIGIN } from './redteam-tool'
import { fail, logged, ok, type McpContext, type ToolRegistrar } from './tool-kit'

const DEFAULT_LIMIT = 50
const DRAFT_TIMEOUT_MS = 50000
const NO_MODELS = 'no routed models; pass model'

interface Args {
    action: 'draft_rule' | 'test_rule' | 'promote_rule'
    finding?: string | undefined
    logsource?: DraftLogsource | undefined
    model?: string | undefined
    rule?: string | undefined
    events?: Record<string, unknown>[] | undefined
    logs?: { since?: string | undefined; engagement?: string | undefined; limit?: number | undefined } | undefined
    expect?: number[] | undefined
    id?: string | undefined
}

/** First routed model id from this Worker's /v1/models, or null on any failure. */
async function firstModel(selfFetch: typeof fetch, key: string): Promise<string | null> {
    try {
        const res = await selfFetch(`${SELF_ORIGIN}/v1/models`, { headers: { 'x-api-key': key } })
        if (!res.ok) return null
        const j = (await res.json()) as { data?: { id?: unknown }[] }
        const id = Array.isArray(j.data) ? j.data[0]?.id : undefined
        return typeof id === 'string' && id !== '' ? id : null
    } catch {
        return null
    }
}

async function draft(ctx: McpContext, a: Args) {
    if (!a.finding || !a.logsource) return fail('draft_rule needs finding and logsource')
    const selfFetch: typeof fetch = (input, init) => race(ctx.selfFetch(new Request(input, init)), init?.signal)
    const key = ctx.config.proxyKey ?? ''
    const model = a.model || (await firstModel(selfFetch, key))
    if (!model) return fail(NO_MODELS)
    const call = judgeViaAnthropic(selfFetch, SELF_ORIGIN, key, model, () => DRAFT_TIMEOUT_MS, DRAFT_MAX_TOKENS)
    return ok({ ...(await draftRule(a.finding, a.logsource, call)), model })
}

async function test(ctx: McpContext, a: Args) {
    if (!a.rule || (a.events === undefined) === (a.logs === undefined)) {
        return fail('test_rule needs rule and one of events or logs')
    }
    if (a.events) return ok(testRule(a.rule, a.events, a.expect))
    const logs = a.logs!
    if (a.expect) return fail('expect needs supplied events')
    const parsed = parseSigma(a.rule)
    if (!parsed.ok) return ok(testRule(a.rule, [])) // the parse failure, with its unsupported list
    const service = parsed.rule.logsource.service
    if (service !== 'detection' && service !== 'request') {
        return fail('logs source needs logsource service detection or request')
    }
    if (ctx.config.observabilityError) return fail(`logs misconfigured: ${ctx.config.observabilityError}`)
    const obs = ctx.config.observability
    if (!obs) return fail('logs not configured: set CF_ACCOUNT_ID and the CF_API_TOKEN secret, or use wrangler tail')
    const now = ctx.now()
    const from = parseSince(logs.since, now)
    if (from === null) return fail('invalid since: use e.g. 30m, 24h, 7d or an ISO time')
    const filters: LogFilter[] = []
    if (logs.engagement !== undefined) {
        filters.push({ key: 'engagement', operation: 'eq', type: 'string', value: logs.engagement })
    }
    const result = await queryEvents(obs, service, from, now, filters, logs.limit ?? DEFAULT_LIMIT)
    if (!result.ok) return fail(result.error)
    const rows = result.rows
    const tested = testRule(
        a.rule,
        rows.map((r) => r.source)
    )
    const stamp = (t: number) => (Number.isNaN(new Date(t).getTime()) ? null : new Date(t).toISOString())
    return ok({
        ...tested,
        rows: tested.matched.map((i) => ({ time: stamp(rows[i]!.time), requestId: rows[i]!.source.requestId }))
    })
}

function promote(a: Args) {
    if (!a.rule || !a.events?.length || !a.expect?.length) return fail('promote_rule needs rule, events and expect')
    const tested = testRule(a.rule, a.events, a.expect)
    if (tested.passed !== true) return fail('promote needs a passing test_rule: ' + JSON.stringify(tested))
    const parsed = parseSigma(a.rule)
    if (!parsed.ok) return fail(parsed.error)
    const p = promoteRule(parsed.rule, a.events, a.id)
    if (!p.ok) return ok({ promotable: false, reason: p.reason })
    return ok({
        promotable: true,
        entry: p.entry,
        snippet: p.snippet,
        note: 'merge entry into the custom array of the GUARD_RULES var and redeploy'
    })
}

export const registerPurpleTool: ToolRegistrar = (server, ctx) => {
    server.registerTool(
        'purple',
        {
            description:
                "Purple loop: draft_rule drafts a Sigma rule from a finding with a routed model (never done until test_rule passes); test_rule runs a rule against supplied JSON events or this proxy's logs; promote_rule turns a passing session-traffic rule into a GUARD_RULES custom entry.",
            inputSchema: {
                action: z
                    .enum(['draft_rule', 'test_rule', 'promote_rule'])
                    .describe('draft_rule, test_rule or promote_rule'),
                finding: z.string().max(4096).optional().describe('Finding text to turn into a rule; draft_rule only'),
                logsource: z
                    .enum(['prompt', 'tool_use', 'detection', 'request'])
                    .optional()
                    .describe('Logsource the drafted rule targets; draft_rule only'),
                model: z
                    .string()
                    .max(200)
                    .optional()
                    .describe('Routed model that drafts the rule (default: first routed model); draft_rule only'),
                rule: z.string().max(16384).optional().describe('Sigma rule YAML; test_rule and promote_rule'),
                events: z
                    .array(z.record(z.string(), z.unknown()))
                    .max(200)
                    .optional()
                    .describe('JSON events to test against; test_rule (instead of logs) and promote_rule'),
                logs: z
                    .object({
                        since: z.string().optional().describe('Look back, e.g. 30m, 24h, 7d, or an ISO time'),
                        engagement: z.string().optional().describe('Engagement name, exact match'),
                        limit: z.number().int().min(1).max(100).optional().describe('Max rows, 1 to 100 (default 50)')
                    })
                    .optional()
                    .describe(
                        'Test against this proxy logs (rule logsource service detection or request); test_rule only'
                    ),
                expect: z
                    .array(z.number().int().min(0))
                    .max(200)
                    .optional()
                    .describe('Indexes of events that must match; test_rule with events and promote_rule'),
                id: z.string().max(48).optional().describe('Id suffix for the promoted entry; promote_rule only')
            }
        },
        (args) =>
            logged(ctx, 'purple', args.action, async () => {
                if (args.action === 'draft_rule') return draft(ctx, args)
                if (args.action === 'test_rule') return test(ctx, args)
                return promote(args)
            })
    )
}
