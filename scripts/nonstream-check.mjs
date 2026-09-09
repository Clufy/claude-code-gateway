// Self-check for the Workers AI non-streaming path: hermes-format tool calls
// emitted as text must survive into the final message, along with the answer text.
// Requires a Workers AI SSE source stream — provided via a stubbed AI binding.
// ponytail: assert-based, no framework. Run via npm run check:nonstream.
import assert from 'node:assert'

const { WorkersAIProvider } = await import('../.tmp-check/providers/workers-ai.js')

const OPEN = '<' + 'tool_call' + '>'
const CLOSE = '<' + '/tool_call' + '>'
const encoder = new TextEncoder()

function sseChunks(lines) {
    return new ReadableStream({
        start(c) {
            for (const l of lines) c.enqueue(encoder.encode(`data: ${JSON.stringify(l)}\n\n`))
            c.close()
        }
    })
}

function fakeAI(chunks) {
    return {
        async run(_model, _options) {
            return new Response(sseChunks(chunks), { status: 200, headers: { 'content-type': 'text/event-stream' } })
        }
    }
}

async function call(chunks, stream) {
    const provider = new WorkersAIProvider({ AI: fakeAI(chunks) })
    const body = JSON.stringify({
        model: 'm',
        stream: stream ?? false,
        max_tokens: 100,
        tools: [{ name: 'get_weather', description: 'd', input_schema: { type: 'object' } }],
        messages: [{ role: 'user', content: 'weather in Paris?' }]
    })
    const request = new Request('http://x/v1/messages', { method: 'POST', body })
    const res = await provider.handle(request, 'req_test')
    return res
}

// 1. Text answer plus hermes-format tool call, non-streaming: both must survive
{
    const res = await call([
        { response: 'Sure! ' },
        { response: `${OPEN}{"name": "get_weather", "arguments": {"city": "Paris"}}${CLOSE}` },
        { response: '', p: 'STOP' }
    ])
    assert.strictEqual(res.status, 200)
    const claude = await res.json()
    assert.strictEqual(claude.stop_reason, 'tool_use')
    assert.ok(
        claude.content.some((b) => b.type === 'text' && b.text === 'Sure! '),
        `answer text was dropped: ${JSON.stringify(claude.content)}`
    )
    const tool = claude.content.find((b) => b.type === 'tool_use')
    assert.ok(tool, 'hermes tool call was dropped')
    assert.strictEqual(tool.name, 'get_weather')
    assert.deepStrictEqual(tool.input, { city: 'Paris' })
    assert.ok(tool.id, 'tool_use block needs an id')
}

// 2. Plain text answer, non-streaming: text must survive (regression guard)
{
    const res = await call([{ response: 'It is sunny.' }, { response: '', p: 'STOP' }])
    const claude = await res.json()
    assert.strictEqual(claude.content[0].type, 'text')
    assert.strictEqual(claude.content[0].text, 'It is sunny.')
    assert.strictEqual(claude.stop_reason, 'end_turn')
}

// 3. Invalid JSON body -> 400, not 500
{
    const provider = new WorkersAIProvider({ AI: fakeAI([]) })
    const request = new Request('http://x/v1/messages', { method: 'POST', body: '{not json' })
    const res = await provider.handle(request, 'req_test')
    assert.strictEqual(res.status, 400)
    const err = await res.json()
    assert.strictEqual(err.error.type, 'invalid_request_error')
}

console.log('nonstream check ok')
