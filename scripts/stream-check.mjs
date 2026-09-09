// Self-check for streaming block-index handling: text and tool_use blocks must
// share ONE index space, stops must not double-fire, and stop_reason must be
// 'tool_use' only when tool_use blocks were actually emitted.
// ponytail: assert-based, no framework. Run via npm run check:stream.
import assert from 'node:assert'

const { ChatCompletionsProvider, ResponsesProvider } = await import('../.tmp-check/providers/openai.js')
const { impl: GeminiImpl } = await import('../.tmp-check/providers/gemini.js')

const encoder = new TextEncoder()

function sseResponse(lines) {
    const body = new ReadableStream({
        start(c) {
            c.enqueue(encoder.encode(lines.map((l) => `data: ${JSON.stringify(l)}\n\n`).join('')))
            c.close()
        }
    })
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

async function readEvents(res) {
    const text = await res.text()
    const events = []
    for (const block of text.split('\n\n')) {
        const e = block.split('\n').find((l) => l.startsWith('event: '))
        const d = block.split('\n').find((l) => l.startsWith('data: '))
        if (e && d) events.push({ event: e.slice(7), data: JSON.parse(d.slice(6)) })
    }
    return events
}

// Asserts every delta/stop matches the currently open block and returns start indices.
function checkBlockIndices(events) {
    const open = []
    const starts = []
    for (const ev of events) {
        if (ev.event === 'content_block_start') {
            starts.push(ev.data.index)
            open.push(ev.data.index)
        } else if (ev.event === 'content_block_delta' || ev.event === 'content_block_stop') {
            assert.ok(open.length > 0, `${ev.event} with no open block`)
            assert.strictEqual(ev.data.index, open[open.length - 1], `${ev.event} index mismatch`)
            if (ev.event === 'content_block_stop') open.pop()
        }
    }
    assert.deepStrictEqual(open, [], 'stream ended with unclosed block(s)')
    return starts
}

function messageDelta(events) {
    const ev = events.find((e) => e.event === 'message_delta')
    assert.ok(ev, 'missing message_delta')
    return ev.data
}

// 1. OpenAI Chat Completions: text then tool call — indices must be [0, 1], not [0, 0]
{
    const p = new ChatCompletionsProvider()
    const res = await p.convertToClaudeResponse(
        sseResponse([
            { choices: [{ index: 0, delta: { content: 'Let me check. ' } }] },
            {
                choices: [
                    {
                        index: 0,
                        delta: {
                            tool_calls: [
                                { index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '{"ci' } }
                            ]
                        }
                    }
                ]
            },
            {
                choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"Paris"}' } }] } }]
            },
            {
                choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
                usage: { prompt_tokens: 10, completion_tokens: 5 }
            }
        ])
    )
    const events = await readEvents(res)
    const starts = checkBlockIndices(events)
    assert.deepStrictEqual(starts, [0, 1], 'text and tool_use blocks must use distinct indices')

    const toolStart = events.find((e) => e.event === 'content_block_start' && e.data.content_block?.type === 'tool_use')
    assert.strictEqual(toolStart.data.content_block.name, 'get_weather')
    const json = events
        .filter((e) => e.event === 'content_block_delta' && e.data.delta?.type === 'input_json_delta')
        .map((e) => e.data.delta.partial_json)
        .join('')
    assert.deepStrictEqual(JSON.parse(json), { city: 'Paris' })

    const delta = messageDelta(events)
    assert.strictEqual(delta.delta.stop_reason, 'tool_use')
    assert.strictEqual(delta.usage.input_tokens, 10)

    // content_block_stop must fire exactly once per block (no duplicates at stream end)
    const stops = events.filter((e) => e.event === 'content_block_stop').map((e) => e.data.index)
    assert.deepStrictEqual(stops.sort(), [0, 1], 'each block must be stopped exactly once')
}

// 2. OpenAI Responses: text then function_call; tool_use must survive response.completed
{
    const p = new ResponsesProvider()
    const res = await p.convertToClaudeResponse(
        sseResponse([
            { type: 'response.output_text.delta', delta: 'Checking. ' },
            {
                type: 'response.output_item.added',
                output_index: 1,
                item: { type: 'function_call', name: 'get_weather', call_id: 'call_1', arguments: '' }
            },
            { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"city":"Paris"}' },
            {
                type: 'response.output_item.done',
                output_index: 1,
                item: { type: 'function_call', name: 'get_weather', call_id: 'call_1', arguments: '{"city":"Paris"}' }
            },
            {
                type: 'response.completed',
                response: { status: 'completed', usage: { input_tokens: 7, output_tokens: 3 } }
            }
        ])
    )
    const events = await readEvents(res)
    const starts = checkBlockIndices(events)
    assert.deepStrictEqual(starts, [0, 1])

    const delta = messageDelta(events)
    assert.strictEqual(delta.delta.stop_reason, 'tool_use', 'tool_use must not be overwritten by response.completed')
    assert.strictEqual(delta.usage.input_tokens, 7)
}

// 3. Gemini: text + functionCall interleaved; tool_use must survive finishReason STOP
{
    const p = new GeminiImpl()
    const res = await p.convertToClaudeResponse(
        sseResponse([
            {
                candidates: [
                    {
                        content: {
                            role: 'model',
                            parts: [
                                { text: 'Checking. ' },
                                { functionCall: { name: 'get_weather', args: { city: 'Paris' } } }
                            ]
                        }
                    }
                ]
            },
            {
                candidates: [
                    {
                        content: { role: 'model', parts: [{ functionCall: { name: 'get_time', args: {} } }] },
                        finishReason: 'STOP'
                    }
                ],
                usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4, totalTokenCount: 13 }
            }
        ])
    )
    const events = await readEvents(res)
    const starts = checkBlockIndices(events)
    assert.deepStrictEqual(starts, [0, 1, 2])

    const delta = messageDelta(events)
    assert.strictEqual(delta.delta.stop_reason, 'tool_use', 'functionCall must set tool_use despite finishReason STOP')
    assert.strictEqual(delta.usage.input_tokens, 9)

    const names = events
        .filter((e) => e.event === 'content_block_start' && e.data.content_block?.type === 'tool_use')
        .map((e) => e.data.content_block.name)
    assert.deepStrictEqual(names, ['get_weather', 'get_time'])
}

// 4. Gemini: no usageMetadata anywhere — message_delta usage must still be a real object
{
    const p = new GeminiImpl()
    const res = await p.convertToClaudeResponse(
        sseResponse([{ candidates: [{ content: { role: 'model', parts: [{ text: 'hi' }] }, finishReason: 'STOP' }] }])
    )
    const events = await readEvents(res)
    checkBlockIndices(events)
    const delta = messageDelta(events)
    assert.strictEqual(typeof delta.usage.input_tokens, 'number')
}

// 5. Gemini non-streaming: candidate without content (e.g. SAFETY block) must not 500
{
    const p = new GeminiImpl()
    const res = new Response(
        JSON.stringify({
            candidates: [{ finishReason: 'SAFETY' }],
            // blocked responses report promptTokenCount but omit candidatesTokenCount
            usageMetadata: { promptTokenCount: 5 }
        }),
        {
            status: 200,
            headers: { 'content-type': 'application/json' }
        }
    )
    const claude = await (await p.convertToClaudeResponse(res)).json()
    assert.strictEqual(claude.type, 'message')
    assert.deepStrictEqual(claude.content, [])
    assert.strictEqual(claude.usage.output_tokens, 0, 'missing candidatesTokenCount must not drop output_tokens')
}

console.log('stream check ok')

// 6. Chat Completions: provider sends tool_calls deltas but finish_reason 'stop'
//    — stop_reason must still be 'tool_use'
{
    const p = new ChatCompletionsProvider()
    const res = await p.convertToClaudeResponse(
        sseResponse([
            { choices: [{ index: 0, delta: { content: 'Hm. ' } }] },
            {
                choices: [
                    {
                        index: 0,
                        delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'f', arguments: '{}' } }] }
                    }
                ]
            },
            { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
        ])
    )
    const events = await readEvents(res)
    checkBlockIndices(events)
    const delta = messageDelta(events)
    assert.strictEqual(
        delta.delta.stop_reason,
        'tool_use',
        "tool_calls deltas must pin tool_use despite finish_reason 'stop'"
    )
}

// 7. Chat Completions NON-streaming: message.tool_calls with finish_reason 'stop'
//    — stop_reason must still be 'tool_use' (same safety net as the stream path)
{
    const p = new ChatCompletionsProvider()
    const res = new Response(
        JSON.stringify({
            id: 'chatcmpl-1',
            choices: [
                {
                    index: 0,
                    message: {
                        content: null,
                        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }]
                    },
                    finish_reason: 'stop'
                }
            ]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
    )
    const claude = await (await p.convertToClaudeResponse(res)).json()
    assert.ok(claude.content.some((b) => b.type === 'tool_use'))
    assert.strictEqual(
        claude.stop_reason,
        'tool_use',
        "non-streaming tool_calls must pin tool_use despite finish_reason 'stop'"
    )
}

// 8. Gemini stream: content present but no parts (blocked/empty candidate) must not error
{
    const p = new GeminiImpl()
    const res = await p.convertToClaudeResponse(
        sseResponse([{ candidates: [{ content: { role: 'model' }, finishReason: 'STOP' }] }])
    )
    const events = await readEvents(res)
    assert.ok(!events.some((e) => e.event === 'error'), 'stream must not emit an error event')
    assert.ok(
        events.some((e) => e.event === 'message_stop'),
        'stream must still terminate cleanly'
    )
    const delta = messageDelta(events)
    assert.strictEqual(delta.delta.stop_reason, 'end_turn')
}

// 9. Gemini stream: usageMetadata without candidatesTokenCount must yield output_tokens 0
{
    const p = new GeminiImpl()
    const res = await p.convertToClaudeResponse(
        sseResponse([
            { candidates: [{ content: { role: 'model', parts: [{ text: 'hi' }] }, finishReason: 'STOP' }] },
            { usageMetadata: { promptTokenCount: 9 } }
        ])
    )
    const events = await readEvents(res)
    const delta = messageDelta(events)
    assert.strictEqual(delta.usage.input_tokens, 9)
    assert.strictEqual(delta.usage.output_tokens, 0, 'missing candidatesTokenCount must not drop output_tokens')
}
