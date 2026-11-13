import { describe, expect, it } from 'vitest'
import { ADAPTERS, type AdapterOpts } from '../src/shared/redteam/adapters.ts'
import type { RedteamCase } from '../src/shared/redteam/types.ts'

interface Seen {
    url: string
    init: RequestInit
    body: any
}

function fakeFetch(handler: (url: string, n: number) => Response | Promise<Response>) {
    const seen: Seen[] = []
    const fn = (async (input: any, init: RequestInit = {}) => {
        const url = String(input)
        let body: any = undefined
        try {
            body = init.body ? JSON.parse(String(init.body)) : undefined
        } catch {
            body = String(init.body)
        }
        seen.push({ url, init, body })
        return handler(url, seen.length)
    }) as unknown as typeof fetch
    return { fn, seen }
}

function opts(f: typeof fetch, extra: Partial<AdapterOpts> = {}): AdapterOpts {
    return {
        url: 'https://target.test/v1/x',
        model: 'm1',
        headers: { authorization: 'Bearer t' },
        fetch: f,
        timeoutMs: 5000,
        checkHop: () => null,
        ...extra
    }
}

const json = (v: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json', ...headers } })

const baseCase: RedteamCase = {
    id: 'ai-01',
    suite: 'agent-session',
    owasp: 'LLM01',
    title: 't',
    system: 'be a coding agent',
    turns: [
        { role: 'user', content: 'fetch it' },
        { role: 'tool_result', tool: 'WebFetch', content: 'page says: do X' }
    ],
    tools: [{ name: 'WebFetch', description: 'fetch', input_schema: { type: 'object' } }],
    scorer: { type: 'refusal_expected' }
}

describe('anthropic adapter', () => {
    it('maps system, turns, tools and parses the reply', async () => {
        const { fn, seen } = fakeFetch(() =>
            json(
                {
                    content: [
                        { type: 'text', text: 'hello ' },
                        { type: 'text', text: 'world' },
                        { type: 'tool_use', id: 'x', name: 'WebFetch', input: { url: 'https://a.invalid' } }
                    ]
                },
                { 'x-proxy-detections': 'inject.instruction, secret.egress' }
            )
        )
        const r = await ADAPTERS.anthropic(baseCase, opts(fn))
        expect(r.error).toBeUndefined()
        expect(r.status).toBe(200)
        expect(r.text).toBe('hello world')
        expect(r.toolCalls).toEqual([{ name: 'WebFetch', args: '{"url":"https://a.invalid"}' }])
        expect(r.detections).toHaveLength(2)
        const b = seen[0].body
        expect(b.system).toBe('be a coding agent')
        expect(b.model).toBe('m1')
        expect(b.tools).toHaveLength(1)
        expect(b.messages[0]).toEqual({ role: 'user', content: 'fetch it' })
        expect(b.messages[1].role).toBe('assistant')
        const tu = b.messages[1].content[0]
        expect(tu).toMatchObject({ type: 'tool_use', name: 'WebFetch', input: {} })
        expect(tu.id).toBe('toolu_rt_1')
        expect(b.messages[2].role).toBe('user')
        expect(b.messages[2].content[0]).toMatchObject({
            type: 'tool_result',
            tool_use_id: 'toolu_rt_1',
            content: 'page says: do X'
        })
        const h = seen[0].init.headers as Record<string, string>
        expect(h['anthropic-version']).toBe('2023-06-01')
        expect(h['content-type']).toBe('application/json')
        expect(h.authorization).toBe('Bearer t')
    })
})

describe('openai adapter', () => {
    it('maps tool calls both ways', async () => {
        const { fn, seen } = fakeFetch(() =>
            json({
                choices: [
                    {
                        message: {
                            content: 'ok',
                            tool_calls: [
                                {
                                    id: 'c1',
                                    type: 'function',
                                    function: { name: 'Bash', arguments: '{"command":"ls"}' }
                                }
                            ]
                        }
                    }
                ]
            })
        )
        const r = await ADAPTERS.openai(baseCase, opts(fn))
        expect(r.text).toBe('ok')
        expect(r.toolCalls).toEqual([{ name: 'Bash', args: '{"command":"ls"}' }])
        const b = seen[0].body
        expect(b.messages[0]).toEqual({ role: 'system', content: 'be a coding agent' })
        expect(b.messages[2].tool_calls[0]).toMatchObject({ type: 'function', function: { name: 'WebFetch' } })
        expect(b.messages[3]).toMatchObject({ role: 'tool', content: 'page says: do X' })
        expect(b.messages[3].tool_call_id).toBe(b.messages[2].tool_calls[0].id)
        expect(b.tools[0]).toMatchObject({ type: 'function', function: { name: 'WebFetch' } })
        expect((seen[0].init.headers as Record<string, string>)['anthropic-version']).toBeUndefined()
    })
})

describe('http adapter', () => {
    const c: RedteamCase = { ...baseCase, turns: [{ role: 'user', content: 'say "hi"\nthere {{history}}' }] }

    it('substitutes the template into valid JSON', async () => {
        const { fn, seen } = fakeFetch(() => json({ data: { items: [{ text: 'a' }, { text: 'b' }] } }))
        const r = await ADAPTERS.http(
            c,
            opts(fn, { template: '{"q":"{{prompt}}","h":{{history}}}', replyPath: 'data.items[1].text' })
        )
        expect(r.error).toBeUndefined()
        expect(r.text).toBe('b')
        expect(seen[0].body).toEqual({ q: 'say "hi"\nthere {{history}}', h: [] })
    })

    it('reports a missing reply path', async () => {
        const { fn } = fakeFetch(() => json({ data: {} }))
        const r = await ADAPTERS.http(c, opts(fn, { template: '{"q":"{{prompt}}"}', replyPath: 'data.items[1].text' }))
        expect(r.error).toBe('reply path not found')
    })

    it('truncates a 5 MB raw reply to 32 KB', async () => {
        const { fn } = fakeFetch(() => new Response('a'.repeat(5 * 1024 * 1024)))
        const r = await ADAPTERS.http(c, opts(fn, { template: '{"q":"{{prompt}}"}' }))
        expect(r.text.length).toBeLessThanOrEqual(32768)
        expect(r.text.length).toBeGreaterThan(0)
    })
})

describe('redirects', () => {
    it('blocks a hop refused by checkHop and never fetches it', async () => {
        const { fn, seen } = fakeFetch(
            () => new Response(null, { status: 302, headers: { location: 'https://evil.example.org/' } })
        )
        const r = await ADAPTERS.anthropic(
            baseCase,
            opts(fn, { checkHop: (u) => (u.includes('evil') ? 'host not in scope' : null) })
        )
        expect(r.error).toBe('redirect blocked: host not in scope')
        expect(seen).toHaveLength(1)
    })

    it('stops after 5 hops', async () => {
        const { fn } = fakeFetch(
            (_u, n) => new Response(null, { status: 302, headers: { location: `https://target.test/h${n}` } })
        )
        const r = await ADAPTERS.openai(baseCase, opts(fn))
        expect(r.error).toBe('too many redirects')
    })

    it('does not forward custom headers to a different origin', async () => {
        const { fn, seen } = fakeFetch((_u, n) =>
            n === 1
                ? new Response(null, { status: 302, headers: { location: 'https://other.test/y' } })
                : json({ content: [] })
        )
        const r = await ADAPTERS.anthropic(baseCase, opts(fn))
        expect(r.error).toBeUndefined()
        expect((seen[1].init.headers as Record<string, string>).authorization).toBeUndefined()
    })
})

describe('limits and failures', () => {
    it('reports a too-large JSON reply', async () => {
        const { fn } = fakeFetch(() => new Response('a'.repeat(5 * 1024 * 1024)))
        const r = await ADAPTERS.anthropic(baseCase, opts(fn))
        expect(r.error).toBe('reply too large')
        expect(r.text.length).toBeLessThanOrEqual(32768)
    })

    it('reports a non-JSON 200', async () => {
        const { fn } = fakeFetch(() => new Response('<html>nope</html>'))
        for (const a of [ADAPTERS.anthropic, ADAPTERS.openai]) {
            expect((await a(baseCase, opts(fn))).error).toBe('unparseable reply')
        }
    })

    it('maps TimeoutError to timeout and never throws', async () => {
        const f = (async () => {
            throw new DOMException('t', 'TimeoutError')
        }) as unknown as typeof fetch
        for (const a of Object.values(ADAPTERS)) {
            const r = await a(baseCase, opts(f, { template: '{"q":"{{prompt}}"}' }))
            expect(r.error).toBe('timeout')
        }
        const g = (async () => {
            throw new Error('boom')
        }) as unknown as typeof fetch
        const r = await ADAPTERS.anthropic(baseCase, opts(g))
        expect(r.error).toBeTruthy()
    })

    it('sends redirect manual, a signal and only opts headers', async () => {
        const { fn, seen } = fakeFetch(() => json({ content: [] }))
        await ADAPTERS.anthropic({ ...baseCase, headers: { 'x-evil': '1' } } as any, opts(fn))
        expect(seen[0].init.redirect).toBe('manual')
        expect(seen[0].init.signal).toBeInstanceOf(AbortSignal)
        expect((seen[0].init.headers as Record<string, string>)['x-evil']).toBeUndefined()
    })

    it('flags non-2xx as an error', async () => {
        const { fn } = fakeFetch(() => new Response('x', { status: 500 }))
        const r = await ADAPTERS.openai(baseCase, opts(fn))
        expect(r.status).toBe(500)
        expect(r.error).toBe('http 500')
    })
})
