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
    it('rejects a token without an account id', () =>
        expect(() => loadConfig({ CF_API_TOKEN: 't' })).toThrow(expect.objectContaining({ variable: 'CF_ACCOUNT_ID' })))
    it('rejects an account id without a token', () =>
        expect(() => loadConfig({ CF_ACCOUNT_ID: ACC })).toThrow(expect.objectContaining({ variable: 'CF_API_TOKEN' })))
    it.each(['ABC', '0123456789ABCDEF0123456789ABCDEF', ACC + '0'])('rejects account id %s', (id) =>
        expect(() => loadConfig({ CF_ACCOUNT_ID: id, CF_API_TOKEN: 't' })).toThrow(
            expect.objectContaining({ variable: 'CF_ACCOUNT_ID' })
        )
    )
    it('never puts the token in the error message', () => {
        expect.assertions(1)
        try {
            loadConfig({ CF_ACCOUNT_ID: 'bad', CF_API_TOKEN: 'sekrit-token' })
        } catch (e) {
            expect(String((e as Error).message)).not.toContain('sekrit-token')
        }
    })
})
