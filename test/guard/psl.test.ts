import { describe, expect, it } from 'vitest'
import { isRegistrable, publicSuffixOf } from '../../src/guard/psl'

describe('publicSuffixOf', () => {
    it('matches the longest rule', () => expect(publicSuffixOf('a.b.co.uk')).toBe('co.uk'))
    it('lets an exception rule win', () => expect(publicSuffixOf('www.ck')).toBe('ck'))
    it('applies wildcard rules', () => expect(publicSuffixOf('x.foo.ck')).toBe('foo.ck'))
    it('returns null with no explicit rule', () => expect(publicSuffixOf('host.local')).toBeNull())
})

describe('isRegistrable', () => {
    it('is false for a public suffix', () => expect(isRegistrable('co.uk')).toBe(false))
    it('is true below a public suffix', () => {
        expect(isRegistrable('acme.co.uk')).toBe(true)
        expect(isRegistrable('xn--bcher-kva.de')).toBe(true)
    })
})
