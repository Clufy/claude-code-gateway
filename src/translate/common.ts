import * as types from './types'

export function generateId(): string {
    return crypto.randomUUID()
}

const encoder = new TextEncoder()

export function safeJsonParse(value: string): any {
    try {
        return JSON.parse(value)
    } catch {
        return {}
    }
}

export function sse(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

export function enqueueSse(controller: ReadableStreamDefaultController, event: string, data: unknown): void {
    controller.enqueue(encoder.encode(sse(event, data)))
}

export function enqueueRawSse(controller: ReadableStreamDefaultController, event: string): void {
    controller.enqueue(encoder.encode(event))
}

export function sendMessageStart(
    controller: ReadableStreamDefaultController,
    usage: types.ClaudeUsage = { input_tokens: 0, output_tokens: 0 }
): void {
    const event = sse('message_start', {
        type: 'message_start',
        message: {
            id: generateId(),
            type: 'message',
            role: 'assistant',
            content: [],
            usage
        }
    })
    controller.enqueue(encoder.encode(event))
}

export function sendMessageDelta(
    controller: ReadableStreamDefaultController,
    stopReason: string,
    usage: types.ClaudeUsage = { input_tokens: 0, output_tokens: 0 }
): void {
    enqueueSse(controller, 'message_delta', {
        type: 'message_delta',
        delta: {
            stop_reason: stopReason,
            stop_sequence: null
        },
        usage
    })
}

export function sendMessageStop(controller: ReadableStreamDefaultController): void {
    const event = sse('message_stop', {
        type: 'message_stop'
    })
    controller.enqueue(encoder.encode(event))
}

export function sendErrorEvent(controller: ReadableStreamDefaultController, message: string): void {
    controller.enqueue(encoder.encode(sse('error', { type: 'error', error: { type: 'api_error', message } })))
}

export function startTextBlock(index: number): string {
    return sse('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: {
            type: 'text',
            text: ''
        }
    })
}

export function textDelta(text: string, index: number): string {
    return sse('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: {
            type: 'text_delta',
            text
        }
    })
}

export function stopContentBlock(index: number): string {
    return sse('content_block_stop', {
        type: 'content_block_stop',
        index
    })
}

export function processTextPart(text: string, index: number): string[] {
    const events: string[] = []
    events.push(startTextBlock(index))
    events.push(textDelta(text, index))
    events.push(stopContentBlock(index))
    return events
}

export function startToolUseBlock(index: number, id: string, name: string): string {
    return sse('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id, name, input: {} }
    })
}

export function inputJsonDelta(index: number, partialJson: string): string {
    return sse('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: partialJson }
    })
}

export function processToolUsePart(functionCall: { name: string; args: any }, index: number): string[] {
    const toolUseId = generateId()
    return [
        startToolUseBlock(index, toolUseId, functionCall.name),
        inputJsonDelta(index, JSON.stringify(functionCall.args)),
        stopContentBlock(index)
    ]
}

export function startThinkingBlock(index: number): string {
    return sse('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'thinking', thinking: '' }
    })
}

export function thinkingDelta(text: string, index: number): string {
    return sse('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'thinking_delta', thinking: text }
    })
}

export function buildUrl(baseUrl: string, endpoint: string): string {
    let finalUrl = baseUrl
    if (!finalUrl.endsWith('/')) {
        finalUrl += '/'
    }
    return finalUrl + endpoint
}

export async function processProviderStream(
    providerResponse: Response,
    processLine: (jsonStr: string) => {
        events: string[]
        stopReason?: string
        usage?: types.ClaudeUsage
    } | null,
    inputTokens = 0
): Promise<Response> {
    const stream = new ReadableStream({
        async start(controller) {
            const reader = providerResponse.body?.getReader()
            if (!reader) {
                controller.close()
                return
            }

            const decoder = new TextDecoder()
            let buffer = ''
            let stopReason = 'end_turn'
            let usage: types.ClaudeUsage | undefined

            sendMessageStart(controller, { input_tokens: inputTokens, output_tokens: 0 })

            try {
                while (true) {
                    const { done, value } = await reader.read()
                    if (done) break

                    const chunk = buffer + decoder.decode(value, { stream: true })
                    const lines = chunk.split('\n')

                    buffer = lines.pop() || ''

                    for (const line of lines) {
                        if (!line.trim() || !line.startsWith('data: ')) continue

                        const jsonStr = line.slice(6)
                        if (jsonStr === '[DONE]') continue

                        const result = processLine(jsonStr)
                        if (result) {
                            stopReason = result.stopReason ?? stopReason
                            if (result.usage) usage = result.usage

                            for (const event of result.events) {
                                controller.enqueue(encoder.encode(event))
                            }
                        }
                    }
                }

                if (buffer.trim() && buffer.startsWith('data: ')) {
                    const result = processLine(buffer.slice(6))
                    if (result) {
                        stopReason = result.stopReason ?? stopReason
                        if (result.usage) usage = result.usage
                        for (const event of result.events) {
                            controller.enqueue(encoder.encode(event))
                        }
                    }
                }

                reader.releaseLock()
                // ponytail: estimate fallback — not every provider sends usage
                sendMessageDelta(controller, stopReason, usage ?? { input_tokens: inputTokens, output_tokens: 0 })
                sendMessageStop(controller)
                controller.close()
            } catch (error) {
                console.error(error)
                reader.releaseLock()
                sendErrorEvent(controller, error instanceof Error ? error.message : String(error))
                controller.close()
            }
        }
    })

    return new Response(stream, {
        status: providerResponse.status,
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive'
        }
    })
}

export function cleanJsonSchema(schema: any): any {
    if (!schema || typeof schema !== 'object') {
        return schema
    }

    const cleaned = { ...schema }

    for (const key in cleaned) {
        if (key === '$schema' || key === 'additionalProperties' || key === 'title' || key === 'examples') {
            delete cleaned[key]
        } else if (key === 'format' && cleaned.type === 'string') {
            delete cleaned[key]
        } else if (key === 'properties' && typeof cleaned[key] === 'object') {
            cleaned[key] = cleanJsonSchema(cleaned[key])
        } else if (key === 'items' && typeof cleaned[key] === 'object') {
            cleaned[key] = cleanJsonSchema(cleaned[key])
        } else if (typeof cleaned[key] === 'object' && !Array.isArray(cleaned[key])) {
            cleaned[key] = cleanJsonSchema(cleaned[key])
        }
    }

    return cleaned
}

const isObject = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Messages and content blocks that are objects. A `null` (or any non-object) entry would throw in a provider's
 * converter and surface as a 500, so it is skipped. A non-array is returned unchanged for the caller to reject.
 */
export function objectMessages<T>(messages: T): T {
    if (!Array.isArray(messages)) return messages
    return messages
        .filter(isObject)
        .map((m) => (Array.isArray(m.content) ? { ...m, content: m.content.filter(isObject) } : m)) as T
}
