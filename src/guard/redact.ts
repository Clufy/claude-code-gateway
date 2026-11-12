/**
 * Secret patterns and redaction (Global Constraints: a secret never reaches a log line unredacted).
 * Every regex is bounded (no unbounded runs, no nested quantifiers) so it stays linear on adversarial input.
 */
export const SECRET_PATTERNS: readonly { name: string; re: RegExp }[] = [
    { name: 'aws', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
    { name: 'github', re: /\bgh[pousr]_[A-Za-z0-9]{36}\b/g },
    { name: 'github_pat', re: /\bgithub_pat_[A-Za-z0-9_]{82}\b/g },
    { name: 'slack', re: /\bxox[baprs]-[A-Za-z0-9-]{10,200}/g },
    { name: 'stripe', re: /\b[sr]k_live_[A-Za-z0-9]{24,200}/g },
    { name: 'pem', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g },
    { name: 'jwt', re: /(?<![\w-])eyJ[\w-]{10,300}\.eyJ[\w-]{10,40}/g },
    {
        name: 'generic',
        // Quoted values run to the closing quote; unquoted ones stop at whitespace, a quote, ) ] } , or ; (P4-R23).
        re: /(?<![a-z0-9])(?:password|passwd|pwd|secret|api[_-]?key|token|access[_-]?key)(?:[_-]?(?:access[_-]?)?key|[_-]?secret|[_-]?id)?["']?\s{0,3}[:=]\s{0,3}(?:"([^"\n]{8,200})|'([^'\n]{8,200})|([^\s"'()\]},;]{8,200}))/gi
    }
]

const PLACEHOLDERS = ['${', '<', '{{', 'xxx', 'changeme', 'example', '****']
const MARKER = '…[redacted]'
const MIN_ENTROPY = 3.5
const MIN_RUN = 32

const counts = new Uint32Array(256)
/** Shannon entropy (bits/char) of text[from, to). Chars are bucketed by their low byte; allocation-free. */
export function entropyOf(text: string, from: number, to: number): number {
    for (let i = from; i < to; i++) counts[text.charCodeAt(i) & 255]++
    const total = to - from
    let h = 0
    for (let i = from; i < to; i++) {
        const k = text.charCodeAt(i) & 255
        const n = counts[k]
        if (n > 0) {
            h -= (n / total) * Math.log2(n / total)
            counts[k] = 0
        }
    }
    return h
}

const DOTTED_CHAIN = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/

function realSecretValue(value: string, quoted: boolean): boolean {
    if (entropyOf(value, 0, value.length) < MIN_ENTROPY) return false
    const lower = value.toLowerCase()
    // 'example' marks a placeholder only in short values: doc sample secrets are 40 chars (P4-R24 needs them to flag).
    if (PLACEHOLDERS.some((p) => lower.includes(p) && (p !== 'example' || value.length < 30))) return false
    if (quoted) {
        // Prose, commands and URLs are not secrets: 2+ spaces, an http(s) URL, or a plain lowercase first word.
        const words = value.split(' ')
        if (/^https?:\/\//.test(lower) || words.length > 2 || (words.length === 2 && /^[a-z]+$/.test(words[0])))
            return false
    }
    return !DOTTED_CHAIN.test(value) && !value.includes('(')
}

export interface SecretSpan {
    start: number
    end: number
}

const isTokenChar = (c: number): boolean =>
    (c >= 48 && c <= 57) || // 0-9
    (c >= 65 && c <= 90) || // A-Z
    (c >= 97 && c <= 122) || // a-z
    c === 95 || // _
    c === 45 || // -
    c === 46 || // .
    c === 43 || // +
    c === 47 || // /
    c === 61 // =

const isSpace = (c: number): boolean => c === 32 || (c >= 9 && c <= 13)

/** End of a PEM block that starts at `from` (just after the BEGIN line): base64, whitespace and header lines. */
function pemEnd(text: string, from: number): number {
    let i = from
    while (i < text.length) {
        if (text.charCodeAt(i) === 45 && text.startsWith('-----END ', i)) {
            const close = text.indexOf('-----', i + 9)
            return close === -1 ? text.length : close + 5
        }
        const c = text.charCodeAt(i)
        if (!isTokenChar(c) && !isSpace(c) && c !== 58 && c !== 44 && c !== 92) break // ':' ',' occur in Proc-Type/DEK-Info; '\' in JSON-escaped newlines
        i++
    }
    return i
}

/** Spans of secret matches (for the generic pattern: the value only), unsorted and possibly overlapping. */
function matchSpans(text: string, firstOnly: boolean): SecretSpan[] {
    const out: SecretSpan[] = []
    for (const { name, re } of SECRET_PATTERNS) {
        let covered = 0 // a PEM scan never restarts inside text it already covered (keeps repeated headers linear)
        for (const m of text.matchAll(re)) {
            let end = m.index + m[0].length
            let start = m.index
            if (name === 'generic') {
                const value = m[1] ?? m[2] ?? m[3]
                if (!realSecretValue(value, m[3] === undefined)) continue
                start = end - value.length
            } else if (name === 'pem' && end > covered) {
                end = covered = pemEnd(text, end)
            }
            out.push({ start, end })
            if (firstOnly) break
        }
    }
    return out
}

/** The earliest secret in the text, or null. */
export function findSecret(text: string): SecretSpan | null {
    const spans = matchSpans(text, true)
    if (spans.length === 0) return null
    return spans.reduce((a, b) => (b.start < a.start ? b : a))
}

/** Runs of ≥32 token chars with entropy ≥3.5 (defense in depth for excerpts, P4-R21). */
function runSpans(text: string): SecretSpan[] {
    const out: SecretSpan[] = []
    let i = 0
    while (i < text.length) {
        if (!isTokenChar(text.charCodeAt(i))) {
            i++
            continue
        }
        const start = i
        while (i < text.length && isTokenChar(text.charCodeAt(i))) i++
        if (i - start >= MIN_RUN && entropyOf(text, start, i) >= MIN_ENTROPY) out.push({ start, end: i })
    }
    return out
}

interface Replacement {
    start: number
    end: number
    newStart: number
    newEnd: number
}

/** Redacted text plus the replaced intervals, so excerptAt can map original offsets. */
function redactMapped(text: string, mask: boolean): { out: string; reps: Replacement[] } {
    // A plain character loop extends each match over the rest of its token; it only scans past what is covered.
    const extend = (end: number): number => {
        while (end < text.length && isTokenChar(text.charCodeAt(end))) end++
        return end
    }
    const all = mask ? [...matchSpans(text, false), ...runSpans(text)] : matchSpans(text, false)
    const spans = all.sort((a, b) => a.start - b.start)
    const intervals: SecretSpan[] = []
    for (const span of spans) {
        const last = intervals[intervals.length - 1]
        if (last && span.start <= last.end) last.end = extend(Math.max(last.end, span.end))
        else intervals.push({ start: span.start, end: extend(span.end) })
    }
    const reps: Replacement[] = []
    let out = ''
    let pos = 0
    for (const iv of intervals) {
        out += text.slice(pos, iv.start)
        const newStart = out.length
        out += text.slice(iv.start, iv.start + 4) + MARKER
        reps.push({ start: iv.start, end: iv.end, newStart, newEnd: out.length })
        pos = iv.end
    }
    return { out: out + text.slice(pos), reps }
}

/** Each secret match becomes its first 4 chars + '…[redacted]'; the rest of the token is dropped too. */
export function redact(text: string): string {
    return redactMapped(text, false).out
}

const CONTEXT = 80
const MARGIN = 500
const MAX_EXCERPT = 200

/** Redacts a window around [start, end) first, then cuts ±80 chars of context to ≤200 chars, newlines as spaces. */
export function excerptAt(text: string, start: number, end: number): string {
    const sliceStart = Math.max(0, start - CONTEXT - MARGIN)
    const sliceEnd = Math.min(text.length, end + CONTEXT + MARGIN)
    const { out, reps } = redactMapped(text.slice(sliceStart, sliceEnd), true)
    // Original offset → redacted offset; an offset inside a replacement takes the whole marker.
    const map = (orig: number, isEnd: boolean): number => {
        let shift = 0
        for (const r of reps) {
            if (orig <= r.start) break
            if (orig < r.end) return isEnd ? r.newEnd : r.newStart
            shift = r.newEnd - r.end
        }
        return orig + shift
    }
    const from = map(Math.max(sliceStart, start - CONTEXT) - sliceStart, false)
    const to = map(Math.min(sliceEnd, end + CONTEXT) - sliceStart, true)
    return out
        .slice(from, to)
        .replace(/[\r\n]+/g, ' ')
        .slice(0, MAX_EXCERPT)
}
