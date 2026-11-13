import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { fetchEngagement } from './engagement.ts'
import { runRedteam, safeLabel, type RedteamIo, type RedteamOptions } from './run.ts'
import { parseTarget } from './targets.ts'

type Seen = { url: string; headers: IncomingMessage['headers']; body: any }

let worker: Server
let external: Server
let base = ''
let extUrl = ''
let extPort = 0
let workerSeen: Seen[] = []
let extSeen: Seen[] = []

const hour = 3600_000
const iso = (ms: number) => new Date(ms).toISOString()

function engagementFor(name: string) {
    const llmTargets =
        name === 'acme'
            ? ['127.0.0.1']
            : name === 'other'
              ? ['other.example.org']
              : name === 'acmeurl'
                ? [`http://127.0.0.1:${extPort}/v1`]
                : name === 'acmeex'
                  ? ['127.0.0.1']
                  : null
    if (!llmTargets) return null
    return {
        name,
        scope: { domains: [], cidrs: [], llmTargets },
        exclude: { domains: [], cidrs: name === 'acmeex' ? ['127.0.0.0/8'] : [] },
        window: { start: iso(Date.now() - hour), end: iso(Date.now() + hour) }
    }
}

function readBody(req: IncomingMessage): Promise<any> {
    return new Promise((resolve) => {
        let s = ''
        req.on('data', (c) => (s += c))
        req.on('end', () => {
            try {
                resolve(JSON.parse(s))
            } catch {
                resolve(null)
            }
        })
    })
}

const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
}
const reply = (res: ServerResponse, text: string) => json(res, 200, { content: [{ type: 'text', text }] })

beforeAll(async () => {
    worker = createServer(async (req, res) => {
        const body = await readBody(req)
        workerSeen.push({ url: req.url ?? '', headers: req.headers, body })
        if (req.url === '/mcp') {
            const e = engagementFor(body.params.arguments.name)
            const text = e ? JSON.stringify(e) : `unknown engagement: ${body.params.arguments.name}`
            return json(res, 200, { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }], isError: !e } })
        }
        if (req.url === '/v1/models') return json(res, 200, { data: [{ id: 'm-ok' }, { id: 'm-bad' }] })
        if (req.url === '/v1/messages') {
            if (body.model === 'm-bad') return json(res, 500, { error: 'boom' })
            if (body.model === 'm-redir') {
                res.writeHead(302, { location: extUrl })
                return res.end()
            }
            if (typeof body.system === 'string' && body.system.includes('attack_succeeded')) {
                return reply(res, '{"attack_succeeded": false, "reason": "fine"}')
            }
            return reply(res, 'I cannot help with that.')
        }
        json(res, 404, {})
    })
    external = createServer(async (req, res) => {
        extSeen.push({ url: req.url ?? '', headers: req.headers, body: await readBody(req) })
        if (req.url?.startsWith('/redir')) {
            res.writeHead(302, { location: `http://localhost:${(external.address() as AddressInfo).port}/hit` })
            return res.end()
        }
        reply(res, 'I cannot help with that.')
    })
    await Promise.all([worker, external].map((s) => new Promise<void>((r) => s.listen(0, '127.0.0.1', r))))
    base = `http://127.0.0.1:${(worker.address() as AddressInfo).port}`
    extPort = (external.address() as AddressInfo).port
    extUrl = `http://127.0.0.1:${extPort}/v1/messages`
})

afterAll(async () => {
    await Promise.all([worker, external].map((s) => new Promise((r) => s.close(r))))
})

beforeEach(() => {
    workerSeen = []
    extSeen = []
})

function makeIo(env: Record<string, string> = {}) {
    const files: Record<string, string> = {}
    const progress: string[] = []
    const io: RedteamIo = {
        write: (p, t) => void (files[p] = t),
        progress: (l) => void progress.push(l),
        now: () => Date.now(),
        env
    }
    return { io, files, progress }
}

const opts = (o: Partial<RedteamOptions>): RedteamOptions => ({
    target: 'self:m-ok',
    concurrency: 2,
    delayMs: 0,
    stopOnErrors: 5,
    base,
    key: 'k',
    out: 'out',
    ...o
})

describe('parseTarget', () => {
    it('parses self and external targets', () => {
        expect(parseTarget('self:@cf/x/y')).toEqual({ kind: 'self', model: '@cf/x/y' })
        expect(parseTarget('self:all')).toEqual({ kind: 'self', model: 'all' })
        expect(parseTarget('openai:https://h/v1/chat/completions')).toEqual({
            kind: 'external',
            adapter: 'openai',
            url: 'https://h/v1/chat/completions'
        })
    })
    it('rejects bad targets', () => {
        expect(() => parseTarget('ftp:x')).toThrow()
        expect(() => parseTarget('self:')).toThrow()
        expect(() => parseTarget('openai:notaurl')).toThrow()
    })
})

describe('fetchEngagement', () => {
    it('posts tools/call to /mcp and maps ISO windows to ms', async () => {
        const e = await fetchEngagement(base, 'k', 'acme', fetch)
        const req = workerSeen[0]
        expect(req.url).toBe('/mcp')
        expect(req.headers.authorization).toBe('Bearer k')
        expect(req.body.params).toEqual({ name: 'engagement', arguments: { action: 'get', name: 'acme' } })
        expect(e.scope.llmTargets).toEqual(['127.0.0.1'])
        expect(typeof e.window.start).toBe('number')
        expect(e.window.end).toBeGreaterThan(Date.now())
    })
    it('throws the error text for an isError result', async () => {
        await expect(fetchEngagement(base, 'k', 'x', fetch)).rejects.toThrow('unknown engagement: x')
    })
})

describe('runRedteam external', () => {
    it('refuses an out-of-scope target without sending anything', async () => {
        const { io } = makeIo()
        await expect(
            runRedteam(opts({ target: `anthropic:${extUrl}`, engagement: 'other', model: 'm' }), fetch, io)
        ).rejects.toThrow('not in engagement other scope')
        expect(extSeen).toHaveLength(0)
    })
    it('P6-R15: refuses an IP target inside the engagement exclude.cidrs without sending anything', async () => {
        const { io } = makeIo()
        await expect(
            runRedteam(opts({ target: `anthropic:${extUrl}`, engagement: 'acmeex', model: 'm' }), fetch, io)
        ).rejects.toThrow('target 127.0.0.1 is excluded from engagement acmeex')
        expect(extSeen).toHaveLength(0)
    })
    it('requires --engagement', async () => {
        const { io } = makeIo()
        await expect(runRedteam(opts({ target: `anthropic:${extUrl}` }), fetch, io)).rejects.toThrow(/--engagement/)
        expect(extSeen).toHaveLength(0)
    })
    it('runs in-scope cases and writes both files under the engagement dir', async () => {
        const { io, files, progress } = makeIo()
        const r = await runRedteam(
            opts({
                target: `anthropic:${extUrl}`,
                engagement: 'acme',
                model: 'm',
                suites: ['direct-injection'],
                maxCases: 3
            }),
            fetch,
            io
        )
        expect(extSeen).toHaveLength(3)
        expect(r.files).toHaveLength(2)
        expect(r.files.every((f) => f.startsWith('out/acme/'))).toBe(true)
        expect(Object.keys(files).sort()).toEqual([...r.files].sort())
        const card = JSON.parse(files[r.files.find((f) => f.endsWith('.json'))!]).cards[0]
        expect(card.meta.engagement).toBe('acme')
        expect(progress[0]).toMatch(/ starting \(3 cases\)$/)
        expect(progress).toHaveLength(4)
        for (const l of progress.slice(1)) expect(l).toMatch(/^\[\d+\/3\] [a-z0-9-]+ (attacked|passed|error|skipped)$/)
    })
    it('P6-R13: runs when the engagement llmTargets entry is a URL', async () => {
        const { io } = makeIo()
        await runRedteam(
            opts({
                target: `anthropic:${extUrl}`,
                engagement: 'acmeurl',
                model: 'm',
                suites: ['direct-injection'],
                maxCases: 2
            }),
            fetch,
            io
        )
        expect(extSeen).toHaveLength(2)
    })
    it('sends --header-env headers to the external target only', async () => {
        const { io } = makeIo({ RT_TOKEN: 'secret-1' })
        await runRedteam(
            opts({
                target: `anthropic:${extUrl}`,
                engagement: 'acme',
                model: 'm',
                suites: ['direct-injection'],
                maxCases: 1,
                headerEnv: 'X-Api-Token=RT_TOKEN'
            }),
            fetch,
            io
        )
        expect(extSeen[0].headers['x-api-token']).toBe('secret-1')
        for (const s of workerSeen) expect(s.headers['x-api-token']).toBeUndefined()
    })
})

describe('runRedteam self', () => {
    it('self:all reads /v1/models, stops the failing model, completes the other', async () => {
        const { io, files } = makeIo()
        const r = await runRedteam(
            opts({ target: 'self:all', suites: ['direct-injection'], maxCases: 6, concurrency: 1, stopOnErrors: 2 }),
            fetch,
            io
        )
        const json = JSON.parse(files[r.files.find((f) => f.endsWith('.json'))!])
        expect(r.files[0].startsWith('out/self/')).toBe(true)
        expect(json.cards.map((c: any) => c.meta.model)).toEqual(['m-ok', 'm-bad'])
        expect(json.cards[0].stopped).toBeUndefined()
        expect(json.cards[1].stopped).toBe('too many errors')
        expect(json.cards[0].meta.isSelf).toBe(true)
        const md = files[r.files.find((f) => f.endsWith('.md'))!]
        expect(md).toContain('| Suite | m-ok | m-bad |')
        expect(md).toMatch(/\+\d+ err/)
        expect(workerSeen.some((s) => s.url === '/mcp')).toBe(false)
    })
    it('judge cases are skipped without --judge-model', async () => {
        const { io, progress } = makeIo()
        await runRedteam(opts({ suites: ['system-prompt-leakage'] }), fetch, io)
        expect(progress.filter((l) => /^\[\d+\/10\] sp-0[79] skipped$/.test(l))).toHaveLength(2)
        expect(workerSeen.filter((s) => s.body?.model === 'judge-m')).toHaveLength(0)
    })
    it('--judge-model sends judge calls to /v1/messages', async () => {
        const { io, progress } = makeIo()
        await runRedteam(opts({ suites: ['system-prompt-leakage'], judgeModel: 'judge-m' }), fetch, io)
        expect(workerSeen.filter((s) => s.body?.model === 'judge-m').length).toBe(2)
        expect(progress.some((l) => /sp-07 skipped/.test(l))).toBe(false)
    })
    it('refuses a self redirect to another origin', async () => {
        const { io, progress } = makeIo()
        await runRedteam(opts({ target: 'self:m-redir', suites: ['direct-injection'], maxCases: 2 }), fetch, io)
        expect(progress.filter((l) => /^\[\d\/2\] [a-z0-9-]+ error$/.test(l))).toHaveLength(2)
        expect(extSeen).toHaveLength(0)
    })
})

describe('runRedteam CLI gate and secrets', () => {
    const key = 'proxykey-xyz-123'
    it('blocks an in-scope target redirecting to an out-of-scope host', async () => {
        const { io, progress } = makeIo()
        const url = extUrl.replace('/v1/messages', '/redir')
        await runRedteam(
            opts({
                target: `anthropic:${url}`,
                engagement: 'acme',
                model: 'm',
                suites: ['direct-injection'],
                maxCases: 2
            }),
            fetch,
            io
        )
        expect(extSeen.map((s) => s.url)).toEqual(['/redir', '/redir'])
        expect(progress.filter((l) => / error$/.test(l))).toHaveLength(2)
    })
    it('stops when the window closes mid-run', async () => {
        const { io, files, progress } = makeIo()
        io.now = () => (extSeen.length >= 2 ? Date.now() + 2 * hour : Date.now())
        const r = await runRedteam(
            opts({
                target: `anthropic:${extUrl}`,
                engagement: 'acme',
                model: 'm',
                suites: ['direct-injection'],
                maxCases: 5,
                concurrency: 1
            }),
            fetch,
            io
        )
        expect(extSeen).toHaveLength(2)
        const card = JSON.parse(files[r.files.find((f) => f.endsWith('.json'))!]).cards[0]
        expect(card.stopped).toContain('window is closed')
        expect(progress.filter((l) => / skipped$/.test(l))).toHaveLength(3)
    })
    it('never sends the header-env value to /mcp, /v1/models or the judge, nor writes secrets', async () => {
        const env = { RT_TOKEN: 'hdr-secret-789' }
        const a = makeIo(env)
        await runRedteam(
            opts({
                target: 'self:all',
                key,
                suites: ['system-prompt-leakage'],
                headerEnv: 'X-Api-Token=RT_TOKEN',
                judgeModel: 'judge-m'
            }),
            fetch,
            a.io
        )
        const b = makeIo(env)
        await runRedteam(
            opts({
                target: `anthropic:${extUrl}`,
                key,
                engagement: 'acme',
                model: 'm',
                suites: ['system-prompt-leakage'],
                maxCases: 10,
                headerEnv: 'X-Api-Token=RT_TOKEN',
                judgeModel: 'judge-m'
            }),
            fetch,
            b.io
        )
        expect(workerSeen.some((s) => s.url === '/mcp')).toBe(true)
        expect(workerSeen.some((s) => s.url === '/v1/models')).toBe(true)
        expect(workerSeen.some((s) => s.body?.model === 'judge-m')).toBe(true)
        for (const s of workerSeen) expect(s.headers['x-api-token']).toBeUndefined()
        expect(extSeen.length).toBeGreaterThan(0)
        for (const s of extSeen) expect(s.headers['x-api-token']).toBe('hdr-secret-789')
        for (const x of [a, b]) {
            const out = JSON.stringify(x.files) + x.progress.join(' ')
            expect(out).not.toContain(key)
            expect(out).not.toContain('hdr-secret-789')
        }
    })
    it('strips userinfo and query from the label and omits unlimited maxCases', async () => {
        expect(safeLabel('openai:https://u:pw@h.example/v1/x?token=abc#f')).toBe('openai:https://h.example/v1/x')
        const { io, files } = makeIo()
        const r = await runRedteam(
            opts({
                target: `anthropic:${extUrl}?token=abc`,
                engagement: 'acme',
                model: 'm',
                suites: ['direct-injection'],
                maxCases: 1
            }),
            fetch,
            io
        )
        const text = files[r.files.find((f) => f.endsWith('.json'))!]
        expect(text).not.toContain('token=abc')
        const self = makeIo()
        const r2 = await runRedteam(opts({ suites: ['direct-injection'] }), fetch, self.io)
        const card = JSON.parse(self.files[r2.files.find((f) => f.endsWith('.json'))!]).cards[0]
        expect('maxCases' in card.meta.controls).toBe(false)
    })
})
