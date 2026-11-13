import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config'

const ACC = '0123456789abcdef0123456789abcdef'

describe('observability config', () => {
    it('is null when neither var is set', () => expect(loadConfig({}).observability).toBeNull())
    it('parses both with the default service', () =>
        expect(loadConfig({ CF_ACCOUNT_ID: ACC, CF_API_TOKEN: 't0k' }).observability).toEqual({
            accountId: ACC,
            apiToken: 't0k',
            service: 'claude-workers-ai-proxy'
        }))
    it('takes OBSERVABILITY_SERVICE', () =>
        expect(
            loadConfig({ CF_ACCOUNT_ID: ACC, CF_API_TOKEN: 't', OBSERVABILITY_SERVICE: 'x' }).observability?.service
        ).toBe('x'))
    it('both fields are null when neither var is set', () => {
        const c = loadConfig({})
        expect(c.observability).toBeNull()
        expect(c.observabilityError).toBeNull()
    })
    it('reports a token without an account id', () => {
        const c = loadConfig({ CF_API_TOKEN: 't' })
        expect(c.observability).toBeNull()
        expect(c.observabilityError).toBe('CF_ACCOUNT_ID is missing')
    })
    it('reports an account id without a token', () => {
        const c = loadConfig({ CF_ACCOUNT_ID: ACC })
        expect(c.observability).toBeNull()
        expect(c.observabilityError).toBe('CF_API_TOKEN is missing')
    })
    it.each(['ABC', '0123456789ABCDEF0123456789ABCDEF', ACC + '0'])('reports account id %s', (id) => {
        const c = loadConfig({ CF_ACCOUNT_ID: id, CF_API_TOKEN: 't' })
        expect(c.observability).toBeNull()
        expect(c.observabilityError).toBe('CF_ACCOUNT_ID must be 32 lowercase hex characters')
    })
    it('never puts the token in the error', () => {
        const c = loadConfig({ CF_ACCOUNT_ID: 'bad', CF_API_TOKEN: 'sekrit-token' })
        expect(c.observabilityError).not.toContain('sekrit-token')
    })
    it('is clean when valid', () =>
        expect(loadConfig({ CF_ACCOUNT_ID: ACC, CF_API_TOKEN: 't' }).observabilityError).toBeNull())
})
