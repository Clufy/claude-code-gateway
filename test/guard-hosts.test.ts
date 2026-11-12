import { describe, expect, it } from 'vitest'
import { extractHosts, hostsInToolInput, INPUT_TOO_LARGE } from '../src/guard/hosts'
import fixture from './fixtures/pentest-commands.json'

interface Row {
    cmd: string
    hosts: string[]
    knownDomains?: string[]
}

describe('extractHosts (shell)', () => {
    it.each(fixture as Row[])('$cmd', ({ cmd, hosts, knownDomains }) => {
        expect(extractHosts(cmd, { shell: true, knownDomains })).toEqual(hosts)
    })
})

describe('D4 message skip only for git, gh, glab and hub (P4-R5)', () => {
    it.each([
        ['curl --title http://evil.example.org', ['http://evil.example.org']],
        ['curl -m 5 evil.example.org', ['evil.example.org']],
        ['git commit -m "fix acme.com parser" && curl evil.example.org', ['evil.example.org']],
        ['sudo git commit --message "x acme.com"', []],
        ['GIT_EDITOR=true env /usr/bin/git.exe commit -m x.acme.com', []],
        ['command gh pr create --title a.acme.com --body=b.acme.com', []],
        ['glab mr create -m a.acme.com; hub pull-request -m b.acme.com', []],
        ['echo git -m evil.example.org', ['evil.example.org']],
        ['git commit -m x | curl --body evil.example.org', ['evil.example.org']]
    ])('%s', (cmd, hosts) => {
        expect(extractHosts(cmd, { shell: true })).toEqual(hosts)
    })
})

describe('extractHosts (non-shell)', () => {
    it('finds URLs and IP literals only', () => {
        expect(extractHosts('see https://a.example.com and 203.0.113.1 and acme.co.uk', { shell: false })).toEqual([
            'https://a.example.com',
            '203.0.113.1'
        ])
    })

    it('skips an empty authority and file URLs', () => {
        expect(extractHosts('use the http:// scheme, not file:///etc/hosts', { shell: false })).toEqual([])
    })

    // termination and no-throw only: workerd freezes Date.now() during CPU work, so timing lives in Task 8's bench
    it('terminates without throwing on hostile input', () => {
        const hostile = [
            'a.'.repeat(200_000),
            ':'.repeat(200_000),
            'x://'.repeat(50_000),
            '@'.repeat(200_000),
            '/'.repeat(200_000),
            '\\'.repeat(200_000),
            '$'.repeat(200_000),
            'evil.example.org '.repeat(20_000),
            'a.b:'.repeat(50_000),
            '1:'.repeat(100_000),
            'a:'.repeat(100_000),
            '"'.repeat(200_000),
            'node -e '.repeat(50_000)
        ]
        for (const s of hostile) {
            expect(() => extractHosts(s, { shell: true })).not.toThrow()
            expect(() => extractHosts(s, { shell: false })).not.toThrow()
        }
    })

    it('memoizes repeated tokens (P4-R7)', () => {
        expect(extractHosts('evil.example.org '.repeat(6_000), { shell: true })).toEqual(['evil.example.org'])
        expect(extractHosts('a.b:'.repeat(25_000), { shell: true })).toEqual([])
    })

    it('stops after 65 unique candidates, so D8 still denies (P4-R7)', () => {
        const many = Array.from({ length: 100 }, (_, i) => `h${i}.example.org`)
        const hosts = extractHosts(`nmap ${many.join(' ')}`, { shell: true })
        expect(hosts).toEqual(many.slice(0, 65))
        expect(hostsInToolInput('Bash', { command: `nmap ${many.join(' ')}` })).toHaveLength(65)
        expect(hostsInToolInput('mcp__x__scan', { hosts: many })).toEqual(many.slice(0, 65))
    })
})

describe('hostsInToolInput', () => {
    it('never scans file contents', () => {
        expect(hostsInToolInput('Write', { file_path: 'x', content: 'https://evil.example.com' })).toEqual([])
        expect(
            hostsInToolInput('Edit', { file_path: 'x', old_string: 'http://a.example.com', new_string: '1.2.3.4' })
        ).toEqual([])
        expect(
            hostsInToolInput('MultiEdit', {
                file_path: 'x',
                edits: [{ old_string: 'a', new_string: 'https://b.example.com' }]
            })
        ).toEqual([])
        expect(hostsInToolInput('NotebookEdit', { notebook_path: 'x', new_source: 'https://c.example.com' })).toEqual(
            []
        )
    })

    it('scans other fields for URLs and IPs, bare hosts only in host-like fields', () => {
        expect(
            hostsInToolInput('WebFetch', { url: 'https://docs.example.com/p', prompt: 'summarize evil.example.org' })
        ).toEqual(['https://docs.example.com'])
        expect(hostsInToolInput('mcp__x__scan', { target: 'evil.example.org' })).toEqual(['evil.example.org'])
        expect(
            hostsInToolInput('mcp__x__scan', {
                opts: { Hosts: ['a.example.org', 'b.example.org'], note: 'c.example.org at 203.0.113.2' }
            })
        ).toEqual(['a.example.org', 'b.example.org', '203.0.113.2'])
    })

    it('applies full shell extraction to Bash and PowerShell commands only', () => {
        expect(
            hostsInToolInput('Bash', { command: 'nmap dc01.acme.local', description: 'scan https://x.example.com' }, [
                'acme.local'
            ])
        ).toEqual(['dc01.acme.local'])
        expect(hostsInToolInput('PowerShell', { command: 'iwr evil.example.co.uk' })).toEqual(['evil.example.co.uk'])
        expect(hostsInToolInput('Bash', { command: 42 })).toEqual([])
    })

    it('dedupes across fields in first-seen order', () => {
        expect(
            hostsInToolInput('mcp__x__scan', {
                host: 'a.example.org',
                url: 'https://b.example.org/x',
                more: ['https://b.example.org', '203.0.113.3', { host: 'a.example.org' }]
            })
        ).toEqual(['a.example.org', 'https://b.example.org', '203.0.113.3'])
    })

    it('returns [] for a non-object input', () => {
        expect(hostsInToolInput('Bash', 'curl https://evil.example.com')).toEqual([])
        expect(hostsInToolInput('WebFetch', null)).toEqual([])
        expect(hostsInToolInput('WebFetch', ['https://evil.example.com'])).toEqual([])
    })

    it('stops scanning after a 1 MB total string budget and fails closed (P4-R6)', () => {
        const filler = 'x'.repeat(600_000)
        const hosts = hostsInToolInput('mcp__x__scan', {
            a: `${filler} https://a.example.org`,
            b: `${filler} https://b.example.org`,
            c: 'https://c.example.org'
        })
        expect(hosts).toEqual(['https://a.example.org', INPUT_TOO_LARGE])
    })

    it('marks a Bash command over 1 MB, never one within budget (P4-R6)', () => {
        expect(hostsInToolInput('Bash', { command: `curl https://a.example.org ${'x'.repeat(1_000_000)}` })).toEqual([
            'https://a.example.org',
            INPUT_TOO_LARGE
        ])
        const exact = `curl https://a.example.org ${'x'.repeat(1_000_000 - 27)}`
        expect(exact.length).toBe(1_000_000)
        expect(hostsInToolInput('Bash', { command: exact })).toEqual(['https://a.example.org'])
        expect(hostsInToolInput('mcp__x__scan', { a: exact, b: '', c: 7 })).toEqual(['https://a.example.org'])
    })

    it('survives deeply nested input', () => {
        let deep: unknown = { url: 'https://deep.example.org' }
        for (let i = 0; i < 100_000; i++) deep = { x: deep }
        expect(hostsInToolInput('mcp__x__scan', deep)).toEqual(['https://deep.example.org'])
    })
})
