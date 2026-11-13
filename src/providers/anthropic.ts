import { Provider } from '../provider'
import { buildUrl } from '../utils'

const ANTHROPIC_VERSION = '2023-06-01'
// P8-D4: only these upstream response headers reach the client. Anthropic's request-id,
// organization id, rate-limit headers and cookies are dropped; the proxy sets its own request-id.
const RESPONSE_HEADERS = ['content-type', 'retry-after']

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/**
 * P8-D2a: drops `thinking` blocks without a non-empty string signature from assistant turns.
 * Workers AI emits unsigned thinking, which Anthropic rejects after a switch or fallback.
 * `redacted_thinking` never carries a signature and is always kept. An assistant turn the strip
 * empties is dropped whole, since Anthropic rejects empty messages. Returns a new array;
 * anything that is not a messages array is returned as is.
 */
export function stripUnsignedThinking(messages: unknown): unknown {
    if (!Array.isArray(messages)) return messages
    return messages.flatMap((m) => {
        if (!isObj(m) || m.role !== 'assistant' || !Array.isArray(m.content)) return [m]
        const content = m.content.filter(
            (b) => !(isObj(b) && b.type === 'thinking' && (typeof b.signature !== 'string' || b.signature === ''))
        )
        if (content.length === 0 && m.content.length > 0) return []
        return [{ ...m, content }]
    })
}

export class AnthropicProvider implements Provider {
    async convertToProviderRequest(request: Request, baseUrl: string, apiKey: string): Promise<Request> {
        const body = (await request.json()) as Record<string, unknown>
        // Built fresh: no inbound header is copied except anthropic-beta. On /v1/messages the
        // inbound x-api-key / Authorization is the proxy key, so it must never be forwarded.
        const headers = new Headers({
            'x-api-key': apiKey.replace(/^Bearer\s+/i, ''),
            'anthropic-version': ANTHROPIC_VERSION,
            'content-type': 'application/json'
        })
        const beta = request.headers.get('anthropic-beta')
        if (beta !== null) headers.set('anthropic-beta', beta)
        return new Request(buildUrl(baseUrl, 'messages'), {
            method: 'POST',
            headers,
            body: JSON.stringify({ ...body, messages: stripUnsignedThinking(body.messages) })
        })
    }

    async convertToClaudeResponse(res: Response): Promise<Response> {
        const headers = new Headers()
        for (const name of RESPONSE_HEADERS) {
            const value = res.headers.get(name)
            if (value !== null) headers.set(name, value)
        }
        return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
    }
}
