import { z } from 'zod'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { Engagement } from '../engagement'
import { checkScope, inWindow } from '../engagement'
import { decideHosts } from '../guard/decide'
import { logged, type ToolRegistrar } from './server'

const MAX_TARGET = 2048
const SAFE_NAME = /^[A-Za-z0-9_.-]{1,64}$/

const ok = (payload: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(payload) }] })
const fail = (message: string): CallToolResult => ({ content: [{ type: 'text', text: message }], isError: true })
const iso = (ms: number) => new Date(ms).toISOString()

export const registerEngagementTool: ToolRegistrar = (server, ctx) => {
    server.registerTool(
        'engagement',
        {
            description:
                "Engagements configured on this proxy: list them, get one's scope, window and rules of engagement, or check whether a host, IP, CIDR or URL is in scope right now.",
            inputSchema: {
                action: z.enum(['list', 'get', 'scope_check']).describe('What to do'),
                name: z.string().optional().describe('Engagement name; used by get and scope_check'),
                target: z.string().optional().describe('Host, IP, CIDR or URL to check; used by scope_check')
            }
        },
        ({ action, name, target }) =>
            logged(ctx, 'engagement', action, async () => {
                const now = ctx.now()
                const engagements = ctx.config.engagements
                if (action === 'list') {
                    if (engagements.size === 0) return ok({ engagements: [], hint: 'set the ENGAGEMENTS secret' })
                    return ok({
                        engagements: [...engagements.values()].map((e) => ({
                            name: e.name,
                            window: { start: iso(e.window.start), end: iso(e.window.end) },
                            active: inWindow(e, now),
                            defaultMode: e.defaultMode
                        }))
                    })
                }
                if (name === undefined) return fail(`name is required for ${action}`)
                const e: Engagement | undefined = engagements.get(name)
                if (!e) return fail(SAFE_NAME.test(name) ? `unknown engagement: ${name}` : 'unknown engagement')
                if (action === 'get') {
                    return ok({
                        name: e.name,
                        scope: e.scope,
                        exclude: e.exclude,
                        window: { start: iso(e.window.start), end: iso(e.window.end) },
                        active: inWindow(e, now),
                        roe: e.roe,
                        defaultMode: e.defaultMode
                    })
                }
                if (target === undefined) return fail('target is required for scope_check')
                if (target.length > MAX_TARGET) return fail(`target too long (max ${MAX_TARGET} chars)`)
                const scope = checkScope(e, target, now)
                const decision = decideHosts(e, [target], now)
                return ok({
                    target,
                    normalized: scope.target,
                    verdict: scope.verdict,
                    inWindow: scope.inWindow,
                    decision: decision.decision,
                    reasons: decision.reasons
                })
            })
    )
}
