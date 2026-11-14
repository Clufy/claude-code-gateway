import type { ReasoningEffort } from './types'

// ponytail: centralize effort mapping so one small self-check can cover it.

export function toOpenAIChatEffort(effort: ReasoningEffort): 'low' | 'medium' | 'high' {
    // Chat Completions reasoning models only accept low/medium/high.
    return effort === 'xhigh' || effort === 'max' ? 'high' : effort
}

export function toGeminiThinkingBudget(effort: ReasoningEffort): number {
    // Gemini thinkingBudget is model-specific and caps at 24576 tokens.
    // low=0 disables thinking; max uses the documented ceiling.
    const thinkingBudgets: Record<ReasoningEffort, number> = {
        low: 0,
        medium: 1024,
        high: 8192,
        xhigh: 16384,
        max: 24576
    }
    return thinkingBudgets[effort]
}
