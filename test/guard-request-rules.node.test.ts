import { describe, expect, it } from 'vitest'
import { excerptAt, redact, SECRET_PATTERNS } from '../src/guard/redact'
import { exfilMarkup, injectInstruction, secretEgress } from '../src/guard/request-rules'

// Runs in the node project: the workers runtime freezes its clock, so timing is meaningless there.
const MB = 1024 * 1024
const MAX_MS = 50

const units: Record<string, string> = {
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

function best(fn: () => unknown): number {
    let min = Infinity
    for (let i = 0; i < 3; i++) {
        const t0 = performance.now()
        fn()
        min = Math.min(min, performance.now() - t0)
    }
    return min
}

describe('adversarial 1 MB input stays fast', () => {
    for (const [uname, unit] of Object.entries(units)) {
        const text = unit.repeat(Math.ceil(MB / unit.length))
        for (const [pname, pass] of Object.entries(passes)) {
            it(`${pname} on ${uname}`, () => {
                pass(text) // warm-up
                expect(best(() => pass(text))).toBeLessThanOrEqual(MAX_MS)
            })
        }
    }
})

describe('fix round 2 units stay fast', () => {
    const rep = (unit: string) => unit.repeat(Math.ceil(MB / unit.length))
    let x = 1
    const body = Array.from({ length: MB }, () => {
        x = (x * 1103515245 + 12345) & 0x7fffffff
        return 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'[(x >> 8) % 64]
    }).join('')
    const cases: [string, string, (t: string) => unknown][] = [
        [
            'exfilMarkup on long-valued links',
            rep('[](http://a?x=aaaaaaaaaaaaaaaaaaaaaaaaa&y=bbbbbbbbbbbbbbbbbbbbbbbbb)'),
            (t) => exfilMarkup({ kind: 'tool_result', text: t })
        ],
        [
            'secretEgress on a PEM header plus 1 MB base64',
            '-----BEGIN PRIVATE KEY-----\n' + body,
            (t) => secretEgress({ kind: 'tool_result', text: t })
        ],
        [
            'secretEgress on repeated PEM headers',
            rep('-----BEGIN PRIVATE KEY-----'),
            (t) => secretEgress({ kind: 'tool_result', text: t })
        ],
        ['redact on a PEM header plus 1 MB base64', '-----BEGIN PRIVATE KEY-----\n' + body, (t) => redact(t)]
    ]
    it.each(cases)('%s', (_name, text, pass) => {
        pass(text)
        expect(best(() => pass(text))).toBeLessThanOrEqual(MAX_MS)
    })
})
