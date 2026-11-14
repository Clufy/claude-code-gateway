import { describe, it, expect } from 'vitest'
import { callWorker, fakeAI, makeEnv } from '../helpers'

const GLM = '@cf/zai-org/glm-5.3'
const KIMI = '@cf/moonshotai/kimi-k2.6'
const DEEPSEEK = '@cf/deepseek-ai/deepseek-v4-pro-0813'
const MODELS = [GLM, KIMI, DEEPSEEK].join(',')
const SHIPPED_ROUTES = {
    [GLM]: { provider: 'workers-ai', model: GLM, contextTokens: 1048576, reasoning: true },
    [KIMI]: { provider: 'workers-ai', model: KIMI, contextTokens: 262144, reasoning: true },
    [DEEPSEEK]: { provider: 'workers-ai', model: DEEPSEEK, contextTokens: 1048576, reasoning: true }
}
const MODEL_ROUTES = JSON.stringify({
    ...SHIPPED_ROUTES,
    'claude-sonnet-4-5': { provider: 'workers-ai', model: GLM },
    'claude-*': { provider: 'workers-ai', model: KIMI, contextTokens: 400000 }
})
const auth = { headers: { 'x-api-key': 'test-key' } }

const shippedEnv = (routes: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
    makeEnv({ MODELS, MODEL_ROUTES: JSON.stringify({ ...SHIPPED_ROUTES, ...routes }), ...extra })

async function list(env = makeEnv({ MODELS, MODEL_ROUTES })): Promise<{ id: string; max_input_tokens: number }[]> {
    const res = await callWorker('/v1/models', auth, env)
    return ((await res.json()) as any).data
}

async function getOne(id: string, env: Env): Promise<any> {
    return (await callWorker(`/v1/models/${id}`, auth, env)).json()
}

describe('models', () => {
    it('empty config lists no models', async () => {
        expect(await list(makeEnv())).toEqual([])
    })

    it('unrouted name still reaches Workers AI', async () => {
        const seen: string[] = []
        const AI = fakeAI((model) => {
            seen.push(model)
            return new Response(JSON.stringify({ response: 'hi' }), { headers: { 'content-type': 'application/json' } })
        })
        const res = await callWorker(
            new Request('https://proxy.test/v1/messages', {
                method: 'POST',
                headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
                body: JSON.stringify({
                    model: 'any-model',
                    max_tokens: 10,
                    messages: [{ role: 'user', content: 'hi' }]
                })
            }),
            undefined,
            makeEnv({ AI })
        )
        await res.text()
        expect(seen).toEqual(['any-model'])
    })

    it('MODELS without routes reports defaults', async () => {
        const data = (await list(makeEnv({ MODELS: 'a,b' }))) as any[]
        expect(data.map((m) => m.id)).toEqual(['a', 'b'])
        for (const m of data) {
            expect(m.max_input_tokens).toBe(24000)
            expect(m.capabilities.tools.supported).toBe(true)
            expect(m.capabilities.vision.supported).toBe(false)
            expect(m.capabilities.multi_tool_use.supported).toBe(false)
            expect(m.capabilities.thinking).toEqual({ name: 'thinking', supported: false })
        }
    })

    it('alias inherits one hop', async () => {
        const env = shippedEnv({ 'claude-sonnet-*': { provider: 'workers-ai', model: GLM } })
        const got = await getOne('claude-sonnet-4-5', env)
        expect(got.max_input_tokens).toBe(1048576)
        expect(got.capabilities.thinking.supported).toBe(true)
    })

    it('does not hop to a route on another provider (P8-D1a)', async () => {
        const env = shippedEnv(
            {
                'claude-sonnet-4-5': { provider: 'workers-ai', model: GLM, contextTokens: 1048576, reasoning: true },
                'claude-direct': {
                    provider: 'anthropic',
                    model: 'claude-sonnet-4-5',
                    baseUrl: 'https://api.anthropic.com/v1',
                    keySecret: 'ANTHROPIC_KEY'
                }
            },
            { ANTHROPIC_KEY: 'k' }
        )
        const got = await getOne('claude-direct', env)
        expect(got.max_input_tokens).toBe(24000)
        expect(got.capabilities.thinking.supported).toBe(false)
    })

    it('own key beats hop', async () => {
        const env = shippedEnv({
            'claude-sonnet-*': { provider: 'workers-ai', model: GLM, contextTokens: 5000, reasoning: false }
        })
        const got = await getOne('claude-sonnet-4-5', env)
        expect(got.max_input_tokens).toBe(5000)
        expect(got.capabilities.thinking.supported).toBe(false)
    })

    it('no second hop', async () => {
        const env = makeEnv({
            MODELS: 'a',
            MODEL_ROUTES: JSON.stringify({
                a: { provider: 'workers-ai', model: 'b' },
                b: { provider: 'workers-ai', model: 'c' },
                c: { provider: 'workers-ai', model: 'c', contextTokens: 9 }
            })
        })
        expect((await getOne('a', env)).max_input_tokens).toBe(24000)
    })

    it('profile beats legacy list', async () => {
        const withKey = makeEnv({
            MODELS: 'v',
            MODEL_ROUTES: JSON.stringify({
                v: { provider: 'workers-ai', model: 'v', vision: false, multiTool: false }
            }),
            VISION_MODELS: 'v',
            MULTI_TOOL_MODELS: 'v'
        })
        const a = await getOne('v', withKey)
        expect(a.capabilities.vision.supported).toBe(false)
        expect(a.capabilities.multi_tool_use.supported).toBe(false)
        const noKey = makeEnv({ MODELS: 'v', VISION_MODELS: 'v', MULTI_TOOL_MODELS: 'v' })
        const b = await getOne('v', noKey)
        expect(b.capabilities.vision.supported).toBe(true)
        expect(b.capabilities.multi_tool_use.supported).toBe(true)
    })

    it('lists exact route ids with their context window and omits globs', async () => {
        const data = await list()
        expect(data.find((m) => m.id === 'claude-sonnet-4-5')?.max_input_tokens).toBe(1048576)
        expect(data.some((m) => m.id.includes('*'))).toBe(false)
    })

    it('lists the configured MODELS', async () => {
        const ids = (await list()).map((m) => m.id)
        expect(ids).toContain(GLM)
        expect(ids).toContain(KIMI)
    })

    it('lists a route id that is also a MODELS id once, described by the route', async () => {
        const env = makeEnv({
            MODELS,
            MODEL_ROUTES: JSON.stringify({ [GLM]: { provider: 'workers-ai', model: 'x', contextTokens: 777 } })
        })
        const data = await list(env)
        const matches = data.filter((m) => m.id === GLM)
        expect(matches).toHaveLength(1)
        expect(matches[0].max_input_tokens).toBe(777)
        const got = await getOne(GLM, env)
        expect(got.max_input_tokens).toBe(777)
    })

    it('describes a MODELS id matched by a glob route by that route', async () => {
        const env = makeEnv({
            MODELS,
            MODEL_ROUTES: JSON.stringify({ '@cf/moonshotai/*': { provider: 'workers-ai', model: 'backing-x' } }),
            VISION_MODELS: 'backing-x'
        })
        const kimi = (await list(env)).find((m) => m.id === KIMI) as any
        expect(kimi.max_input_tokens).toBe(24000)
        expect(kimi.capabilities.vision.supported).toBe(true)
        const glm = (await list(env)).find((m) => m.id === GLM) as any
        expect(glm.max_input_tokens).toBe(24000)
    })

    it('lists routed ids after the MODELS ids', async () => {
        const ids = (await list()).map((m) => m.id)
        expect(ids.indexOf('claude-sonnet-4-5')).toBeGreaterThan(ids.indexOf(DEEPSEEK))
    })

    it.each([
        ['backing model', GLM],
        ['alias id', 'claude-sonnet-4-5']
    ])('capability flags for a routed id honour %s in VISION_MODELS and MULTI_TOOL_MODELS', async (_n, name) => {
        const env = makeEnv({ MODELS, MODEL_ROUTES, VISION_MODELS: name, MULTI_TOOL_MODELS: name })
        const listed = (await list(env)).find((m) => m.id === 'claude-sonnet-4-5') as any
        expect(listed.capabilities.vision.supported).toBe(true)
        expect(listed.capabilities.multi_tool_use.supported).toBe(true)
        const got = await getOne('claude-sonnet-4-5', env)
        expect(got.capabilities.vision.supported).toBe(true)
        expect(got.capabilities.multi_tool_use.supported).toBe(true)
    })

    it('capability flags for a glob-matched id come from the backing model', async () => {
        const env = makeEnv({ MODELS, MODEL_ROUTES, VISION_MODELS: KIMI, MULTI_TOOL_MODELS: KIMI })
        const got = await getOne('claude-opus-4', env)
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

    it.each(['redteam%2Fclaude-sonnet-4-5', 'redteam/claude-sonnet-4-5', 'PURPLE/claude-sonnet-4-5'])(
        'GET /v1/models/%s resolves the mode alias like the bare id',
        async (path) => {
            const env = makeEnv({ MODEL_ROUTES })
            const bare = await (await callWorker('/v1/models/claude-sonnet-4-5', auth, env)).json()
            const res = await callWorker(`/v1/models/${path}`, auth, env)
            expect(res.status).toBe(200)
            const got = (await res.json()) as any
            expect(got).toEqual(bare)
            expect(got.max_input_tokens).toBe(1048576)
        }
    )

    it('GET /v1/models/redteam/ is 404 even when a catch-all route exists', async () => {
        const env = makeEnv({
            MODEL_ROUTES: JSON.stringify({ '*': { provider: 'workers-ai', model: GLM } })
        })
        const res = await callWorker('/v1/models/redteam%2F', auth, env)
        expect(res.status).toBe(404)
    })

    it('GET /v1/models/{id} returns 404 for an unrouted unknown id', async () => {
        const res = await callWorker('/v1/models/nope-1', auth, makeEnv({ MODEL_ROUTES }))
        expect(res.status).toBe(404)
    })
})
