import type { Engagement } from '../engagement'
import { decideToolCall } from './decide'
import { excerptAt, redact } from './redact'

const MAX_EXCERPT = 200
const MAX_RISKY_INPUT = 65536
const OVER_64KB = 'command over 64 KB; only the first 64 KB inspected: '

/** input.command when the tool is Bash or PowerShell and it is a string. */
export function shellCommand(tool: string, input: unknown): string | null {
    if (tool !== 'Bash' && tool !== 'PowerShell') return null
    if (typeof input !== 'object' || input === null) return null
    const c = (input as { command?: unknown }).command
    return typeof c === 'string' ? c : null
}

// rm with flags (checked for recursive + force below) aimed at exactly /, /*, ~, ~/, ~/*, $HOME or ${HOME}.
const RM_ROOT =
    /\brm\s{1,10}((?:--?[a-z-]{1,20}\s{1,10}){1,6})["']?(?:\/\*?|~\/?\*?|\$HOME\/?\*?|\$\{HOME\}\/?\*?)["']?(?=\s|[;&|]|$)/gi

function rmRoot(cmd: string): [number, number] | null {
    for (const m of cmd.matchAll(RM_ROOT)) {
        const flags = m[1].toLowerCase()
        const recursive = /(?:^|\s)-[a-z]{0,10}r|--recursive/.test(flags)
        const force = /(?:^|\s)-[a-z]{0,10}f|--force/.test(flags)
        if (recursive && force) return [m.index, m.index + m[0].length]
    }
    return null
}

// Remove-Item with -Recurse and -Force aimed at a drive root such as C:\.
const PS_REMOVE = /\bRemove-Item\b[^\n;|&]{0,200}/gi
function psRemoveRoot(cmd: string): [number, number] | null {
    for (const m of cmd.matchAll(PS_REMOVE)) {
        const t = m[0]
        if (/\s-recurse\b/i.test(t) && /\s-force\b/i.test(t) && /(?:^|\s)[A-Za-z]:\\?(?=\s|$)/.test(t)) {
            return [m.index, m.index + t.length]
        }
    }
    return null
}

// Every run is bounded; \s{1,10} sits between literals.
const RISKY: readonly RegExp[] = [
    /(?:curl|wget)\b[^|\n]{0,300}\|\s{0,3}(?:sudo(?:\s{1,5}-\S{1,20}){0,3}\s{1,5})?(?:(?:ba|z|k)?sh|python[0-9.]{0,4}|perl|ruby|node)\b/i,
    /\b(?:ba|z|k)?sh\s{1,5}<\(\s{0,3}(?:curl|wget)\b/i,
    /\b(?:ba|z|k)?sh\s{1,5}-c\s{1,5}["']?\$\(\s{0,3}(?:curl|wget)\b/i,
    /\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^|\n]{0,300}\|\s{0,3}(?:iex|Invoke-Expression)\b/i,
    /\b(?:powershell|pwsh)(?:\.exe)?\b[^\n]{0,100}\s-e(?:nc(?:odedcommand)?)?\s{1,5}[A-Za-z0-9+/=]{40}/i,
    /\b(?:iex|Invoke-Expression)\b[^\n]{0,40}\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod|Net\.WebClient|DownloadString)\b/i,
    /Set-MpPreference\s{1,10}-Disable\w{1,40}\s{1,10}\$?true/i,
    /netsh\s{1,10}advfirewall\s{1,10}set\s{1,10}\w{1,20}\s{1,10}state\s{1,10}off/i,
    /\bufw\s{1,10}disable\b/i,
    /systemctl\s{1,10}(?:stop|disable)\s{1,10}(?:firewalld|ufw|apparmor)/i,
    /\bsetenforce\s{1,10}0\b/i,
    /sc(?:\.exe)?\s{1,10}(?:stop|config)\s{1,10}WinDefend/i,
    /\.aws\/credentials/i,
    /\.ssh\/id_[a-z0-9]{1,10}\b(?!\.pub)/i,
    /\/etc\/shadow/i,
    /security\s{1,10}find-(?:generic|internet)-password/i,
    /cmdkey\s{1,10}\/list/i,
    /reg(?:\.exe)?\s{1,10}save\s{1,10}hklm\\(?:sam|security|system)/i,
    /procdump[^\n]{0,80}lsass/i,
    /comsvcs(?:\.dll)?[^\n]{0,40}MiniDump/i,
    /[/\\]Login Data/i,
    /\bmimikatz\b/i,
    /\bmkfs(?:\.\w{1,10})?\s/i,
    /\bdd\s[^\n]{0,80}of=\/dev\/(?:sd|nvme|disk)/i,
    /:\(\)\s{0,2}\{\s{0,2}:\|:&\s{0,2}\};:/
]

/**
 * cmd.risky: a redacted excerpt around the earliest risky match, or null. Only the first 64 KB is scanned, so a
 * huge streamed command cannot hold the stream (P4-R37); a longer command with a clean head is still flagged with
 * an "over 64 KB" excerpt of its start, never dropped (P4-R38).
 */
export function cmdRisky(tool: string, input: unknown): string | null {
    const full = shellCommand(tool, input)
    if (full === null) return null
    const cmd = full.slice(0, MAX_RISKY_INPUT)
    const hit = riskyMatch(cmd)
    if (hit !== null) return excerptAt(cmd, hit[0], hit[1])
    if (full.length <= MAX_RISKY_INPUT) return null
    // redacted over the scanned head (so a token cut at 120 chars is still masked), then cut to 120 chars
    return OVER_64KB + excerptAt(cmd, 0, 120).slice(0, 120)
}

function riskyMatch(cmd: string): [number, number] | null {
    let best = rmRoot(cmd)
    const ps = psRemoveRoot(cmd)
    if (ps !== null && (best === null || ps[0] < best[0])) best = ps
    for (const re of RISKY) {
        const m = re.exec(cmd)
        if (m !== null && (best === null || m.index < best[0])) best = [m.index, m.index + m[0].length]
    }
    return best
}

/** scope.out_of_scope: the window is treated as open (the request side logs out_of_window). */
export function scopeOutOfScope(tool: string, input: unknown, e: Engagement): string | null {
    const d = decideToolCall(e, tool, input, e.window.start)
    if (d.decision === 'allow') return null
    return redact(`${tool}: ${d.reasons.join('; ')}`).slice(0, MAX_EXCERPT)
}
