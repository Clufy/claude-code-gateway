import type { Engagement } from '../engagement'
import { PURPLE_METHOD } from './packs/purple'
import { REDTEAM_METHOD } from './packs/redteam'

export const FINDING_FORMAT = `Write each finding to findings/<id>.md (id: short-kebab-case) with:
# <title>
Severity: critical|high|medium|low|info
ATT&CK: <technique IDs, e.g. T1190>
## Evidence
## Reproduction
## Remediation`

const list = (items: string[]): string => (items.length ? items.join(', ') : 'none')

function scopeLine(e: Engagement): string {
    const { domains, cidrs, llmTargets } = e.scope
    return `domains: ${list(domains)}; cidrs: ${list(cidrs)}; llm targets: ${list(llmTargets)}`
}

export function buildModeBlock(mode: 'redteam' | 'purple', e: Engagement): string {
    const lines = [
        `Engagement ${e.name}: ${mode} mode`,
        `In scope: ${scopeLine(e)}`,
        `Excluded: domains: ${list(e.exclude.domains)}; cidrs: ${list(e.exclude.cidrs)}`,
        `Window (UTC): ${new Date(e.window.start).toISOString()} to ${new Date(e.window.end).toISOString()}`
    ]
    if (e.roe.trim()) lines.push(`Rules of engagement: ${e.roe.trim()}`)
    lines.push(
        mode === 'purple' ? PURPLE_METHOD : REDTEAM_METHOD,
        'Only act against in-scope targets; if a request targets anything outside scope or outside the window, say so and do not run it.',
        FINDING_FORMAT,
        `Scope (repeat): ${scopeLine(e)}`
    )
    return lines.join('\n')
}
