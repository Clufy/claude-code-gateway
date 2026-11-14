import { describe, expect, it } from 'vitest'
import { MAX_RULE_BYTES, parseSigma } from '../src/purple/sigma'
import {
    DRAFT_SYSTEM,
    MAX_FINDING_CHARS,
    draftRule,
    draftTemplate,
    extractYaml,
    type DraftLogsource
} from '../src/purple/draft'

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
    it('P7-M5: takes the rest of an unterminated yaml fence, trimmed', () => {
        expect(extractYaml('Here is the rule:\n```YML\ntitle: x\nlevel: high\n  ')).toBe('title: x\nlevel: high')
    })
    it('P7-M5: takes the rest of an unterminated plain fence, trimmed', () => {
        expect(extractYaml('Rule:\n```\ntitle: x\n')).toBe('title: x')
    })
    it('P7-M5: a closed fence still wins, yaml before plain', () => {
        expect(extractYaml('```\na: 1\n```\n```yaml\nb: 2\n```')).toBe('b: 2')
        expect(extractYaml('```yaml\na: 1\n```\n```yaml\nb: 2')).toBe('a: 1')
    })
    it('P7-M5 follow-up: a closed plain fence beats a later unterminated yaml fence', () => {
        expect(extractYaml('```\na: 1\n```\n```yaml\nb: 2')).toBe('a: 1')
    })
    it('P7-M5: caps an unterminated fence to MAX_RULE_BYTES', () => {
        expect(new TextEncoder().encode(extractYaml('```yaml\n' + 'a'.repeat(MAX_RULE_BYTES + 100))).length).toBe(
            MAX_RULE_BYTES
        )
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
    it('M3: gives a template that parses, uses the logsource and the first field, before the finding', async () => {
        const kinds: [DraftLogsource, string][] = [
            ['prompt', 'text'],
            ['tool_use', 'tool'],
            ['detection', 'ruleId'],
            ['request', 'model']
        ]
        for (const [kind, field] of kinds) {
            const t = draftTemplate(kind)
            const p = parseSigma(t)
            expect(p.ok).toBe(true)
            if (!p.ok) continue
            expect(p.rule.selections.selection![0]![0]!.field).toBe(field)
            const { user } = await userFor('f', kind)
            expect(user).toContain(t)
            expect(user.indexOf(t)).toBeLessThan(user.indexOf('<<<FINDING'))
        }
        const p = parseSigma(draftTemplate('detection'))
        expect(p.ok && p.rule.logsource).toEqual({ product: 'claude-proxy', service: 'detection' })
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
    it('M4: warns about a logsource that differs from the requested one, and stays valid', async () => {
        const d = await draftRule('f', 'tool_use', async () => VALID)
        expect(d.valid).toBe(true)
        expect(d.warnings).toEqual(['logsource.category is "prompt", expected "tool_use"'])
    })
    it('M4: warns about a missing logsource key and a field the logsource does not have', async () => {
        const text = VALID.replace('  category: prompt\n', '').replace('text|contains', 'prompt|contains')
        const d = await draftRule('f', 'prompt', async () => text)
        expect(d.valid).toBe(true)
        expect(d.warnings).toEqual([
            'logsource.category is missing, expected "prompt"',
            'field "prompt" is not a prompt field (fields: text)'
        ])
    })
    it('M4: lists each unknown field once', async () => {
        const text = VALID.replace(
            '    text|contains: ignore previous',
            '    x: 1\n    y|contains: a\n  sel2:\n    x: 2'
        )
        const d = await draftRule('f', 'prompt', async () => text.replace('condition: sel', 'condition: sel or sel2'))
        expect(d.warnings).toEqual([
            'field "x" is not a prompt field (fields: text)',
            'field "y" is not a prompt field (fields: text)'
        ])
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
    it.each(['', '  \n '])('reports an empty model reply clearly (%j)', async (reply) => {
        const d = await draftRule('f', 'prompt', async () => reply)
        expect(d).toEqual({
            yaml: '',
            valid: false,
            error: 'draft model returned no text; a reasoning model may have used its whole token budget, so try another model',
            unsupported: [],
            status: 'draft',
            next: NEXT
        })
    })
})
