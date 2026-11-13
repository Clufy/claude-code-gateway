import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config'
import { handleMcp } from '../src/mcp/server'
import { parseGuardRules } from '../src/guard/config'
import { makeEnv, mcpCall, stubFetch } from './helpers'

const NOW = Date.parse('2026-11-13T12:00:00Z')
const ACCOUNT = '0123456789abcdef0123456789abcdef'
const OBS = { CF_ACCOUNT_ID: ACCOUNT, CF_API_TOKEN: 'tok-secret' }
const ACME = {
    scope: { domains: ['*.scope-only.example'], cidrs: [], llmTargets: [] },
    exclude: { domains: [] },
    window: { start: '2026-11-10T00:00:00Z', end: '2026-11-21T23:59:59Z' },
    roe: '',
    defaultMode: 'purple'
}

const PROMPT_RULE =
    'title: Foo prompt\nlevel: high\nlogsource:\n  product: claude-proxy\n  category: prompt\ndetection:\n  s:\n    text|contains: foo\n  condition: s\n'
const DETECTION_RULE =
    'title: Det\nlogsource:\n  product: claude-proxy\n  service: detection\ndetection:\n  s:\n    ruleId: secret.github\n  condition: s\n'
const BAD_RULE =
    'title: Bad\nlogsource:\n  product: claude-proxy\n  category: prompt\ndetection:\n  s:\n    text|base64: foo\n  condition: s\n'

type SelfFetch = (req: Request) => Promise<Response>

async function call(args: Record<string, unknown>, selfFetch?: SelfFetch, env: Record<string, unknown> = {}) {
    const config = loadConfig({ PROXY_KEY: 'test-key', ENGAGEMENTS: JSON.stringify({ acme: ACME }), ...env })
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
            params: { name: 'purple', arguments: args }
        })
    })
    const res = await handleMcp(request, config, 'req_1', () => NOW, selfFetch ? { selfFetch } : undefined)
    expect(res.status).toBe(200)
    const json: any = await res.json()
    const text: string = json.result.content[0].text
    const isError = json.result.isError === true
    return { isError, text, data: isError ? null : JSON.parse(text) }
}

const reply = (text: string) => Response.json({ content: [{ type: 'text', text }] })
const fenced = '```yaml\n' + PROMPT_RULE + '```'

let stub: ReturnType<typeof stubFetch> | undefined
afterEach(() => {
    stub?.restore()
    stub = undefined
    vi.restoreAllMocks()
})

describe('purple tool', () => {
    it('is listed with the action enum', async () => {
        const res = await mcpCall('tools/list', undefined, { env: makeEnv() })
        const json: any = await res.json()
        const tool = json.result.tools.find((t: any) => t.name === 'purple')
        expect(tool.inputSchema.properties.action.enum).toEqual(['draft_rule', 'test_rule', 'promote_rule'])
    })

    it('draft_rule with an explicit model returns a valid draft', async () => {
        const seen: Request[] = []
        const selfFetch: SelfFetch = async (req) => {
            seen.push(req)
            return reply(fenced)
        }
        const r = await call(
            { action: 'draft_rule', finding: 'foo exfil', logsource: 'prompt', model: 'm1' },
            selfFetch
        )
        expect(r.data).toMatchObject({ valid: true, model: 'm1', status: 'draft' })
        expect(seen).toHaveLength(1)
        const body: any = await seen[0]!.clone().json()
        expect(body.max_tokens).toBe(4096)
        expect(body.model).toBe('m1')
        expect(seen[0]!.headers.get('x-api-key')).toBe('test-key')
    })

    it('draft_rule defaults to the first routed model', async () => {
        const urls: string[] = []
        const selfFetch: SelfFetch = async (req) => {
            urls.push(new URL(req.url).pathname)
            if (req.url.endsWith('/v1/models')) {
                expect(req.headers.get('x-api-key')).toBe('test-key')
                return Response.json({ data: [{ id: 'first' }, { id: 'second' }] })
            }
            return reply(fenced)
        }
        const r = await call({ action: 'draft_rule', finding: 'foo', logsource: 'prompt' }, selfFetch)
        expect(r.data.model).toBe('first')
        expect(urls).toEqual(['/v1/models', '/v1/messages'])
    })

    it.each([
        ['empty list', async () => Response.json({ data: [] })],
        ['non-2xx', async () => new Response('no', { status: 500 })],
        ['bad json', async () => new Response('not json')],
        ['missing data', async () => Response.json({})],
        [
            'thrown fetch',
            async (): Promise<Response> => {
                throw new Error('boom')
            }
        ]
    ])('draft_rule with %s models fails', async (_n, models) => {
        const r = await call({ action: 'draft_rule', finding: 'foo', logsource: 'prompt' }, models)
        expect(r.isError).toBe(true)
        expect(r.text).toBe('no routed models; pass model')
    })

    it('draft_rule needs finding and logsource', async () => {
        const r = await call({ action: 'draft_rule', finding: 'foo' })
        expect(r.text).toBe('draft_rule needs finding and logsource')
        expect(r.isError).toBe(true)
    })

    it('test_rule with events and expect passes', async () => {
        const r = await call({
            action: 'test_rule',
            rule: PROMPT_RULE,
            events: [{ text: 'a foo b' }, { text: 'bar' }],
            expect: [0]
        })
        expect(r.data).toMatchObject({ passed: true, matched: [0] })
    })

    it('test_rule reports unsupported features as not passed', async () => {
        const r = await call({ action: 'test_rule', rule: BAD_RULE, events: [{ text: 'foo' }], expect: [0] })
        expect(r.data.passed).toBe(false)
        expect(r.data.unsupported.length).toBeGreaterThan(0)
    })

    it('test_rule rejects both events and logs, or neither', async () => {
        const both = await call({ action: 'test_rule', rule: DETECTION_RULE, events: [], logs: {} })
        expect(both.isError).toBe(true)
        expect(both.text).toBe('test_rule needs rule and one of events or logs')
        const neither = await call({ action: 'test_rule', rule: DETECTION_RULE })
        expect(neither.text).toBe('test_rule needs rule and one of events or logs')
    })

    it('test_rule with logs queries the engagement and returns rows', async () => {
        stub = stubFetch(() =>
            Response.json({
                result: {
                    events: {
                        events: [
                            {
                                timestamp: NOW - 1000,
                                source: {
                                    event: 'detection',
                                    engagement: 'acme',
                                    ruleId: 'secret.github',
                                    requestId: 'r1'
                                }
                            },
                            {
                                timestamp: NOW - 2000,
                                source: { event: 'detection', engagement: 'acme', ruleId: 'other', requestId: 'r2' }
                            }
                        ],
                        count: 2
                    }
                }
            })
        )
        const r = await call(
            { action: 'test_rule', rule: DETECTION_RULE, logs: { engagement: 'acme' } },
            undefined,
            OBS
        )
        const body: any = JSON.parse(await stub.calls[0]!.clone().text())
        expect(body.limit).toBe(50)
        expect(body.parameters.filters).toContainEqual({
            key: 'engagement',
            operation: 'eq',
            type: 'string',
            value: 'acme'
        })
        expect(body.parameters.filters).toContainEqual({
            key: 'event',
            operation: 'eq',
            type: 'string',
            value: 'detection'
        })
        expect(r.data.matched).toEqual([0])
        expect(r.data.rows).toEqual([{ time: new Date(NOW - 1000).toISOString(), requestId: 'r1' }])
        expect(r.text).not.toContain('secret.github')
    })

    it('P7-M1: test_rule with logs reports a parse failure, not a logsource error', async () => {
        const r = await call({ action: 'test_rule', rule: BAD_RULE, logs: {} }, undefined, OBS)
        expect(r.isError).toBe(false)
        expect(r.data).toEqual({
            passed: false,
            matched: [],
            missedExpected: [],
            unexpectedMatches: [],
            unsupported: ['modifier:base64'],
            error: 'unsupported Sigma features'
        })
    })

    it('test_rule with logs enforces its guards', async () => {
        const unconfigured = await call({ action: 'test_rule', rule: DETECTION_RULE, logs: {} })
        expect(unconfigured.text).toBe(
            'logs not configured: set CF_ACCOUNT_ID and the CF_API_TOKEN secret, or use wrangler tail'
        )
        const misconfigured = await call({ action: 'test_rule', rule: DETECTION_RULE, logs: {} }, undefined, {
            CF_ACCOUNT_ID: 'bad',
            CF_API_TOKEN: 'tok'
        })
        expect(misconfigured.text).toMatch(/^logs misconfigured: /)
        const withExpect = await call(
            { action: 'test_rule', rule: DETECTION_RULE, logs: {}, expect: [0] },
            undefined,
            OBS
        )
        expect(withExpect.text).toBe('expect needs supplied events')
        const wrongSource = await call({ action: 'test_rule', rule: PROMPT_RULE, logs: {} }, undefined, OBS)
        expect(wrongSource.text).toBe('logs source needs logsource service detection or request')
        const since = await call({ action: 'test_rule', rule: DETECTION_RULE, logs: { since: 'x' } }, undefined, OBS)
        expect(since.text).toBe('invalid since: use e.g. 30m, 24h, 7d or an ISO time')
    })

    it('promote_rule promotes a passing rule to a snippet parseGuardRules accepts', async () => {
        const r = await call({
            action: 'promote_rule',
            rule: PROMPT_RULE,
            events: [{ text: 'a foo b' }, { text: 'bar' }],
            expect: [0],
            id: 'foo1'
        })
        expect(r.data.promotable).toBe(true)
        expect(r.data.note).toBe('merge entry into the custom array of the GUARD_RULES var and redeploy')
        expect(() => parseGuardRules(r.data.snippet)).not.toThrow()
        expect(parseGuardRules(r.data.snippet).custom).toHaveLength(1)
    })

    it('promote_rule needs rule, events and expect', async () => {
        const r = await call({ action: 'promote_rule', rule: PROMPT_RULE, events: [] })
        expect(r.text).toBe('promote_rule needs rule, events and expect')
    })

    it('P7-M2: promote_rule treats an empty expect as missing (no vacuous proof)', async () => {
        const r = await call({ action: 'promote_rule', rule: PROMPT_RULE, events: [{ text: 'bar' }], expect: [] })
        expect(r.isError).toBe(true)
        expect(r.text).toBe('promote_rule needs rule, events and expect')
    })

    it('P7-M2: promote_rule treats empty events as missing', async () => {
        const r = await call({ action: 'promote_rule', rule: PROMPT_RULE, events: [], expect: [0] })
        expect(r.isError).toBe(true)
        expect(r.text).toBe('promote_rule needs rule, events and expect')
    })

    it('promote_rule fails when the test does not pass', async () => {
        const r = await call({ action: 'promote_rule', rule: PROMPT_RULE, events: [{ text: 'bar' }], expect: [0] })
        expect(r.isError).toBe(true)
        expect(r.text).toMatch(/^promote needs a passing test_rule: \{/)
        expect(JSON.parse(r.text.slice('promote needs a passing test_rule: '.length)).passed).toBe(false)
    })

    it('promote_rule reports non-promotable rules', async () => {
        const r = await call({
            action: 'promote_rule',
            rule: DETECTION_RULE,
            events: [{ ruleId: 'secret.github' }],
            expect: [0]
        })
        expect(r.data.promotable).toBe(false)
        expect(typeof r.data.reason).toBe('string')
    })

    it('writes exactly one mcp log line per call, without arguments', async () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {})
        await call({ action: 'test_rule', rule: PROMPT_RULE, events: [{ text: 'foo-secret-marker' }] })
        await call({ action: 'draft_rule', finding: 'nope' })
        const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('"event":"mcp"'))
        expect(lines).toHaveLength(2)
        expect(JSON.parse(lines[0]!)).toMatchObject({ tool: 'purple', action: 'test_rule', ok: true })
        expect(JSON.parse(lines[1]!)).toMatchObject({ tool: 'purple', action: 'draft_rule', ok: false })
        expect(lines.join('')).not.toContain('foo-secret-marker')
    })
})
