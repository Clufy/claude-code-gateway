import { readLimitedBody } from '../http/body-limit'
import type { ProxyConfig } from '../config'
import { isObj } from '../engagement'
import { anthropicError, jsonResponse } from '../http/errors'
import { decideToolCall } from './decide'
import { redact } from './redact'

const TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/ // P4-R16: MCP names such as mcp__x__scan fit
const MAX_LOGGED_HOSTS = 20
const MAX_LOGGED_HOST = 200

/** POST /v1/guard/check body handling. Authentication happens in the router. */
export async function handleGuardCheck(request: Request, cfg: ProxyConfig, requestId: string): Promise<Response> {
    const bad = (message: string) => anthropicError(400, 'invalid_request_error', message, requestId)
    const limited = await readLimitedBody(request, cfg.maxBodyBytes)
    if (!limited.ok) {
        return anthropicError(
            413,
            'request_too_large',
            `request body exceeds MAX_BODY_BYTES (${cfg.maxBodyBytes} bytes)`,
            requestId
        )
    }
    let body: unknown
    try {
        body = JSON.parse(limited.text)
    } catch {
        return bad('invalid JSON body')
    }
    if (!isObj(body)) return bad('body must be a JSON object')
    if (typeof body.engagement !== 'string') return bad('engagement must be a string')
    const engagement = cfg.engagements.get(body.engagement)
    if (engagement === undefined) return bad('unknown engagement')
    if (typeof body.tool !== 'string' || !TOOL_NAME.test(body.tool)) {
        return bad('tool must match /^[A-Za-z0-9_.-]{1,64}$/')
    }
    if (!isObj(body.input)) return bad('input must be an object')

    const d = decideToolCall(engagement, body.tool, body.input, Date.now())
    // a host or reason can carry a token (`dig ghp_….evil.org`): both are redacted in the answer and the log
    const hosts = d.hosts.map((h) => redact(h))
    const reasons = d.reasons.map((r) => redact(r))
    console.log(
        JSON.stringify({
            event: 'hook.decision',
            requestId,
            engagement: engagement.name,
            tool: body.tool,
            decision: d.decision,
            hosts: hosts.slice(0, MAX_LOGGED_HOSTS).map((h) => h.slice(0, MAX_LOGGED_HOST)),
            reasons: reasons.length
        })
    )
    return jsonResponse({ decision: d.decision, hosts, reasons }, 200, requestId)
}
