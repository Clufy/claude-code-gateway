import { describe, it, expect } from 'vitest'
import { callWorker, makeEnv } from './helpers'

const MODEL_ROUTES = JSON.stringify({
    'claude-sonnet-4-5': { provider: 'workers-ai', model: '@cf/zai-org/glm-5.3' },
    'claude-*': { provider: 'workers-ai', model: '@cf/moonshotai/kimi-k2.6', contextTokens: 400000 }
})
const auth = { headers: { 'x-api-key': 'test-key' } }

async function list(env = makeEnv({ MODEL_ROUTES })): Promise<{ id: string; max_input_tokens: number }[]> {
    const res = await callWorker('/v1/models', auth, env)
    return ((await res.json()) as any).data
}

describe('models', () => {
    it('lists exact route ids with their context window and omits globs', async () => {
        const data = await list()
        expect(data.find((m) => m.id === 'claude-sonnet-4-5')?.max_input_tokens).toBe(1048576)
        expect(data.some((m) => m.id.includes('*'))).toBe(false)
    })

    it('still lists the default Workers AI models', async () => {
        const ids = (await list()).map((m) => m.id)
        expect(ids).toContain('@cf/zai-org/glm-5.3')
        expect(ids).toContain('@cf/moonshotai/kimi-k2.6')
    })

    it('lists a route id that is also a Workers AI id once', async () => {
        const env = makeEnv({
            MODEL_ROUTES: JSON.stringify({
                '@cf/zai-org/glm-5.3': { provider: 'workers-ai', model: 'x', contextTokens: 777 }
            })
        })
        const data = await list(env)
        const matches = data.filter((m) => m.id === '@cf/zai-org/glm-5.3')
        expect(matches).toHaveLength(1)
        expect(matches[0].max_input_tokens).toBe(1048576)
    })

    it('lists routed ids after the Workers AI ids', async () => {
        const ids = (await list()).map((m) => m.id)
        expect(ids.indexOf('claude-sonnet-4-5')).toBeGreaterThan(ids.indexOf('@cf/deepseek-ai/deepseek-v4-pro-0813'))
    })

    it.each([
        ['backing model', '@cf/zai-org/glm-5.3'],
        ['alias id', 'claude-sonnet-4-5']
    ])('capability flags for a routed id honour %s in VISION_MODELS and MULTI_TOOL_MODELS', async (_n, name) => {
        const env = makeEnv({ MODEL_ROUTES, VISION_MODELS: name, MULTI_TOOL_MODELS: name })
        const listed = (await list(env)).find((m) => m.id === 'claude-sonnet-4-5') as any
        expect(listed.capabilities.vision.supported).toBe(true)
        expect(listed.capabilities.multi_tool_use.supported).toBe(true)
        const got = (await (await callWorker('/v1/models/claude-sonnet-4-5', auth, env)).json()) as any
        expect(got.capabilities.vision.supported).toBe(true)
        expect(got.capabilities.multi_tool_use.supported).toBe(true)
    })

    it('capability flags for a glob-matched id come from the backing model', async () => {
        const env = makeEnv({
            MODEL_ROUTES,
            VISION_MODELS: '@cf/moonshotai/kimi-k2.6',
            MULTI_TOOL_MODELS: '@cf/moonshotai/kimi-k2.6'
        })
        const got = (await (await callWorker('/v1/models/claude-opus-4', auth, env)).json()) as any
        expect(got.capabilities.vision.supported).toBe(true)
        expect(got.capabilities.multi_tool_use.supported).toBe(true)
    })

    it('GET /v1/models/{id} returns 200 for a listed route id', async () => {
        const res = await callWorker('/v1/models/claude-sonnet-4-5', auth, makeEnv({ MODEL_ROUTES }))
        expect(res.status).toBe(200)
    })

    it('GET /v1/models/{id} returns 200 for a glob-matched id with the route context window', async () => {
        const res = await callWorker('/v1/models/claude-opus-4', auth, makeEnv({ MODEL_ROUTES }))
        expect(res.status).toBe(200)
        expect(((await res.json()) as any).max_input_tokens).toBe(400000)
    })

    it('GET /v1/models/{id} returns 404 for an unrouted unknown id', async () => {
        const res = await callWorker('/v1/models/nope-1', auth, makeEnv({ MODEL_ROUTES }))
        expect(res.status).toBe(404)
    })
})
