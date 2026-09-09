import { countTokensForRequest, estimateTokens } from '../tokens'
import { HermesFilter, repairJson } from '../hermes'
import type { HermesCall } from '../hermes'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function sse(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function systemText(system: unknown): string {
    if (system == null) return ''
    if (typeof system === 'string') return system
    if (Array.isArray(system)) {
        return system
            .filter((p) => p && p.type === 'text')
            .map((p) => p.text ?? '')
            .join('\n')
    }
    return String(system)
}

function toolResultToText(content: unknown): string {
    return typeof content === 'string' ? content : JSON.stringify(content)
}

function cleanSchema(schema: any): any {
    if (!schema || typeof schema !== 'object') return schema
    if (Array.isArray(schema)) return schema.map(cleanSchema)
    const out: any = {}
    for (const key of Object.keys(schema)) {
        if (key === '$schema' || key === 'additionalProperties' || key === 'title' || key === 'examples') continue
        out[key] = cleanSchema(schema[key])
    }
    return out
}

function convertTools(tools: any): any {
    if (!Array.isArray(tools) || tools.length === 0) return undefined
    return tools
        .filter((t) => t && t.name)
        .map((t) => ({
            type: 'function',
            function: {
                name: t.name,
                description: t.description,
                parameters: cleanSchema(t.input_schema) || { type: 'object', properties: {} }
            }
        }))
}

function imagePart(source: any): any | undefined {
    if (source?.type === 'base64') {
        return { type: 'image', source: { type: 'base64', media_type: source.media_type, data: source.data } }
    }
    if (source?.type === 'url') {
        return { type: 'image', source: { type: 'url', url: source.url } }
    }
    return undefined
}

function documentPart(source: any): any | undefined {
    if (source?.type === 'text') {
        return { type: 'text', text: source.text }
    }
    // ponytail: Workers AI document input is spotty; fall back to text placeholder for base64/url PDFs
    if (source?.type === 'base64' || source?.type === 'url') {
        return { type: 'text', text: `[document${source.type === 'base64' ? `: ${source.media_type}` : ''}]` }
    }
    return undefined
}

function convertMessages(messages: any[]): any[] {
    const out: any[] = []
    for (const message of messages) {
        const role = message.role === 'assistant' ? 'assistant' : 'user'
        if (typeof message.content === 'string') {
            out.push({ role, content: message.content })
            continue
        }
        if (!Array.isArray(message.content)) {
            out.push({ role, content: String(message.content ?? '') })
            continue
        }

        const contentParts: any[] = []
        const toolCalls: any[] = []
        const toolResults: any[] = []

        for (const part of message.content) {
            if (part.type === 'text') {
                contentParts.push({ type: 'text', text: part.text ?? '' })
            } else if (part.type === 'image') {
                const img = imagePart(part.source)
                if (img) contentParts.push(img)
            } else if (part.type === 'document') {
                const doc = documentPart(part.source)
                if (doc) contentParts.push(doc)
            } else if (part.type === 'tool_use') {
                toolCalls.push({
                    id: part.id,
                    type: 'function',
                    function: {
                        name: part.name,
                        arguments: JSON.stringify(part.input ?? {})
                    }
                })
            } else if (part.type === 'tool_result') {
                toolResults.push({
                    tool_call_id: part.tool_use_id,
                    content: toolResultToText(part.content)
                })
            }
            // thinking / redacted_thinking / cache_control are dropped on user turns
        }

        // ponytail: Workers AI chat models accept either a string or an array of content parts.
        // If the only part is text, keep the simple string form for broader compatibility.
        if (contentParts.length > 0 || toolCalls.length > 0) {
            const onlyText = contentParts.length > 0 && contentParts.every((p) => p.type === 'text')
            out.push({
                role,
                content:
                    onlyText && toolCalls.length === 0
                        ? contentParts.map((p) => p.text).join('\n')
                        : contentParts.length > 0
                          ? contentParts
                          : '',
                ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
            })
        }

        for (const result of toolResults) {
            out.push({ role: 'tool', tool_call_id: result.tool_call_id, content: result.content })
        }
    }
    return out
}

function extractText(payload: any): string {
    if (payload == null) return ''
    const parts: string[] = []
    const push = (v: any) => {
        if (typeof v === 'string' && v.length > 0) parts.push(v)
    }

    push(payload.response)
    push(payload.text)

    const choices = payload.choices
    if (Array.isArray(choices)) {
        for (const choice of choices) {
            push(choice?.delta?.content)
            push(choice?.message?.content)
        }
    }

    return parts.join('')
}

function extractReasoning(payload: any): string {
    if (payload == null) return ''
    const parts: string[] = []
    const push = (v: any) => {
        if (typeof v === 'string' && v.length > 0) parts.push(v)
    }

    push(payload.reasoning_content)
    push(payload.reasoning)

    const choices = payload.choices
    if (Array.isArray(choices)) {
        for (const choice of choices) {
            push(choice?.delta?.reasoning_content)
            push(choice?.delta?.reasoning)
            push(choice?.message?.reasoning_content)
            push(choice?.message?.reasoning)
        }
    }

    return parts.join('')
}

function collectToolCalls(payload: any, map: Map<number, any>): void {
    if (payload == null) return

    const choices = payload.choices
    if (Array.isArray(choices)) {
        for (const choice of choices) {
            const deltaCalls = choice?.delta?.tool_calls
            if (Array.isArray(deltaCalls)) {
                for (const call of deltaCalls) {
                    const idx = call.index ?? 0
                    const cur = map.get(idx) ?? { id: undefined, name: undefined, arguments: '' }
                    if (call.id) cur.id = call.id
                    if (call.function?.name) cur.name = call.function.name
                    if (call.function?.arguments) cur.arguments += call.function.arguments
                    map.set(idx, cur)
                }
            }

            const msgCalls = choice?.message?.tool_calls
            if (Array.isArray(msgCalls)) {
                for (let i = 0; i < msgCalls.length; i++) {
                    const call = msgCalls[i]
                    const idx = call.index ?? i
                    const cur = map.get(idx) ?? { id: undefined, name: undefined, arguments: '' }
                    if (call.id) cur.id = call.id
                    if (call.function?.name) cur.name = call.function.name
                    if (call.function?.arguments) cur.arguments = call.function.arguments
                    map.set(idx, cur)
                }
            }
        }
    }

    const legacy = payload.tool_calls
    if (Array.isArray(legacy) && legacy.length > 0 && !payload.choices) {
        for (let i = 0; i < legacy.length; i++) {
            const call = legacy[i]
            const cur = map.get(i) ?? { id: undefined, name: undefined, arguments: '' }
            if (call.name) cur.name = call.name
            if (call.arguments != null) {
                cur.arguments = typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments)
            }
            map.set(i, cur)
        }
    }
}

function finishReason(payload: any): string | null {
    return payload?.choices?.[0]?.finish_reason ?? null
}

function parseArguments(str: string): any {
    if (!str) return {}
    // ponytail: repair chain (fences, prose, trailing commas, unbalanced braces) from hermes.ts
    return repairJson(str) ?? {}
}

function toolUseId(existing: string | undefined): string {
    return existing || `toolu_${crypto.randomUUID().replace(/-/g, '')}`
}

// Workers AI sends usage on OpenAI-style payloads (prompt_tokens/completion_tokens);
// the generic envelope format uses input_tokens/output_tokens. Absent = estimate.
function extractUsage(payload: any): { prompt: number | null; completion: number | null } {
    const usage = payload?.usage
    if (!usage || typeof usage !== 'object') return { prompt: null, completion: null }
    const prompt = usage.prompt_tokens ?? usage.input_tokens ?? null
    const completion = usage.completion_tokens ?? usage.output_tokens ?? null
    return { prompt, completion }
}

export class WorkersAIProvider {
    private requestId = ''

    constructor(private env: Env) {}

    async handle(request: Request, requestId: string): Promise<Response> {
        this.requestId = requestId
        const body = (await request.json()) as any
        const model = body?.model
        const messages = body?.messages
        const id = `msg_${crypto.randomUUID()}`

        if (typeof model !== 'string' || model.length === 0) {
            return this.error(400, 'invalid_request_error', "missing or invalid 'model'")
        }
        if (!Array.isArray(messages) || messages.length === 0) {
            return this.error(400, 'invalid_request_error', "missing or invalid 'messages'")
        }

        const system = systemText(body.system)
        const aiMessages = convertMessages(messages)
        if (system) {
            aiMessages.unshift({ role: 'system', content: system })
        }

        const stream = body.stream === true
        const options: any = { messages: aiMessages, stream: true }

        const tools = convertTools(body.tools)
        if (tools) options.tools = tools
        if (body.max_tokens != null) options.max_tokens = body.max_tokens
        if (body.temperature != null) options.temperature = body.temperature

        let rawStream
        try {
            rawStream = await this.env.AI.run(model, options, { returnRawResponse: true })
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e)
            return this.error(502, 'api_error', `Workers AI call failed: ${message}`)
        }

        // ponytail: input token estimate from chars/4 — Workers AI only reports prompt usage on some models
        const inputEstimate = countTokensForRequest(body).input_tokens

        let source: ReadableStream
        if (rawStream instanceof ReadableStream) {
            source = rawStream
        } else if (rawStream instanceof Response && rawStream.body) {
            source = rawStream.body
        } else {
            return this.error(502, 'api_error', 'Workers AI did not return a stream')
        }

        const knownTools = new Set<string>(
            (Array.isArray(body.tools) ? body.tools : [])
                .filter((t: any) => t && typeof t.name === 'string')
                .map((t: any) => t.name)
        )

        if (!stream) {
            return this.handleNonStreaming(source, model, id, inputEstimate, knownTools)
        }

        return this.handleStreaming(source, model, id, inputEstimate, knownTools)
    }

    private error(status: number, type: string, message: string): Response {
        return new Response(JSON.stringify({ type: 'error', error: { type, message }, request_id: this.requestId }), {
            status,
            headers: { 'content-type': 'application/json' }
        })
    }

    private async handleNonStreaming(
        source: ReadableStream,
        model: string,
        id: string,
        inputEstimate: number,
        knownTools: Set<string>
    ): Promise<Response> {
        let text = ''
        let reasoning = ''
        const toolCalls = new Map<number, any>()
        let stopReason: any = 'end_turn'
        let realPrompt: number | null = null
        let realCompletion: number | null = null

        try {
            const reader = source.getReader()
            let buffer = ''
            while (true) {
                const { done, value } = await reader.read()
                if (done) break
                buffer += typeof value === 'string' ? value : decoder.decode(value, { stream: true })
                const lines = buffer.split('\n')
                buffer = lines.pop() ?? ''
                for (const line of lines) {
                    const payload = this.parseSsePayload(line)
                    if (!payload) continue
                    text += extractText(payload)
                    reasoning += extractReasoning(payload)
                    collectToolCalls(payload, toolCalls)
                    const usage = extractUsage(payload)
                    if (usage.prompt != null) realPrompt = usage.prompt
                    if (usage.completion != null) realCompletion = usage.completion
                    if (finishReason(payload) === 'tool_calls') stopReason = 'tool_use'
                    else if (finishReason(payload) === 'length') stopReason = 'max_tokens'
                }
            }
            if (buffer.trim()) {
                const payload = this.parseSsePayload(buffer)
                if (payload) {
                    text += extractText(payload)
                    reasoning += extractReasoning(payload)
                    collectToolCalls(payload, toolCalls)
                    const usage = extractUsage(payload)
                    if (usage.prompt != null) realPrompt = usage.prompt
                    if (usage.completion != null) realCompletion = usage.completion
                    if (finishReason(payload) === 'tool_calls') stopReason = 'tool_use'
                    else if (finishReason(payload) === 'length') stopReason = 'max_tokens'
                }
            }
            reader.releaseLock()
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e)
            return this.error(502, 'api_error', `Workers AI stream failed: ${message}`)
        }

        // Open models often emit tool calls as Hermes-format text instead of native
        // tool_calls deltas; scan accumulated text and reconstruct them.
        const hermes = new HermesFilter(knownTools)
        hermes.push(text)
        const { text: visibleText, calls: hermesCalls } = hermes.flush()

        const content: any[] = []
        if (reasoning) content.push({ type: 'thinking', thinking: reasoning })
        if (visibleText) content.push({ type: 'text', text: visibleText })

        const calls = [...toolCalls.entries()].sort(([a], [b]) => a - b)
        for (const [, call] of calls) {
            if (!call.name) continue
            content.push({
                type: 'tool_use',
                id: toolUseId(call.id),
                name: call.name,
                input: parseArguments(call.arguments)
            })
        }
        for (const call of hermesCalls) {
            content.push({ type: 'tool_use', id: toolUseId(undefined), name: call.name, input: call.input })
        }
        if (calls.length > 0 || hermesCalls.length > 0) stopReason = 'tool_use'

        return new Response(
            JSON.stringify({
                id,
                type: 'message',
                role: 'assistant',
                model,
                content,
                stop_reason: stopReason,
                stop_sequence: null,
                usage: {
                    input_tokens: realPrompt ?? inputEstimate,
                    output_tokens: realCompletion ?? estimateTokens(text + reasoning)
                }
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
        )
    }

    private parseSsePayload(line: string): any | null {
        const trimmed = line.trim()
        if (!trimmed || !trimmed.startsWith('data:')) return null
        const data = trimmed.slice(5).trim()
        if (data === '[DONE]') return null
        try {
            return JSON.parse(data)
        } catch {
            return null
        }
    }

    private handleStreaming(
        source: ReadableStream,
        model: string,
        id: string,
        inputEstimate: number,
        knownTools: Set<string>
    ): Response {
        // Scans streamed visible text for tool calls emitted as Hermes-format text.
        const hermes = new HermesFilter(knownTools)

        const state = {
            text: '',
            reasoning: '',
            textBlockOpen: false,
            thinkingBlockOpen: false,
            blockIndex: 0,
            toolCalls: new Map<number, any>(),
            toolBlocksEmitted: 0,
            stopReason: 'end_turn' as any,
            realPrompt: null as number | null,
            realCompletion: null as number | null,
            _buffer: '' as string
        }

        const openTextBlock = (controller: TransformStreamDefaultController) => {
            if (state.textBlockOpen) return
            controller.enqueue(
                encoder.encode(
                    sse('content_block_start', {
                        type: 'content_block_start',
                        index: state.blockIndex,
                        content_block: { type: 'text', text: '' }
                    })
                )
            )
            state.textBlockOpen = true
        }

        const closeTextBlock = (controller: TransformStreamDefaultController) => {
            if (!state.textBlockOpen) return
            controller.enqueue(
                encoder.encode(sse('content_block_stop', { type: 'content_block_stop', index: state.blockIndex }))
            )
            state.blockIndex++
            state.textBlockOpen = false
        }

        const closeThinkingBlock = (controller: TransformStreamDefaultController) => {
            if (!state.thinkingBlockOpen) return
            controller.enqueue(
                encoder.encode(sse('content_block_stop', { type: 'content_block_stop', index: state.blockIndex }))
            )
            state.blockIndex++
            state.thinkingBlockOpen = false
        }

        const openThinkingBlock = (controller: TransformStreamDefaultController) => {
            if (state.thinkingBlockOpen) return
            closeTextBlock(controller)
            controller.enqueue(
                encoder.encode(
                    sse('content_block_start', {
                        type: 'content_block_start',
                        index: state.blockIndex,
                        content_block: { type: 'thinking', thinking: '' }
                    })
                )
            )
            state.thinkingBlockOpen = true
        }

        const emitReasoning = (controller: TransformStreamDefaultController, token: string) => {
            state.reasoning += token
            openThinkingBlock(controller)
            controller.enqueue(
                encoder.encode(
                    sse('content_block_delta', {
                        type: 'content_block_delta',
                        index: state.blockIndex,
                        delta: { type: 'thinking_delta', thinking: token }
                    })
                )
            )
        }

        const emitText = (controller: TransformStreamDefaultController, token: string) => {
            state.text += token
            closeThinkingBlock(controller)
            openTextBlock(controller)
            controller.enqueue(
                encoder.encode(
                    sse('content_block_delta', {
                        type: 'content_block_delta',
                        index: state.blockIndex,
                        delta: { type: 'text_delta', text: token }
                    })
                )
            )
        }

        const emitToolCalls = (controller: TransformStreamDefaultController) => {
            closeTextBlock(controller)
            closeThinkingBlock(controller)
            const calls = [...state.toolCalls.entries()].sort(([a], [b]) => a - b)
            let emitted = 0
            for (let i = state.toolBlocksEmitted; i < calls.length; i++) {
                const [, call] = calls[i]
                if (!call.name) continue
                const toolId = toolUseId(call.id)
                const input = parseArguments(call.arguments)
                const blockIndex = state.blockIndex + emitted

                controller.enqueue(
                    encoder.encode(
                        sse('content_block_start', {
                            type: 'content_block_start',
                            index: blockIndex,
                            content_block: { type: 'tool_use', id: toolId, name: call.name, input: {} }
                        })
                    )
                )
                controller.enqueue(
                    encoder.encode(
                        sse('content_block_delta', {
                            type: 'content_block_delta',
                            index: blockIndex,
                            delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) }
                        })
                    )
                )
                controller.enqueue(
                    encoder.encode(sse('content_block_stop', { type: 'content_block_stop', index: blockIndex }))
                )
                emitted++
            }
            state.blockIndex += emitted
            state.toolBlocksEmitted = calls.length
            state.stopReason = 'tool_use'
        }

        const emitHermesCalls = (controller: TransformStreamDefaultController, calls: HermesCall[]) => {
            closeTextBlock(controller)
            closeThinkingBlock(controller)
            for (const call of calls) {
                const blockIndex = state.blockIndex
                controller.enqueue(
                    encoder.encode(
                        sse('content_block_start', {
                            type: 'content_block_start',
                            index: blockIndex,
                            content_block: { type: 'tool_use', id: toolUseId(undefined), name: call.name, input: {} }
                        })
                    )
                )
                controller.enqueue(
                    encoder.encode(
                        sse('content_block_delta', {
                            type: 'content_block_delta',
                            index: blockIndex,
                            delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) }
                        })
                    )
                )
                controller.enqueue(
                    encoder.encode(sse('content_block_stop', { type: 'content_block_stop', index: blockIndex }))
                )
                state.blockIndex++
            }
            state.stopReason = 'tool_use'
        }

        const processLine = (controller: TransformStreamDefaultController, line: string) => {
            const payload = this.parseSsePayload(line)
            if (!payload) return
            const reasoning = extractReasoning(payload)
            if (reasoning) emitReasoning(controller, reasoning)
            const token = extractText(payload)
            if (token) {
                const { text: visible, calls } = hermes.push(token)
                if (visible) emitText(controller, visible)
                if (calls.length > 0) emitHermesCalls(controller, calls)
            }
            collectToolCalls(payload, state.toolCalls)
            const usage = extractUsage(payload)
            if (usage.prompt != null) state.realPrompt = usage.prompt
            if (usage.completion != null) state.realCompletion = usage.completion
            if (finishReason(payload) === 'tool_calls') {
                emitToolCalls(controller)
            } else if (finishReason(payload) === 'length') {
                state.stopReason = 'max_tokens'
            }
        }

        const transform = new TransformStream({
            start(controller) {
                controller.enqueue(
                    encoder.encode(
                        sse('message_start', {
                            type: 'message_start',
                            message: {
                                id,
                                type: 'message',
                                role: 'assistant',
                                model,
                                content: [],
                                stop_reason: null,
                                stop_sequence: null,
                                usage: { input_tokens: inputEstimate, output_tokens: 0 }
                            }
                        })
                    )
                )
            },
            transform(chunk, controller) {
                const raw = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
                let buffer: string = state._buffer || ''
                buffer += raw
                const lines = buffer.split('\n')
                state._buffer = lines.pop() ?? ''
                for (const line of lines) processLine(controller, line)
            },
            flush(controller) {
                if (state._buffer) processLine(controller, state._buffer)
                state._buffer = ''

                const { text, calls } = hermes.flush()
                if (text) emitText(controller, text)
                if (calls.length > 0) emitHermesCalls(controller, calls)

                if (state.toolCalls.size > state.toolBlocksEmitted) {
                    emitToolCalls(controller)
                } else {
                    closeTextBlock(controller)
                    closeThinkingBlock(controller)
                }

                controller.enqueue(
                    encoder.encode(
                        sse('message_delta', {
                            type: 'message_delta',
                            delta: { stop_reason: state.stopReason, stop_sequence: null },
                            usage: {
                                input_tokens: state.realPrompt ?? inputEstimate,
                                output_tokens: state.realCompletion ?? estimateTokens(state.text + state.reasoning)
                            }
                        })
                    )
                )
                controller.enqueue(encoder.encode(sse('message_stop', { type: 'message_stop' })))
            }
        })

        return new Response(source.pipeThrough(transform), {
            status: 200,
            headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }
        })
    }
}
