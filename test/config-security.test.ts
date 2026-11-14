import { describe, expect, it } from 'vitest'
import { ConfigError, DEFAULT_ALLOWED_HOSTS, loadConfig } from '../src/config'
import { callWorker, makeEnv } from './helpers'

describe('loadConfig', () => {
    it('applies defaults', () => {
        const c = loadConfig({ PROXY_KEY: 'k' })
        expect(c.proxyKey).toBe('k')
        expect(c.allowAnonymous).toBe(false)
        expect(c.allowHttp).toBe(false)
        expect(c.maxBodyBytes).toBe(33554432)
        expect(c.upstreamTtfbMs).toBe(120000)
        expect(c.upstreamTotalMs).toBe(600000)
        expect([...(c.allowedHosts as Set<string>)].sort()).toEqual([...DEFAULT_ALLOWED_HOSTS].sort())
    })
    it('normalizes sloppy ALLOWED_HOSTS', () => {
        const c = loadConfig({ ALLOWED_HOSTS: ' API.OpenAI.com , ,api.groq.com. ' })
        expect([...(c.allowedHosts as Set<string>)].sort()).toEqual(['api.groq.com', 'api.openai.com'])
    })
    it('star means open', () => expect(loadConfig({ ALLOWED_HOSTS: '*' }).allowedHosts).toBe('*'))
    it.each(['https://api.openai.com', 'api.openai.com:443', 'a@b.com', '*,api.openai.com'])(
        'rejects ALLOWED_HOSTS entry %s',
        (v) => expect(() => loadConfig({ ALLOWED_HOSTS: v })).toThrow(ConfigError)
    )
    it('accepts TRUE, rejects yes', () => {
        expect(loadConfig({ ALLOW_HTTP: 'TRUE' }).allowHttp).toBe(true)
        expect(() => loadConfig({ ALLOW_HTTP: 'yes' })).toThrowError(
            expect.objectContaining({ variable: 'ALLOW_HTTP' })
        )
    })
    it.each(['0', '-5', '1.5', 'abc'])('rejects MAX_BODY_BYTES=%s', (v) =>
        expect(() => loadConfig({ MAX_BODY_BYTES: v })).toThrow(ConfigError)
    )
    it('empty PROXY_KEY is unset', () => expect(loadConfig({ PROXY_KEY: '' }).proxyKey).toBeNull())
})

it('invalid config fails every request with 500', async () => {
    const res = await callWorker('/', undefined, makeEnv({ ALLOW_HTTP: 'yes' }))
    expect(res.status).toBe(500)
    const body = await res.json<any>()
    expect(body.error).toEqual({ type: 'api_error', message: 'invalid config: ALLOW_HTTP' })
    expect(res.headers.get('request-id')).toBe(body.request_id)
})
