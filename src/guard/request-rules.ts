/** Request-side detection rules (flag only). They run over the newest turn of a /v1/messages request. */
import { checkScope, isObj, type Engagement } from '../engagement'
import { entropyOf, excerptAt, findSecret } from './redact'

export interface Segment {
    kind: 'user' | 'tool_result'
    text: string
}

function resultText(content: unknown): string {
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''
    const parts: string[] = []
    for (const b of content) if (isObj(b) && b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
    return parts.join('\n')
}

/** Trailing user messages after the last assistant message (every message if there is none). Never throws. */
export function newestTurn(messages: unknown): Segment[] {
    if (!Array.isArray(messages)) return []
    let first = 0
    for (let i = messages.length - 1; i >= 0; i--) {
        const m: unknown = messages[i]
        if (isObj(m) && m.role === 'assistant') {
            first = i + 1
            break
        }
    }
    const out: Segment[] = []
    for (let i = first; i < messages.length; i++) {
        const m: unknown = messages[i]
        if (!isObj(m) || m.role !== 'user') continue
        const c = m.content
        if (typeof c === 'string') {
            out.push({ kind: 'user', text: c })
        } else if (Array.isArray(c)) {
            for (const b of c) {
                if (!isObj(b)) continue
                if (b.type === 'text' && typeof b.text === 'string') out.push({ kind: 'user', text: b.text })
                else if (b.type === 'tool_result') out.push({ kind: 'tool_result', text: resultText(b.content) })
            }
        }
    }
    return out
}

// P4-R23: fake tags keep system/tool_result/function_*; user/assistant/human and "admin"/"in" are too common.
// `anchors` are lowercase literals every match of the pattern contains. A pattern runs only if the lowercased text
// holds one (an indexOf pass, far cheaper than the case-insensitive regex), which keeps clean 1 MB results fast.
const INJECT_PATTERNS: readonly { re: RegExp; anchors?: readonly string[] }[] = [
    {
        re: /ignore (?:all |any )?(?:the )?(?:previous|prior|above|earlier) (?:instructions|prompts|messages|rules)/i,
        anchors: ['gnore']
    },
    { re: /disregard (?:all |the )?(?:previous|prior|above) /i },
    {
        re: /<\/?(?:system|tool_result|function_results|function_calls)>/i,
        anchors: ['<']
    },
    { re: /<\|im_(?:start|end)\|>/i, anchors: ['<|'] },
    {
        re: /\byou are now (?:an?|the) (?:[\w-]+ ){0,3}(?:assistant|ai|model|agent|developer mode|dan|jailbroken)\b/i,
        anchors: ['you a']
    },
    { re: /[\u{E0000}-\u{E007F}]/u },
    { re: /[\u200B-\u200D\u2060\uFEFF]{3}/ }
]

/** Prompt-injection triggers inside a tool result. */
export function injectInstruction(seg: Segment): string | null {
    if (seg.kind !== 'tool_result') return null
    let lower: string | undefined
    for (const { re, anchors } of INJECT_PATTERNS) {
        if (anchors) {
            lower ??= seg.text.toLowerCase()
            if (!anchors.some((a) => lower!.includes(a))) continue
        }
        const m = re.exec(seg.text)
        if (m) return excerptAt(seg.text, m.index, m.index + m[0].length)
    }
    return null
}

// The link text and URL exclude '[' and '(' so a run of repeated openers cannot make the scan quadratic.
const MARKUP = /!?\[[^[\]\n]{0,200}\]\((https?:\/\/[^\s()]{1,2048})\)/g
const ODD_VALUE = /[{}[\]<>$]/

function decode(v: string): string {
    if (!/[%+]/.test(v)) return v
    const spaced = v.replace(/\+/g, ' ')
    try {
        return decodeURIComponent(spaced)
    } catch {
        return spaced
    }
}

/** P4-R22: a value is suspicious if it holds {}[]<>$, or is a long, space-free, high-entropy blob. */
function suspiciousValue(raw: string): boolean {
    const v = decode(raw)
    if (ODD_VALUE.test(v)) return true
    return (
        v.length >= 24 &&
        !v.includes(' ') &&
        !v.startsWith('data:') &&
        !v.startsWith('http') &&
        entropyOf(v, 0, v.length) >= 4.2
    )
}

/** Lexical query check: no URL parsing, and only URLs that contain '?'. */
function suspiciousQuery(url: string): boolean {
    const q = url.indexOf('?')
    if (q === -1) return false
    let query = url.slice(q + 1)
    const hash = query.indexOf('#')
    if (hash !== -1) query = query.slice(0, hash)
    for (const pair of query.split('&')) {
        const eq = pair.indexOf('=')
        if (eq !== -1 && suspiciousValue(pair.slice(eq + 1))) return true
    }
    return false
}

/** A markdown image or link in a tool result whose query looks like it carries data out. */
export function exfilMarkup(seg: Segment, e?: Engagement): string | null {
    if (seg.kind !== 'tool_result') return null
    for (const m of seg.text.matchAll(MARKUP)) {
        const url = m[1]
        if (!suspiciousQuery(url)) continue
        if (e && checkScope(e, url).verdict === 'in_scope') continue
        return excerptAt(seg.text, m.index, m.index + m[0].length)
    }
    return null
}

/** A credential anywhere in the newest turn. */
export function secretEgress(seg: Segment): string | null {
    const s = findSecret(seg.text)
    return s ? excerptAt(seg.text, s.start, s.end) : null
}
