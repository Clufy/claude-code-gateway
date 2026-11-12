/** Request-side detection rules (flag only). They run over the newest turn of a /v1/messages request. */
import { checkScope, isObj, type Engagement } from '../engagement'
import { excerptAt, findSecret } from './redact'

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

const INJECT_PATTERNS: readonly RegExp[] = [
    /ignore (?:all |any )?(?:the )?(?:previous|prior|above|earlier) (?:instructions|prompts|messages|rules)/i,
    /disregard (?:all |the )?(?:previous|prior|above) /i,
    /<\/?(?:system|assistant|user|human|tool_result|function_results)>/i,
    /<\|im_(?:start|end)\|>/i,
    /\byou are now (?:an?|the|in) (?:[\w-]+ ){0,3}(?:assistant|ai|model|agent|admin|developer mode|dan|jailbroken)\b/i,
    /[\u{E0000}-\u{E007F}]/u,
    /[​-‍⁠﻿]{3}/
]

/** Prompt-injection triggers inside a tool result. */
export function injectInstruction(seg: Segment): string | null {
    if (seg.kind !== 'tool_result') return null
    for (const re of INJECT_PATTERNS) {
        const m = re.exec(seg.text)
        if (m) return excerptAt(seg.text, m.index, m.index + m[0].length)
    }
    return null
}

// The link text and URL exclude '[' and '(' so a run of repeated openers cannot make the scan quadratic.
const MARKUP = /!?\[[^[\]\n]{0,200}\]\((https?:\/\/[^\s()]{1,2048})\)/g
const MAX_LINKS = 200
const ODD_VALUE = /[{}[\]<>$]/

function suspiciousQuery(url: string): boolean {
    let u: URL
    try {
        u = new URL(url)
    } catch {
        return false
    }
    for (const [, v] of u.searchParams) if (v.length >= 24 || ODD_VALUE.test(v)) return true
    return false
}

/** A markdown image or link in a tool result whose query looks like it carries data out. */
export function exfilMarkup(seg: Segment, e?: Engagement): string | null {
    if (seg.kind !== 'tool_result') return null
    let seen = 0
    for (const m of seg.text.matchAll(MARKUP)) {
        if (++seen > MAX_LINKS) return null
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
