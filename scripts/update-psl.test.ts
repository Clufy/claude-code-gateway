import { describe, expect, it } from 'vitest'
import { icannRules } from './update-psl.ts'

const FIXTURE = `// comment before the sections
// ===BEGIN ICANN DOMAINS===

// a comment
com
*.ck
!www.ck
公司.cn
// ===END ICANN DOMAINS===
// ===BEGIN PRIVATE DOMAINS===
blogspot.com
// ===END PRIVATE DOMAINS===
`

describe('icannRules', () => {
    const rules = icannRules(FIXTURE)
    it('keeps only the ICANN section', () => {
        expect(rules).toContain('com')
        expect(rules).not.toContain('blogspot.com')
    })
    it('punycodes labels and keeps wildcard and exception markers', () => {
        expect(rules).toContain('xn--55qx5d.cn')
        expect(rules).toContain('*.ck')
        expect(rules).toContain('!www.ck')
    })
    it('drops comments and blank lines and sorts', () => {
        expect(rules.some((r) => r === '' || r.startsWith('//'))).toBe(false)
        expect(rules).toEqual([...rules].sort())
    })
})
