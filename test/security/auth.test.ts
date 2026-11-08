import { describe, expect, it } from 'vitest'
import { callWorker, makeEnv } from '../helpers'

const msg = { model: 'm', messages: [{ role: 'user', content: 'hi' }] }
const post = (_path: string, headers: Record<string, string> = {}) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(msg)
})

describe('proxy auth', () => {
    it('no PROXY_KEY and no ALLOW_ANONYMOUS → 500 not configured on internal and external routes', async () => {
        const env = makeEnv({ PROXY_KEY: undefined })
        for (const [path, init] of [
            ['/v1/models', undefined],
            ['/v1/messages', post('/v1/messages')],
            ['/v1/messages/count_tokens', post('/v1/messages/count_tokens')],
            ['/openai/api.openai.com/v1/messages', post('', { 'x-api-key': 'sk-provider' })]
        ] as const) {
            const res = await callWorker(path, init, env)
            expect(res.status, path).toBe(500)
            expect((await res.json<any>()).error.message).toBe(
                'proxy not configured: set PROXY_KEY or ALLOW_ANONYMOUS=true'
            )
        }
    })
    it('health check stays open when not configured', async () => {
        expect((await callWorker('/', undefined, makeEnv({ PROXY_KEY: undefined }))).status).toBe(200)
    })
    it('ALLOW_ANONYMOUS=true restores open behavior', async () => {
        const res = await callWorker(
            '/v1/models',
            undefined,
            makeEnv({ PROXY_KEY: undefined, ALLOW_ANONYMOUS: 'true' })
        )
        expect(res.status).toBe(200)
    })
    it('wrong key → 401, right key → 200', async () => {
        expect((await callWorker('/v1/models', { headers: { 'x-api-key': 'nope' } })).status).toBe(401)
        expect((await callWorker('/v1/models', { headers: { 'x-api-key': 'test-key' } })).status).toBe(200)
    })
    it('external route checks x-proxy-key, not x-api-key', async () => {
        const res = await callWorker('/openai/api.openai.com/v1/messages', post('', { 'x-api-key': 'test-key' }))
        expect(res.status).toBe(401)
        expect((await res.json<any>()).error.message).toBe('invalid x-proxy-key')
    })
    it('unknown provider type 404s only for authenticated callers', async () => {
        const anon = await callWorker('/nope/example.com/v1/messages', post('', {}))
        expect(anon.status).toBe(401)
        const authed = await callWorker('/nope/example.com/v1/messages', post('', { 'x-proxy-key': 'test-key' }))
        expect(authed.status).toBe(404)
    })
})
