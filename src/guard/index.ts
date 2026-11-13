/**
 * The session guard (spec §5.4): flag only. It runs the built-in and custom rules over the newest request turn and
 * over each response tool_use block, and logs redacted detection lines. Every rule call is wrapped: a guard
 * failure is lost silently and never reaches the client or the request log line.
 */
import { logDetection, type Severity } from '../audit'
import type { ProxyConfig } from '../config'
import type { Engagement } from '../engagement'
import type { BackendStats } from '../stats'
import { excerptAt } from './redact'
import { exfilMarkup, injectInstruction, newestTurn, secretEgress, type Segment } from './request-rules'
import { cmdRisky, scopeOutOfScope, shellCommand } from './response-rules'

export interface Guard {
    /** Logs request-side hits; returns the unique request-side rule ids in first-hit order (for the header). */
    scanRequest(body: Record<string, unknown>): string[]
    /** Response-side rules and response custom rules over one tool_use block; logs hits. */
    onToolUse(name: string, input: unknown): void
    /** toolcall.unparsed when the backend left tool-call text it could not parse. */
    onEnd(stats: BackendStats): void
}

const MAX_LINES = 20 // D9: per request, both sides together
const MAX_CUSTOM_INPUT = 1024 * 1024

function customMatch(re: RegExp, text: string): string | null {
    const m = re.exec(text)
    return m === null ? null : excerptAt(text, m.index, m.index + m[0].length)
}

/** The text response custom rules see: the shell command, else the JSON input (≤1 MB). */
function responseText(name: string, input: unknown): string {
    return (shellCommand(name, input) ?? JSON.stringify(input) ?? '').slice(0, MAX_CUSTOM_INPUT)
}

/**
 * outOfWindow: applyMode already logged engagement.out_of_window for this request. It counts as one of the 20 lines
 * and leads the request-side ids, so it appears in x-proxy-detections (P4-R29).
 */
export function createGuard(cfg: ProxyConfig, requestId: string, engagement?: Engagement, outOfWindow = false): Guard {
    const { disabled, severity, custom } = cfg.guard
    const requestCustom = custom.filter((c) => c.side === 'request')
    const responseCustom = custom.filter((c) => c.side === 'response')
    let lines = outOfWindow ? 1 : 0

    /** Runs one rule; logs a hit while under the cap. Returns whether the rule hit. */
    const run = (ruleId: string, rule: () => string | null): boolean => {
        try {
            const excerpt = rule()
            if (excerpt === null) return false
            if (lines < MAX_LINES) {
                lines++
                const sev: Severity = severity.get(ruleId) ?? 'medium'
                logDetection({
                    ruleId,
                    severity: sev,
                    requestId,
                    ...(engagement ? { engagement: engagement.name } : {}),
                    excerpt
                })
            }
            return true
        } catch {
            return false // a rule failure is lost silently
        }
    }
    const enabled = (id: string) => !disabled.has(id)

    return {
        scanRequest(body) {
            const hits: string[] = outOfWindow ? ['engagement.out_of_window'] : []
            let segments: Segment[]
            try {
                segments = newestTurn(body.messages)
            } catch {
                return hits
            }
            const rules: [string, (seg: Segment) => string | null][] = [
                ['inject.instruction', injectInstruction],
                ['inject.exfil_markup', (seg) => exfilMarkup(seg, engagement)],
                ['secret.egress', secretEgress]
            ]
            const active = rules.filter(([id]) => enabled(id))
            for (const c of requestCustom) active.push([c.id, (seg) => customMatch(c.re, seg.text)])
            for (const seg of segments) {
                for (const [id, rule] of active) {
                    // Past the line cap a rule already in the header has nothing left to add.
                    if (lines >= MAX_LINES && hits.includes(id)) continue
                    if (run(id, () => rule(seg)) && !hits.includes(id)) hits.push(id)
                }
            }
            return hits
        },

        onToolUse(name, input) {
            if (enabled('cmd.risky')) run('cmd.risky', () => cmdRisky(name, input))
            if (engagement && enabled('scope.out_of_scope')) {
                run('scope.out_of_scope', () => scopeOutOfScope(name, input, engagement))
            }
            if (responseCustom.length === 0) return
            let text: string
            try {
                text = responseText(name, input)
            } catch {
                return
            }
            for (const c of responseCustom) run(c.id, () => customMatch(c.re, text))
        },

        onEnd(stats) {
            if (!enabled('toolcall.unparsed')) return
            run('toolcall.unparsed', () =>
                stats.unparsedToolText ? 'tool-call text in the response could not be parsed into a tool_use' : null
            )
        }
    }
}
