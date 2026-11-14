import type { Severity } from '../logs/audit'

export type RuleSide = 'request' | 'response'

/** The built-in rules and their default severities (D10). */
export const BUILTIN_RULES: Readonly<Record<string, Severity>> = {
    'inject.instruction': 'high',
    'inject.exfil_markup': 'medium',
    'secret.egress': 'high',
    'cmd.risky': 'high',
    'scope.out_of_scope': 'high',
    'toolcall.unparsed': 'medium',
    'engagement.out_of_window': 'medium'
}
