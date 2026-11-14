import { afterEach, describe, expect, it } from 'vitest'
import { resolveProviderUrl } from '../../src/routing/provider-url'
import { callWorker, makeEnv, stubFetch } from '../helpers'

const cfg = { allowedHosts: new Set(['api.openai.com']), allowHttp: false }

describe('resolveProviderUrl', () => {
    const okCases: [string, string][] = [
        ['api.openai.com', 'https://api.openai.com'],
        ['https:/api.openai.com/v1', 'https://api.openai.com/v1'],
        ['API.OPENAI.COM.', 'https://api.openai.com'],
        ['api.openai.com/../evil.com', 'https://api.openai.com/evil.com']
    ]
    it.each(okCases)('accepts %s', (raw, baseUrl) => {
        expect(resolveProviderUrl(raw, cfg)).toEqual({ ok: true, baseUrl })
    })

    const failCases: [string, number, string][] = [
        ['http://api.openai.com', 403, 'http provider URLs are disabled; set ALLOW_HTTP=true'],
        ['evil.com', 403, 'Provider host not allowed by ALLOWED_HOSTS'],
        ['api.openai.com.evil.com', 403, 'Provider host not allowed by ALLOWED_HOSTS'],
        ['api.openai.com@evil.com', 400, 'credentials in provider URL are not allowed'],
        ['user:pw@api.openai.com', 400, 'credentials in provider URL are not allowed'],
        ['evil.com#api.openai.com', 403, 'Provider host not allowed by ALLOWED_HOSTS'],
        ['api.openai.com:8443', 403, 'custom ports are not allowed'],
        ['[::1]', 403, 'IP-literal provider hosts are not allowed'],
        ['127.0.0.1', 403, 'IP-literal provider hosts are not allowed'],
        ['%', 400, 'invalid provider URL']
    ]
    it.each(failCases)('rejects %s', (raw, status, message) => {
        expect(resolveProviderUrl(raw, cfg)).toEqual({ ok: false, status, message })
    })

    it('allows http when allowHttp is set', () => {
        expect(resolveProviderUrl('http://api.openai.com', { ...cfg, allowHttp: true })).toEqual({
            ok: true,
            baseUrl: 'http://api.openai.com'
        })
    })

    it('allows anything under wildcard', () => {
        expect(resolveProviderUrl('1.2.3.4:8080', { allowedHosts: '*', allowHttp: false })).toEqual({
            ok: true,
            baseUrl: 'https://1.2.3.4:8080'
        })
    })
})

describe('provider URL policy in the router', () => {
    let restore = () => {}
    afterEach(() => restore())

    const post = (path: string) =>
        callWorker(
            path,
            {
                method: 'POST',
                headers: { 'x-proxy-key': 'test-key', 'x-api-key': 'sk-provider', 'content-type': 'application/json' },
                body: JSON.stringify({ model: 'm', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] })
            },
            makeEnv()
        )

    it('closes the open relay', async () => {
        const stub = stubFetch(() => new Response('{}'))
        restore = stub.restore
        const res = await post('/openai/evil.com/v1/messages')
        expect(res.status).toBe(403)
        expect((await res.json<any>()).error.type).toBe('permission_error')
        expect(stub.calls.length).toBe(0)
    })

    it('never fetches another host for encoded paths', async () => {
        const stub = stubFetch(() => new Response('{}'))
        restore = stub.restore
        const res = await post('/openai/api.openai.com%2F..%2F..%40evil.com/v1/messages')
        expect(res.status).toBe(200)
        expect(stub.calls.length).toBeGreaterThan(0)
        for (const c of stub.calls) expect(new URL(c.url).hostname).toBe('api.openai.com')
    })

    it('returns 400 for malformed escapes', async () => {
        const stub = stubFetch(() => new Response('{}'))
        restore = stub.restore
        const res = await post('/openai/%/v1/messages')
        expect(res.status).toBe(400)
        expect((await res.json<any>()).error.message).toBe('invalid provider URL')
        expect(stub.calls.length).toBe(0)
    })
})
