// Self-check for rich content block handling.
// ponytail: assert-based, no framework. Run via npm run check:blocks.
import assert from 'node:assert'

// tokens.ts is self-contained, so we can import its compiled output directly.
const { estimateTokens, countTokensForRequest } = await import('../.tmp-check/tokens.js')

assert.strictEqual(estimateTokens('hello'), 2)

const r = countTokensForRequest({
    messages: [
        {
            role: 'user',
            content: [
                { type: 'text', text: 'aaaa' },
                { type: 'document', source: { type: 'text', text: 'bbbb' } },
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'cccc' } },
                { type: 'cache_control', cache_control: { type: 'ephemeral' } }
            ]
        }
    ]
})
assert.ok(r.input_tokens > 0)

console.log('blocks check ok')
