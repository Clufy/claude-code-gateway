export const UPSTREAM_HEADER_ALLOWLIST: readonly string[] = [
    'content-type',
    'accept',
    'anthropic-version',
    'anthropic-beta',
    'openai-organization',
    'openai-project',
    'user-agent'
]

export function upstreamHeaders(inbound: Headers): Headers {
    const out = new Headers()
    for (const name of UPSTREAM_HEADER_ALLOWLIST) {
        const value = inbound.get(name)
        if (value !== null) out.set(name, value)
    }
    return out
}
