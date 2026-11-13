import { describe, expect, it } from 'vitest'
import { callWorker, makeEnv, mcpCall } from './helpers'

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
        expect(json.result.serverInfo.name).toBe('claude-worker-proxy')
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

    it('allows anonymous when configured', async () => {
        const env = makeEnv({ PROXY_KEY: undefined, ALLOW_ANONYMOUS: 'true' })
        const res = await mcpCall('initialize', init, { env, headers: { authorization: '' } })
        expect(res.status).toBe(200)
    })

    it('rejects a body over 65536 bytes with 413', async () => {
        const res = await rawPost(
            JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'x', params: { p: 'a'.repeat(70000) } })
        )
        expect(res.status).toBe(413)
    })

    it('answers malformed JSON with a parse error', async () => {
        const res = await rawPost('{')
        const json: any = await res.json()
        expect(json.error.code).toBe(-32700)
    })
})
