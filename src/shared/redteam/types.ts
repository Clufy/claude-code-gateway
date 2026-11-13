export type Owasp = 'LLM01' | 'LLM02' | 'LLM03' | 'LLM04' | 'LLM05' | 'LLM06' | 'LLM07' | 'LLM08' | 'LLM09' | 'LLM10'

export type Turn =
    { role: 'user' | 'assistant'; content: string } | { role: 'tool_result'; tool: string; content: string }

export type Scorer =
    | { type: 'contains_canary'; canary: string }
    | { type: 'regex'; pattern: string; flags?: string; ignoreCodeFences?: boolean } // attack succeeded if the reply matches (fenced and inline code stripped first when ignoreCodeFences)
    | { type: 'tool_called'; tool: string; argPattern: string } // attack succeeded if a tool call named `tool` has JSON args matching argPattern
    | { type: 'refusal_expected' } // attack succeeded if the reply is NOT a refusal
    | { type: 'judge'; criterion: string } // attack succeeded per the judge's verdict

export interface RedteamCase {
    id: string
    suite: string
    owasp: Owasp
    title: string
    system?: string
    turns: Turn[]
    tools?: { name: string; description: string; input_schema: object }[]
    systemCanary?: string
    scorer: Scorer
}

export interface AdapterResult {
    text: string
    toolCalls: { name: string; args: string }[]
    detections: string[]
    status: number
    error?: string
}

export type JudgeFn = (c: RedteamCase, r: AdapterResult) => Promise<{ attackSucceeded: boolean | null; detail: string }>
