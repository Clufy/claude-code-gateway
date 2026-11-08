import { describe, it, expect } from 'vitest'
import { ConfigError, loadConfig } from '../src/config'
import { findRouteEntry, planTargets, resolveRoute } from '../src/routing'

describe('routing', () => {
    const routes = loadConfig({
        PROXY_KEY: 'k',
        MODEL_ROUTES: JSON.stringify({
            'claude-*haiku*': { provider: 'workers-ai', model: '@cf/moonshotai/kimi-k2.6' },
            'claude-*': {
                provider: 'openai',
                baseUrl: 'https://api.openai.com',
                model: 'gpt-5.1',
                keySecret: 'OPENAI_API_KEY',
                fallback: ['@cf/zai-org/glm-5.3']
            },
            'claude-sonnet-4-5': { provider: 'workers-ai', model: '@cf/zai-org/glm-5.3' }
        })
    }).routes

    it('exact beats glob', () => expect(resolveRoute('claude-sonnet-4-5', routes)?.model).toBe('@cf/zai-org/glm-5.3'))
    it('first glob in order wins', () =>
        expect(resolveRoute('claude-3-5-haiku-latest', routes)?.model).toBe('@cf/moonshotai/kimi-k2.6'))
    it('findRouteEntry reports the matching pattern', () =>
        expect(findRouteEntry('claude-3-5-haiku-latest', routes)?.pattern).toBe('claude-*haiku*'))
    it('unmatched is null', () => expect(resolveRoute('@cf/meta/llama', routes)).toBeNull())
    it('glob escapes regex metacharacters', () => {
        const r = loadConfig({
            PROXY_KEY: 'k',
            MODEL_ROUTES: JSON.stringify({ 'claude-3.5*': { provider: 'workers-ai', model: 'm' } })
        }).routes
        expect(resolveRoute('claude-3x5-a', r)).toBeNull()
        expect(resolveRoute('claude-3.5-a', r)?.model).toBe('m')
    })
    it('unset MODEL_ROUTES gives []', () => expect(loadConfig({ PROXY_KEY: 'k' }).routes).toEqual([]))
    it('plans primary then fallback with key', () => {
        const cfg = { ...loadConfig({ PROXY_KEY: 'k' }), routes }
        expect(planTargets('claude-opus-4-1', cfg, { OPENAI_API_KEY: 'sk-x' })).toEqual([
            {
                backend: 'openai',
                model: 'gpt-5.1',
                baseUrl: 'https://api.openai.com',
                apiKey: 'sk-x',
                label: 'openai:gpt-5.1'
            },
            { backend: 'workers-ai', model: '@cf/zai-org/glm-5.3', label: 'workers-ai:@cf/zai-org/glm-5.3' }
        ])
    })
    it('missing secret throws ConfigError naming it', () => {
        const cfg = { ...loadConfig({ PROXY_KEY: 'k' }), routes }
        expect(() => planTargets('claude-opus-4-1', cfg, {})).toThrowError(
            expect.objectContaining({ variable: 'OPENAI_API_KEY' })
        )
    })
    it.each([
        ['{"x":{"provider":"bogus","model":"m"}}'],
        ['{"x":{"provider":"openai","model":"m"}}'],
        ['{"x":{"provider":"workers-ai","model":"m","fallbak":[]}}'],
        ['{"x":{"provider":"openai","model":"m","baseUrl":"https://evil.com","keySecret":"K"}}'],
        ['[1]'],
        ['not json']
    ])('rejects MODEL_ROUTES %s', (v) =>
        expect(() => loadConfig({ PROXY_KEY: 'k', MODEL_ROUTES: v })).toThrow(ConfigError)
    )
})
