/**
 * Host extractor (plan D1–D5): pulls URLs, hostnames, IPs and CIDRs out of tool inputs and shell commands. The
 * candidates are raw strings for checkScope: `scheme://authority` (userinfo dropped), a bare host, an IP or a CIDR.
 * Matching is lexical, never DNS. A hand tokenizer keeps it linear; no regex here has a nested quantifier.
 * Where clients disagree, every reading is emitted (fail closed): WHATWG leniency (`https:/h`, `https:\\h`, tab or
 * newline inside a WebFetch URL or a code string), `a.com\@b.com` (curl and wget reach b.com), octal or hex dotted
 * quads (`0127.0.0.1`, read by checkScope as 87.0.0.1) and IPv6 zone IDs (`fe80::1%eth0` → `fe80::1`).
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
const SPECIAL_SCHEMES = new Set(['http', 'https', 'ws', 'wss', 'ftp']) // WHATWG: slashes and backslashes are lenient
const URL_STRIPPED = /[\t\n\r]/g // removed by the WHATWG URL parser anywhere in the input
const CODE_ESCAPES = /\\[tnr]/g // the same characters written as escapes inside a code string
const QUAD_PART = /^(?:0[xX][0-9a-fA-F]{0,8}|[0-9]{1,11})$/

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

/**
 * The first URL in a token: `scheme://` for any scheme, or a WHATWG special scheme followed by any run of `/` and
 * `\` (`https:/h`, `https:\\h`, `https:///h` all reach h). Other schemes need `//`, so `C:\Users` is not a URL.
 * `rest` starts at the authority and `start` is the scheme's index. The scheme is '' when no letter precedes the
 * colon (then nothing is emitted).
 */
function findUrl(t: string): { start: number; scheme: string; rest: string } | null {
    for (let c = t.indexOf(':'); c !== -1; c = t.indexOf(':', c + 1)) {
        if (t[c + 1] !== '/' && t[c + 1] !== '\\') continue
        let s = c
        while (s > 0 && SCHEME_CHAR.test(t[s - 1])) s--
        while (s < c && !LETTER.test(t[s])) s++
        const scheme = t.slice(s, c)
        if (SPECIAL_SCHEMES.has(scheme.toLowerCase())) {
            let a = c + 1
            while (a < t.length && (t[a] === '/' || t[a] === '\\')) a++
            return { start: s, scheme, rest: t.slice(a) }
        }
        if (t.startsWith('//', c + 1)) return { start: s, scheme, rest: t.slice(c + 3) }
    }
    return null
}

/** Adds `scheme://authority`; drops trailing prose punctuation. */
function addAuthority(scheme: string, authority: string, shell: boolean, out: Set<string>): void {
    // keep a `]` or `}` whose opener is in the authority (`[v6]`, `${HOST}`)
    const bracket = authority.includes('[')
    const brace = authority.includes('{')
    let n = authority.length
    while (n > 0) {
        const c = authority[n - 1]
        if (c === ']' ? bracket : c === '}' ? brace : !'.:!*'.includes(c)) break
        n--
    }
    const auth = authority.slice(0, n)
    // in shell text an empty authority is indirection (`http://"$H"`, backticks): returned so checkScope rejects it
    if (auth === '' && !shell) return
    out.add(`${scheme}://${auth}`)
}

/** `scheme://authority` with userinfo dropped; nothing for no scheme or `file://` (D5). */
function urlCandidates(scheme: string, rest: string, shell: boolean, out: Set<string>): void {
    if (scheme === '' || scheme.toLowerCase() === 'file') return
    const cut = cutPath(rest)
    addAuthority(scheme, cut.slice(cut.lastIndexOf('@') + 1), shell, out)
    // curl, wget and urllib3 read `a.com\@b.com` as userinfo then host b.com: emit both readings (fail closed)
    if (rest[cut.length] === '\\') {
        const at = rest.lastIndexOf('@')
        if (at > cut.length) addAuthority(scheme, cutPath(rest.slice(at + 1)), shell, out)
    }
}

/**
 * The WHATWG reading of a whole string (what WebFetch and `fetch` request): tab, CR and LF are stripped, so
 * `https://a.com<TAB>.evil.org` is the host `a.com.evil.org`. Emits `protocol//host`; skips `file:` and no host.
 */
function whatwgCandidate(v: string, out: Set<string>): void {
    if (!v.includes(':')) return
    const u = URL.parse(v.replace(URL_STRIPPED, ''))
    if (u === null || u.protocol === 'file:' || u.host === '') return
    out.add(`${u.protocol}//${u.host}`)
}

/** a.b.c.d where a part is octal (leading 0) or 0x-hex: inet_aton and WHATWG read it as an IPv4 (P4-R15). */
function isOddQuad(p: string): boolean {
    if (p.length > 47) return false
    const parts = p.split('.')
    return (
        parts.length === 4 && parts.every((x) => QUAD_PART.test(x)) && parts.some((x) => x.length > 1 && x[0] === '0')
    )
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
        const inner = withoutZone(h.slice(1, Math.max(h.indexOf(']'), 1)))
        if (isIp(inner)) out.add(inner)
        return
    }
    const ip = withoutZone(h)
    if (isIp(ip) || isOddQuad(ip)) {
        out.add(ip)
        return
    }
    // every `:` part, not only the first: `TCP:host:443`, `--resolve host:443:ip`, `-L 8080:ip:80`
    for (const part of h.split(':')) {
        const p = trimDots(part)
        if (isIp(p) || isOddQuad(p) || (isHost !== null && isHost(p))) out.add(p)
    }
}

/** `fe80::1%eth0` → `fe80::1` (an IPv6 zone ID, also `%25eth0` in a URL); other text unchanged. */
function withoutZone(h: string): string {
    const pct = h.indexOf('%')
    return pct > 0 && isIp(h.slice(0, pct)) ? h.slice(0, pct) : h
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
            const url = findUrl(t)
            if (url === null) bareCandidates(t, hosts ? hostCheck : null, out)
            else {
                urlCandidates(url.scheme, url.rest, opts.shell, out)
                // `evil.org/https://ok.com`: curl and wget connect to the text before the scheme (P4-R39)
                if (url.start > 0) bareCandidates(t.slice(0, url.start), hosts ? hostCheck : null, out)
            }
        }
    }
    // inline code: full extraction inside its quoted strings (fail closed), URLs and IPs elsewhere
    const scanPiece = (piece: string, quoted: boolean) => {
        scan(piece, quoted)
        if (!quoted) return
        // a quoted string is what fetch/urlopen parse; `\t` escapes become the stripped characters at run time
        whatwgCandidate(piece, out)
        if (piece.includes('\\')) whatwgCandidate(piece.replace(CODE_ESCAPES, ''), out)
    }
    const scanCode = (s: string) => {
        let start = 0
        let quote = ''
        for (let i = 0; i < s.length; i++) {
            if (quote === '' ? !CODE_QUOTES.includes(s[i]) : s[i] !== quote) continue
            scanPiece(s.slice(start, i), quote !== '')
            quote = quote === '' ? s[i] : ''
            start = i + 1
        }
        scanPiece(s.slice(start), quote !== '')
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
    const take = (s: string, shell: boolean, whole: boolean) => {
        if (s.length > budget) truncated = true
        const t = s.slice(0, budget)
        budget -= t.length
        for (const h of extractHosts(t, { shell, knownDomains })) out.add(h)
        if (whole) whatwgCandidate(t, out) // the whole field as WebFetch would parse it (A1)
    }
    // fail closed: an unscanned remainder could hide a host
    const result = () => (truncated ? [...capped(out), INPUT_TOO_LARGE] : capped(out))
    if (SHELL_TOOLS.has(tool)) {
        if (typeof input.command === 'string') take(input.command, true, false)
        return result()
    }
    const skip = FILE_CONTENT.get(tool) ?? []
    // iterative walk in document order (deep nesting must not overflow the stack)
    const stack: [string, unknown][] = Object.entries(input)
        .filter(([k]) => !skip.includes(k))
        .reverse()
    while (stack.length > 0 && !truncated && out.size < MAX_CANDIDATES) {
        const [key, v] = stack.pop()!
        if (typeof v === 'string') take(v, HOST_FIELD.test(key), true)
        else if (Array.isArray(v)) for (let i = v.length - 1; i >= 0; i--) stack.push([key, v[i]])
        else if (isObj(v)) {
            const entries = Object.entries(v)
            for (let i = entries.length - 1; i >= 0; i--) stack.push(entries[i])
        }
    }
    return result()
}
