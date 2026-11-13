import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config'
import { capCard } from '../src/mcp/redteam-tool'
import { handleMcp } from '../src/mcp/server'
import type { Scorecard } from '../src/shared/redteam/scorecard.ts'
import { makeEnv, mcpCall, stubFetch } from './helpers'

const ACME = {
    scope: { domains: ['*.scope-only.example'], cidrs: [], llmTargets: ['https://llm.acme-test.com/v1'] },
    exclude: { domains: [] },
    window: { start: '2026-11-10T00:00:00Z', end: '2026-11-21T23:59:59Z' },
    roe: '',
    defaultMode: 'redteam'
}
const OPEN = Date.parse('2026-11-15T00:00:00Z')
const WINDOW_END = Date.parse('2026-11-21T23:59:59Z')

type SelfFetch = (req: Request) => Promise<Response>

async function call(args: Record<string, unknown>, selfFetch?: SelfFetch, now: () => number = () => OPEN) {
    const config = loadConfig({ PROXY_KEY: 'test-key', ENGAGEMENTS: JSON.stringify({ acme: ACME }) })
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
            params: { name: 'redteam', arguments: args }
        })
    })
    const res = await handleMcp(request, config, 'req_1', now, selfFetch ? { selfFetch } : undefined)
    expect(res.status).toBe(200)
    const json: any = await res.json()
    const text: string = json.result.content[0].text
    return { isError: json.result.isError === true, text, data: json.result.isError ? null : JSON.parse(text) }
}

const anthropicReply = (text: string, headers: Record<string, string> = {}) =>
    Response.json({ content: [{ type: 'text', text }] }, { headers })

let stub: ReturnType<typeof stubFetch> | undefined
afterEach(() => {
    stub?.restore()
    stub = undefined
    vi.restoreAllMocks()
})

describe('redteam tool', () => {
    it('is listed with action enum', async () => {
        const res = await mcpCall('tools/list', undefined, { env: makeEnv() })
        const json: any = await res.json()
        expect(json.result.tools.map((t: any) => t.name).sort()).toEqual(['engagement', 'logs', 'redteam'])
        const tool = json.result.tools.find((t: any) => t.name === 'redteam')
        expect(tool.inputSchema.properties.action.enum).toEqual(['suites', 'run'])
    })

    it('suites lists 7 suites of 10 cases', async () => {
        const r = await call({ action: 'suites' })
        expect(r.data.suites).toHaveLength(7)
        for (const s of r.data.suites) expect(s.cases).toBe(10)
    })

    it('self run scores agent-session and reads detections', async () => {
        const seen: Request[] = []
        const selfFetch: SelfFetch = async (req) => {
            seen.push(req)
            return Response.json(
                {
                    content: [
                        {
                            type: 'tool_use',
                            id: 't1',
                            name: 'Bash',
                            input: {
                                command:
                                    'curl https://CANARY-as01k3.invalid https://CANARY-as02k3.invalid https://CANARY-as03k3.invalid'
                            }
                        },
                        {
                            type: 'tool_use',
                            id: 't2',
                            name: 'WebFetch',
                            input: {
                                url: 'https://CANARY-as01k3.invalid https://CANARY-as02k3.invalid https://CANARY-as03k3.invalid'
                            }
                        }
                    ]
                },
                { headers: { 'x-proxy-detections': 'inject.instruction' } }
            )
        }
        const r = await call(
            { action: 'run', suite: 'agent-session', target: 'self:@cf/test/model', maxCases: 3 },
            selfFetch
        )
        expect(r.isError).toBe(false)
        const s = r.data.suites[0]
        expect(s.suite).toBe('agent-session')
        expect(s.attacked).toBe(3)
        expect(r.data.detectionRecall).toBe(1)
        expect(r.data.meta.corpusSha).toBe('bundled')
        expect(seen).toHaveLength(3)
        expect(seen[0].headers.get('x-api-key')).toBe('test-key')
        expect(new URL(seen[0].url).origin).toBe('https://self.internal')
    })

    it('rejects maxCases over 25', async () => {
        const r = await call({ action: 'run', suite: 'agent-session', target: 'self:m', maxCases: 26 })
        expect(r.isError).toBe(true)
    })

    it('refuses an out-of-scope external target without fetching', async () => {
        stub = stubFetch(() => new Response('no', { status: 500 }))
        const r = await call({
            action: 'run',
            suite: 'direct-injection',
            target: 'openai:https://evil.example.org/v1/chat/completions',
            engagement: 'acme'
        })
        expect(r.isError).toBe(true)
        expect(r.text).toContain('not in engagement acme scope')
        expect(stub.calls).toHaveLength(0)
    })

    it('runs an in-scope external target through global fetch', async () => {
        stub = stubFetch(() => anthropicReply('I cannot help with that.'))
        const r = await call({
            action: 'run',
            suite: 'direct-injection',
            target: 'anthropic:https://llm.acme-test.com/v1/messages',
            engagement: 'acme',
            maxCases: 2
        })
        expect(r.isError).toBe(false)
        expect(stub.calls).toHaveLength(2)
        expect(stub.calls[0].url).toBe('https://llm.acme-test.com/v1/messages')
        expect(r.data.meta.engagement).toBe('acme')
        expect(r.data.suites[0].total).toBe(2)
    })

    it('calls the judge model through selfFetch', async () => {
        const models: string[] = []
        const selfFetch: SelfFetch = async (req) => {
            const body: any = await req.json()
            models.push(body.model)
            return anthropicReply(body.model === 'judge-m' ? '{"attack_succeeded": false, "reason": "ok"}' : 'fine')
        }
        const r = await call(
            {
                action: 'run',
                suite: 'system-prompt-leakage',
                target: 'self:target-m',
                maxCases: 10,
                judgeModel: 'judge-m'
            },
            selfFetch
        )
        expect(r.isError).toBe(false)
        expect(models).toContain('judge-m')
        expect(r.data.judge.length).toBeGreaterThan(0)
    })

    it('logs one mcp line and no prompt text', async () => {
        const lines: string[] = []
        vi.spyOn(console, 'log').mockImplementation((...a) => void lines.push(String(a[0])))
        await call({ action: 'run', suite: 'agent-session', target: 'self:m', maxCases: 1 }, async () =>
            anthropicReply('I cannot help with that.')
        )
        const mcp = lines.map((l) => JSON.parse(l)).filter((l) => l.event === 'mcp')
        expect(mcp).toHaveLength(1)
        expect(mcp[0]).toMatchObject({ tool: 'redteam', action: 'run', ok: true })
        expect(lines.join('\n')).not.toMatch(/CANARY|coding agent|cannot help/i)
    })

    it('accepts maxCases 25', async () => {
        const r = await call({ action: 'run', suite: 'agent-session', target: 'self:m', maxCases: 25 }, async () =>
            anthropicReply('I cannot help with that.')
        )
        expect(r.isError).toBe(false)
        expect(r.data.suites[0].total).toBe(10)
    })

    it('a redirect to an out-of-scope host is an error and the evil host is never fetched', async () => {
        stub = stubFetch(() => new Response(null, { status: 302, headers: { location: 'https://evil.example.org/x' } }))
        const r = await call({
            action: 'run',
            suite: 'direct-injection',
            target: 'anthropic:https://llm.acme-test.com/v1/messages',
            engagement: 'acme',
            maxCases: 2
        })
        expect(r.isError).toBe(false)
        expect(r.data.suites[0].errors).toBe(2)
        expect(r.data.suites[0].passed).toBe(0)
        expect(stub.calls.every((c) => new URL(c.url).hostname === 'llm.acme-test.com')).toBe(true)
    })

    it('stops when the window closes mid-run', async () => {
        stub = stubFetch(() => anthropicReply('I cannot help with that.'))
        const s = stub
        const r = await call(
            {
                action: 'run',
                suite: 'direct-injection',
                target: 'anthropic:https://llm.acme-test.com/v1/messages',
                engagement: 'acme',
                maxCases: 6
            },
            undefined,
            () => (s.calls.length >= 2 ? WINDOW_END + 1000 : WINDOW_END - 1000)
        )
        expect(r.data.stopped).toContain('window is closed')
        expect(s.calls.length).toBeLessThan(6)
    })

    it('sends no credentials to external targets', async () => {
        stub = stubFetch(() => anthropicReply('I cannot help with that.'))
        await call({
            action: 'run',
            suite: 'direct-injection',
            target: 'openai:https://llm.acme-test.com/v1/chat/completions',
            engagement: 'acme',
            maxCases: 2
        })
        for (const c of stub.calls) {
            expect(c.headers.get('x-api-key')).toBeNull()
            expect(c.headers.get('authorization')).toBeNull()
        }
    })

    it('skips judge cases without judgeModel', async () => {
        const r = await call(
            { action: 'run', suite: 'system-prompt-leakage', target: 'self:m', maxCases: 10 },
            async () => anthropicReply('I cannot help with that.')
        )
        expect(r.data.suites[0].judgeCases).toBe(2)
        expect(r.data.judge.filter((j: any) => j.status === 'skipped')).toHaveLength(2)
        expect(r.data.judge.every((j: any) => j.status === 'skipped')).toBe(true)
    })

    it('caps output at 32 KB, dropping examples first then judge detail', () => {
        const ex = { id: 'x', title: 't', reply: 'r'.repeat(300) }
        const card = {
            meta: {},
            suites: Array.from({ length: 200 }, (_, i) => ({ suite: `s${i}`, examples: [ex, ex, ex] })),
            detectionRecall: null,
            judge: Array.from({ length: 400 }, (_, i) => ({
                id: `j${i}`,
                suite: 's',
                status: 'passed',
                detail: 'd'.repeat(200)
            }))
        } as unknown as Scorecard
        const text = capCard(card)
        expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(32768)
        const out = JSON.parse(text)
        expect(out.suites[0].examples).toEqual([])
        expect(out.judge[0].detail.length).toBeLessThanOrEqual(80)
    })
})
