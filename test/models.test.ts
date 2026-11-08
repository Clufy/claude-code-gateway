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
            MODEL_ROUTES: JSON.stringify({ '@cf/zai-org/glm-5.3': { provider: 'workers-ai', model: 'x' } })
        })
        const ids = (await list(env)).map((m) => m.id)
        expect(ids.filter((id) => id === '@cf/zai-org/glm-5.3')).toHaveLength(1)
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
