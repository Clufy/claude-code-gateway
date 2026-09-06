// Self-check for tool_choice mapping.
// ponytail: assert-based, no framework. Run via npm run check:tool-choice.
import assert from 'node:assert'

const { toOpenAIChatToolChoice, toOpenAIResponsesToolChoice, toGeminiToolConfig } =
    await import('../.tmp-check/tool-choice.js')

// OpenAI Chat Completions
assert.strictEqual(toOpenAIChatToolChoice('auto'), 'auto')
assert.strictEqual(toOpenAIChatToolChoice('any'), 'required')
assert.strictEqual(toOpenAIChatToolChoice('none'), 'none')
assert.deepStrictEqual(toOpenAIChatToolChoice({ type: 'tool', name: 'foo' }), {
    type: 'function',
    function: { name: 'foo' }
})
assert.strictEqual(toOpenAIChatToolChoice('unknown'), undefined)

// OpenAI Responses
assert.strictEqual(toOpenAIResponsesToolChoice('auto'), 'auto')
assert.strictEqual(toOpenAIResponsesToolChoice('any'), 'required')
assert.strictEqual(toOpenAIResponsesToolChoice('none'), 'none')
assert.deepStrictEqual(toOpenAIResponsesToolChoice({ type: 'tool', name: 'foo' }), {
    type: 'function',
    function: { name: 'foo' }
})

// Gemini
assert.strictEqual(toGeminiToolConfig('auto'), undefined)
assert.strictEqual(toGeminiToolConfig(undefined), undefined)
assert.deepStrictEqual(toGeminiToolConfig('any'), {
    functionCallingConfig: { mode: 'ANY' }
})
assert.deepStrictEqual(toGeminiToolConfig('none'), {
    functionCallingConfig: { mode: 'NONE' }
})
assert.deepStrictEqual(toGeminiToolConfig({ type: 'tool', name: 'foo' }), {
    functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['foo'] }
})

console.log('tool choice check ok')
