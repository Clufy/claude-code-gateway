import type { ProxyConfig } from '../config'

export type ProviderUrlResult = { ok: true; baseUrl: string } | { ok: false; status: 400 | 403; message: string }

const fail = (status: 400 | 403, message: string): ProviderUrlResult => ({ ok: false, status, message })

// Bracketed IPv6 (as produced by new URL) or dotted-quad IPv4.
function isIpLiteral(host: string): boolean {
    return host.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
}

export function resolveProviderUrl(
    raw: string,
    cfg: Pick<ProxyConfig, 'allowedHosts' | 'allowHttp'>
): ProviderUrlResult {
    let text = raw.replace(/^(https?):\/(?!\/)/i, '$1://')
    if (!/^https?:\/\//i.test(text)) text = `https://${text}`

    let url: URL
    try {
        url = new URL(text)
    } catch {
        return fail(400, 'invalid provider URL')
    }

    if (url.username || url.password) {
        return fail(400, 'credentials in provider URL are not allowed')
    }
    if (url.protocol === 'http:' && !cfg.allowHttp) {
        return fail(403, 'http provider URLs are disabled; set ALLOW_HTTP=true')
    }

    const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
    if (cfg.allowedHosts !== '*') {
        if (isIpLiteral(hostname)) return fail(403, 'IP-literal provider hosts are not allowed')
        if (url.port) return fail(403, 'custom ports are not allowed')
        if (!cfg.allowedHosts.has(hostname)) return fail(403, 'Provider host not allowed by ALLOWED_HOSTS')
    }

    const host = url.port ? `${hostname}:${url.port}` : hostname
    return { ok: true, baseUrl: `${url.protocol}//${host}${url.pathname}`.replace(/\/$/, '') }
}
