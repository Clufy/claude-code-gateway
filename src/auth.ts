export async function verifyProxyKey(provided: string | null, expected: string | undefined): Promise<boolean> {
    if (!expected) {
        return true
    }
    if (!provided) {
        return false
    }
    const enc = new TextEncoder()
    const [ha, hb] = await Promise.all([
        crypto.subtle.digest('SHA-256', enc.encode(provided)),
        crypto.subtle.digest('SHA-256', enc.encode(expected))
    ])
    return crypto.subtle.timingSafeEqual(ha, hb)
}

export function extractProviderKey(headers: Headers): { apiKey: string; headers: Headers } | null {
    const apiKey = headers.get('x-api-key') ?? authHeaderToken(headers.get('authorization'))
    if (!apiKey) {
        return null
    }
    const cleanHeaders = new Headers(headers)
    cleanHeaders.delete('x-api-key')
    cleanHeaders.delete('authorization')
    cleanHeaders.delete('x-proxy-key')
    return { apiKey, headers: cleanHeaders }
}

function authHeaderToken(value: string | null): string | null {
    if (!value) return null
    const parts = value.trim().split(' ')
    if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
        return parts[1]
    }
    return parts[0]
}
