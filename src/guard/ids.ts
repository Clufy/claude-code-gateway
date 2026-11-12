import type { Severity } from '../audit'

export type RuleSide = 'request' | 'response'

/** The built-in rules and their default severities (D10). */
export const BUILTIN_RULES: Readonly<Record<string, { side: RuleSide; severity: Severity }>> = {
    'inject.instruction': { side: 'request', severity: 'high' },
    'inject.exfil_markup': { side: 'request', severity: 'medium' },
    'secret.egress': { side: 'request', severity: 'high' },
    'cmd.risky': { side: 'response', severity: 'high' },
    'scope.out_of_scope': { side: 'response', severity: 'high' },
    'toolcall.unparsed': { side: 'response', severity: 'medium' },
    'engagement.out_of_window': { side: 'request', severity: 'medium' }
}
