import { afterEach, describe, expect, it } from 'vitest'
import { callWorker, makeEnv, mcpCall, stubFetch } from '../helpers'

const init = {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' }
}

function rawPost(body: string, headers: Record<string, string> = {}) {
    return callWorker('/mcp', {
        method: 'POST',
        headers: {
            authorization: 'Bearer test-key',
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            ...headers
        },
        body
    })
}

describe('POST /mcp', () => {
    it('answers initialize', async () => {
        const res = await mcpCall('initialize', init)
        expect(res.status).toBe(200)
        const json: any = await res.json()
        expect(json.result.serverInfo.name).toBe('claude-code-gateway')
        expect(json.result.capabilities.tools).toBeDefined()
    })

    it('lists tools', async () => {
        const res = await mcpCall('tools/list')
        expect(res.status).toBe(200)
        const json: any = await res.json()
        expect(Array.isArray(json.result.tools)).toBe(true)
    })

    it('accepts notifications with 202', async () => {
        const res = await mcpCall('notifications/initialized', undefined, { id: null })
        expect(res.status).toBe(202)
    })

    it('accepts a lowercase bearer scheme', async () => {
        const res = await mcpCall('initialize', init, { headers: { authorization: 'bearer test-key' } })
        expect(res.status).toBe(200)
    })

    it.each(['GET', 'DELETE'])('rejects %s with 405', async (method) => {
        const res = await callWorker('/mcp', { method, headers: { authorization: 'Bearer test-key' } })
        expect(res.status).toBe(405)
        expect(res.headers.get('allow')).toBe('POST')
    })

    it('rejects a missing authorization header', async () => {
        const res = await mcpCall('initialize', init, { headers: { authorization: '' } })
        expect(res.status).toBe(401)
        expect(await res.json()).toEqual({ error: 'invalid authorization' })
    })

    it('rejects a wrong bearer token', async () => {
        const res = await mcpCall('initialize', init, { headers: { authorization: 'Bearer wrong' } })
        expect(res.status).toBe(401)
    })

    it('does not accept x-api-key', async () => {
        const res = await rawPost('{}', { authorization: '', 'x-api-key': 'test-key' })
        expect(res.status).toBe(401)
    })

    it('reports an unconfigured proxy', async () => {
        const res = await mcpCall('initialize', init, { env: makeEnv({ PROXY_KEY: undefined }) })
        expect(res.status).toBe(500)
        expect(await res.text()).toContain('proxy not configured')
    })

    it('requires PROXY_KEY even with ALLOW_ANONYMOUS', async () => {
        const env = makeEnv({ PROXY_KEY: undefined, ALLOW_ANONYMOUS: 'true' })
        const res = await mcpCall('initialize', init, { env, headers: { authorization: '' } })
        expect(res.status).toBe(500)
        expect(await res.text()).toContain('proxy not configured: /mcp requires PROXY_KEY')
    })

    it('still rejects a wrong bearer when PROXY_KEY and ALLOW_ANONYMOUS are both set', async () => {
        const env = makeEnv({ ALLOW_ANONYMOUS: 'true' })
        const res = await mcpCall('initialize', init, { env, headers: { authorization: 'Bearer wrong' } })
        expect(res.status).toBe(401)
    })

    it('rejects a body over 65536 bytes with 413', async () => {
        const res = await rawPost(
            JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'x', params: { p: 'a'.repeat(70000) } })
        )
        expect(res.status).toBe(413)
        expect(res.headers.get('request-id')).toBeTruthy()
    })

    it('answers malformed JSON with a parse error', async () => {
        const res = await rawPost('{')
        const json: any = await res.json()
        expect(json.error.code).toBe(-32700)
    })

    it('checks auth before the body cap', async () => {
        const big = JSON.stringify({ p: 'a'.repeat(70000) })
        const res = await rawPost(big, { authorization: '' })
        expect(res.status).toBe(401)
    })

    it('rate limits before auth', async () => {
        const env = makeEnv({ RATE_LIMITER: { limit: async () => ({ success: false }) } })
        const res = await mcpCall('initialize', init, { env, headers: { authorization: '' } })
        expect(res.status).toBe(429)
    })

    it.each(['/mcp/', '/MCP'])('404s on %s', async (path) => {
        const res = await callWorker(path, {
            method: 'POST',
            headers: { authorization: 'Bearer test-key' },
            body: '{}'
        })
        expect(res.status).toBe(404)
    })

    it('ignores the query string', async () => {
        const noAuth = await callWorker('/mcp?x=1', { method: 'POST', body: '{}' })
        expect(noAuth.status).toBe(401)
        const res = await callWorker('/mcp?x=1', {
            method: 'POST',
            headers: {
                authorization: 'Bearer test-key',
                'content-type': 'application/json',
                accept: 'application/json, text/event-stream'
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: init })
        })
        expect(res.status).toBe(200)
    })

    it('rejects a chunked body over the cap', async () => {
        const chunk = new TextEncoder().encode('a'.repeat(1000))
        const stream = new ReadableStream({
            start(c) {
                for (let i = 0; i < 70; i++) c.enqueue(chunk)
                c.close()
            }
        })
        const res = await callWorker('/mcp', {
            method: 'POST',
            headers: {
                authorization: 'Bearer test-key',
                'content-type': 'application/json',
                accept: 'application/json, text/event-stream'
            },
            body: stream,
            duplex: 'half'
        } as RequestInit)
        expect(res.status).toBe(413)
    })

    it('rejects a declared content-length over the cap', async () => {
        const res = await rawPost('{}', { 'content-length': '70000' })
        expect(res.status).toBe(413)
    })

    it.each(['Bearer', 'Bearer    '])('rejects %j with 401', async (authorization) => {
        const res = await mcpCall('initialize', init, { headers: { authorization } })
        expect(res.status).toBe(401)
    })

    it('accepts a lowercase scheme with two spaces', async () => {
        const res = await mcpCall('initialize', init, { headers: { authorization: 'bearer  test-key' } })
        expect(res.status).toBe(200)
    })
})

describe('POST /mcp batches', () => {
    const call = (name: string) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } })
    const env = () => makeEnv({ CF_ACCOUNT_ID: '0123456789abcdef0123456789abcdef', CF_API_TOKEN: 'tok' })
    let stub: ReturnType<typeof stubFetch> | undefined
    afterEach(() => stub?.restore())

    const post = (body: string) =>
        callWorker(
            '/mcp',
            {
                method: 'POST',
                headers: {
                    authorization: 'Bearer test-key',
                    'content-type': 'application/json',
                    accept: 'application/json, text/event-stream'
                },
                body
            },
            env()
        )

    it.each(['', '  \n\t'])('rejects a batch (prefix %j) with 400 and never fetches', async (prefix) => {
        stub = stubFetch(() => new Response('{}'))
        const res = await post(prefix + JSON.stringify([call('logs'), { ...call('logs'), id: 2 }]))
        expect(res.status).toBe(400)
        expect(res.headers.get('content-type')).toContain('application/json')
        expect(await res.json()).toEqual({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32600, message: 'batch requests are not supported' }
        })
        expect(stub.calls).toHaveLength(0)
    })

    it('still serves a single request', async () => {
        const res = await post(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))
        expect(res.status).toBe(200)
    })
})

describe('partial CF_* config does not break other routes', () => {
    it('GET / and /v1/messages still return 200 with only CF_API_TOKEN set', async () => {
        const env = makeEnv({ CF_API_TOKEN: 'tok' })
        expect((await callWorker('/', undefined, env)).status).toBe(200)
        const res = await callWorker(
            '/v1/messages',
            {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-api-key': 'test-key' },
                body: JSON.stringify({
                    model: 'claude-sonnet-4-5',
                    max_tokens: 10,
                    messages: [{ role: 'user', content: 'hi' }]
                })
            },
            env
        )
        expect(res.status).toBe(200)
    })
})
