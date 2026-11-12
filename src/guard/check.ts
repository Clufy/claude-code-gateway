import { readLimitedBody } from '../body-limit'
import type { ProxyConfig } from '../config'
import { isObj } from '../engagement'
import { anthropicError, jsonResponse } from '../errors'
import { decideToolCall } from './decide'

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
    if (typeof body.tool !== 'string') return bad('tool must be a string')
    if (!isObj(body.input)) return bad('input must be an object')

    const { decision, hosts, reasons } = decideToolCall(engagement, body.tool, body.input, Date.now())
    console.log(
        JSON.stringify({
            event: 'hook.decision',
            requestId,
            engagement: engagement.name,
            tool: body.tool,
            decision,
            hosts: hosts.slice(0, 20),
            reasons: reasons.length
        })
    )
    return jsonResponse({ decision, hosts, reasons }, 200, requestId)
}
