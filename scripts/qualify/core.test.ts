import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { collectResponse } from './collect.ts'
import { isValidToolCall, validateToolInput } from './validate.ts'
import { loadFixture, redactFixture } from './fixture.ts'

type Ev = [string, unknown]

const sse = (events: Ev[], tail = '', eol = '\n') =>
    events.map(([e, d]) => `event: ${e}${eol}data: ${JSON.stringify(d)}${eol}${eol}`).join('') + tail

const delta = (index: number, d: unknown): Ev => [
    'content_block_delta',
    { type: 'content_block_delta', index, delta: d }
]

const toolStream = (fragments: string[], tail = '', eol = '\n') =>
    sse(
        [
            ['message_start', { type: 'message_start', message: { usage: { input_tokens: 5 } } }],
            ['ping', { type: 'ping' }],
            [
                'content_block_start',
                {
                    type: 'content_block_start',
                    index: 0,
                    content_block: { type: 'tool_use', id: 't1', name: 'Read', input: {} }
                }
            ],
            ...fragments.map((f) => delta(0, { type: 'input_json_delta', partial_json: f })),
            ['content_block_stop', { type: 'content_block_stop', index: 0 }],
            [
                'message_delta',
                { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } }
            ],
            ['message_stop', { type: 'message_stop' }]
        ],
        tail,
        eol
    )

const sseRes = (body: string, status = 200) =>
    new Response(body, { status, headers: { 'content-type': 'text/event-stream' } })

const tools = [
    {
        name: 'Read',
        input_schema: {
            type: 'object',
            properties: { file_path: { type: 'string' }, limit: { type: 'integer' } },
            required: ['file_path']
        }
    }
]

describe('collectResponse', () => {
    it('collects streamed tool call', async () => {
        const c = await collectResponse(sseRes(toolStream(['{"file_pa', 'th":"/a"}'])), Date.now())
        expect(c.blocks[0]).toEqual({ type: 'tool_use', name: 'Read', input: { file_path: '/a' } })
        expect(c.stopReason).toBe('tool_use')
        expect(c.usage).toEqual({ input_tokens: 5, output_tokens: 9 })
        expect(c.error).toBeNull()
    })

    it('handles CRLF line endings', async () => {
        const c = await collectResponse(sseRes(toolStream(['{"file_pa', 'th":"/a"}'], '', '\r\n')), Date.now())
        expect(c.blocks[0]).toEqual({ type: 'tool_use', name: 'Read', input: { file_path: '/a' } })
    })

    it('marks broken tool json', async () => {
        const c = await collectResponse(sseRes(toolStream(['{"file_path": "/a"'])), Date.now())
        expect(c.blocks[0].inputError).toBeTruthy()
        expect(isValidToolCall(c.blocks[0], tools)).toBe(false)
    })

    it('reads proxy stats comment', async () => {
        const stats = {
            backend: 'workers-ai',
            model: 'm',
            fallbackUsed: false,
            ttfbMs: 12,
            toolCallsFromText: 2,
            unparsedToolText: false
        }
        const c = await collectResponse(sseRes(toolStream(['{}'], `: proxy-stats ${JSON.stringify(stats)}\n\n`)), 0)
        expect(c.proxyStats?.toolCallsFromText).toBe(2)
    })

    it('reads proxy stats header on json responses', async () => {
        const stats = {
            backend: 'b',
            model: 'm',
            fallbackUsed: true,
            ttfbMs: 1,
            toolCallsFromText: 0,
            unparsedToolText: false
        }
        const res = new Response(
            JSON.stringify({
                content: [{ type: 'text', text: 'hi' }],
                stop_reason: 'end_turn',
                usage: { input_tokens: 1, output_tokens: 2 }
            }),
            { headers: { 'content-type': 'application/json', 'x-proxy-stats': JSON.stringify(stats) } }
        )
        const c = await collectResponse(res, Date.now())
        expect(c.proxyStats?.fallbackUsed).toBe(true)
        expect(c.blocks).toEqual([{ type: 'text', text: 'hi' }])
        expect(c.stopReason).toBe('end_turn')
    })

    it('http 500 is an error not a throw', async () => {
        const res = new Response(JSON.stringify({ error: { message: 'boom' } }), {
            status: 500,
            headers: { 'content-type': 'application/json' }
        })
        const c = await collectResponse(res, Date.now())
        expect(c.error).toMatch(/500/)
        expect(c.status).toBe(500)
    })

    it('reports an SSE error event', async () => {
        const body = sse([['error', { type: 'error', error: { type: 'api_error', message: 'upstream died' } }]])
        const c = await collectResponse(sseRes(body), Date.now())
        expect(c.error).toMatch(/upstream died/)
    })

    it('reports an unparseable body without throwing', async () => {
        const res = new Response('<html>', { headers: { 'content-type': 'application/json' } })
        const c = await collectResponse(res, Date.now())
        expect(c.error).toBeTruthy()
    })

    it('collects text and thinking blocks', async () => {
        const body = sse([
            [
                'content_block_start',
                { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }
            ],
            delta(0, { type: 'thinking_delta', thinking: 'hm' }),
            [
                'content_block_start',
                { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }
            ],
            delta(1, { type: 'text_delta', text: 'hel' }),
            delta(1, { type: 'text_delta', text: 'lo' })
        ])
        const c = await collectResponse(sseRes(body), Date.now())
        expect(c.blocks).toEqual([
            { type: 'thinking', text: 'hm' },
            { type: 'text', text: 'hello' }
        ])
    })
})

describe('collectResponse edge cases', () => {
    it('keeps the status for an HTML error page', async () => {
        const res = new Response('<html>Bad gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } })
        const c = await collectResponse(res, Date.now())
        expect(c.error).toMatch(/^HTTP 502:/)
    })

    it('keeps the status when a JSON content-type body is not JSON', async () => {
        const res = new Response('<html>', { status: 502, headers: { 'content-type': 'application/json' } })
        const c = await collectResponse(res, Date.now())
        expect(c.error).toMatch(/^HTTP 502:/)
    })

    it('ignores a missing partial_json fragment', async () => {
        const c = await collectResponse(
            sseRes(toolStream(['{"file_path":', undefined as unknown as string, '"/a"}'])),
            Date.now()
        )
        expect(c.blocks[0].inputError).toBeUndefined()
        expect(c.blocks[0].input).toEqual({ file_path: '/a' })
    })
})

describe('validateToolInput', () => {
    const schema = tools[0].input_schema
    it('reports missing required', () => {
        expect(validateToolInput(schema, {}).join()).toMatch(/missing required.*file_path/i)
    })
    it('reports wrong type', () => {
        expect(validateToolInput(schema, { file_path: '/a', limit: '10' }).join()).toMatch(/limit.*integer/)
    })
    it('accepts valid input', () => {
        expect(validateToolInput(schema, { file_path: '/a', limit: 10 })).toEqual([])
    })
    it('checks enum membership', () => {
        const s = { type: 'object', properties: { m: { enum: ['a', 'b'] } } }
        expect(validateToolInput(s, { m: 'c' }).join()).toMatch(/enum/)
        expect(validateToolInput(s, { m: 'a' })).toEqual([])
    })
    it('isValidToolCall rejects unknown tools and accepts good calls', () => {
        expect(isValidToolCall({ type: 'tool_use', name: 'Nope', input: {} }, tools)).toBe(false)
        expect(isValidToolCall({ type: 'tool_use', name: 'Read', input: { file_path: '/a' } }, tools)).toBe(true)
    })
})

describe('redactFixture', () => {
    const opts = { home: 'C:\\Users\\jdoe', user: 'jdoe' }
    const run = (text: string) =>
        redactFixture({ system: [{ type: 'text', text }], tools: [], messages: [{ role: 'user', content: 'x' }] }, opts)

    it('redacts home, user and secrets, drops messages', () => {
        const out = run('cwd C:\\Users\\jdoe\\proj by jdoe key sk-abcdefghijklmnop')
        const s = JSON.stringify(out)
        expect(s).not.toContain('jdoe')
        expect(s).not.toContain('sk-abcdefghijklmnop')
        expect(s).toContain('/home/user')
        expect(s).toContain('[redacted]')
        expect('messages' in out).toBe(false)
    })

    it('redacts the forward-slash form of the home dir', () => {
        const s = JSON.stringify(run('cwd C:/Users/jdoe/proj'))
        expect(s).not.toContain('jdoe')
        expect(s).toContain('/home/user')
    })

    it('redacts inside tool descriptions and nested schemas', () => {
        const out = redactFixture(
            {
                system: 's',
                tools: [
                    {
                        name: 'T',
                        description: 'in C:\\Users\\jdoe',
                        input_schema: { properties: { a: { description: 'ghp_' + 'a'.repeat(20) } } }
                    }
                ]
            },
            opts
        )
        const s = JSON.stringify(out)
        expect(s).not.toContain('jdoe')
        expect(s).not.toContain('ghp_')
    })
})

describe('loadFixture', () => {
    const tmp = (obj: unknown) => {
        mkdirSync(join(process.cwd(), '.tmp-check'), { recursive: true })
        const p = join(mkdtempSync(join(process.cwd(), '.tmp-check', 'fx-')), 'f.json')
        writeFileSync(p, JSON.stringify(obj))
        return p
    }
    it('resolves an explicit relative path against the current directory', () => {
        const p = tmp({ system: 's', tools: [] })
        const rel = relative(process.cwd(), p)
        expect(loadFixture(rel).tools).toEqual([])
    })
    it('rejects a fixture without a tools array, naming the file', () => {
        const p = tmp({ system: 's' })
        expect(() => loadFixture(p)).toThrow(/f.json/)
    })
    it('falls back to synthetic', () => {
        const f = loadFixture()
        expect(f.tools.length).toBeGreaterThanOrEqual(14)
    })
    it('synthetic fixture has the required tools and a short system prompt', () => {
        const f = loadFixture('test/fixtures/claude-code-request.synthetic.json')
        const names = f.tools.map((t) => t.name)
        for (const n of ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'WebFetch', 'TodoWrite', 'Task'])
            expect(names).toContain(n)
        expect(JSON.stringify(f.system).length).toBeLessThanOrEqual(2000)
    })
})
