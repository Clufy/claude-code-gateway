import { describe, expect, it } from 'vitest'
import { MAX_RULE_BYTES } from '../src/purple/sigma'
import { DRAFT_SYSTEM, MAX_FINDING_CHARS, draftRule, extractYaml, type DraftLogsource } from '../src/purple/draft'

const VALID = [
    'title: Test rule',
    'logsource:',
    '  product: claude-proxy',
    '  category: prompt',
    'detection:',
    '  sel:',
    '    text|contains: ignore previous',
    '  condition: sel'
].join('\n')

async function userFor(finding: string, kind: DraftLogsource = 'prompt'): Promise<{ system: string; user: string }> {
    let seen = { system: '', user: '' }
    await draftRule(finding, kind, async (system, user) => {
        seen = { system, user }
        return ''
    })
    return seen
}

describe('extractYaml', () => {
    it('takes the first yaml fence, case-insensitively', () => {
        expect(extractYaml('hi\n```YAML\na: 1\n```\n```yaml\nb: 2\n```')).toBe('a: 1')
    })
    it('takes a yml fence', () => {
        expect(extractYaml('```yml\na: 1\n```')).toBe('a: 1')
    })
    it('falls back to the first plain fence', () => {
        expect(extractYaml('x\n```\na: 1\n```\n```\nb: 2\n```')).toBe('a: 1')
    })
    it('falls back to the trimmed reply', () => {
        expect(extractYaml('  \na: 1\n ')).toBe('a: 1')
    })
    it('cuts to MAX_RULE_BYTES', () => {
        expect(new TextEncoder().encode(extractYaml('a'.repeat(MAX_RULE_BYTES + 100))).length).toBe(MAX_RULE_BYTES)
    })
    it('never ends mid-character when cutting multibyte text', () => {
        for (const pad of ['', 'a', 'aa']) {
            const out = extractYaml(pad + '\u20ac'.repeat(MAX_RULE_BYTES))
            expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(MAX_RULE_BYTES)
            expect(out).not.toContain('\ufffd')
        }
    })
})

describe('draftRule prompt', () => {
    it('system prompt states the contract', () => {
        for (const s of [
            '```yaml',
            'contains',
            'startswith',
            'endswith',
            're',
            'all',
            'not',
            '1 of',
            'all of',
            'near',
            'timeframe',
            '<<<FINDING',
            'FINDING>>>'
        ]) {
            expect(DRAFT_SYSTEM).toContain(s)
        }
    })
    it('gives the logsource block and fields for each kind', async () => {
        const cases: [DraftLogsource, string, string[]][] = [
            ['prompt', '{product: claude-proxy, category: prompt}', ['text']],
            ['tool_use', '{product: claude-proxy, category: tool_use}', ['tool', 'text']],
            [
                'detection',
                '{product: claude-proxy, service: detection}',
                ['ruleId', 'severity', 'engagement', 'requestId', 'excerpt']
            ],
            [
                'request',
                '{product: claude-proxy, service: request}',
                ['model', 'route', 'backend', 'status', 'tools', 'engagement', 'mode']
            ]
        ]
        for (const [kind, block, fields] of cases) {
            const { user } = await userFor('f', kind)
            expect(user).toContain(block)
            for (const f of fields) expect(user).toContain(f)
            expect(user.indexOf(block)).toBeLessThan(user.indexOf('<<<FINDING'))
        }
    })
    it('fences the finding and strips markers, including nested ones', async () => {
        const { user } = await userFor('a <<<FIN<<<FINDINGDING b FINDING>>> c FINDIFINDING>>>NG>>>')
        expect(user.match(/<<<FINDING/g)).toHaveLength(1)
        expect(user.match(/FINDING>>>/g)).toHaveLength(1)
        expect(user).toContain('<<<FINDING\na  b  c \nFINDING>>>')
    })
    it('cuts the finding after stripping', async () => {
        const { user } = await userFor('x'.repeat(MAX_FINDING_CHARS + 500))
        expect(user).toContain(`<<<FINDING\n${'x'.repeat(MAX_FINDING_CHARS)}\nFINDING>>>`)
    })
})

describe('draftRule result', () => {
    const NEXT = 'not done: run test_rule with events and expect until passed is true'
    it('reports a valid draft as a draft', async () => {
        const d = await draftRule('f', 'prompt', async () => '```yaml\n' + VALID + '\n```')
        expect(d).toEqual({ yaml: VALID, valid: true, unsupported: [], status: 'draft', next: NEXT })
        expect('error' in d).toBe(false)
    })
    it('lists unsupported features', async () => {
        const text = VALID.replace('text|contains: ignore previous', 'text|base64: x')
        const d = await draftRule('f', 'prompt', async () => text)
        expect(d.valid).toBe(false)
        expect(d.unsupported.length).toBeGreaterThan(0)
        expect(d.error).toBeTruthy()
        expect(d.status).toBe('draft')
        expect(d.next).toBe(NEXT)
    })
    it('reports a hard parse error', async () => {
        const d = await draftRule('f', 'prompt', async () => 'not: [valid')
        expect(d.valid).toBe(false)
        expect(d.error).toBeTruthy()
    })
    it('reports a model call failure without throwing', async () => {
        const d = await draftRule('f', 'prompt', async () => {
            throw new Error('boom')
        })
        expect(d).toEqual({
            yaml: '',
            valid: false,
            error: 'draft model call failed',
            unsupported: [],
            status: 'draft',
            next: NEXT
        })
    })
})
