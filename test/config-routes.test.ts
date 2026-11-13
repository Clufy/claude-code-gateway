import { describe, expect, it } from 'vitest'
import { ConfigError, loadConfig } from '../src/config'

const routes = (r: Record<string, unknown>) => loadConfig({ MODEL_ROUTES: JSON.stringify({ 'm-*': r }) }).routes

describe('route profile keys', () => {
    for (const key of ['vision', 'multiTool', 'reasoning']) {
        for (const val of [true, false]) {
            it(`copies ${key}=${val}`, () => {
                const [e] = routes({ provider: 'workers-ai', model: 'x', [key]: val })
                expect((e.route as unknown as Record<string, unknown>)[key]).toBe(val)
            })
        }
        it(`rejects non-boolean ${key}`, () => {
            const run = () => routes({ provider: 'workers-ai', model: 'x', [key]: 'yes' })
            expect(run).toThrow(ConfigError)
            expect(run).toThrow(`route "m-*" ${key} must be a boolean`)
        })
    }
})

describe('anthropic backend', () => {
    it('requires baseUrl and keySecret', () => {
        expect(() => routes({ provider: 'anthropic', model: 'x' })).toThrow(
            'route "m-*" requires baseUrl and keySecret'
        )
    })
    it('parses with baseUrl and keySecret', () => {
        const [e] = routes({
            provider: 'anthropic',
            model: 'x',
            baseUrl: 'https://api.anthropic.com/v1',
            keySecret: 'ANTHROPIC_KEY'
        })
        expect(e.route.provider).toBe('anthropic')
    })
})

describe('role models', () => {
    it('trims and nulls empty', () => {
        const c = loadConfig({ DRAFT_MODEL: '  m1 ', JUDGE_MODEL: '' })
        expect(c.draftModel).toBe('m1')
        expect(c.judgeModel).toBeNull()
    })
    it('defaults to null', () => {
        const c = loadConfig({})
        expect(c.draftModel).toBeNull()
        expect(c.judgeModel).toBeNull()
    })
})
