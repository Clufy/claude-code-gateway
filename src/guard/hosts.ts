/**
 * Host extractor (plan D1–D5): pulls URLs, hostnames, IPs and CIDRs out of tool inputs and shell commands. The
 * candidates are raw strings for checkScope: `scheme://authority` (userinfo dropped), a bare host, an IP or a CIDR.
 * Matching is lexical, never DNS. A hand tokenizer keeps it linear; no regex here has a nested quantifier.
 *
 * Documented limits:
 * - Shell indirection (variables, `$(…)`, backticks, brace expansion, encodings) can hide a host. A URL whose host
 *   is indirect is still returned so checkScope rejects it (D3); a bare indirect token is skipped (D2).
 * - A script written to disk and then run is not seen: file-content fields are never scanned (D1).
 * - Single-label hosts (`dc01`) and names outside the PSL ICANN section are found only under an engagement
 *   domain (`knownDomains`). Two-label names ending in a common file extension (`evil.py`) are skipped (D2).
 * - Inline interpreter code (`node -e`, `python -c`, …) gets full extraction only inside its quoted strings;
 *   elsewhere URLs and IPs only, since `obj.name` there is code. Heredoc bodies are scanned as shell text.
 * - Targets read from files are not seen (`nmap -iL`, `wget -i`, `nuclei -l`, `curl -K`).
 * - Obfuscation hides a host: PowerShell backticks or cmd `^` inside a name, an interior backslash, short or
 *   decimal IPv4 (`10.1`, `167772161`) and brace expansion (`{a,b}.evil.com`).
 * - At most 65 unique candidates are returned: D8 denies more than 64 anyway.
 */
import { isObj, parseCidr, parseIp } from '../engagement'
import { isRegistrable } from './psl'

export interface ExtractOptions {
    shell: boolean // full extraction (D1) vs URLs + IP literals only
    knownDomains?: readonly string[] // engagement scope + exclude domains, '*.' prefix allowed (D2)
}

const MAX_HOST = 253
const BUDGET = 1_000_000
const MAX_CANDIDATES = 65 // D8 denies more than 64, so collecting stops here (P4-R7)
/** Appended by hostsInToolInput when the 1 MB budget ran out before every string was scanned (P4-R6). */
export const INPUT_TOO_LARGE = '(tool input over 1 MB)'
/** Appended when collection stopped at the candidate cap (P4-R11); the decision denies on it. */
export const TOO_MANY_TARGETS = '(more than 64 targets)'
const CODE_QUOTES = ['"', "'", '`'] // string delimiters inside inline code, JS template literals included (P4-R12)
const FILE_EXTS = new Set('ai am cc gz in java md mk ml mov pl pm ps pub py rs sc sh so tf zip'.split(' '))
const MESSAGE_FLAGS = ['-m', '-am', '--message', '--author', '--body', '--title'] // D4
const MESSAGE_PROGRAMS = new Set(['git', 'gh', 'glab', 'hub']) // P4-R5: D4 applies only to these
// skipped when finding a segment's program (P4-R5, P4-R9), with `timeout`'s duration; a flag after one makes the
// program unknown (P4-R10)
const PROGRAM_PREFIX = new Set(['sudo', 'env', 'command', 'time', 'nohup', 'xargs', 'timeout'])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const INTERPRETER = /^(node|nodejs|bun|deno|python[0-9.]*|py|pypy[0-9.]*|ruby|perl|php[0-9.]*|lua[0-9.]*|rscript)$/
const CODE_FLAG = /^(-[A-Za-z]*[ceE]|-[pr]|--eval|--print)$/
const SEGMENT = new Set([';', '|', '&', '(', ')', '\n', '\r'])
const SUB_BREAK = /[\s;|&()<>"'`,=]/
const SPACE = /\s/
const SCHEME_CHAR = /[A-Za-z0-9+.-]/
const LETTER = /[A-Za-z]/
const DIGIT = /[0-9]/
const HOST_CHAR = /[A-Za-z0-9._-]/

const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])
const FILE_CONTENT = new Map([
    ['Write', ['content']],
    ['Edit', ['old_string', 'new_string']],
    ['MultiEdit', ['edits']],
    ['NotebookEdit', ['new_source']]
])
const HOST_FIELD = /^(url|uri|host|hostname|domain|target|endpoint)s?$/i

interface Word {
    text: string
    newSegment: boolean
}

/** Split shell text into words: quotes group (and are removed), `;|&()` and newlines also end a command segment. */
function shellWords(text: string): Word[] {
    const words: Word[] = []
    let cur = ''
    let inWord = false
    let seg = true
    const flush = () => {
        if (inWord) {
            words.push({ text: cur, newSegment: seg })
            seg = false
        }
        cur = ''
        inWord = false
    }
    for (let i = 0; i < text.length; i++) {
        const c = text[i]
        // `$'…'` and `$"…"` are quoting, not indirection (P4-R7)
        if (c === '$' && (text[i + 1] === "'" || text[i + 1] === '"')) continue
        if (c === "'" || c === '"') {
            let j = i + 1
            while (j < text.length && text[j] !== c) j += c === '"' && text[j] === '\\' ? 2 : 1
            cur += text.slice(i + 1, Math.min(j, text.length))
            inWord = true
            i = j
        } else if (SEGMENT.has(c)) {
            flush()
            seg = true
        } else if (c === '<' || c === '>' || c <= ' ' || (c > '~' && SPACE.test(c))) flush()
        else {
            cur += c
            inWord = true
        }
    }
    flush()
    return words
}

function isIp(s: string): boolean {
    if (s.length > 45) return false // the longest IP literal (IPv6 with an IPv4 tail) is 45 chars
    const ip = parseIp(s)
    // a bare IPv6 needs a digit, so `face::` or `a::b` in code is not an address
    return ip !== null && (ip.family === 4 || DIGIT.test(s))
}

function trimDots(s: string): string {
    let n = s.length
    while (n > 0 && s[n - 1] === '.') n--
    return s.slice(0, n)
}

/** D2: a name under a PSL ICANN suffix (not `x.py`-style), or under an engagement domain. */
function isHost(p: string, known: readonly string[]): boolean {
    if (p === '' || p.length > MAX_HOST) return false
    let ascii = true
    for (const c of p) {
        if (c.charCodeAt(0) > 0x7f) ascii = false
        else if (!HOST_CHAR.test(c)) return false
    }
    let h = p.toLowerCase()
    if (!ascii) {
        const u = URL.parse(`http://${h}`)
        if (u === null) return false
        h = u.hostname
        if (parseIp(h) !== null) return true // IDNA maps full-width digits and dots to an IPv4
    }
    const labels = h.split('.')
    if (labels.length < 2 || labels.some((l) => l === '' || l.startsWith('-') || l.endsWith('-'))) return false
    if (known.some((d) => h === d || h.endsWith(`.${d}`))) return true
    if (labels.length === 2 && FILE_EXTS.has(labels[1])) return false
    return isRegistrable(h)
}

function cutPath(s: string): string {
    let i = 0
    while (i < s.length && s[i] !== '/' && s[i] !== '\\' && s[i] !== '?' && s[i] !== '#') i++
    return s.slice(0, i)
}

/** `scheme://authority` with userinfo dropped; null for no scheme or `file://` (D5). */
function urlCandidate(t: string, sep: number, shell: boolean): string | null {
    let s = sep
    while (s > 0 && SCHEME_CHAR.test(t[s - 1])) s--
    while (s < sep && !LETTER.test(t[s])) s++
    if (s === sep) return null
    const scheme = t.slice(s, sep)
    if (scheme.toLowerCase() === 'file') return null
    let auth = cutPath(t.slice(sep + 3))
    auth = auth.slice(auth.lastIndexOf('@') + 1)
    // drop trailing prose punctuation, but keep a `]` or `}` whose opener is in the authority (`[v6]`, `${HOST}`)
    const bracket = auth.includes('[')
    const brace = auth.includes('{')
    let n = auth.length
    while (n > 0) {
        const c = auth[n - 1]
        if (c === ']' ? bracket : c === '}' ? brace : !'.:!*'.includes(c)) break
        n--
    }
    auth = auth.slice(0, n)
    // in shell text an empty authority is indirection (`http://"$H"`, backticks): returned so checkScope rejects it
    if (auth === '' && !shell) return null
    return `${scheme}://${auth}`
}

/**
 * Bare token: CIDR, `user@host`, Impacket `domain/user@host`, scp `host:path`, UNC `\\host\share` or `//host/share`,
 * `/dev/tcp/host/port`, `host:port`, `[v6]`, IP or hostname. `isHost` is null when only IPs are wanted.
 */
function bareCandidates(token: string, isHost: ((p: string) => boolean) | null, out: Set<string>): void {
    const t = trimDots(token)
    if (!t.includes('.') && !t.includes(':')) return // an IP, CIDR or hostname has a dot or a colon
    const slash = t.indexOf('/')
    if (slash > 0 && parseCidr(t) !== null && isIp(t.slice(0, slash))) {
        out.add(t)
        return
    }
    const dev = Math.max(t.indexOf('/dev/tcp/'), t.indexOf('/dev/udp/'))
    let h = dev === -1 ? t : t.slice(dev + 9)
    let lead = 0
    while (lead < h.length && (h[lead] === '\\' || h[lead] === '/')) lead++
    if (lead >= 2) {
        // UNC, also bash-escaped (4 backslashes); WebDAV `\\host@SSL@443\path` ends the host at the first `@`
        h = h.slice(lead)
        if (h.includes('@')) h = h.slice(0, h.indexOf('@'))
        hostCandidates(cutPath(h), isHost, out)
        return
    }
    const cut = cutPath(h)
    const at = h.lastIndexOf('@')
    // an `@` past the path cut gives both: `acme.local/admin@10.0.0.5` and `evil.example.org/mod@latest`
    hostCandidates(cut.slice(cut.lastIndexOf('@') + 1), isHost, out)
    if (at >= cut.length) hostCandidates(cutPath(h.slice(at + 1)), isHost, out)
}

/** A host part with the path already cut: `[v6]`, IP, or `:`-separated IPs and hostnames. */
function hostCandidates(h: string, isHost: ((p: string) => boolean) | null, out: Set<string>): void {
    if (h.includes('$')) return // D2: shell indirection (a `//h/C$` share name is already cut off)
    if (h.startsWith('[')) {
        const inner = h.slice(1, Math.max(h.indexOf(']'), 1))
        if (isIp(inner)) out.add(inner)
        return
    }
    if (isIp(h)) {
        out.add(h)
        return
    }
    // every `:` part, not only the first: `TCP:host:443`, `--resolve host:443:ip`, `-L 8080:ip:80`
    for (const part of h.split(':')) {
        const p = trimDots(part)
        if (isIp(p) || (isHost !== null && isHost(p))) out.add(p)
    }
}

/**
 * At most 65 candidates, then TOO_MANY_TARGETS when collection hit the cap (P4-R11): padding such as case or
 * `:port` variants of one host collapses in checkScope and could otherwise hide the next host. An inner call's
 * marker survives the union in hostsInToolInput.
 */
function capped(out: Set<string>): string[] {
    const hosts = [...out].filter((h) => h !== TOO_MANY_TARGETS)
    if (hosts.length < MAX_CANDIDATES && !out.has(TOO_MANY_TARGETS)) return hosts
    return [...hosts.slice(0, MAX_CANDIDATES), TOO_MANY_TARGETS]
}

/** Raw candidates in first-seen order, deduped. Shell mode adds bare hosts and the D4 message-argument skip. */
export function extractHosts(text: string, opts: ExtractOptions): string[] {
    const known = (opts.knownDomains ?? []).map((d) => d.toLowerCase().replace(/^\*\./, '')).filter((d) => d !== '')
    const out = new Set<string>()
    const memo = new Map<string, boolean>()
    const hostCheck = (p: string): boolean => {
        let v = memo.get(p)
        if (v === undefined) memo.set(p, (v = isHost(p, known)))
        return v
    }
    const scan = (s: string, hosts: boolean) => {
        for (const t of s.split(SUB_BREAK)) {
            if (out.size >= MAX_CANDIDATES) return
            if (t === '') continue
            const sep = t.indexOf('://')
            if (sep === -1) bareCandidates(t, hosts ? hostCheck : null, out)
            else {
                const url = urlCandidate(t, sep, opts.shell)
                if (url !== null) out.add(url)
            }
        }
    }
    // inline code: full extraction inside its quoted strings (fail closed), URLs and IPs elsewhere
    const scanCode = (s: string) => {
        let start = 0
        let quote = ''
        for (let i = 0; i < s.length; i++) {
            if (quote === '' ? !CODE_QUOTES.includes(s[i]) : s[i] !== quote) continue
            scan(s.slice(start, i), quote !== '')
            quote = quote === '' ? s[i] : ''
            start = i + 1
        }
        scan(s.slice(start), quote !== '')
    }
    const result = () => capped(out)
    if (!opts.shell) {
        scan(text, false)
        return result()
    }
    let skipNext = false
    let codeNext = false
    let flagsOpen = false // an interpreter's options, before its first positional argument (the script)
    let awaitDuration = false
    let program: string | null = null // the segment's command past prefixes and VAR=value; '' when unknown
    for (const w of shellWords(text)) {
        if (out.size >= MAX_CANDIDATES) break
        if (w.newSegment) {
            skipNext = codeNext = flagsOpen = awaitDuration = false
            program = null
        }
        if (skipNext) {
            skipNext = false
            continue
        }
        const lw = w.text.toLowerCase()
        if (codeNext) {
            codeNext = flagsOpen = false
            scanCode(w.text)
            continue
        }
        if (program === null) {
            const base = lw.slice(Math.max(lw.lastIndexOf('/'), lw.lastIndexOf('\\')) + 1).replace(/\.exe$/, '')
            const duration = awaitDuration && DIGIT.test(lw[0]) // `timeout 30 cmd`, directly after `timeout`
            awaitDuration = false
            if (PROGRAM_PREFIX.has(base)) awaitDuration = base === 'timeout'
            else if (lw.startsWith('-')) {
                // a prefix's flag may take a value that looks like a program (`sudo -u git`): the program is unknown,
                // so no D4 skip and no interpreter mode for this segment (P4-R10, fail closed)
                program = ''
            } else if (ASSIGNMENT.test(w.text) || duration) {
                // VAR=value, or timeout's duration
            } else {
                program = base
                flagsOpen = INTERPRETER.test(base)
            }
        } else if (MESSAGE_PROGRAMS.has(program)) {
            if (MESSAGE_FLAGS.includes(lw)) {
                skipNext = true
                continue
            }
            if (MESSAGE_FLAGS.some((f) => f.startsWith('--') && lw.startsWith(`${f}=`))) continue
        } else if (flagsOpen) {
            if (CODE_FLAG.test(w.text)) {
                codeNext = true
                continue
            }
            if (!lw.startsWith('-')) flagsOpen = false
        }
        scan(w.text, true)
    }
    return result()
}

/**
 * D1 per tool: Bash/PowerShell `command` gets full shell extraction. Other tools: URLs and IPs in every string,
 * bare hosts too in host-like fields; file-content fields are never scanned. 1 MB total string budget.
 */
export function hostsInToolInput(tool: string, input: unknown, knownDomains?: readonly string[]): string[] {
    if (!isObj(input)) return []
    const out = new Set<string>()
    let budget = BUDGET
    let truncated = false
    const take = (s: string, shell: boolean) => {
        if (s.length > budget) truncated = true
        const t = s.slice(0, budget)
        budget -= t.length
        for (const h of extractHosts(t, { shell, knownDomains })) out.add(h)
    }
    // fail closed: an unscanned remainder could hide a host
    const result = () => (truncated ? [...capped(out), INPUT_TOO_LARGE] : capped(out))
    if (SHELL_TOOLS.has(tool)) {
        if (typeof input.command === 'string') take(input.command, true)
        return result()
    }
    const skip = FILE_CONTENT.get(tool) ?? []
    // iterative walk in document order (deep nesting must not overflow the stack)
    const stack: [string, unknown][] = Object.entries(input)
        .filter(([k]) => !skip.includes(k))
        .reverse()
    while (stack.length > 0 && !truncated && out.size < MAX_CANDIDATES) {
        const [key, v] = stack.pop()!
        if (typeof v === 'string') take(v, HOST_FIELD.test(key))
        else if (Array.isArray(v)) for (let i = v.length - 1; i >= 0; i--) stack.push([key, v[i]])
        else if (isObj(v)) {
            const entries = Object.entries(v)
            for (let i = entries.length - 1; i >= 0; i--) stack.push(entries[i])
        }
    }
    return result()
}
