import { afterEach, describe, expect, it } from 'vitest'
import { makeEnv, mcpCall, stubFetch } from './helpers'
import { loadConfig } from '../src/config'
import { handleMcp } from '../src/mcp/server'
import { parseSince } from '../src/mcp/logs-tool'

const NOW = Date.parse('2026-11-13T12:00:00Z')
const H = 3600_000
const ACCOUNT = '0123456789abcdef0123456789abcdef'
const OBS = { CF_ACCOUNT_ID: ACCOUNT, CF_API_TOKEN: 'tok-secret' }

let stub: ReturnType<typeof stubFetch> | undefined
afterEach(() => stub?.restore())

const apiBody = (events: { timestamp: number; source: unknown }[], count?: number) =>
    Response.json({ result: { events: { events, count: count ?? events.length } } })

async function call(args: Record<string, unknown>, env: Record<string, unknown> = OBS) {
    const config = loadConfig({ PROXY_KEY: 'test-key', ...env })
    const request = new Request('https://proxy.test/mcp', {
        method: 'POST',
        headers: {
            authorization: 'Bearer test-key',
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'mcp-protocol-version': '2025-06-18'
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'logs', arguments: args } })
    })
    const res = await handleMcp(request, config, 'req_1', () => NOW)
    expect(res.status).toBe(200)
    const json: any = await res.json()
    const text: string = json.result.content[0].text
    return { isError: json.result.isError === true, text, data: json.result.isError ? null : JSON.parse(text) }
}

const sent = async (i = 0): Promise<any> => JSON.parse(await stub!.calls[i].clone().text())

describe('parseSince', () => {
    it('parses and clamps', () => {
        expect(parseSince(undefined, NOW)).toBe(NOW - 24 * H)
        expect(parseSince('30m', NOW)).toBe(NOW - 30 * 60_000)
        expect(parseSince('30d', NOW)).toBe(NOW - 7 * 24 * H)
        expect(parseSince('2026-11-13T00:00:00Z', NOW)).toBe(Date.parse('2026-11-13T00:00:00Z'))
        expect(parseSince('yesterday', NOW)).toBeNull()
        expect(parseSince('2026-11-14T00:00:00Z', NOW)).toBeNull()
    })
})

describe('logs tool', () => {
    it('is listed beside engagement', async () => {
        const res = await mcpCall('tools/list', undefined, { env: makeEnv() })
        const json: any = await res.json()
        expect(json.result.tools.map((t: any) => t.name).sort()).toEqual(['engagement', 'logs'])
        const tool = json.result.tools.find((t: any) => t.name === 'logs')
        expect(tool.inputSchema.properties.action.enum).toEqual(['findings', 'activity'])
    })

    it('findings builds filters and maps rows', async () => {
        stub = stubFetch(() =>
            apiBody([
                {
                    timestamp: NOW - 1000,
                    source: {
                        event: 'detection',
                        ruleId: 'secret.github',
                        severity: 'high',
                        engagement: 'acme',
                        requestId: 'r1',
                        excerpt: `token ghp_${'a'.repeat(36)} end`,
                        extra: 'x'
                    }
                }
            ])
        )
        const r = await call({ action: 'findings', engagement: 'acme', rule: 'secret.', severity: 'medium' })
        const body = await sent()
        expect(body.limit).toBe(50)
        expect(body.timeframe).toEqual({ from: NOW - 24 * H, to: NOW })
        expect(body.parameters.filters).toEqual(
            expect.arrayContaining([
                { key: 'engagement', operation: 'eq', type: 'string', value: 'acme' },
                { key: 'ruleId', operation: 'starts_with', type: 'string', value: 'secret.' },
                { key: 'severity', operation: 'in', type: 'string', value: ['medium', 'high'] }
            ])
        )
        expect(r.data.count).toBe(1)
        expect(r.data.returned).toBe(1)
        const row = r.data.rows[0]
        expect(Object.keys(row).sort()).toEqual(
            ['engagement', 'excerpt', 'requestId', 'ruleId', 'severity', 'time'].sort()
        )
        expect(row.time).toBe(new Date(NOW - 1000).toISOString())
        expect(row.excerpt).not.toContain('a'.repeat(36))
    })

    it('exact rule uses eq', async () => {
        stub = stubFetch(() => apiBody([]))
        await call({ action: 'findings', rule: 'secret.egress' })
        const body = await sent()
        expect(body.parameters.filters).toContainEqual({
            key: 'ruleId',
            operation: 'eq',
            type: 'string',
            value: 'secret.egress'
        })
    })

    it('activity keeps present fields and never excerpt', async () => {
        stub = stubFetch(() =>
            apiBody([
                {
                    timestamp: NOW - 5,
                    source: {
                        event: 'request',
                        requestId: 'r2',
                        model: 'm',
                        tools: ['Bash'],
                        durationMs: 12,
                        ttfbMs: 3,
                        excerpt: 'nope'
                    }
                }
            ])
        )
        const r = await call({ action: 'activity' })
        expect(r.data.rows[0]).toEqual({
            time: new Date(NOW - 5).toISOString(),
            requestId: 'r2',
            model: 'm',
            tools: ['Bash'],
            durationMs: 12,
            ttfbMs: 3
        })
    })

    it('rejects bad arguments at the schema', async () => {
        stub = stubFetch(() => apiBody([]))
        expect((await call({ action: 'activity', limit: 0 })).isError).toBe(true)
        expect((await call({ action: 'activity', limit: 1000 })).isError).toBe(true)
        expect((await call({ action: 'findings', severity: 'critical' })).isError).toBe(true)
        expect(stub.calls).toHaveLength(0)
    })

    it('rejects invalid since', async () => {
        stub = stubFetch(() => apiBody([]))
        const r = await call({ action: 'activity', since: 'yesterday' })
        expect(r.isError).toBe(true)
        expect(r.text).toBe('invalid since: use e.g. 30m, 24h, 7d or an ISO time')
        expect(stub.calls).toHaveLength(0)
    })

    it('not configured never fetches', async () => {
        stub = stubFetch(() => apiBody([]))
        const r = await call({ action: 'activity' }, {})
        expect(r.isError).toBe(true)
        expect(r.text).toBe('logs not configured: set CF_ACCOUNT_ID and the CF_API_TOKEN secret, or use wrangler tail')
        expect(stub.calls).toHaveLength(0)
    })

    it('upstream 500 is an isError at HTTP 200', async () => {
        stub = stubFetch(() => new Response('{}', { status: 500 }))
        const r = await call({ action: 'activity' })
        expect(r.isError).toBe(true)
        expect(r.text).toBe('logs query failed: HTTP 500')
        expect(r.text).not.toContain('tok-secret')
    })

    it('caps output at 32 KB', async () => {
        const events = Array.from({ length: 300 }, (_, i) => ({
            timestamp: NOW - i,
            source: { event: 'detection', ruleId: 'x.y', severity: 'low', excerpt: 'é'.repeat(400) }
        }))
        stub = stubFetch(() => apiBody(events))
        const r = await call({ action: 'findings' })
        expect(r.data.truncated).toBe(true)
        expect(new TextEncoder().encode(r.text).length).toBeLessThanOrEqual(32768)
        expect(r.data.returned).toBe(r.data.rows.length)
        expect(r.data.returned).toBeLessThan(300)
        expect(r.data.count).toBe(300)
    })

    it('logs the mcp line with the action', async () => {
        stub = stubFetch(() => apiBody([]))
        const lines: string[] = []
        const orig = console.log
        console.log = (s: unknown) => void lines.push(String(s))
        try {
            await call({ action: 'findings' })
        } finally {
            console.log = orig
        }
        const line = JSON.parse(lines.find((l) => l.includes('"event":"mcp"'))!)
        expect(line).toMatchObject({ tool: 'logs', action: 'findings', ok: true })
    })
})
