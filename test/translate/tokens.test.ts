import { expect, it } from 'vitest'
import { estimateTokens, countTokensForRequest } from '../../src/translate/tokens'

it('counts tokens for rich content blocks', () => {
    expect(estimateTokens('hello')).toBe(2)

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
    } as any)
    expect(r.input_tokens).toBeGreaterThan(0)
})
