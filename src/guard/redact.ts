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
    { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,300}\.eyJ[A-Za-z0-9_-]{10,40}/g },
    {
        name: 'generic',
        re: /\b(?:password|passwd|pwd|secret|api[_-]?key|token)\s{0,3}[:=]\s{0,3}["']?([^\s"']{8,200})/gi
    }
]

const PLACEHOLDERS = ['${', '<', '{{', 'xxx', 'changeme', 'example', '****']
const MARKER = '…[redacted]'

function entropy(s: string): number {
    const counts = new Map<string, number>()
    let total = 0
    for (const ch of s) {
        counts.set(ch, (counts.get(ch) ?? 0) + 1)
        total++
    }
    let h = 0
    for (const n of counts.values()) h -= (n / total) * Math.log2(n / total)
    return h
}

function realSecretValue(value: string): boolean {
    const lower = value.toLowerCase()
    if (PLACEHOLDERS.some((p) => lower.includes(p))) return false
    return entropy(value) >= 3.5
}

export interface SecretSpan {
    start: number
    end: number
}

/** Spans of secret matches (for the generic pattern: the value only), unsorted and possibly overlapping. */
function matchSpans(text: string, firstOnly: boolean): SecretSpan[] {
    const out: SecretSpan[] = []
    for (const { name, re } of SECRET_PATTERNS) {
        for (const m of text.matchAll(re)) {
            const end = m.index + m[0].length
            let start = m.index
            if (name === 'generic') {
                if (!realSecretValue(m[1])) continue
                start = end - m[1].length
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

interface Replacement {
    start: number
    end: number
    newStart: number
    newEnd: number
}

/** Redacted text plus the replaced intervals, so excerptAt can map original offsets. */
function redactMapped(text: string): { out: string; reps: Replacement[] } {
    // A plain character loop extends each match over the rest of its token; it only scans past what is covered.
    const extend = (end: number): number => {
        while (end < text.length && isTokenChar(text.charCodeAt(end))) end++
        return end
    }
    const spans = matchSpans(text, false).sort((a, b) => a.start - b.start)
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
    return redactMapped(text).out
}

const CONTEXT = 80
const MARGIN = 500
const MAX_EXCERPT = 200

/** Redacts a window around [start, end) first, then cuts ±80 chars of context to ≤200 chars, newlines as spaces. */
export function excerptAt(text: string, start: number, end: number): string {
    const sliceStart = Math.max(0, start - CONTEXT - MARGIN)
    const sliceEnd = Math.min(text.length, end + CONTEXT + MARGIN)
    const { out, reps } = redactMapped(text.slice(sliceStart, sliceEnd))
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
