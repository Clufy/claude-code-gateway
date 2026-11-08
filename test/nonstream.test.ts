import { describe, expect, it } from 'vitest'
import { WorkersAIProvider } from '../src/providers/workers-ai'
import { fakeAI } from './helpers'

const OPEN = '<' + 'tool_call' + '>'
const CLOSE = '<' + '/tool_call' + '>'

async function call(chunks: unknown[], stream?: boolean) {
    const provider = new WorkersAIProvider({ AI: fakeAI(chunks) } as any)
    const body = JSON.stringify({
        model: 'm',
        stream: stream ?? false,
        max_tokens: 100,
        tools: [{ name: 'get_weather', description: 'd', input_schema: { type: 'object' } }],
        messages: [{ role: 'user', content: 'weather in Paris?' }]
    })
    const request = new Request('http://x/v1/messages', { method: 'POST', body })
    return provider.handle(request, 'req_test')
}

describe('Workers AI non-streaming path', () => {
    it('1. text answer plus hermes-format tool call: both must survive', async () => {
        const res = await call([
            { response: 'Sure! ' },
            { response: `${OPEN}{"name": "get_weather", "arguments": {"city": "Paris"}}${CLOSE}` },
            { response: '', p: 'STOP' }
        ])
        expect(res.status).toBe(200)
        const claude: any = await res.json()
        expect(claude.stop_reason).toBe('tool_use')
        expect(
            claude.content.some((b: any) => b.type === 'text' && b.text === 'Sure! '),
            `answer text was dropped: ${JSON.stringify(claude.content)}`
        ).toBe(true)
        const tool = claude.content.find((b: any) => b.type === 'tool_use')
        expect(tool, 'hermes tool call was dropped').toBeTruthy()
        expect(tool.name).toBe('get_weather')
        expect(tool.input).toEqual({ city: 'Paris' })
        expect(tool.id, 'tool_use block needs an id').toBeTruthy()
    })

    it('2. plain text answer: text must survive (regression guard)', async () => {
        const res = await call([{ response: 'It is sunny.' }, { response: '', p: 'STOP' }])
        const claude: any = await res.json()
        expect(claude.content[0].type).toBe('text')
        expect(claude.content[0].text).toBe('It is sunny.')
        expect(claude.stop_reason).toBe('end_turn')
    })

    it('3. invalid JSON body gives 400, not 500', async () => {
        const provider = new WorkersAIProvider({ AI: fakeAI([]) } as any)
        const request = new Request('http://x/v1/messages', { method: 'POST', body: '{not json' })
        const res = await provider.handle(request, 'req_test')
        expect(res.status).toBe(400)
        const err: any = await res.json()
        expect(err.error.type).toBe('invalid_request_error')
    })
})
