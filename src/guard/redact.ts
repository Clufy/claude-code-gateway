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

/**
 * Permissive keyword pattern for REDACTION only (P4-R25): no lookbehind (camelCase keys), any suffix, always redacts
 * the value. Detection keeps the strict generic pattern above.
 */
const REDACT_KEYWORD =
    /(?:password|passwd|pwd|secret|api[_-]?key|token|access[_-]?key)[\w-]{0,30}["']?\s{0,3}[:=]\s{0,3}(?:"([^"\n]{1,200})|'([^'\n]{1,200})|([^\s"'()\]},;]{1,200}))/gi

const RUNNERS = [
    'node',
    'npm',
    'npx',
    'yarn',
    'pnpm',
    'python',
    'python3',
    'bash',
    'sh',
    'ruby',
    'go',
    'java',
    'deno',
    'bun'
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

/** Quoted prose, commands and URLs are not secrets. Cheap, allocation-free checks (P4-R24/R25). */
function looksLikeProse(value: string): boolean {
    if (value.startsWith('http://') || value.startsWith('https://')) return true
    const sp = value.indexOf(' ')
    if (sp === -1) return false
    if (value.indexOf(' ', sp + 1) !== -1) return true // 2+ spaces
    if (value.indexOf('/', sp) !== -1 || value.indexOf('.', sp) !== -1) return true // "node scripts/token.js"
    return RUNNERS.some((r) => r.length === sp && value.startsWith(r))
}

function realSecretValue(value: string, quoted: boolean): boolean {
    if (value.length < 12) return false // 3.5 bits per char needs at least 12 chars (2^3.5 > 11)
    if (quoted && looksLikeProse(value)) return false
    if (entropyOf(value, 0, value.length) < MIN_ENTROPY) return false
    const lower = value.toLowerCase()
    // 'example' marks a placeholder only in short values: doc sample secrets are 40 chars (P4-R24 needs them to flag).
    if (PLACEHOLDERS.some((p) => lower.includes(p) && (p !== 'example' || value.length < 30))) return false
    return !DOTTED_CHAIN.test(value) && !value.includes('(')
}

export interface SecretSpan {
    start: number
    end: number
    /** Show no characters of the secret (P4-R26); otherwise the first 4 chars, a public type prefix, stay. */
    bare?: boolean
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
function matchSpans(text: string, firstOnly: boolean, permissive: boolean): SecretSpan[] {
    const out: SecretSpan[] = []
    for (const pattern of SECRET_PATTERNS) {
        const name = pattern.name
        const re = name === 'generic' && permissive ? REDACT_KEYWORD : pattern.re
        let covered = 0 // a PEM scan never restarts inside text it already covered (keeps repeated headers linear)
        for (const m of text.matchAll(re)) {
            let end = m.index + m[0].length
            let start = m.index
            if (name === 'generic') {
                const value = m[1] ?? m[2] ?? m[3]
                if (!permissive && !realSecretValue(value, m[3] === undefined)) continue
                start = end - value.length
                out.push({ start, end, bare: true })
                if (firstOnly) break
                continue
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
    const spans = matchSpans(text, true, false)
    if (spans.length === 0) return null
    return spans.reduce((a, b) => (b.start < a.start ? b : a))
}

/**
 * Key bodies whose BEGIN line lies outside the slice: from every END line scan backward over base64, whitespace,
 * backslashes and header chars (stopping at a BEGIN line or the previous END line) and mask the whole stretch.
 */
function pemTails(text: string): SecretSpan[] {
    const out: SecretSpan[] = []
    const endRe = /-----END (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/y
    let floor = 0
    for (let i = text.indexOf('-----END '); i !== -1; i = text.indexOf('-----END ', i + 1)) {
        if (i < floor) continue
        endRe.lastIndex = i
        const m = endRe.exec(text)
        if (!m) continue
        let j = i
        while (j > floor) {
            const c = text.charCodeAt(j - 1)
            if (!isTokenChar(c) && !isSpace(c) && c !== 58 && c !== 44 && c !== 92) break
            j--
        }
        // Stay clear of a BEGIN line: the forward PEM scan already covers it.
        const begin = text.lastIndexOf('-----BEGIN ', i)
        if (begin >= j) j = text.indexOf('-----', begin + 11) + 5 || j
        floor = i + m[0].length
        if (j < i) out.push({ start: j, end: floor, bare: true })
    }
    return out
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
        if (i - start >= MIN_RUN && entropyOf(text, start, i) >= MIN_ENTROPY) out.push({ start, end: i, bare: true })
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
    const found = matchSpans(text, false, true)
    const all = mask ? [...found, ...runSpans(text), ...pemTails(text)] : found
    // Matches of one pattern arrive in order, so a single-pattern input needs no sort.
    let sorted = true
    for (let i = 1; i < all.length && sorted; i++) sorted = all[i - 1].start < all[i].start
    const spans = sorted
        ? all
        : all.sort((a, b) => a.start - b.start || Number(a.bare ?? false) - Number(b.bare ?? false))
    const intervals: SecretSpan[] = []
    for (const span of spans) {
        const last = intervals[intervals.length - 1]
        if (last && span.start <= last.end) last.end = extend(Math.max(last.end, span.end))
        // The interval starts at its earliest span; a typed-prefix span at the same start wins (sorted first).
        else intervals.push({ start: span.start, end: extend(span.end), bare: span.bare })
    }
    const reps: Replacement[] = []
    let out = ''
    let pos = 0
    for (const iv of intervals) {
        out += text.slice(pos, iv.start)
        const newStart = out.length
        out += iv.bare ? '[redacted]' : text.slice(iv.start, iv.start + 4) + MARKER
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
export function excerptAt(text: string, start: number, endRaw: number): string {
    const end = Math.min(endRaw, start + MAX_EXCERPT) // only ~200 chars survive the cut, so never window a huge span
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
