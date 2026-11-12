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

    const W = MIN.window
    const sc = (scope: unknown) => ({ x: { ...MIN, scope } })
    it.each([
        ['bad JSON', '{nope', /not valid JSON/],
        ['an array', '[]', /must be a JSON object/],
        ['a bad name', { 'a b': MIN }, /"a b"/],
        ['a missing scope', { x: { window: W } }, /"x" requires a scope/],
        ['an empty scope', sc({ domains: [] }), /"x" scope must contain/],
        ['a * domain', sc({ domains: ['*'] }), /^engagement "x" scope\.domains\[0\]: invalid domain$/],
        ['a *.com domain', sc({ domains: ['a.test', '*.com'] }), /^engagement "x" scope\.domains\[1\]: too broad/],
        ['a backslash domain', sc({ domains: ['a.test\\evil'] }), /"x" scope\.domains\[0\]: invalid domain/],
        ['a percent domain', sc({ domains: ['a%2etest'] }), /"x" scope\.domains\[0\]: invalid domain/],
        ['a control char domain', sc({ domains: ['a.test'] }), /"x" scope\.domains\[0\]: invalid domain/],
        [
            'a bad exclude domain',
            { x: { ...MIN, exclude: { domains: ['a b'] } } },
            /"x" exclude\.domains\[0\]: invalid domain/
        ],
        ['an unknown exclude key', { x: { ...MIN, exclude: { cidr: [] } } }, /"x" exclude has unknown key "cidr"/],
        ['a bad CIDR', sc({ cidrs: ['203.0.113.0/33'] }), /"x" scope\.cidrs\[0\]: invalid CIDR or IP$/],
        ['a bad IPv6 CIDR', sc({ cidrs: ['2001:db8::/129'] }), /"x" scope\.cidrs\[0\]: invalid CIDR or IP$/],
        ['a non-URL llmTarget', sc({ llmTargets: ['not a url'] }), /"x" scope\.llmTargets\[0\]: not a URL$/],
        ['a non-http llmTarget', sc({ llmTargets: ['ftp://a.test'] }), /"x" scope\.llmTargets\[0\]: must be http/],
        [
            'a javascript: llmTarget',
            sc({ llmTargets: ['javascript:alert(1)'] }),
            /"x" scope\.llmTargets\[0\]: must be http/
        ],
        ['null in a list', sc({ domains: [null] }), /"x" scope\.domains must be an array of strings/],
        ['a number in a list', sc({ cidrs: [5] }), /"x" scope\.cidrs must be an array of strings/],
        ['a nested array in a list', sc({ domains: [['a.test']] }), /"x" scope\.domains must be an array/],
        ['a missing window', { x: { scope: MIN.scope } }, /"x" requires a window/],
        ['an unparseable date', { x: { ...MIN, window: { start: 'soon', end: W.end } } }, /"x" window\.start/],
        ['a free-form date', { x: { ...MIN, window: { start: 'Nov 10 2026', end: W.end } } }, /"x" window\.start/],
        ['a numeric-string date', { x: { ...MIN, window: { start: '1', end: W.end } } }, /"x" window\.start/],
        [
            'a zoneless date',
            { x: { ...MIN, window: { start: '2026-01-01T00:00:00', end: W.end } } },
            /"x" window\.start/
        ],
        ['a date-only value', { x: { ...MIN, window: { start: '2026-01-01', end: W.end } } }, /"x" window\.start/],
        [
            'an impossible date 2026-02-30T00:00:00Z',
            { x: { ...MIN, window: { start: '2026-02-30T00:00:00Z', end: '2030-01-01T00:00:00Z' } } },
            /"x" window\.start/
        ],
        [
            'an impossible date 2026-02-29T00:00:00Z',
            { x: { ...MIN, window: { start: '2026-02-29T00:00:00Z', end: '2030-01-01T00:00:00Z' } } },
            /"x" window\.start/
        ],
        [
            'an impossible date 2026-04-31T00:00:00Z',
            { x: { ...MIN, window: { start: '2026-04-31T00:00:00Z', end: '2030-01-01T00:00:00Z' } } },
            /"x" window\.start/
        ],
        [
            'an impossible date 2026-11-10T24:00:00Z',
            { x: { ...MIN, window: { start: '2026-11-10T24:00:00Z', end: '2030-01-01T00:00:00Z' } } },
            /"x" window\.start/
        ],
        [
            'an impossible date 2026-11-10T00:60:00Z',
            { x: { ...MIN, window: { start: '2026-11-10T00:60:00Z', end: '2030-01-01T00:00:00Z' } } },
            /"x" window\.start/
        ],
        [
            'an impossible date 2026-11-10T00:00:60Z',
            { x: { ...MIN, window: { start: '2026-11-10T00:00:60Z', end: '2030-01-01T00:00:00Z' } } },
            /"x" window\.start/
        ],
        ['a numeric date', { x: { ...MIN, window: { start: 5, end: W.end } } }, /"x" window\.start/],
        ['start >= end', { x: { ...MIN, window: { start: W.end, end: W.start } } }, /"x" window\.start must be before/],
        ['an unknown defaultMode', { x: { ...MIN, defaultMode: 'blue' } }, /"x" defaultMode/],
        ['a non-string roe', { x: { ...MIN, roe: 1 } }, /"x" roe/],
        ['an unknown top-level key (scop)', { x: { ...MIN, scop: {} } }, /"x" has unknown key "scop"/],
        ['an unknown scope key', sc({ domains: ['a.test'], extra: [] }), /"x" scope has unknown key "extra"/],
        ['an unknown window key', { x: { ...MIN, window: { ...W, tz: 'UTC' } } }, /"x" window has unknown key "tz"/]
    ])('rejects %s', (_label, input, message) => {
        let err: unknown
        try {
            eng(input)
        } catch (e) {
            err = e
        }
        expect(err).toBeInstanceOf(ConfigError)
        expect((err as ConfigError).variable).toBe('ENGAGEMENTS')
        expect((err as ConfigError).message).toMatch(message)
    })

    it('keeps the offending domain, CIDR and URL out of the message', () => {
        for (const scope of [
            { domains: ['a.test', 'secret-host;x.test'] },
            { cidrs: ['10.0.0.0/8', 'secret-cidr/99'] },
            { llmTargets: ['https://a.test', 'secret-url'] }
        ]) {
            let message = ''
            try {
                eng(sc(scope))
            } catch (e) {
                message = (e as ConfigError).message
            }
            expect(message).toMatch(/^engagement "x" scope\.\w+\[1\]: /)
            expect(message).not.toContain('secret')
        }
    })

    it.each([[{ a: 1 }], [5], [null], [true], [[]]])('rejects a non-string ENGAGEMENTS value %j', (v) => {
        expect(() => loadConfig({ ENGAGEMENTS: v })).toThrow(ConfigError)
    })

    it.each(['2028-02-29T00:00:00Z', '2026-11-10T09:00:00+05:30'])('accepts valid instant %s', (t) => {
        const e = eng({ x: { ...MIN, window: { start: t, end: '2030-01-01T00:00:00Z' } } })
        expect(e.engagements.get('x')!.window.start).toBe(Date.parse(t))
    })

    it('accepts ISO date-times with a numeric offset', () => {
        const e = eng({
            x: { ...MIN, window: { start: '2026-11-10T00:00:00+05:00', end: '2026-11-11T00:00:00.500Z' } }
        })
        expect(e.engagements.get('x')!.window.start).toBe(Date.parse('2026-11-09T19:00:00Z'))
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
        expect(parseIp('1::')?.value).toBe(2n ** 112n)
        expect(parseIp('::ffff:203.0.113.5')?.value).toBe(0xffffn * 2n ** 32n + parseIp('203.0.113.5')!.value)
        expect(parseIp('2001:db8::1')?.value).toBe(0x20010db8n * 2n ** 96n + 1n)
        expect(parseCidr('2001:db8::/32')?.bits).toBe(32)
        expect(parseCidr('::1')?.bits).toBe(128)
        expect(parseCidr('2001:db8:1::/32')?.base).toBe(0x20010db8n * 2n ** 96n)
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
        '1.2.3.4/',
        '1.2.3.4/-1',
        '1.2.3.4/x',
        '1.2.3.4/024',
        '1:',
        '1:2:3:4:5:6:7:',
        ':1',
        '1:2:3:4:5:6:7:8:9',
        'g::1',
        '+1.2.3.4'
    ])('rejects %s', (s) => {
        expect(parseCidr(s)).toBeNull()
    })
})

describe('wildcard over a public suffix', () => {
    it.each(['*.co.uk', '*.com.au', '*.uk'])('rejects %s', (d) => {
        const run = () => eng({ x: { ...MIN, scope: { domains: [d] } } })
        expect(run).toThrow(ConfigError)
        try {
            run()
        } catch (e) {
            expect((e as ConfigError).variable).toBe('ENGAGEMENTS')
        }
    })
    it.each(['*.acme.co.uk', '*.acme-test.com'])('accepts %s', (d) => {
        expect(() => eng({ x: { ...MIN, scope: { domains: [d] } } })).not.toThrow()
    })
})
