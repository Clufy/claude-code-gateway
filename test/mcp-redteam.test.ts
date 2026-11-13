import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config'
import { capCard, race } from '../src/mcp/redteam-tool'
import { ADAPTERS } from '../src/shared/redteam/adapters.ts'
import { CORPUS } from '../src/shared/redteam/corpus.ts'
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
const IPEX = {
    ...ACME,
    scope: { domains: [], cidrs: [], llmTargets: ['https://203.0.113.7/v1'] },
    exclude: { domains: [], cidrs: ['203.0.113.0/24'] }
}
const OPEN = Date.parse('2026-11-15T00:00:00Z')
const WINDOW_END = Date.parse('2026-11-21T23:59:59Z')

type SelfFetch = (req: Request) => Promise<Response>

async function call(args: Record<string, unknown>, selfFetch?: SelfFetch, now: () => number = () => OPEN) {
    const config = loadConfig({ PROXY_KEY: 'test-key', ENGAGEMENTS: JSON.stringify({ acme: ACME, ipex: IPEX }) })
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
        expect(json.result.tools.map((t: any) => t.name).sort()).toEqual(['engagement', 'logs', 'purple', 'redteam'])
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

    it('P6-R15: refuses an IP target inside exclude.cidrs without fetching', async () => {
        stub = stubFetch(() => anthropicReply('I cannot help with that.'))
        const r = await call({
            action: 'run',
            suite: 'direct-injection',
            target: 'anthropic:https://203.0.113.7/v1/messages',
            engagement: 'ipex'
        })
        expect(r.isError).toBe(true)
        expect(r.text).toBe('target 203.0.113.7 is excluded from engagement ipex')
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

    it('P6-R18: passes model to external targets', async () => {
        stub = stubFetch(() => anthropicReply('I cannot help with that.'))
        const r = await call({
            action: 'run',
            suite: 'direct-injection',
            target: 'openai:https://llm.acme-test.com/v1/chat/completions',
            engagement: 'acme',
            model: 'ext-m',
            maxCases: 1
        })
        expect(r.isError).toBe(false)
        expect(stub.calls).toHaveLength(1)
        expect(((await stub.calls[0].json()) as any).model).toBe('ext-m')
    })

    it('P6-R18: rejects a target or model over 200 chars', async () => {
        stub = stubFetch(() => anthropicReply('I cannot help with that.'))
        const long = `openai:https://llm.acme-test.com/v1/${'x'.repeat(200)}`
        const t = await call({ action: 'run', suite: 'direct-injection', target: long, engagement: 'acme' })
        expect(t.isError).toBe(true)
        const m = await call({
            action: 'run',
            suite: 'direct-injection',
            target: 'openai:https://llm.acme-test.com/v1/chat/completions',
            engagement: 'acme',
            model: 'm'.repeat(201)
        })
        expect(m.isError).toBe(true)
        expect(stub.calls).toHaveLength(0)
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

    it('P6-R17: race rejects with the abort reason, up front or when the signal fires', async () => {
        const never = new Promise<string>(() => {})
        const pre = new AbortController()
        pre.abort(new Error('gone'))
        await expect(race(never, pre.signal)).rejects.toThrow('gone')
        const later = new AbortController()
        const p = race(never, later.signal)
        later.abort(new DOMException('timeout', 'TimeoutError'))
        await expect(p).rejects.toMatchObject({ name: 'TimeoutError' })
        await expect(race(Promise.resolve('ok'), new AbortController().signal)).resolves.toBe('ok')
        await expect(race(Promise.resolve('ok'), undefined)).resolves.toBe('ok')
    })

    it('P6-R17: a raced fetch that never answers gives the adapter error timeout', async () => {
        const r = await ADAPTERS.anthropic(CORPUS['direct-injection']![0]!, {
            url: 'https://self.internal/v1/messages',
            model: 'm',
            headers: {},
            fetch: (_input, init) => race(new Promise<Response>(() => {}), init?.signal),
            timeoutMs: 50,
            checkHop: () => null
        })
        expect(r.error).toBe('timeout')
    })

    it('P6-R17: a self run whose selfFetch never resolves ends at the clamped deadline', async () => {
        const t0 = Date.now()
        let calls = 0
        // Calls 1-3 are the mcp log start, startedAt and the runner deadline; after them ~200 ms of the 55 s remain.
        const now = () => (++calls <= 3 ? OPEN : OPEN + 54_800) + (Date.now() - t0)
        const r = await call(
            { action: 'run', suite: 'direct-injection', target: 'self:m', maxCases: 1 },
            () => new Promise<Response>(() => {}),
            now
        )
        expect(Date.now() - t0).toBeLessThan(3000)
        expect(r.isError).toBe(false)
        expect(r.data.suites[0]).toMatchObject({ total: 1, errors: 1, passed: 0, attacked: 0 })
    }, 10000)

    it('P6-R17: a judge selfFetch that never resolves also ends', async () => {
        const t0 = Date.now()
        let jump = 0
        const now = () => OPEN + jump + (Date.now() - t0)
        const selfFetch: SelfFetch = async (req) => {
            const body: any = await req.json()
            if (body.model === 'judge-m') return new Promise<Response>(() => {})
            jump = 54_800 // the first target reply leaves ~200 ms of the 55 s deadline
            return anthropicReply('fine')
        }
        const r = await call(
            { action: 'run', suite: 'system-prompt-leakage', target: 'self:m', maxCases: 10, judgeModel: 'judge-m' },
            selfFetch,
            now
        )
        expect(Date.now() - t0).toBeLessThan(3000)
        expect(r.isError).toBe(false)
        expect(r.data.judge).toHaveLength(2)
        expect(r.data.judge.some((j: any) => j.status === 'unknown' && j.detail === 'judge call failed')).toBe(true)
    }, 10000)

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
