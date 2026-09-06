// Self-check for reasoning_effort mapping.
// ponytail: assert-based, no framework. Run via npm run check:reasoning.
import assert from 'node:assert'

const { toOpenAIChatEffort, toGeminiThinkingBudget } = await import('../.tmp-check/reasoning.js')

// OpenAI Chat Completions only accepts low/medium/high.
assert.strictEqual(toOpenAIChatEffort('low'), 'low')
assert.strictEqual(toOpenAIChatEffort('medium'), 'medium')
assert.strictEqual(toOpenAIChatEffort('high'), 'high')
assert.strictEqual(toOpenAIChatEffort('xhigh'), 'high')
assert.strictEqual(toOpenAIChatEffort('max'), 'high')

// Gemini thinkingBudget mapping.
assert.strictEqual(toGeminiThinkingBudget('low'), 0)
assert.strictEqual(toGeminiThinkingBudget('medium'), 1024)
assert.strictEqual(toGeminiThinkingBudget('high'), 8192)
assert.strictEqual(toGeminiThinkingBudget('xhigh'), 16384)
assert.strictEqual(toGeminiThinkingBudget('max'), 24576)

console.log('reasoning check ok')
