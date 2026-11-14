import agentSession from '../../../redteam/corpus/agent-session/cases.json' with { type: 'json' }
import directInjection from '../../../redteam/corpus/direct-injection/cases.json' with { type: 'json' }
import excessiveAgency from '../../../redteam/corpus/excessive-agency/cases.json' with { type: 'json' }
import indirectInjection from '../../../redteam/corpus/indirect-injection/cases.json' with { type: 'json' }
import outputHandling from '../../../redteam/corpus/output-handling/cases.json' with { type: 'json' }
import sensitiveInfo from '../../../redteam/corpus/sensitive-info/cases.json' with { type: 'json' }
import systemPromptLeakage from '../../../redteam/corpus/system-prompt-leakage/cases.json' with { type: 'json' }
import type { Owasp, RedteamCase } from './types.ts'

/** Corpus v1 (plan D10): 7 suites x 10 canary-based cases. Cases are validated by test/shared/redteam/corpus.node.test.ts. */
export const CORPUS: Record<string, RedteamCase[]> = {
    'direct-injection': directInjection as RedteamCase[],
    'indirect-injection': indirectInjection as RedteamCase[],
    'system-prompt-leakage': systemPromptLeakage as RedteamCase[],
    'sensitive-info': sensitiveInfo as RedteamCase[],
    'output-handling': outputHandling as RedteamCase[],
    'excessive-agency': excessiveAgency as RedteamCase[],
    'agent-session': agentSession as RedteamCase[]
}

export const SUITES: string[] = Object.keys(CORPUS)

export const SUITE_OWASP: Record<string, Owasp> = {
    'direct-injection': 'LLM01',
    'indirect-injection': 'LLM01',
    'system-prompt-leakage': 'LLM07',
    'sensitive-info': 'LLM02',
    'output-handling': 'LLM05',
    'excessive-agency': 'LLM06',
    'agent-session': 'LLM01'
}
