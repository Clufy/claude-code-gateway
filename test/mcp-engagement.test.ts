import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeEnv, mcpCall } from './helpers'
import { loadConfig } from '../src/config'
import { handleMcp } from '../src/mcp/server'

const ACME = {
    scope: { domains: ['*.acme-test.com'], cidrs: ['203.0.0.0/8'], llmTargets: [] },
    exclude: { domains: ['mail.acme-test.com'] },
    window: { start: '2026-11-10T00:00:00Z', end: '2026-11-21T23:59:59Z' },
    roe: '',
    defaultMode: 'redteam'
}
const ENGAGEMENTS = JSON.stringify({ acme: ACME })
const OPEN = Date.parse('2026-11-15T00:00:00Z')
const CLOSED = Date.parse('2026-12-15T00:00:00Z')

async function call(args: Record<string, unknown>, opts: { engagements?: string; now?: number } = {}) {
    const engagements = 'engagements' in opts ? opts.engagements : ENGAGEMENTS
    const config = loadConfig({ PROXY_KEY: 'test-key', ENGAGEMENTS: engagements })
    const request = new Request('https://proxy.test/mcp', {
        method: 'POST',
        headers: {
            authorization: 'Bearer test-key',
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'mcp-protocol-version': '2025-06-18'
        },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'engagement', arguments: args }
        })
    })
    const res = await handleMcp(request, config, 'req_1', () => opts.now ?? OPEN)
    expect(res.status).toBe(200)
    const json: any = await res.json()
    const text: string = json.result.content[0].text
    return { isError: json.result.isError === true, text, data: json.result.isError ? null : JSON.parse(text) }
}

afterEach(() => vi.restoreAllMocks())

describe('engagement tool', () => {
    it('is listed with a flat schema', async () => {
        const res = await mcpCall('tools/list', undefined, { env: makeEnv({ ENGAGEMENTS }) })
        const json: any = await res.json()
        const tool = json.result.tools.find((t: any) => t.name === 'engagement')
        expect(tool.inputSchema.properties.action.enum).toEqual(['list', 'get', 'scope_check'])
        expect(tool.inputSchema.required).toEqual(['action'])
        expect(tool.description.split(/(?<=\.)\s+/).length).toBeLessThanOrEqual(2)
    })

    it('list', async () => {
        const r = await call({ action: 'list' })
        expect(r.data.engagements[0]).toEqual({
            name: 'acme',
            window: { start: '2026-11-10T00:00:00.000Z', end: '2026-11-21T23:59:59.000Z' },
            active: true,
            defaultMode: 'redteam'
        })
    })

    it('list with none configured', async () => {
        const r = await call({ action: 'list' }, { engagements: undefined })
        expect(r.data).toEqual({ engagements: [], hint: 'set the ENGAGEMENTS secret' })
    })

    it('get', async () => {
        const r = await call({ action: 'get', name: 'acme' })
        expect(r.data.scope.domains).toEqual(['*.acme-test.com'])
        expect(r.data.scope.llmTargets).toEqual([])
        expect(r.data.roe).toBe('')
    })

    it('get without name', async () => {
        const r = await call({ action: 'get' })
        expect(r).toMatchObject({ isError: true, text: 'name is required for get' })
    })

    it('unknown engagement names', async () => {
        expect(await call({ action: 'get', name: 'nope' })).toMatchObject({
            isError: true,
            text: 'unknown engagement: nope'
        })
        for (const name of ['a\nb', 'x'.repeat(500)]) {
            expect(await call({ action: 'get', name })).toMatchObject({ isError: true, text: 'unknown engagement' })
        }
    })

    it.each([
        ['https://app.acme-test.com/x', 'in_scope', 'allow'],
        ['mail.acme-test.com', 'excluded', 'deny'],
        ['evil.example.org', 'out_of_scope', 'deny']
    ])('scope_check %s', async (target, verdict, decision) => {
        const r = await call({ action: 'scope_check', name: 'acme', target })
        expect(r.data).toMatchObject({ verdict, decision, inWindow: true })
        if (verdict === 'in_scope') expect(r.data.reasons).toEqual([])
    })

    it('scope_check empty and loopback targets', async () => {
        const empty = await call({ action: 'scope_check', name: 'acme', target: '' })
        expect(empty.data.verdict).toBe('invalid_target')
        const lo = await call({ action: 'scope_check', name: 'acme', target: '127.0.0.1' })
        expect(lo.data.decision).toBe('allow')
    })

    it('scope_check rejects a long target', async () => {
        const r = await call({ action: 'scope_check', name: 'acme', target: 'x'.repeat(2049) })
        expect(r).toMatchObject({ isError: true, text: 'target too long (max 2048 chars)' })
    })

    it('scope_check accepts a 2048-char target', async () => {
        const r = await call({ action: 'scope_check', name: 'acme', target: 'x'.repeat(2048) })
        expect(r.isError).toBe(false)
    })

    it('scope_check without target', async () => {
        const r = await call({ action: 'scope_check', name: 'acme' })
        expect(r).toMatchObject({ isError: true, text: 'target is required for scope_check' })
    })

    it('scope_check after the window', async () => {
        const r = await call({ action: 'scope_check', name: 'acme', target: 'app.acme-test.com' }, { now: CLOSED })
        expect(r.data).toMatchObject({ inWindow: false, decision: 'deny' })
    })

    it('invalid action is an isError at HTTP 200', async () => {
        const res = await mcpCall(
            'tools/call',
            { name: 'engagement', arguments: { action: 'nope' } },
            { env: makeEnv({ ENGAGEMENTS }) }
        )
        expect(res.status).toBe(200)
        const json: any = await res.json()
        expect(json.result.isError).toBe(true)
    })

    it('logs one mcp line without arguments', async () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {})
        await call({ action: 'get', name: 'acme' })
        expect(log).toHaveBeenCalledTimes(1)
        const line = JSON.parse(String(log.mock.calls[0][0]))
        expect(line).toMatchObject({ event: 'mcp', tool: 'engagement', action: 'get', ok: true })
        expect(typeof line.requestId).toBe('string')
        expect(typeof line.durationMs).toBe('number')
        expect(line).not.toHaveProperty('target')
        expect(line).not.toHaveProperty('name')
    })

    it('logs ok:false for a handler error', async () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {})
        await call({ action: 'get', name: 'nope' })
        expect(log).toHaveBeenCalledTimes(1)
        expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({ action: 'get', ok: false })
    })
})
