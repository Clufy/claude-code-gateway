import { afterEach, describe, expect, it } from 'vitest'
import { matches, queryEvents, type LogFilter } from '../src/observability'
import { stubFetch } from './helpers'

const cfg = {
    accountId: '0123456789abcdef0123456789abcdef',
    apiToken: 't0k',
    service: 'claude-workers-ai-proxy'
}
const URL_ =
    'https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/workers/observability/telemetry/query'

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const ev = (timestamp: number, source: unknown) => ({
    $metadata: { id: String(timestamp) },
    dataset: 'cloudflare-workers',
    source,
    timestamp
})

let stub: ReturnType<typeof stubFetch> | undefined
afterEach(() => stub?.restore())

describe('queryEvents', () => {
    it('sends the documented request', async () => {
        stub = stubFetch(() => json({ result: { events: { events: [] } } }))
        const extra: LogFilter = { key: 'engagement', operation: 'eq', type: 'string', value: 'acme' }
        await queryEvents(cfg, 'detection', 1000, 2000, [extra], 50)
        const req = stub.calls[0]
        expect(req.url).toBe(URL_)
        expect(req.method).toBe('POST')
        expect(req.headers.get('authorization')).toBe('Bearer t0k')
        expect(req.headers.get('content-type')).toContain('application/json')
        const body = (await req.json()) as any
        expect(body).toMatchObject({
            queryId: 'proxy-mcp-logs',
            view: 'events',
            dry: true,
            limit: 50,
            timeframe: { from: 1000, to: 2000 },
            parameters: { filterCombination: 'and' }
        })
        expect(body.parameters.filters).toEqual([
            { key: '$metadata.service', operation: 'eq', type: 'string', value: cfg.service },
            { key: 'event', operation: 'eq', type: 'string', value: 'detection' },
            extra
        ])
    })

    it('parses object and JSON-string sources, drops bad ones, sorts newest first', async () => {
        stub = stubFetch(() =>
            json({
                result: {
                    events: {
                        events: [
                            ev(100, { event: 'detection', n: 1 }),
                            ev(300, JSON.stringify({ event: 'detection', n: 3 })),
                            ev(200, 'not json')
                        ]
                    }
                }
            })
        )
        const r = await queryEvents(cfg, 'detection', 0, 1, [], 50)
        expect(r).toEqual({
            ok: true,
            count: 2,
            rows: [
                { time: 300, source: { event: 'detection', n: 3 } },
                { time: 100, source: { event: 'detection', n: 1 } }
            ]
        })
    })

    it('re-checks the event and caller filters client-side', async () => {
        stub = stubFetch(() =>
            json({
                result: {
                    events: {
                        events: [
                            ev(1, { event: 'request', engagement: 'acme' }),
                            ev(2, { event: 'detection', engagement: 'other' }),
                            ev(3, { event: 'detection', engagement: 'acme' })
                        ]
                    }
                }
            })
        )
        const f: LogFilter = { key: 'engagement', operation: 'eq', type: 'string', value: 'acme' }
        const r = await queryEvents(cfg, 'detection', 0, 1, [f], 50)
        expect(r.ok && r.rows.map((x) => x.time)).toEqual([3])
    })

    it('uses result.events.count when numeric', async () => {
        stub = stubFetch(() => json({ result: { events: { count: 42, events: [ev(1, { event: 'request' })] } } }))
        const r = await queryEvents(cfg, 'request', 0, 1, [], 50)
        expect(r).toMatchObject({ ok: true, count: 42 })
    })

    const errorCases: Array<[string, () => Response, string]> = [
        [
            'http 500 with message',
            () => json({ errors: [{ message: 'bad query' }] }, 500),
            'logs query failed: HTTP 500: bad query'
        ],
        ['http 403 non-json', () => new Response('Forbidden t0k', { status: 403 }), 'logs query failed: HTTP 403'],
        ['empty 200', () => json({}), 'logs query returned an unexpected response'],
        [
            'timeout',
            () => {
                throw new DOMException('timed out t0k', 'TimeoutError')
            },
            'logs query timed out after 10 s'
        ],
        [
            'network error',
            () => {
                throw new TypeError('boom t0k')
            },
            'logs query failed: network error'
        ]
    ]
    for (const [name, handler, expected] of errorCases) {
        it(`error: ${name}`, async () => {
            stub = stubFetch(handler)
            const r = await queryEvents(cfg, 'request', 0, 1, [], 50)
            expect(r).toEqual({ ok: false, error: expected })
            expect(JSON.stringify(r)).not.toContain('t0k')
        })
    }

    it('truncates error messages to 200 chars', async () => {
        stub = stubFetch(() => json({ errors: [{ message: 'x'.repeat(500) }] }, 400))
        const r = await queryEvents(cfg, 'request', 0, 1, [], 50)
        expect(r).toEqual({ ok: false, error: `logs query failed: HTTP 400: ${'x'.repeat(200)}` })
    })
})

describe('matches', () => {
    const f = (operation: LogFilter['operation'], value: string | string[], key = 'k'): LogFilter => ({
        key,
        operation,
        type: 'string',
        value
    })
    it('eq', () => {
        expect(matches({ k: 'a' }, f('eq', 'a'))).toBe(true)
        expect(matches({ k: 5 }, f('eq', '5'))).toBe(true)
        expect(matches({ k: 'b' }, f('eq', 'a'))).toBe(false)
        expect(matches({}, f('eq', 'undefined'))).toBe(false)
    })
    it('starts_with', () => {
        expect(matches({ k: 'secret.aws' }, f('starts_with', 'secret.'))).toBe(true)
        expect(matches({ k: 'other' }, f('starts_with', 'secret.'))).toBe(false)
        expect(matches({ k: 5 }, f('starts_with', '5'))).toBe(false)
        expect(matches({}, f('starts_with', ''))).toBe(false)
    })
    it('in', () => {
        expect(matches({ k: 'high' }, f('in', ['medium', 'high']))).toBe(true)
        expect(matches({ k: 'low' }, f('in', ['medium', 'high']))).toBe(false)
        expect(matches({}, f('in', ['a']))).toBe(false)
    })
    it('skips $ keys', () => {
        expect(matches({}, f('eq', 'svc', '$metadata.service'))).toBe(true)
    })
})
