import { describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config'
import { decideToolCall } from '../src/guard/decide'
import { hostsInToolInput } from '../src/guard/hosts'
import { createGuard } from '../src/guard/index'

// End-to-end pathological inputs must terminate without throwing. Time budgets live in test/guard-bench.bench.test.ts.
const MB = 1024 * 1024
const KB = 1024
const NOW = Date.parse('2026-06-01T00:00:00Z')
const rep = (unit: string, n: number) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n)

const env = {
    PROXY_KEY: 'test-key',
    ENGAGEMENTS: JSON.stringify({
        alpha: {
            scope: { domains: ['*.alpha-test.com'], cidrs: ['10.1.0.0/16'] },
            window: { start: '2026-01-01T00:00:00Z', end: '2027-01-01T00:00:00Z' },
            defaultMode: 'redteam'
        }
    }),
    GUARD_RULES: JSON.stringify({
        custom: [
            { id: 'custom.req', side: 'request', pattern: 'mimikatz', flags: 'i' },
            { id: 'custom.res', side: 'response', pattern: 'vssadmin\s{1,5}delete', flags: 'i' }
        ]
    })
}

describe('guard pathological inputs terminate', () => {
    const cfg = loadConfig(env)
    const e = cfg.engagements.get('alpha')!
    const quiet = () => vi.spyOn(console, 'log').mockImplementation(() => {})
    const units: Record<string, (n: number) => string> = {
        a: (n) => 'a'.repeat(n),
        spaces: (n) => ' '.repeat(n),
        'a.': (n) => rep('a.', n),
        ignore: (n) => rep('ignore previous ', n),
        pem: (n) => rep('-----BEGIN ', n),
        markup: (n) => '![x](http://a/?' + 'b'.repeat(n),
        password: (n) => rep('password=', n),
        zerowidth: (n) => '\u200B'.repeat(n)
    }
    for (const [name, make] of Object.entries(units)) {
        it(`1 MB tool_result of ${name}`, () => {
            const spy = quiet()
            const b = {
                messages: [
                    { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Read', input: {} }] },
                    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: make(MB) }] }
                ]
            }
            expect(() => createGuard(cfg, 'r', e, NOW).scanRequest(b)).not.toThrow()
            spy.mockRestore()
        })
        it(`100 KB Bash command of ${name}`, () => {
            const spy = quiet()
            const command = make(100 * KB)
            expect(() => createGuard(cfg, 'r', e, NOW).onToolUse('Bash', { command })).not.toThrow()
            spy.mockRestore()
        })
    }

    it('100 KB of dense two-label words and 64 KB host commands', () => {
        const command = rep('x.y ', 100 * KB)
        const known = [...e.scope.domains, ...e.exclude.domains]
        expect(() => hostsInToolInput('Bash', { command }, known)).not.toThrow()
        expect(() => decideToolCall(e, 'Bash', { command }, NOW)).not.toThrow()
        const hosts = rep('curl https://app.alpha-test.com/x 10.1.2.3 other.example.org ', 64 * KB)
        expect(() => decideToolCall(e, 'Bash', { command: hosts }, NOW)).not.toThrow()
    })

    it('100 KB of "iwr " through onToolUse(PowerShell) and a 1 MB Write input', () => {
        const spy = quiet()
        const command = rep('iwr ', 100 * KB)
        expect(() => createGuard(cfg, 'r', e, NOW).onToolUse('PowerShell', { command })).not.toThrow()
        const content = rep('export const add = (a: number, b: number) => a + b\n', MB)
        expect(() => createGuard(cfg, 'r', e, NOW).onToolUse('Write', { file_path: 'x', content })).not.toThrow()
        spy.mockRestore()
    })
})
