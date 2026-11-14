import { expect, it } from 'vitest'
import { toOpenAIChatEffort, toGeminiThinkingBudget } from '../../src/translate/reasoning'

it('maps effort to OpenAI Chat low/medium/high', () => {
    expect(toOpenAIChatEffort('low')).toBe('low')
    expect(toOpenAIChatEffort('medium')).toBe('medium')
    expect(toOpenAIChatEffort('high')).toBe('high')
    expect(toOpenAIChatEffort('xhigh')).toBe('high')
    expect(toOpenAIChatEffort('max')).toBe('high')
})

it('maps effort to Gemini thinkingBudget', () => {
    expect(toGeminiThinkingBudget('low')).toBe(0)
    expect(toGeminiThinkingBudget('medium')).toBe(1024)
    expect(toGeminiThinkingBudget('high')).toBe(8192)
    expect(toGeminiThinkingBudget('xhigh')).toBe(16384)
    expect(toGeminiThinkingBudget('max')).toBe(24576)
})
