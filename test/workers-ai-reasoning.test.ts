import { describe, expect, it } from 'vitest'
import { callWorker, fakeAI, makeEnv, readSse } from './helpers'

// glm-5.3 on Workers AI sends the same reasoning text in both `reasoning_content` and `reasoning`.
const chunks = [
    { choices: [{ delta: { reasoning_content: 'The user', reasoning: 'The user' } }] },
    { choices: [{ delta: { reasoning_content: ' wants a file.', reasoning: ' wants a file.' } }] },
    { choices: [{ delta: { content: 'Done.' } }] }
]

const post = (stream: boolean) => ({
    method: 'POST',
    headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
    body: JSON.stringify({
        model: '@cf/zai-org/glm-5.3',
        max_tokens: 64,
        stream,
        messages: [{ role: 'user', content: 'hi' }]
    })
})

describe('Workers AI reasoning aliases', () => {
    it('streams thinking once when both reasoning fields carry the same text', async () => {
        const res = await callWorker('/v1/messages', post(true), makeEnv({ AI: fakeAI(chunks) }))
        const thinking = (await readSse(res))
            .filter((e) => e.event === 'content_block_delta' && e.data.delta.type === 'thinking_delta')
            .map((e) => e.data.delta.thinking)
            .join('')
        expect(thinking).toBe('The user wants a file.')
    })

    it('returns thinking once in a non-streaming response', async () => {
        const res = await callWorker('/v1/messages', post(false), makeEnv({ AI: fakeAI(chunks) }))
        const body: any = await res.json()
        expect(body.content.find((b: any) => b.type === 'thinking').thinking).toBe('The user wants a file.')
    })

    it('still reads `reasoning` when `reasoning_content` is absent', async () => {
        const only = [{ choices: [{ delta: { reasoning: 'Plan.' } }] }, { choices: [{ delta: { content: 'ok' } }] }]
        const res = await callWorker('/v1/messages', post(false), makeEnv({ AI: fakeAI(only) }))
        const body: any = await res.json()
        expect(body.content.find((b: any) => b.type === 'thinking').thinking).toBe('Plan.')
    })
})
