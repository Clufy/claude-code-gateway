// Streaming block-index handling: text and tool_use blocks must share ONE index
// space, stops must not double-fire, and stop_reason must be 'tool_use' only
// when tool_use blocks were actually emitted.
import { describe, expect, it } from 'vitest'
import { ChatCompletionsProvider, ResponsesProvider } from '../src/providers/openai'
import { impl as GeminiImpl } from '../src/providers/gemini'
import { fakeAI, readSse } from './helpers'

// Builds an SSE Response of `data: <json>\n\n` lines.
function sseResponse(lines: unknown[]): Promise<Response> {
    return fakeAI(lines).run('m', {})
}

const readEvents = readSse

// Asserts every delta/stop matches the currently open block and returns start indices.
function checkBlockIndices(events: { event: string; data: any }[]) {
    const open: number[] = []
    const starts: number[] = []
    for (const ev of events) {
        if (ev.event === 'content_block_start') {
            starts.push(ev.data.index)
            open.push(ev.data.index)
        } else if (ev.event === 'content_block_delta' || ev.event === 'content_block_stop') {
            expect(open.length > 0, `${ev.event} with no open block`).toBe(true)
            expect(ev.data.index, `${ev.event} index mismatch`).toBe(open[open.length - 1])
            if (ev.event === 'content_block_stop') open.pop()
        }
    }
    expect(open, 'stream ended with unclosed block(s)').toEqual([])
    return starts
}

function messageDelta(events: { event: string; data: any }[]) {
    const ev = events.find((e) => e.event === 'message_delta')
    expect(ev, 'missing message_delta').toBeTruthy()
    return ev!.data
}

describe('stream conversion', () => {
    it('1. OpenAI Chat Completions: text then tool call, indices must be [0, 1], not [0, 0]', async () => {
        const p = new ChatCompletionsProvider()
        const res = await p.convertToClaudeResponse(
            await sseResponse([
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
                    choices: [
                        { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"Paris"}' } }] } }
                    ]
                },
                {
                    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
                    usage: { prompt_tokens: 10, completion_tokens: 5 }
                }
            ])
        )
        const events = await readEvents(res)
        const starts = checkBlockIndices(events)
        expect(starts, 'text and tool_use blocks must use distinct indices').toEqual([0, 1])

        const toolStart = events.find(
            (e) => e.event === 'content_block_start' && e.data.content_block?.type === 'tool_use'
        )!
        expect(toolStart.data.content_block.name).toBe('get_weather')
        const json = events
            .filter((e) => e.event === 'content_block_delta' && e.data.delta?.type === 'input_json_delta')
            .map((e) => e.data.delta.partial_json)
            .join('')
        expect(JSON.parse(json)).toEqual({ city: 'Paris' })

        const delta = messageDelta(events)
        expect(delta.delta.stop_reason).toBe('tool_use')
        expect(delta.usage.input_tokens).toBe(10)

        // content_block_stop must fire exactly once per block (no duplicates at stream end)
        const stops = events.filter((e) => e.event === 'content_block_stop').map((e) => e.data.index)
        expect(stops.sort(), 'each block must be stopped exactly once').toEqual([0, 1])
    })

    it('2. OpenAI Responses: text then function_call; tool_use must survive response.completed', async () => {
        const p = new ResponsesProvider()
        const res = await p.convertToClaudeResponse(
            await sseResponse([
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
                    item: {
                        type: 'function_call',
                        name: 'get_weather',
                        call_id: 'call_1',
                        arguments: '{"city":"Paris"}'
                    }
                },
                {
                    type: 'response.completed',
                    response: { status: 'completed', usage: { input_tokens: 7, output_tokens: 3 } }
                }
            ])
        )
        const events = await readEvents(res)
        const starts = checkBlockIndices(events)
        expect(starts).toEqual([0, 1])

        const delta = messageDelta(events)
        expect(delta.delta.stop_reason, 'tool_use must not be overwritten by response.completed').toBe('tool_use')
        expect(delta.usage.input_tokens).toBe(7)
    })

    it('3. Gemini: text + functionCall interleaved; tool_use must survive finishReason STOP', async () => {
        const p = new GeminiImpl()
        const res = await p.convertToClaudeResponse(
            await sseResponse([
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
        expect(starts).toEqual([0, 1, 2])

        const delta = messageDelta(events)
        expect(delta.delta.stop_reason, 'functionCall must set tool_use despite finishReason STOP').toBe('tool_use')
        expect(delta.usage.input_tokens).toBe(9)

        const names = events
            .filter((e) => e.event === 'content_block_start' && e.data.content_block?.type === 'tool_use')
            .map((e) => e.data.content_block.name)
        expect(names).toEqual(['get_weather', 'get_time'])
    })

    it('4. Gemini: no usageMetadata anywhere, message_delta usage must still be a real object', async () => {
        const p = new GeminiImpl()
        const res = await p.convertToClaudeResponse(
            await sseResponse([
                { candidates: [{ content: { role: 'model', parts: [{ text: 'hi' }] }, finishReason: 'STOP' }] }
            ])
        )
        const events = await readEvents(res)
        checkBlockIndices(events)
        const delta = messageDelta(events)
        expect(typeof delta.usage.input_tokens).toBe('number')
    })

    it('5. Gemini non-streaming: candidate without content (e.g. SAFETY block) must not 500', async () => {
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
        const claude: any = await (await p.convertToClaudeResponse(res)).json()
        expect(claude.type).toBe('message')
        expect(claude.content).toEqual([])
        expect(claude.usage.output_tokens, 'missing candidatesTokenCount must not drop output_tokens').toBe(0)
    })

    it("6. Chat Completions: tool_calls deltas with finish_reason 'stop' still give stop_reason tool_use", async () => {
        const p = new ChatCompletionsProvider()
        const res = await p.convertToClaudeResponse(
            await sseResponse([
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
        expect(delta.delta.stop_reason, "tool_calls deltas must pin tool_use despite finish_reason 'stop'").toBe(
            'tool_use'
        )
    })

    it("7. Chat Completions NON-streaming: message.tool_calls with finish_reason 'stop' still gives tool_use", async () => {
        const p = new ChatCompletionsProvider()
        const res = new Response(
            JSON.stringify({
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
        const claude: any = await (await p.convertToClaudeResponse(res)).json()
        expect(claude.content.some((b: any) => b.type === 'tool_use')).toBe(true)
        expect(claude.stop_reason, "non-streaming tool_calls must pin tool_use despite finish_reason 'stop'").toBe(
            'tool_use'
        )
    })

    it('8. Gemini stream: content present but no parts (blocked/empty candidate) must not error', async () => {
        const p = new GeminiImpl()
        const res = await p.convertToClaudeResponse(
            await sseResponse([{ candidates: [{ content: { role: 'model' }, finishReason: 'STOP' }] }])
        )
        const events = await readEvents(res)
        expect(
            events.some((e) => e.event === 'error'),
            'stream must not emit an error event'
        ).toBe(false)
        expect(
            events.some((e) => e.event === 'message_stop'),
            'stream must still terminate cleanly'
        ).toBe(true)
        const delta = messageDelta(events)
        expect(delta.delta.stop_reason).toBe('end_turn')
    })

    it('9. Gemini stream: usageMetadata without candidatesTokenCount must yield output_tokens 0', async () => {
        const p = new GeminiImpl()
        const res = await p.convertToClaudeResponse(
            await sseResponse([
                { candidates: [{ content: { role: 'model', parts: [{ text: 'hi' }] }, finishReason: 'STOP' }] },
                { usageMetadata: { promptTokenCount: 9 } }
            ])
        )
        const events = await readEvents(res)
        const delta = messageDelta(events)
        expect(delta.usage.input_tokens).toBe(9)
        expect(delta.usage.output_tokens, 'missing candidatesTokenCount must not drop output_tokens').toBe(0)
    })
})
