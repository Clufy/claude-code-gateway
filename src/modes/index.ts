import { logDetection } from '../audit'
import type { ProxyConfig } from '../config'
import { inWindow, type ProxyMode } from '../engagement'
import { anthropicError } from '../errors'
import { buildModeBlock } from './block'

export type ModeOk = { ok: true; engagement?: string; mode: ProxyMode }
export type ModeErr = { ok: false; response: Response }

const ALIAS = /^(redteam|purple)\//i
const MODES: readonly string[] = ['redteam', 'purple', 'off']

/** Resolves engagement + mode, strips a mode alias from body.model, appends the pack, logs out-of-window. Mutates body. */
export function applyMode(
    headers: Headers,
    body: any,
    cfg: ProxyConfig,
    requestId: string,
    now: number = Date.now()
): ModeOk | ModeErr {
    const fail = (message: string): ModeErr => ({
        ok: false,
        response: anthropicError(400, 'invalid_request_error', message, requestId)
    })

    const name = headers.get('x-engagement')?.trim() || undefined
    const e = name === undefined ? undefined : cfg.engagements.get(name)
    if (name !== undefined && !e) return fail(`unknown engagement '${name.slice(0, 64)}'`)

    let alias: ProxyMode | undefined
    const match = typeof body.model === 'string' ? ALIAS.exec(body.model) : null
    if (match) {
        alias = match[1].toLowerCase() as ProxyMode
        body.model = body.model.slice(match[0].length)
    }

    const rawHeader = headers.get('x-proxy-mode')
    let headerMode: ProxyMode | undefined
    if (rawHeader !== null) {
        const v = rawHeader.trim().toLowerCase()
        if (!MODES.includes(v)) return fail(`invalid x-proxy-mode '${v}' (use redteam, purple or off)`)
        headerMode = v as ProxyMode
    }

    // The alias wins: a subagent can change only its model.
    const mode = alias ?? headerMode ?? e?.defaultMode ?? 'off'
    if (!e) return mode === 'off' ? { ok: true, mode } : fail(`x-proxy-mode ${mode} needs an x-engagement header`)

    if (mode !== 'off') {
        const s = body.system
        if (s != null && typeof s !== 'string' && !Array.isArray(s)) {
            return fail("'system' must be a string or an array of content blocks")
        }
        appendSystem(body, buildModeBlock(mode, e))
    }
    if (!inWindow(e, now)) {
        const iso = (t: number) => new Date(t).toISOString()
        logDetection({
            ruleId: 'engagement.out_of_window',
            severity: 'medium',
            requestId,
            engagement: name,
            excerpt: `${iso(now)} outside ${iso(e.window.start)}..${iso(e.window.end)}`
        })
    }
    return { ok: true, engagement: name, mode }
}

/** Appends a text block to body.system; existing blocks are left as they are. */
export function appendSystem(body: any, text: string): void {
    if (body.system == null) body.system = text
    else if (typeof body.system === 'string') body.system = `${body.system}\n\n${text}`
    else body.system.push({ type: 'text', text })
}
