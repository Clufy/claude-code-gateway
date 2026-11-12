import { describe, expect, it } from 'vitest'
import { ConfigError, loadConfig } from '../src/config'
import { parseCidr, parseIp } from '../src/engagement'

const ACME = {
    scope: {
        domains: ['*.acme-test.com'],
        cidrs: ['203.0.113.0/24'],
        llmTargets: ['https://chat.acme-test.com/api']
    },
    exclude: { domains: ['mail.acme-test.com'] },
    window: { start: '2026-11-10T00:00:00Z', end: '2026-11-21T23:59:59Z' },
    roe: 'No DoS.',
    defaultMode: 'redteam'
}
const MIN = { scope: { domains: ['a.test'] }, window: { start: '2026-01-01T00:00:00Z', end: '2026-01-02T00:00:00Z' } }
const eng = (v: unknown) => loadConfig({ ENGAGEMENTS: typeof v === 'string' ? v : JSON.stringify(v) })

describe('ENGAGEMENTS parsing', () => {
    it('parses the spec example and fills defaults', () => {
        const e = eng({ 'acme-2026q4': ACME }).engagements.get('acme-2026q4')!
        expect(e.name).toBe('acme-2026q4')
        expect(e.window.start).toBe(Date.parse('2026-11-10T00:00:00Z'))
        expect(e.window.end).toBe(Date.parse('2026-11-21T23:59:59Z'))
        expect(e.defaultMode).toBe('redteam')
        expect(e.scope.cidrs).toEqual(['203.0.113.0/24'])
        expect(e.exclude).toEqual({ domains: ['mail.acme-test.com'], cidrs: [] })
    })

    it('defaults roe, defaultMode and exclude', () => {
        const e = eng({ x: MIN }).engagements.get('x')!
        expect(e.roe).toBe('')
        expect(e.defaultMode).toBe('off')
        expect(e.exclude).toEqual({ domains: [], cidrs: [] })
        expect(e.scope).toEqual({ domains: ['a.test'], cidrs: [], llmTargets: [] })
    })

    it('is empty when ENGAGEMENTS is unset or empty', () => {
        expect(loadConfig({}).engagements.size).toBe(0)
        expect(loadConfig({ ENGAGEMENTS: '' }).engagements.size).toBe(0)
    })

    it('accepts bare IPs and normalizes domain spelling', () => {
        const e = eng({
            x: { ...MIN, scope: { domains: ['Bücher.ACME-test.com.'], cidrs: ['203.0.113.5', '2001:db8::1'] } }
        }).engagements.get('x')!
        expect(e.scope.domains).toEqual(['xn--bcher-kva.acme-test.com'])
        expect(e.scope.cidrs).toEqual(['203.0.113.5', '2001:db8::1'])
    })

    it.each([
        ['bad JSON', '{nope'],
        ['an array', '[]'],
        ['a bad name', { 'a b': MIN }],
        ['a missing scope', { x: { window: MIN.window } }],
        ['an empty scope', { x: { ...MIN, scope: { domains: [] } } }],
        ['a * domain', { x: { ...MIN, scope: { domains: ['*'] } } }],
        ['a *.com domain', { x: { ...MIN, scope: { domains: ['*.com'] } } }],
        ['a bad exclude domain', { x: { ...MIN, exclude: { domains: ['a b'] } } }],
        ['a bad CIDR', { x: { ...MIN, scope: { cidrs: ['203.0.113.0/33'] } } }],
        ['a bad IPv6 CIDR', { x: { ...MIN, scope: { cidrs: ['2001:db8::/129'] } } }],
        ['a non-URL llmTarget', { x: { ...MIN, scope: { llmTargets: ['not a url'] } } }],
        ['a non-http llmTarget', { x: { ...MIN, scope: { llmTargets: ['ftp://a.test'] } } }],
        ['a missing window', { x: { scope: MIN.scope } }],
        ['an unparseable date', { x: { ...MIN, window: { start: 'soon', end: MIN.window.end } } }],
        ['start >= end', { x: { ...MIN, window: { start: MIN.window.end, end: MIN.window.start } } }],
        ['an unknown defaultMode', { x: { ...MIN, defaultMode: 'blue' } }],
        ['a non-string roe', { x: { ...MIN, roe: 1 } }],
        ['an unknown top-level key (scop)', { x: { ...MIN, scop: {} } }],
        ['an unknown scope key', { x: { ...MIN, scope: { domains: ['a.test'], extra: [] } } }],
        ['an unknown window key', { x: { ...MIN, window: { ...MIN.window, tz: 'UTC' } } }]
    ])('rejects %s', (_label, input) => {
        let err: unknown
        try {
            eng(input)
        } catch (e) {
            err = e
        }
        expect(err).toBeInstanceOf(ConfigError)
        expect((err as ConfigError).variable).toBe('ENGAGEMENTS')
    })

    it('treats prototype-ish names as ordinary keys', () => {
        const m = eng({ constructor: MIN }).engagements
        expect(m.get('constructor')?.name).toBe('constructor')
        expect(m.get('toString')).toBeUndefined()
        expect(m.get('__proto__')).toBeUndefined()
        expect(() => eng('{"__proto__": ' + JSON.stringify(MIN) + '}')).toThrow(ConfigError)
    })
})

describe('IP and CIDR helpers', () => {
    it('parses IPv4 and clears host bits', () => {
        expect(parseCidr('203.0.113.77/24')).toEqual({ family: 4, base: parseIp('203.0.113.0')!.value, bits: 24 })
        expect(parseCidr('203.0.113.5')).toEqual({ family: 4, base: parseIp('203.0.113.5')!.value, bits: 32 })
        expect(parseCidr('0.0.0.0/0')?.bits).toBe(0)
    })

    it('parses IPv6 forms', () => {
        expect(parseIp('::1')?.value).toBe(1n)
        expect(parseIp('::')?.value).toBe(0n)
        expect(parseIp('::ffff:203.0.113.5')?.value).toBe(0xffffn * 2n ** 32n + parseIp('203.0.113.5')!.value)
        expect(parseIp('2001:db8::1')?.value).toBe(0x20010db8n * 2n ** 96n + 1n)
        expect(parseCidr('2001:db8::/32')?.bits).toBe(32)
        expect(parseCidr('::1')?.bits).toBe(128)
    })

    it.each([
        '1.2.3',
        '1.2.3.256',
        '01.2.3.4',
        '0xCB.0.113.5',
        '1:2:3',
        '::1::2',
        ':::',
        '1.2.3.4/33',
        '::/129',
        'a/8',
        '1.2.3.4/'
    ])('rejects %s', (s) => {
        expect(parseCidr(s)).toBeNull()
    })
})
