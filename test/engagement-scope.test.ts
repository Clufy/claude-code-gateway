import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config'
import { checkScope, inWindow, normalizeTarget, type Engagement } from '../src/engagement'

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
const make = (over: Record<string, unknown> = {}): Engagement =>
    loadConfig({ ENGAGEMENTS: JSON.stringify({ x: { ...ACME, ...over } }) }).engagements.get('x')!
const acme = make()
const NOW = Date.parse('2026-11-15T00:00:00Z')

describe('checkScope verdicts', () => {
    it.each([
        ['app.acme-test.com', 'in_scope'],
        ['APP.Acme-Test.com.', 'in_scope'],
        ['a.b.acme-test.com', 'in_scope'],
        ['acme-test.com', 'out_of_scope'],
        ['mail.acme-test.com', 'excluded'],
        ['https://user:pw@app.acme-test.com:8443/x', 'in_scope'],
        ['bücher.acme-test.com', 'in_scope'],
        ['xn--bcher-kva.acme-test.com', 'in_scope'],
        ['203.0.113.5', 'in_scope'],
        ['0xCB.0.113.5', 'in_scope'],
        ['3405803781', 'in_scope'],
        ['203.0.113.5.', 'in_scope'],
        ['[::ffff:203.0.113.5]', 'in_scope'],
        ['::ffff:203.0.113.5', 'in_scope'],
        ['::ffff:cb00:7105', 'in_scope'],
        ['http://[::ffff:cb00:7105]:80/', 'in_scope'],
        ['203.0.114.1', 'out_of_scope'],
        ['::ffff:203.0.114.1', 'out_of_scope'],
        ['2001:db8::1', 'out_of_scope'],
        ['evil-acme-test.com', 'out_of_scope'],
        ['https://chat.acme-test.com/api/v1/chat', 'in_scope'],
        ['https://chat.acme-test.com/apix', 'in_scope'],
        ['https://MAIL.acme-test.com./x', 'excluded'],
        ['ssh://root@app.acme-test.com', 'in_scope'],
        ['STRAẞE.acme-test.com', 'invalid_target'],
        ['ẞ.acme-test.com', 'invalid_target'],
        ['stra%C3%9Fe.acme-test.com', 'invalid_target'],
        ['https://stra%C3%9Fe.acme-test.com/', 'invalid_target'],
        ['%ZZ@stra%C3%9Fe.acme-test.com', 'invalid_target'],
        ['%FF@stra%C3%9Fe.acme-test.com', 'invalid_target'],
        ['https://u%ZZ:p@stra%C3%9Fe.acme-test.com/x', 'invalid_target'],
        ['ΑΣ-1.acme-test.com', 'in_scope'],
        ['file:///etc/passwd', 'invalid_target'],
        ['ssh:///app.acme-test.com', 'invalid_target'],
        ['ssh://a@app.acme-test.com@evil.com', 'out_of_scope'],
        ['ftp://203.0.114.1', 'out_of_scope'],
        ['app.acme-test.com..', 'invalid_target'],
        ['app.acme-test.com\\@evil.com', 'invalid_target'],
        ['app.acme-test.com\\@203.0.114.1:8080', 'invalid_target'],
        ['https://app.acme-test.com\\@evil.com/', 'invalid_target'],
        ['straße.acme-test.com', 'invalid_target'],
        ['aς.acme-test.com', 'invalid_target'],
        ['a‌b.acme-test.com', 'invalid_target'],
        ['a‍b.acme-test.com', 'invalid_target'],
        ['app.acme-test.com/a b', 'invalid_target'],
        ['', 'invalid_target'],
        ['http://', 'invalid_target'],
        ['$(curl${IFS}evil.com).acme-test.com', 'invalid_target'],
        ['`id`.acme-test.com', 'invalid_target'],
        ['evil.com;.acme-test.com', 'invalid_target'],
        ['evil.com&&.acme-test.com', 'invalid_target'],
        ['a{b,c}.acme-test.com', 'invalid_target'],
        ['*.acme-test.com', 'invalid_target'],
        ["a'b.acme-test.com", 'invalid_target'],
        ['a=b!.acme-test.com', 'invalid_target'],
        ['https://evil.com;.acme-test.com/x', 'invalid_target'],
        ['＄(id).acme-test.com', 'invalid_target'],
        ['-a.acme-test.com', 'invalid_target'],
        ['_dmarc.acme-test.com', 'in_scope'],
        ['a_b_.acme-test.com', 'in_scope'],
        ['ａｐｐ.acme-test.com', 'in_scope'],
        ['app。acme-test.com', 'in_scope']
    ])('%s -> %s', (input, verdict) => {
        expect(checkScope(acme, input, NOW).verdict).toBe(verdict)
    })

    it('reports the normalized target', () => {
        expect(checkScope(acme, 'bücher.acme-test.com', NOW).target).toBe('xn--bcher-kva.acme-test.com')
        expect(checkScope(acme, '0xCB.0.113.5', NOW).target).toBe('203.0.113.5')
        expect(checkScope(acme, '[::ffff:203.0.113.5]', NOW).target).toBe('203.0.113.5')
        expect(checkScope(acme, '', NOW).target).toBe('')
    })

    it('normalizeTarget returns null for junk', () => {
        for (const s of ['', 'http://', ' ', 'a..b.', 'http://[::1', '1.2.3.999']) expect(normalizeTarget(s)).toBeNull()
    })

    it('matches IPv6 CIDRs, not across families', () => {
        const e = make({ scope: { cidrs: ['2001:db8::/32'] } })
        expect(checkScope(e, '2001:DB8:0:0::1', NOW).verdict).toBe('in_scope')
        expect(checkScope(e, '[2001:db9::1]', NOW).verdict).toBe('out_of_scope')
        expect(checkScope(e, '203.0.113.5', NOW).verdict).toBe('out_of_scope')
    })

    it('an exclusion CIDR beats a scope domain and a scope CIDR', () => {
        const e = make({ exclude: { cidrs: ['203.0.113.0/28'] } })
        expect(checkScope(e, '203.0.113.3', NOW).verdict).toBe('excluded')
        expect(checkScope(e, '::ffff:203.0.113.3', NOW).verdict).toBe('excluded')
        expect(checkScope(e, '203.0.113.20', NOW).verdict).toBe('in_scope')
    })

    it('collapses mapped IPv6 CIDRs to IPv4 for scope and exclusion', () => {
        const ex = make({ exclude: { cidrs: ['::ffff:203.0.113.0/124'] } })
        expect(checkScope(ex, '203.0.113.3', NOW).verdict).toBe('excluded')
        expect(checkScope(ex, '::ffff:203.0.113.3', NOW).verdict).toBe('excluded')
        const sc = make({ scope: { cidrs: ['::ffff:198.51.100.0/120'] } })
        expect(checkScope(sc, '198.51.100.9', NOW).verdict).toBe('in_scope')
        expect(checkScope(sc, '198.51.101.9', NOW).verdict).toBe('out_of_scope')
    })

    it('keeps the last @ host and brackets bare IPv6 after a scheme', () => {
        expect(checkScope(acme, 'ssh://a@app.acme-test.com@evil.com', NOW).target).toBe('evil.com')
        const e = make({ scope: { cidrs: ['2001:db8::/32'] } })
        expect(checkScope(e, 'ssh://2001:db8::1', NOW).verdict).toBe('in_scope')
        expect(checkScope(e, 'ssh://[2001:db8::1]', NOW).verdict).toBe('in_scope')
    })

    it('rejects short IPv6 CIDRs overlapping the mapped range', () => {
        for (const c of ['::ffff:0:0/95', '::/0']) {
            expect(() => make({ scope: { cidrs: [c] } })).toThrow(/IPv4 CIDRs/)
            expect(() => make({ exclude: { cidrs: [c] } })).toThrow(/exclude.cidrs/)
        }
        expect(() => make({ scope: { cidrs: ['2001:db8::/32', '::ffff:0:0/96'] } })).not.toThrow()
    })

    it('pins the IPv6 target form', () => {
        expect(normalizeTarget('2001:DB8:0:0::1')).toBe('2001:db8::1')
    })

    it('accepts underscore and fullwidth config domains', () => {
        const e = make({ scope: { domains: ['_srv.acme-test.com', '*._tcp.acme-test.com', 'ａ.acme-test.com'] } })
        expect(e.scope.domains).toEqual(['_srv.acme-test.com', '*._tcp.acme-test.com', 'a.acme-test.com'])
        expect(checkScope(e, '_srv.acme-test.com', NOW).verdict).toBe('in_scope')
        expect(checkScope(e, 'x._tcp.acme-test.com', NOW).verdict).toBe('in_scope')
    })

    it('rejects non-hostname config domains', () => {
        for (const d of ['a;b.test', '*.a$b.test', 'a*.test', '-a.test']) {
            expect(() => make({ scope: { domains: [d] } })).toThrow(/scope\.domains/)
        }
    })

    it('rejects IDNA deviation characters in config domains', () => {
        for (const d of ['STRAẞE.test', '*.ẞ.test', 'straße.test', '*.aς.test', 'a‌b.test']) {
            expect(() => make({ scope: { domains: [d] } })).toThrow(/scope\.domains/)
        }
    })

    it('llmTargets respects the path boundary', () => {
        const e = make({ scope: { llmTargets: ['https://chat.x-test.com/api'] }, exclude: {} })
        expect(checkScope(e, 'https://chat.x-test.com/api/x', NOW).verdict).toBe('in_scope')
        expect(checkScope(e, 'https://chat.x-test.com/api', NOW).verdict).toBe('in_scope')
        expect(checkScope(e, 'https://chat.x-test.com:443/api/x?q=1', NOW).verdict).toBe('in_scope')
        expect(checkScope(e, 'https://chat.x-test.com/apix', NOW).verdict).toBe('out_of_scope')
        expect(checkScope(e, 'https://chat.x-test.com/api/../other', NOW).verdict).toBe('out_of_scope')
        expect(checkScope(e, 'http://chat.x-test.com/api/x', NOW).verdict).toBe('out_of_scope')
        expect(checkScope(e, 'https://chat.x-test.com:8443/api/x', NOW).verdict).toBe('out_of_scope')
        expect(checkScope(e, 'chat.x-test.com', NOW).verdict).toBe('out_of_scope')
        expect(checkScope(e, 'HTTPS://CHAT.X-TEST.COM./api/x', NOW).verdict).toBe('in_scope')
        expect(checkScope(e, 'ws://chat.x-test.com/api/x', NOW).verdict).toBe('out_of_scope')
    })
})

describe('window', () => {
    const { start, end } = acme.window
    it('is inclusive at both ends and false 1 ms outside', () => {
        expect(inWindow(acme, start)).toBe(true)
        expect(inWindow(acme, end)).toBe(true)
        expect(inWindow(acme, start - 1)).toBe(false)
        expect(inWindow(acme, end + 1)).toBe(false)
    })

    it('is reported independently of the verdict', () => {
        const late = checkScope(acme, 'app.acme-test.com', end + 1)
        expect(late).toEqual({ verdict: 'in_scope', target: 'app.acme-test.com', inWindow: false })
        expect(checkScope(acme, 'app.acme-test.com', NOW).inWindow).toBe(true)
    })

    afterEach(() => vi.useRealTimers())
    it('defaults now to Date.now()', () => {
        vi.useFakeTimers()
        vi.setSystemTime(end + 1)
        expect(checkScope(acme, 'app.acme-test.com').inWindow).toBe(false)
        vi.setSystemTime(start)
        expect(checkScope(acme, 'app.acme-test.com').inWindow).toBe(true)
    })
})
