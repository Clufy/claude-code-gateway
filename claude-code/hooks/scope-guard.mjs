// @ts-check
// Claude Code PreToolUse hook: relays Bash / PowerShell / WebFetch calls to the Worker's
// POST /v1/guard/check during an engagement and denies on "deny" or on any failure.
// It never prints permissionDecision "allow" (that would skip the user's permission prompt).
// Allow is a silent exit 0. Dependency-free; uses only fetch, process and AbortSignal.

const UNAVAILABLE = 'scope check unavailable; set PROXY_SCOPE_HOOK=off to bypass'

/** @param {string} reason */
function deny(reason) {
    return JSON.stringify({
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: reason
        }
    })
}

/**
 * Header lines to a map. For a repeated name the first non-empty value wins, so a later empty
 * `x-engagement:` line cannot switch the hook off.
 * @param {string | undefined} raw @returns {Map<string, string>}
 */
function parseHeaders(raw) {
    const out = new Map()
    for (const line of (raw ?? '').split(/\r?\n/)) {
        const i = line.indexOf(':')
        if (i <= 0) continue
        const name = line.slice(0, i).trim().toLowerCase()
        if (name && !out.get(name)) out.set(name, line.slice(i + 1).trim())
    }
    return out
}

async function readStdin() {
    const chunks = []
    for await (const c of process.stdin) chunks.push(c)
    return Buffer.concat(chunks).toString('utf8')
}

/**
 * Rejects when the signal aborts. AbortSignal.timeout does not end `for await (process.stdin)`, so stdin is
 * raced against this.
 * @param {AbortSignal} signal @returns {Promise<never>}
 */
function aborted(signal) {
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('timeout'))))
}

/** @param {string} engagement @param {Map<string, string>} headers @returns {Promise<string | null>} */
async function check(engagement, headers) {
    // one 3 s budget for reading stdin and asking the Worker
    const signal = AbortSignal.timeout(3000)
    const input = JSON.parse(await Promise.race([readStdin(), aborted(signal)]))
    if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('bad stdin')
    const base = process.env.ANTHROPIC_BASE_URL
    if (!base) throw new Error('no base url')
    const key =
        headers.get('x-proxy-key') ||
        headers.get('x-api-key') ||
        process.env.ANTHROPIC_API_KEY ||
        process.env.ANTHROPIC_AUTH_TOKEN
    /** @type {Record<string, string>} */
    const reqHeaders = { 'content-type': 'application/json' }
    if (key) reqHeaders['x-api-key'] = key
    const res = await fetch(new URL('/v1/guard/check', base), {
        method: 'POST',
        headers: reqHeaders,
        body: JSON.stringify({ engagement, tool: input.tool_name, input: input.tool_input }),
        redirect: 'error', // a redirect could hand the decision to another server
        signal
    })
    if (res.status !== 200) throw new Error(`status ${res.status}`)
    const body = await res.json()
    if (body?.decision === 'allow') return null
    if (body?.decision === 'deny' && Array.isArray(body.reasons)) {
        return deny(`scope-guard (${engagement}): ${body.reasons.join('; ')}`)
    }
    throw new Error('bad response')
}

async function main() {
    if ((process.env.PROXY_SCOPE_HOOK ?? '').toLowerCase() === 'off') return null
    const headers = parseHeaders(process.env.ANTHROPIC_CUSTOM_HEADERS)
    const engagement = headers.get('x-engagement')
    if (!engagement) return null
    // From here on every failure is a deny: a crash would be a non-blocking error (fail open).
    try {
        return await check(engagement, headers)
    } catch {
        return deny(UNAVAILABLE)
    }
}

let out = null
try {
    out = await main()
} catch {
    out = deny(UNAVAILABLE)
}
process.exitCode = 0
if (out) process.stdout.write(out, () => process.exit(0))
