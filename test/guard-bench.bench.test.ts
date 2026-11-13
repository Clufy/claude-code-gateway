import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config'
import { decideToolCall } from '../src/guard/decide'
import { hostsInToolInput } from '../src/guard/hosts'
import { createGuard } from '../src/guard/index'
import { excerptAt, redact, SECRET_PATTERNS } from '../src/guard/redact'
import { cmdRisky, scopeOutOfScope } from '../src/guard/response-rules'
import { exfilMarkup, injectInstruction, secretEgress } from '../src/guard/request-rules'

// Runs in the bench project (npm run bench): the workers runtime freezes performance.now() during synchronous CPU work.
const MB = 1024 * 1024
const KB = 1024
const MAX_MS = 50
const NOW = Date.parse('2026-06-01T00:00:00Z')

const rep = (unit: string, n: number) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n)

const REQUEST_PATTERNS = [
    'mimikatz',
    'sekurlsa::',
    'certutil\\s{1,10}-urlcache',
    'procdump[^\\n]{0,80}lsass',
    'Invoke-Mimikatz',
    'lsadump::',
    'kerberoast',
    'bloodhound',
    'rubeus\\s{1,5}asktgt',
    'secretsdump',
    'crackmapexec',
    'ntds\\.dit',
    'reg\\s{1,5}save\\s{1,5}hklm',
    'cobaltstrike',
    'meterpreter',
    'impacket-[a-z]{1,20}'
]
const RESPONSE_PATTERNS = [
    'vssadmin\\s{1,5}delete',
    'wevtutil\\s{1,5}cl',
    'bcdedit\\s{1,5}/set',
    'schtasks\\s{1,5}/create',
    'net\\s{1,5}user\\s{1,5}/add',
    'Set-MpPreference',
    'AmsiUtils',
    'amsiInitFailed',
    'nc\\s{1,5}-e\\s{1,5}/bin',
    'bash\\s{1,5}-i\\s{1,5}>&',
    'wmic\\s{1,5}shadowcopy',
    'cipher\\s{1,5}/w',
    'sdelete',
    'mshta\\s{1,5}http',
    'rundll32[^\\n]{0,60}comsvcs',
    'regsvr32\\s{1,5}/s'
]
const custom = [
    ...REQUEST_PATTERNS.map((pattern, i) => ({ id: `custom.req-${i}`, side: 'request', pattern, flags: 'i' })),
    ...RESPONSE_PATTERNS.map((pattern, i) => ({ id: `custom.res-${i}`, side: 'response', pattern, flags: 'i' }))
]

const engagement = (domain: string, cidr: string) => ({
    scope: { domains: [`*.${domain}`], cidrs: [cidr] },
    window: { start: '2026-01-01T00:00:00Z', end: '2027-01-01T00:00:00Z' },
    defaultMode: 'redteam'
})
const engagements = JSON.stringify({
    alpha: engagement('alpha-test.com', '10.1.0.0/16'),
    beta: engagement('beta-test.com', '10.2.0.0/16'),
    gamma: engagement('gamma-test.com', '10.3.0.0/16')
})
/** The request budget (10 ms p95; relaxed from the spec's 5 ms by user decision, 2026-11-13) is measured on the default config: built-in rules only (P4-R31). */
const env = { PROXY_KEY: 'test-key', ENGAGEMENTS: engagements }
const customEnv = { ...env, GUARD_RULES: JSON.stringify({ custom }) }
const requestOnlyEnv = {
    ...env,
    GUARD_RULES: JSON.stringify({ custom: custom.filter((c) => c.side === 'request') })
}

/** ~1 MB tool_result: code lines, prose, 200 URLs, 50 markdown links, 20 low-entropy password= lines. */
function buildBody(): Record<string, unknown> {
    const code = 'function add(a, b) {\n    const total = a + b\n    return total * 2 // doubled\n}\n'
    const prose = 'The quick brown fox jumps over the lazy dog while the build system compiles every module again.\n'
    const special: string[] = []
    for (let i = 0; i < 200; i++) special.push(`see https://docs.example.com/page/${i}?ref=${i * 7} for details\n`)
    for (let i = 0; i < 50; i++) special.push(`[link ${i}](https://example.org/a/${i})\n`)
    for (let i = 0; i < 20; i++) special.push(`password=hunter${i}\n`)
    const pieces: string[] = []
    let size = 0
    for (let k = 0; size < MB; k++) {
        const piece = code + prose + (special[k] ?? '')
        pieces.push(piece)
        size += piece.length
    }
    const result = pieces.join('').slice(0, MB)
    const history: unknown[] = []
    for (let i = 0; i < 20; i++) {
        history.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `turn ${i}: please continue the work` })
    }
    return {
        model: 'm',
        messages: [
            ...history,
            { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'x' } }] },
            {
                role: 'user',
                content: [
                    { type: 'tool_result', tool_use_id: 't1', content: result },
                    { type: 'text', text: 'summarise the file' }
                ]
            }
        ]
    }
}

function percentile(xs: number[], p: number): number {
    const s = [...xs].sort((a, b) => a - b)
    return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]!
}
/** Best of 15: the 50 ms units are worst-case termination checks, so the fastest run is what they assert on. */
function best(fn: () => unknown, n = 15): number {
    let min = Infinity
    for (let i = 0; i < n; i++) {
        const t0 = performance.now()
        fn()
        min = Math.min(min, performance.now() - t0)
    }
    return min
}
/** Honest p95: 5 warm-ups, then 200 measured iterations pooled together; no best-of-batches. */
function p95Of(iter: () => void): { p95: number; median: number } {
    for (let i = 0; i < 5; i++) iter()
    const times: number[] = []
    for (let i = 0; i < 200; i++) {
        const t0 = performance.now()
        iter()
        times.push(performance.now() - t0)
    }
    return { p95: percentile(times, 0.95), median: percentile(times, 0.5) }
}

beforeAll(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterAll(() => vi.restoreAllMocks())

describe('guard CPU budget', () => {
    const body = buildBody()
    const command4k = rep('echo hello world && ls -la /tmp; ', 4 * KB)

    it('builds a ~1 MB body', () => {
        expect(JSON.stringify(body).length).toBeGreaterThan(MB)
    })

    it('request iteration p95 <= 10 ms (default config: loadConfig + createGuard + scanRequest + onToolUse)', () => {
        {
            const { p95, median } = p95Of(() => {
                const cfg = loadConfig(env)
                const g = createGuard(cfg, 'req-1', cfg.engagements.get('alpha'))
                g.scanRequest(body)
                g.onToolUse('Bash', { command: command4k })
            })
            console.info(`[bench] request iteration p95=${p95.toFixed(2)}ms median=${median.toFixed(2)}ms`)
            expect(p95).toBeLessThanOrEqual(10)
        }
    })

    it('request scan alone p95 <= 10 ms (default config)', () => {
        const cfg = loadConfig(env)
        const e = cfg.engagements.get('alpha')
        const { p95 } = p95Of(() => void createGuard(cfg, 'req-2', e).scanRequest(body))
        console.info(`[bench] scanRequest p95=${p95.toFixed(2)}ms`)
        expect(p95).toBeLessThanOrEqual(10)
    })

    it('16 request custom rules cost <= 0.4 ms each per MB (best-of-15, with minus without)', () => {
        const scan = (e: typeof env) => {
            const cfg = loadConfig(e)
            const g = createGuard(cfg, 'req-c', cfg.engagements.get('alpha'))
            return () => void g.scanRequest(body)
        }
        const base = scan(env)
        const withRules = scan(requestOnlyEnv)
        base()
        withRules()
        const perRule = (best(withRules, 15) - best(base, 15)) / 16
        console.info(`[bench] custom rule cost per rule per MB (best-of-15)=${perRule.toFixed(3)}ms`)
        expect(perRule).toBeLessThanOrEqual(0.4)
    })

    it('response scan alone p95 <= 5 ms (4 KB Bash command, 16 response custom rules)', () => {
        const cfg = loadConfig(customEnv)
        const e = cfg.engagements.get('alpha')
        const { p95 } = p95Of(() => createGuard(cfg, 'req-3', e).onToolUse('Bash', { command: command4k }))
        console.info(`[bench] onToolUse p95=${p95.toFixed(2)}ms`)
        expect(p95).toBeLessThanOrEqual(5)
    })

    it('decideToolCall on a 64 KB command averages <= 50 ms', () => {
        const e = loadConfig(env).engagements.get('alpha')!
        const command = rep('curl https://app.alpha-test.com/x 10.1.2.3 other.example.org ', 64 * KB)
        const run = () => decideToolCall(e, 'Bash', { command }, NOW)
        run()
        const times: number[] = []
        for (let i = 0; i < 15; i++) {
            const t0 = performance.now()
            run()
            times.push(performance.now() - t0)
        }
        const avg = times.reduce((a, b) => a + b, 0) / times.length
        console.info(`[bench] decideToolCall 64KB avg=${avg.toFixed(2)}ms`)
        expect(avg).toBeLessThanOrEqual(MAX_MS)
    })
})

describe('pathological inputs', () => {
    const units: Record<string, (n: number) => string> = {
        a: (n) => 'a'.repeat(n),
        spaces: (n) => ' '.repeat(n),
        'a.': (n) => rep('a.', n),
        ignore: (n) => rep('ignore previous ', n),
        pem: (n) => rep('-----BEGIN ', n),
        markup: (n) => '![x](http://a/?' + 'b'.repeat(n),
        password: (n) => rep('password=', n),
        zerowidth: (n) => '​'.repeat(n)
    }
    const cfg = loadConfig(customEnv)
    const e = cfg.engagements.get('alpha')

    for (const [name, make] of Object.entries(units)) {
        it(`1 MB tool_result of ${name}`, () => {
            const b = {
                messages: [
                    { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Read', input: {} }] },
                    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: make(MB) }] }
                ]
            }
            const run = () => createGuard(cfg, 'r', e).scanRequest(b)
            run()
            expect(best(run)).toBeLessThanOrEqual(MAX_MS)
        })
        it(`100 KB Bash command of ${name}`, () => {
            const command = make(100 * KB)
            const run = () => createGuard(cfg, 'r', e).onToolUse('Bash', { command })
            run()
            expect(best(run)).toBeLessThanOrEqual(MAX_MS)
        })
    }
})

describe('units deferred from earlier reviews', () => {
    const cfg = loadConfig(customEnv)
    const e = cfg.engagements.get('alpha')!

    it('Task 2: 100 KB of dense two-label words through hostsInToolInput and decideToolCall', () => {
        const command = rep('x.y ', 100 * KB)
        const known = [...e.scope.domains, ...e.exclude.domains]
        const runs = [
            () => hostsInToolInput('Bash', { command }, known),
            () => decideToolCall(e, 'Bash', { command }, NOW)
        ]
        for (const run of runs) {
            run()
            expect(best(run)).toBeLessThanOrEqual(MAX_MS)
        }
    })

    it('Task 6: 100 KB of "iwr " through onToolUse(PowerShell)', () => {
        const command = rep('iwr ', 100 * KB)
        const run = () => createGuard(cfg, 'r', e).onToolUse('PowerShell', { command })
        run()
        expect(best(run)).toBeLessThanOrEqual(MAX_MS)
    })

    it('Task 7: a 1 MB Write input with 16 response custom rules', () => {
        const code = 'export function add(a: number, b: number): number {\n    return a + b // sum\n}\n'
        const content = rep(code, MB)
        const run = () => createGuard(cfg, 'r', e).onToolUse('Write', { file_path: 'x', content })
        run()
        const t = best(run)
        console.info(`[bench] Write 1 MB with 16 response custom rules best-of-15=${t.toFixed(2)}ms`)
        expect(t).toBeLessThanOrEqual(MAX_MS)
    })
})

// Per-rule timing units (moved from guard-request-rules.node.test.ts)

const ruleUnits: Record<string, string> = {
    pem: '-----BEGIN ',
    password: 'password=',
    'password space': 'password= ',
    ignore: 'ignore previous ',
    eyJ: 'eyJ',
    '-eyJ': '-eyJ',
    'eyJ-': 'eyJ-',
    slack: 'xoxb-',
    aws: 'AKIA',
    markup: '![x](http://a/?',
    bracket: '[',
    zerowidth: '\u200B',
    'token run': 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fG'
}

const passes: Record<string, (text: string) => unknown> = {
    patterns: (t) => {
        for (const { re } of SECRET_PATTERNS) for (const _ of t.matchAll(re)) void _
    },
    inject: (t) => injectInstruction({ kind: 'tool_result', text: t }),
    exfil: (t) => exfilMarkup({ kind: 'tool_result', text: t }),
    egress: (t) => secretEgress({ kind: 'tool_result', text: t }),
    redact: (t) => redact(t),
    excerpt: (t) => excerptAt(t, t.length >> 1, (t.length >> 1) + 50)
}

describe('adversarial 1 MB input stays fast', () => {
    for (const [uname, unit] of Object.entries(ruleUnits)) {
        const text = rep(unit, MB)
        for (const [pname, pass] of Object.entries(passes)) {
            it(`${pname} on ${uname}`, () => {
                pass(text) // warm-up
                expect(best(() => pass(text))).toBeLessThanOrEqual(MAX_MS)
            })
        }
    }
})

describe('fix round 2 units stay fast', () => {
    const repMB = (unit: string) => rep(unit, MB)
    let x = 1
    const body = Array.from({ length: MB }, () => {
        x = (x * 1103515245 + 12345) & 0x7fffffff
        return 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'[(x >> 8) % 64]
    }).join('')
    const cases: [string, string, (t: string) => unknown][] = [
        [
            'exfilMarkup on long-valued links',
            repMB('[](http://a?x=aaaaaaaaaaaaaaaaaaaaaaaaa&y=bbbbbbbbbbbbbbbbbbbbbbbbb)'),
            (t) => exfilMarkup({ kind: 'tool_result', text: t })
        ],
        [
            'secretEgress on a PEM header plus 1 MB base64',
            '-----BEGIN PRIVATE KEY-----\n' + body,
            (t) => secretEgress({ kind: 'tool_result', text: t })
        ],
        [
            'secretEgress on repeated PEM headers',
            repMB('-----BEGIN PRIVATE KEY-----'),
            (t) => secretEgress({ kind: 'tool_result', text: t })
        ],
        ['redact on a PEM header plus 1 MB base64', '-----BEGIN PRIVATE KEY-----\n' + body, (t) => redact(t)]
    ]
    it.each(cases)('%s', (_name, text, pass) => {
        pass(text)
        expect(best(() => pass(text))).toBeLessThanOrEqual(MAX_MS)
    })
})

describe('fix round 3 quoted-value units stay fast', () => {
    const repMB = (unit: string) => rep(unit, MB)
    it.each([
        ['runner word', repMB('pwd="hunter Xk9#qLz2" ')],
        ['url value', repMB('pwd="https://ab.cd/Xk9#qLz2" ')],
        ['prose value', repMB('password="the quick brown fox jumps over" ')]
    ])('secretEgress, redact and excerpt on %s', (_name, text) => {
        for (const pass of [
            (t: string) => secretEgress({ kind: 'tool_result', text: t }),
            (t: string) => redact(t),
            (t: string) => excerptAt(t, t.length >> 1, (t.length >> 1) + 50)
        ]) {
            pass(text)
            expect(best(() => pass(text))).toBeLessThanOrEqual(MAX_MS)
        }
    })
})

describe('cmdRisky stays fast on 100 KB commands', () => {
    for (const unit of ['curl ', 'rm -rf ', 'iex ', 'procdump ', 'Set-MpPreference -Disable', 'a.']) {
        it(`unit ${JSON.stringify(unit)}`, () => {
            const command = rep(unit, 100 * KB)
            cmdRisky('Bash', { command }) // warm-up
            expect(best(() => cmdRisky('Bash', { command }))).toBeLessThanOrEqual(MAX_MS)
        })
    }
})

describe('scopeOutOfScope stays fast on 100 KB commands', () => {
    const eng = {
        name: 'acme',
        scope: { domains: ['*.acme-test.com'], cidrs: ['10.10.0.0/16'], llmTargets: [] },
        exclude: { domains: [], cidrs: [] },
        window: { start: 0, end: 1e13 },
        roe: '',
        defaultMode: 'redteam' as const
    }
    for (const unit of ['http://', 'a@', 'a.b. ']) {
        it(`unit ${JSON.stringify(unit)}`, () => {
            const command = rep(unit, 100 * KB)
            const run = () => scopeOutOfScope('Bash', { command }, eng)
            run()
            expect(best(run)).toBeLessThanOrEqual(MAX_MS)
        })
    }
})
