import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { callWorker, makeEnv } from './helpers'
import { loadConfig } from '../src/config'
import { decideHosts, decideToolCall, isLoopback } from '../src/guard/decide'
import { INPUT_TOO_LARGE, TOO_MANY_TARGETS } from '../src/guard/hosts'

const ACME = {
    scope: { domains: ['*.acme-test.com'], cidrs: ['203.0.0.0/8'], llmTargets: [] },
    exclude: { domains: ['mail.acme-test.com'] },
    window: { start: '2026-11-10T00:00:00Z', end: '2026-11-21T23:59:59Z' },
    roe: '',
    defaultMode: 'redteam'
}
const ENGAGEMENTS = JSON.stringify({ acme: ACME })
const acme = loadConfig({ ENGAGEMENTS }).engagements.get('acme')!
const OPEN = Date.parse('2026-11-15T00:00:00Z')
const CLOSED = Date.parse('2026-12-15T00:00:00Z')
const TOO_LARGE_REASON = 'tool input too large to check (over 1 MB)'
const TOO_MANY_REASON = 'too many targets to check (more than 64)'

describe('isLoopback', () => {
    it.each(['127.0.0.1', '127.255.0.9', '::1', 'localhost', 'a.localhost', '127.0.0.0/8', '127.1.0.0/16'])('%s', (t) =>
        expect(isLoopback(t)).toBe(true)
    )
    it.each(['128.0.0.1', '10.0.0.1', '::2', 'localhost.evil.com', '127.0.0.0/7', '::1/64', 'notlocalhost'])(
        '%s is not loopback',
        (t) => expect(isLoopback(t)).toBe(false)
    )
})

describe('decideHosts', () => {
    it('allows no candidates even with the window closed', () => {
        expect(decideHosts(acme, [], CLOSED)).toEqual({ decision: 'allow', hosts: [], reasons: [] })
    })
    it('allows an in-scope host in the window', () => {
        expect(decideHosts(acme, ['app.acme-test.com'], OPEN)).toEqual({
            decision: 'allow',
            hosts: ['app.acme-test.com'],
            reasons: []
        })
    })
    it('allows loopback hosts, even with the window closed', () => {
        for (const now of [OPEN, CLOSED]) {
            const d = decideHosts(acme, ['http://127.0.0.1:8080', 'localhost', 'a.localhost', '[::1]'], now)
            expect(d.decision).toBe('allow')
            expect(d.reasons).toEqual([])
        }
    })
    it('denies an out-of-scope host', () => {
        expect(decideHosts(acme, ['192.168.1.5'], OPEN)).toEqual({
            decision: 'deny',
            hosts: ['192.168.1.5'],
            reasons: ['192.168.1.5 is out of scope for engagement acme']
        })
    })
    it('denies an excluded host', () => {
        expect(decideHosts(acme, ['mail.acme-test.com'], OPEN).reasons).toEqual([
            'mail.acme-test.com is excluded from engagement acme'
        ])
    })
    it('denies an invalid target and shows its raw text', () => {
        expect(decideHosts(acme, ['http://$TARGET'], OPEN)).toEqual({
            decision: 'deny',
            hosts: ['http://$TARGET'],
            reasons: ['http://$TARGET is not a checkable target; write the literal host']
        })
    })
    it('denies an in-scope host with the window closed', () => {
        expect(decideHosts(acme, ['app.acme-test.com'], CLOSED)).toEqual({
            decision: 'deny',
            hosts: ['app.acme-test.com'],
            reasons: ['engagement acme window is closed']
        })
    })
    it('orders reasons: too many, per-host, then window', () => {
        const d = decideHosts(acme, ['10.0.0.1', 'mail.acme-test.com', TOO_MANY_TARGETS], CLOSED)
        expect(d.reasons).toEqual([
            TOO_MANY_REASON,
            '10.0.0.1 is out of scope for engagement acme',
            'mail.acme-test.com is excluded from engagement acme',
            'engagement acme window is closed'
        ])
    })
    it('denies 65 distinct in-scope IPs, with the reason once', () => {
        const ips = Array.from({ length: 65 }, (_, i) => `203.0.113.${i + 1}`)
        const d = decideHosts(acme, ips, OPEN)
        expect(d.decision).toBe('deny')
        expect(d.reasons).toEqual([TOO_MANY_REASON])
        expect(decideHosts(acme, ips.slice(0, 64), OPEN).decision).toBe('allow')
    })
    it('does not repeat the too-many reason when the sentinel and 65 candidates coincide', () => {
        const ips = Array.from({ length: 65 }, (_, i) => `203.0.113.${i + 1}`)
        expect(decideHosts(acme, [...ips, TOO_MANY_TARGETS], OPEN).reasons).toEqual([TOO_MANY_REASON])
    })
    it('denies each sentinel alone and never lists it as a host', () => {
        expect(decideHosts(acme, [INPUT_TOO_LARGE], OPEN)).toEqual({
            decision: 'deny',
            hosts: [],
            reasons: [TOO_LARGE_REASON]
        })
        expect(decideHosts(acme, [TOO_MANY_TARGETS], OPEN)).toEqual({
            decision: 'deny',
            hosts: [],
            reasons: [TOO_MANY_REASON]
        })
    })
    it('denies both sentinels together with both reasons', () => {
        const d = decideHosts(acme, [INPUT_TOO_LARGE, TOO_MANY_TARGETS], OPEN)
        expect(d.decision).toBe('deny')
        expect(d.reasons).toEqual([TOO_LARGE_REASON, TOO_MANY_REASON])
    })
    it('denies a sentinel next to in-scope hosts', () => {
        const d = decideHosts(acme, ['app.acme-test.com', INPUT_TOO_LARGE], OPEN)
        expect(d.decision).toBe('deny')
        expect(d.hosts).toEqual(['app.acme-test.com'])
        expect(d.reasons).toEqual([TOO_LARGE_REASON])
    })
    it('checks a CIDR argument', () => {
        expect(decideHosts(acme, ['203.0.113.0/24'], OPEN).decision).toBe('allow')
        expect(decideHosts(acme, ['0.0.0.0/0'], OPEN).decision).toBe('deny')
    })
})

describe('decideToolCall', () => {
    it('extracts hosts from a Bash command', () => {
        const d = decideToolCall(acme, 'Bash', { command: 'nmap evil.example.org' }, OPEN)
        expect(d.hosts).toEqual(['evil.example.org'])
        expect(d.decision).toBe('deny')
    })
})

describe('POST /v1/guard/check', () => {
    let logSpy: MockInstance<typeof console.log>
    beforeEach(() => {
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(OPEN)
    })
    afterEach(() => {
        vi.useRealTimers()
        logSpy.mockRestore()
    })
    const env = makeEnv({ ENGAGEMENTS })
    const post = (body: unknown, headers: Record<string, string> = { 'x-api-key': 'test-key' }) =>
        callWorker(
            '/v1/guard/check',
            { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) },
            env
        )
    const good = { engagement: 'acme', tool: 'Bash', input: { command: 'nmap evil.example.org' } }

    it('requires the proxy key', async () => {
        expect((await post(good, {})).status).toBe(401)
        expect((await post(good, { 'x-api-key': 'wrong' })).status).toBe(401)
    })
    it.each([
        ['invalid JSON', '{nope'],
        ['a non-object body', '[]'],
        ['missing engagement', { tool: 'Bash', input: {} }],
        ['unknown engagement', { ...good, engagement: 'nope' }],
        ['non-string engagement', { ...good, engagement: 5 }],
        ['non-string tool', { ...good, tool: 5 }],
        ['missing tool', { engagement: 'acme', input: {} }],
        ['non-object input', { ...good, input: 'ls' }],
        ['array input', { ...good, input: [] }]
    ])('400 for %s', async (_n, body) => {
        expect((await post(body)).status).toBe(400)
    })
    it('413 for a body over MAX_BODY_BYTES', async () => {
        const small = makeEnv({ ENGAGEMENTS, MAX_BODY_BYTES: '50' })
        const res = await callWorker(
            '/v1/guard/check',
            { method: 'POST', headers: { 'x-api-key': 'test-key' }, body: JSON.stringify(good) },
            small
        )
        expect(res.status).toBe(413)
    })
    it('denies an out-of-scope host and logs one hook.decision line', async () => {
        const res = await post(good)
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({
            decision: 'deny',
            hosts: ['evil.example.org'],
            reasons: ['evil.example.org is out of scope for engagement acme']
        })
        const lines = logSpy.mock.calls.map((c) => JSON.parse(String(c[0])))
        const decision = lines.filter((l) => l.event === 'hook.decision')
        expect(decision).toHaveLength(1)
        expect(decision[0]).toMatchObject({
            engagement: 'acme',
            tool: 'Bash',
            decision: 'deny',
            hosts: ['evil.example.org'],
            reasons: 1
        })
        expect(lines.some((l) => l.event === 'request')).toBe(false)
    })
    it('allows an in-scope call', async () => {
        const res = await post({ ...good, input: { command: 'curl https://app.acme-test.com/x' } })
        expect(((await res.json()) as { decision: string }).decision).toBe('allow')
    })
    it('denies when the window is closed (200, not an error)', async () => {
        vi.setSystemTime(CLOSED)
        const res = await post({ ...good, input: { command: 'curl https://app.acme-test.com/x' } })
        expect(res.status).toBe(200)
        expect(((await res.json()) as { reasons: string[] }).reasons).toEqual(['engagement acme window is closed'])
    })
    it('returns 404 for GET', async () => {
        const res = await callWorker('/v1/guard/check', { headers: { 'x-api-key': 'test-key' } }, env)
        expect(res.status).toBe(404)
    })
})
