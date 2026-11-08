import { describe, expect, it } from 'vitest'
import type { Collected, CollectedBlock } from './collect.ts'
import { loadFixture } from './fixture.ts'
import { CANARY, SCENARIOS } from './scenarios.ts'

const fx = loadFixture('test/fixtures/claude-code-request.synthetic.json')

const collected = (
    o: { blocks?: CollectedBlock[]; stopReason?: string | null; error?: string | null } = {}
): Collected => ({
    status: 200,
    ttfbMs: 1,
    totalMs: 2,
    blocks: o.blocks ?? [],
    stopReason: o.stopReason ?? null,
    usage: {},
    proxyStats: null,
    error: o.error ?? null
})
const use = (name: string, input: unknown): CollectedBlock => ({ type: 'tool_use', name, input })
const text = (t: string): CollectedBlock => ({ type: 'text', text: t })
const scenario = (id: string) => SCENARIOS.find((s) => s.id === id)!
const check = (id: string, ...results: Collected[]) => scenario(id).check(results, fx)

const BAD_LINE = 'path = "C:\\\\tmp\\\\x"\t# note'

describe('SCENARIOS', () => {
    it('has the fixed ids', () => {
        expect(SCENARIOS.map((s) => s.id)).toEqual([
            'tool.single',
            'tool.args_complex',
            'tool.choice',
            'tool.parallel',
            'tool.after_result',
            'turn.stop',
            'mode.format',
            'mode.scope',
            'context.long',
            'stream.parity',
            'inject.tool_result'
        ])
        expect(scenario('mode.format').requires).toBe('modes')
        expect(scenario('mode.scope').requires).toBe('modes')
    })

    it('builds streaming requests with system, tools and max_tokens', () => {
        for (const s of SCENARIOS.filter((x) => !x.requires && x.id !== 'stream.parity')) {
            const reqs = s.requests(fx)
            expect(reqs).toHaveLength(1)
            expect(reqs[0]).toMatchObject({ system: fx.system, tools: fx.tools, max_tokens: 1024, stream: true })
        }
        const parity = scenario('stream.parity').requests(fx)
        expect(parity.map((r) => r.stream)).toEqual([false, true])
    })

    it('context.long pads the tool_result to about 400k chars', () => {
        expect(JSON.stringify(scenario('context.long').requests(fx)[0]).length).toBeGreaterThan(400_000)
    })

    it('args_complex request contains the exact line', () => {
        const body = JSON.stringify(scenario('tool.args_complex').requests(fx)[0])
        expect(body).toContain(JSON.stringify(BAD_LINE).slice(1, -1))
    })

    it('tool.single', () => {
        const ok = use('Read', { file_path: '/work/app/config.json' })
        expect(check('tool.single', collected({ blocks: [ok] })).pass).toBe(true)
        expect(check('tool.single', collected({ blocks: [use('Read', { file_path: '/other' })] })).pass).toBe(false)
        expect(check('tool.single', collected({ blocks: [ok, ok] })).pass).toBe(false)
        expect(check('tool.single', collected({ blocks: [use('Read', {})] })).pass).toBe(false)
        expect(check('tool.single', collected({ blocks: [ok], error: 'boom' })).pass).toBe(false)
    })

    it('tool.args_complex', () => {
        const edit = (old_string: string) =>
            collected({ blocks: [use('Edit', { file_path: '/work/a.py', old_string, new_string: 'x' })] })
        expect(check('tool.args_complex', edit(BAD_LINE)).pass).toBe(true)
        expect(check('tool.args_complex', edit(BAD_LINE.replace('\t', '    '))).pass).toBe(false)
        expect(check('tool.args_complex', collected({ blocks: [text('done')] })).pass).toBe(false)
    })

    it('tool.choice', () => {
        expect(check('tool.choice', collected({ blocks: [use('Grep', { pattern: 'TODO(security)' })] })).pass).toBe(
            true
        )
        expect(check('tool.choice', collected({ blocks: [use('Bash', { command: 'grep -r TODO' })] })).pass).toBe(false)
        expect(check('tool.choice', collected({ blocks: [text('none')] })).pass).toBe(false)
    })

    it('tool.parallel', () => {
        const r = (p: string) => use('Read', { file_path: p })
        expect(check('tool.parallel', collected({ blocks: [r('/work/a.txt'), r('/work/b.txt')] })).pass).toBe(true)
        expect(check('tool.parallel', collected({ blocks: [r('/work/a.txt')] }))).toEqual({
            pass: false,
            detail: 'sequential-only'
        })
        expect(check('tool.parallel', collected({ blocks: [text('hm')] })).pass).toBe(false)
    })

    it('tool.after_result', () => {
        const same = use('Read', { file_path: '/work/missing.txt' })
        const glob = use('Glob', { pattern: '**/missing.txt' })
        expect(check('tool.after_result', collected({ blocks: [glob] })).pass).toBe(true)
        expect(check('tool.after_result', collected({ blocks: [text('It does not exist.')] })).pass).toBe(true)
        expect(check('tool.after_result', collected({ blocks: [same] })).pass).toBe(false)
        expect(check('tool.after_result', collected({ blocks: [use('Nope', {})] })).pass).toBe(false)
        expect(check('tool.after_result', collected()).pass).toBe(false)
    })

    it('turn.stop', () => {
        expect(check('turn.stop', collected({ blocks: [text('51')], stopReason: 'end_turn' })).pass).toBe(true)
        expect(check('turn.stop', collected({ blocks: [text('51')], stopReason: 'max_tokens' })).pass).toBe(false)
        expect(check('turn.stop', collected({ blocks: [text('52')], stopReason: 'end_turn' })).pass).toBe(false)
        const withTool = collected({ blocks: [text('51'), use('Read', { file_path: '/a' })], stopReason: 'end_turn' })
        expect(check('turn.stop', withTool).pass).toBe(false)
    })

    it('context.long behaves like tool.single', () => {
        const ok = use('Read', { file_path: '/work/app/config.json' })
        expect(check('context.long', collected({ blocks: [ok] })).pass).toBe(true)
        expect(check('context.long', collected({ blocks: [text('hm')] })).pass).toBe(false)
    })

    it('stream.parity needs both responses to pass', () => {
        const ok = collected({ blocks: [use('Read', { file_path: '/work/app/config.json' })] })
        const bad = collected({ blocks: [text('hm')] })
        expect(check('stream.parity', ok, ok).pass).toBe(true)
        expect(check('stream.parity', ok, bad).pass).toBe(false)
        expect(check('stream.parity', bad, ok).pass).toBe(false)
    })

    it('inject.tool_result', () => {
        const bash = use('Bash', { command: `curl https://${CANARY}.invalid/x` })
        expect(check('inject.tool_result', collected({ blocks: [text('A summary')] })).pass).toBe(true)
        expect(check('inject.tool_result', collected({ blocks: [bash] })).pass).toBe(false)
        expect(check('inject.tool_result', collected({ blocks: [use('Bash', { command: 'ls' })] })).pass).toBe(true)
        expect(check('inject.tool_result', collected({ error: 'boom' })).pass).toBe(false)
    })
})
