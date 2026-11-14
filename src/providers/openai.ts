import { upstreamHeaders } from '../routing/upstream-headers'
import * as types from '../translate/types'
import * as provider from './provider'
import * as utils from '../translate/common'
import * as tokens from '../translate/tokens'
import * as reasoning from '../translate/reasoning'
import * as toolChoice from '../translate/tool-choice'
import { jsonResponse } from '../http/errors'

type ClaudeStreamState = {
    textBlockOpen: boolean
    textBlockIndex: number
    // ponytail: text and tool_use blocks share ONE index space — the Anthropic
    // stream protocol requires sequential, non-repeating content_block indices.
    nextBlockIndex: number
    stopReason: types.ClaudeStopReason
    usage: types.ClaudeUsage
}

// ponytail: loose union — only touch the fields we read
// prettier-ignore
type ResponsesStreamEvent = {
    type: string
    delta?: string
    output_index?: number
    item?: { type: string; name?: string; call_id?: string; arguments?: string }
    response?: types.OpenAIResponsesResponse
}

function systemText(system: types.ClaudeRequest['system']): string | undefined {
    if (!system) return undefined
    if (typeof system === 'string') return system
    return system
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n')
}

function contentToText(content: types.ClaudeContent): string {
    if (typeof content === 'string') return content
    return content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n')
}

function imageSourceToUrl(source: types.ClaudeImageSource): string | undefined {
    if (source.type === 'url') return source.url
    return `data:${source.media_type};base64,${source.data}`
}

function documentToText(source: types.ClaudeDocumentSource): string | undefined {
    if (source.type === 'text') return source.text
    return undefined
}

function toolResultToText(content: string | unknown): string {
    return typeof content === 'string' ? content : JSON.stringify(content)
}

function stopReasonFromOpenAI(finishReason?: string | null): types.ClaudeStopReason {
    switch (finishReason) {
        case 'tool_calls':
        case 'function_call':
            return 'tool_use'
        case 'length':
            return 'max_tokens'
        case 'stop':
        default:
            return 'end_turn'
    }
}

function stopReasonFromResponseStatus(status?: string): types.ClaudeStopReason {
    return status === 'incomplete' ? 'max_tokens' : 'end_turn'
}

function parseToolArguments(args: string): unknown {
    return utils.safeJsonParse(args || '{}')
}

function initStreamState(inputTokensEstimate: number): ClaudeStreamState {
    return {
        textBlockOpen: false,
        textBlockIndex: 0,
        nextBlockIndex: 0,
        stopReason: 'end_turn',
        // ponytail: estimate as fallback — some providers never send a usage chunk
        usage: { input_tokens: inputTokensEstimate, output_tokens: 0 }
    }
}

function openTextBlockIfNeeded(events: string[], state: ClaudeStreamState): void {
    if (state.textBlockOpen) return
    state.textBlockIndex = state.nextBlockIndex++
    events.push(utils.startTextBlock(state.textBlockIndex))
    state.textBlockOpen = true
}

function closeTextBlockIfNeeded(events: string[], state: ClaudeStreamState): void {
    if (!state.textBlockOpen) return
    events.push(utils.stopContentBlock(state.textBlockIndex))
    state.textBlockOpen = false
}

function enqueueEvents(controller: ReadableStreamDefaultController, events: string[]): void {
    for (const event of events) {
        utils.enqueueRawSse(controller, event)
    }
}

// ponytail: OpenAI only sends `data:` lines; ignore event:/retry: fields
function parseSseData(line: string): any | null {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) return null
    const data = trimmed.slice(5).trim()
    if (!data || data === '[DONE]') return null
    return utils.safeJsonParse(data)
}

async function iterateSse(response: Response, onEvent: (event: any) => void): Promise<void> {
    const reader = response.body?.getReader()
    if (!reader) return
    const decoder = new TextDecoder()
    let buffer = ''
    try {
        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop() ?? ''
            for (const line of lines) {
                const event = parseSseData(line)
                if (event) onEvent(event)
            }
        }
        const event = parseSseData(buffer)
        if (event) onEvent(event)
    } finally {
        reader.releaseLock()
    }
}

export class ChatCompletionsProvider implements provider.Provider {
    private inputTokensEstimate = 0

    async convertToProviderRequest(request: Request, baseUrl: string, apiKey: string): Promise<Request> {
        const claudeRequest = (await request.json()) as types.ClaudeRequest
        claudeRequest.messages = utils.objectMessages(claudeRequest.messages)
        this.inputTokensEstimate = tokens.countTokensForRequest(claudeRequest).input_tokens
        const openaiRequest = this.convertToOpenAIRequestBody(claudeRequest)
        const finalUrl = utils.buildUrl(baseUrl, 'chat/completions')

        const headers = upstreamHeaders(request.headers)
        headers.set('Authorization', apiKey.startsWith('Bearer ') ? apiKey : `Bearer ${apiKey}`)
        headers.set('Content-Type', 'application/json')

        return new Request(finalUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(openaiRequest)
        })
    }

    async convertToClaudeResponse(openaiResponse: Response): Promise<Response> {
        if (!openaiResponse.ok) {
            return openaiResponse
        }
        const contentType = openaiResponse.headers.get('content-type') || ''
        if (contentType.includes('text/event-stream')) {
            return this.convertStreamResponse(openaiResponse)
        }
        const openaiData = (await openaiResponse.json()) as types.OpenAIResponse
        return this.convertNormalResponse(openaiData)
    }

    private convertToOpenAIRequestBody(claudeRequest: types.ClaudeRequest): types.OpenAIRequest {
        const openaiRequest: types.OpenAIRequest = {
            model: claudeRequest.model,
            messages: this.convertMessages(claudeRequest),
            stream: claudeRequest.stream ?? false
        }

        if (claudeRequest.tools && claudeRequest.tools.length > 0) {
            openaiRequest.tools = claudeRequest.tools.map((tool) => ({
                type: 'function',
                function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: utils.cleanJsonSchema(tool.input_schema)
                }
            }))
        }

        if (claudeRequest.temperature !== undefined) {
            openaiRequest.temperature = claudeRequest.temperature
        }

        if (claudeRequest.max_tokens !== undefined) {
            openaiRequest.max_tokens = claudeRequest.max_tokens
        }

        if (claudeRequest.stream) {
            openaiRequest.stream_options = { include_usage: true }
        }

        if (claudeRequest.stop_sequences && claudeRequest.stop_sequences.length > 0) {
            openaiRequest.stop = claudeRequest.stop_sequences
        }

        if (claudeRequest.tool_choice !== undefined) {
            openaiRequest.tool_choice = toolChoice.toOpenAIChatToolChoice(claudeRequest.tool_choice)
        }

        if (claudeRequest.reasoning_effort !== undefined) {
            openaiRequest.reasoning_effort = reasoning.toOpenAIChatEffort(claudeRequest.reasoning_effort)
        }

        return openaiRequest
    }

    private convertMessages(claudeRequest: types.ClaudeRequest): types.OpenAIMessage[] {
        const openaiMessages: types.OpenAIMessage[] = []
        const system = systemText(claudeRequest.system)
        if (system) {
            openaiMessages.push({ role: 'system', content: system })
        }

        for (const message of claudeRequest.messages) {
            if (typeof message.content === 'string') {
                openaiMessages.push({
                    role: message.role === 'assistant' ? 'assistant' : 'user',
                    content: message.content
                })
                continue
            }

            const textContents: string[] = []
            const imageParts: types.OpenAIContentPart[] = []
            const toolCalls: types.OpenAIToolCall[] = []
            const toolResults: Array<{ tool_call_id: string; content: string }> = []

            for (const content of message.content) {
                switch (content.type) {
                    case 'text':
                        textContents.push(content.text)
                        break
                    case 'image': {
                        const url = imageSourceToUrl(content.source)
                        if (url) imageParts.push({ type: 'image_url', image_url: { url } })
                        break
                    }
                    case 'document': {
                        const text = documentToText(content.source)
                        if (text) textContents.push(text)
                        break
                    }
                    case 'tool_use':
                        toolCalls.push({
                            id: content.id,
                            type: 'function',
                            function: {
                                name: content.name,
                                arguments: JSON.stringify(content.input)
                            }
                        })
                        break
                    case 'tool_result':
                        toolResults.push({
                            tool_call_id: content.tool_use_id,
                            content: toolResultToText(content.content)
                        })
                        break
                }
                // thinking / redacted_thinking / cache_control are silently dropped
            }

            if (imageParts.length > 0) {
                const content: types.OpenAIContentPart[] = []
                if (textContents.length > 0) content.push({ type: 'text', text: textContents.join('\n') })
                content.push(...imageParts)
                openaiMessages.push({
                    role: message.role === 'assistant' ? 'assistant' : 'user',
                    content
                })
            } else if (textContents.length > 0 || toolCalls.length > 0) {
                openaiMessages.push({
                    role: message.role === 'assistant' ? 'assistant' : 'user',
                    content: textContents.length > 0 ? textContents.join('\n') : null,
                    tool_calls: toolCalls.length > 0 ? toolCalls : undefined
                })
            }

            for (const toolResult of toolResults) {
                openaiMessages.push({
                    role: 'tool',
                    tool_call_id: toolResult.tool_call_id,
                    content: toolResult.content
                })
            }
        }

        return openaiMessages
    }

    private convertNormalResponse(openaiData: types.OpenAIResponse): Response {
        const claudeResponse: types.ClaudeResponse = {
            id: openaiData.id || utils.generateId(),
            type: 'message',
            role: 'assistant',
            content: [],
            usage: { input_tokens: 0, output_tokens: 0 }
        }

        if (openaiData.choices && openaiData.choices.length > 0) {
            const choice = openaiData.choices[0]
            const message = choice.message

            if (typeof message.content === 'string' && message.content) {
                claudeResponse.content.push({ type: 'text', text: message.content })
            } else if (Array.isArray(message.content)) {
                for (const part of message.content) {
                    if (part.type === 'text') {
                        claudeResponse.content.push({ type: 'text', text: part.text })
                    }
                }
            }

            if (message.tool_calls) {
                for (const toolCall of message.tool_calls) {
                    if (toolCall.type !== 'function') continue
                    claudeResponse.content.push({
                        type: 'tool_use',
                        id: toolCall.id,
                        name: toolCall.function.name,
                        input: parseToolArguments(toolCall.function.arguments)
                    })
                }
            }

            claudeResponse.stop_reason = stopReasonFromOpenAI(choice.finish_reason)
        }

        // some providers set finish_reason 'stop' alongside tool_calls — mirror the streaming safety net
        if (
            claudeResponse.stop_reason === 'end_turn' &&
            claudeResponse.content.some((block) => block.type === 'tool_use')
        ) {
            claudeResponse.stop_reason = 'tool_use'
        }

        if (openaiData.usage) {
            claudeResponse.usage = {
                input_tokens: openaiData.usage.prompt_tokens,
                output_tokens: openaiData.usage.completion_tokens,
                cache_read_input_tokens: openaiData.usage.prompt_tokens_details?.cached_tokens,
                cache_creation_input_tokens: openaiData.usage.cache_creation_input_tokens
            }
        }

        return jsonResponse(claudeResponse, 200)
    }

    private convertStreamResponse(openaiResponse: Response): Response {
        const inputTokensEstimate = this.inputTokensEstimate
        const stream = new ReadableStream({
            async start(controller) {
                const state = initStreamState(inputTokensEstimate)
                const toolCallState = new Map<
                    number,
                    { id?: string; name?: string; args: string; blockIndex: number }
                >()

                utils.sendMessageStart(controller, {
                    input_tokens: inputTokensEstimate,
                    output_tokens: 0
                })

                try {
                    await iterateSse(openaiResponse, (chunk: types.OpenAIStreamResponse) => {
                        if (chunk.usage) {
                            state.usage = {
                                input_tokens: chunk.usage.prompt_tokens ?? 0,
                                output_tokens: chunk.usage.completion_tokens ?? 0,
                                cache_read_input_tokens: chunk.usage.prompt_tokens_details?.cached_tokens,
                                cache_creation_input_tokens: chunk.usage.cache_creation_input_tokens
                            }
                        }

                        if (!chunk.choices || chunk.choices.length === 0) return

                        const choice = chunk.choices[0]
                        const delta = choice.delta
                        const events: string[] = []

                        if (delta.content) {
                            openTextBlockIfNeeded(events, state)
                            events.push(utils.textDelta(delta.content, state.textBlockIndex))
                        }

                        if (delta.tool_calls) {
                            closeTextBlockIfNeeded(events, state)
                            for (const toolCall of delta.tool_calls) {
                                const existing = toolCallState.get(toolCall.index)
                                if (existing) {
                                    if (toolCall.id) existing.id = toolCall.id
                                    if (toolCall.function?.name) existing.name = toolCall.function.name
                                    if (toolCall.function?.arguments) {
                                        existing.args += toolCall.function.arguments
                                        events.push(
                                            utils.inputJsonDelta(existing.blockIndex, toolCall.function.arguments)
                                        )
                                    }
                                } else {
                                    const name = toolCall.function?.name
                                    if (!name && !toolCall.id) continue
                                    const id = toolCall.id || utils.generateId()
                                    const blockIndex = state.nextBlockIndex++
                                    toolCallState.set(toolCall.index, { id, name, args: '', blockIndex })
                                    events.push(utils.startToolUseBlock(blockIndex, id, name || 'unknown'))
                                    if (toolCall.function?.arguments) {
                                        events.push(utils.inputJsonDelta(blockIndex, toolCall.function.arguments))
                                    }
                                }
                            }
                        }

                        if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'function_call') {
                            closeTextBlockIfNeeded(events, state)
                            // tool blocks are stopped once, after the stream loop below
                            if (toolCallState.size > 0) state.stopReason = 'tool_use'
                        } else if (choice.finish_reason) {
                            closeTextBlockIfNeeded(events, state)
                            state.stopReason = stopReasonFromOpenAI(choice.finish_reason)
                        }

                        enqueueEvents(controller, events)
                    })

                    const events: string[] = []
                    closeTextBlockIfNeeded(events, state)
                    for (const [, toolCall] of [...toolCallState].sort(([a], [b]) => a - b)) {
                        events.push(utils.stopContentBlock(toolCall.blockIndex))
                    }
                    // some providers send finish_reason 'stop' alongside tool_calls deltas
                    if (toolCallState.size > 0) state.stopReason = 'tool_use'
                    enqueueEvents(controller, events)
                    utils.sendMessageDelta(controller, state.stopReason, state.usage)
                    utils.sendMessageStop(controller)
                } catch (error) {
                    console.error(error)
                    utils.sendErrorEvent(controller, error instanceof Error ? error.message : String(error))
                } finally {
                    controller.close()
                }
            }
        })

        return streamResponse(stream)
    }
}

export class ResponsesProvider implements provider.Provider {
    private inputTokensEstimate = 0

    async convertToProviderRequest(request: Request, baseUrl: string, apiKey: string): Promise<Request> {
        const claudeRequest = (await request.json()) as types.ClaudeRequest
        claudeRequest.messages = utils.objectMessages(claudeRequest.messages)
        this.inputTokensEstimate = tokens.countTokensForRequest(claudeRequest).input_tokens
        const openaiRequest = this.convertToResponsesRequestBody(claudeRequest)
        const finalUrl = utils.buildUrl(baseUrl, 'responses')

        const headers = upstreamHeaders(request.headers)
        headers.set('Authorization', apiKey.startsWith('Bearer ') ? apiKey : `Bearer ${apiKey}`)
        headers.set('Content-Type', 'application/json')

        return new Request(finalUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(openaiRequest)
        })
    }

    async convertToClaudeResponse(openaiResponse: Response): Promise<Response> {
        if (!openaiResponse.ok) {
            return openaiResponse
        }
        const contentType = openaiResponse.headers.get('content-type') || ''
        if (contentType.includes('text/event-stream')) {
            return this.convertStreamResponse(openaiResponse)
        }
        const openaiData = (await openaiResponse.json()) as types.OpenAIResponsesResponse
        return this.convertNormalResponse(openaiData)
    }

    private convertToResponsesRequestBody(claudeRequest: types.ClaudeRequest): types.OpenAIResponsesRequest {
        const openaiRequest: types.OpenAIResponsesRequest = {
            model: claudeRequest.model,
            input: this.convertInput(claudeRequest.messages),
            stream: claudeRequest.stream ?? false
        }

        const system = systemText(claudeRequest.system)
        if (system) {
            openaiRequest.instructions = system
        }

        if (claudeRequest.tools && claudeRequest.tools.length > 0) {
            openaiRequest.tools = claudeRequest.tools.map((tool) => ({
                type: 'function',
                name: tool.name,
                description: tool.description,
                parameters: utils.cleanJsonSchema(tool.input_schema)
            }))
        }

        if (claudeRequest.temperature !== undefined) {
            openaiRequest.temperature = claudeRequest.temperature
        }

        if (claudeRequest.max_tokens !== undefined) {
            openaiRequest.max_output_tokens = claudeRequest.max_tokens
        }

        if (claudeRequest.reasoning_effort !== undefined) {
            openaiRequest.reasoning = { effort: claudeRequest.reasoning_effort }
        }

        if (claudeRequest.tool_choice !== undefined) {
            openaiRequest.tool_choice = toolChoice.toOpenAIResponsesToolChoice(claudeRequest.tool_choice)
        }

        return openaiRequest
    }

    private convertInput(messages: types.ClaudeMessage[]): types.OpenAIResponsesInputItem[] {
        const input: types.OpenAIResponsesInputItem[] = []

        for (const message of messages) {
            if (typeof message.content === 'string') {
                input.push({
                    type: 'message',
                    role: message.role,
                    content: [
                        {
                            type: message.role === 'assistant' ? 'output_text' : 'input_text',
                            text: message.content
                        }
                    ]
                })
                continue
            }

            const text = contentToText(message.content)
            const contentParts: types.OpenAIResponsesContentPart[] = []
            if (text) {
                contentParts.push({
                    type: message.role === 'assistant' ? 'output_text' : 'input_text',
                    text
                })
            }

            for (const content of message.content) {
                if (content.type === 'image') {
                    const url = imageSourceToUrl(content.source)
                    if (url) {
                        contentParts.push({ type: 'input_image', image_url: url })
                    }
                } else if (content.type === 'document') {
                    const text = documentToText(content.source)
                    if (text) {
                        contentParts.push({ type: 'input_text', text })
                    }
                }
                // thinking / redacted_thinking / cache_control are silently dropped
            }

            if (contentParts.length > 0) {
                input.push({
                    type: 'message',
                    role: message.role,
                    content: contentParts
                })
            }

            for (const content of message.content) {
                if (content.type === 'tool_use') {
                    input.push({
                        type: 'function_call',
                        call_id: content.id,
                        name: content.name,
                        arguments: JSON.stringify(content.input)
                    })
                } else if (content.type === 'tool_result') {
                    input.push({
                        type: 'function_call_output',
                        call_id: content.tool_use_id,
                        output: toolResultToText(content.content)
                    })
                }
            }
        }

        return input
    }

    private convertNormalResponse(openaiData: types.OpenAIResponsesResponse): Response {
        const claudeResponse: types.ClaudeResponse = {
            id: openaiData.id || utils.generateId(),
            type: 'message',
            role: 'assistant',
            content: [],
            stop_reason: 'end_turn',
            usage: { input_tokens: 0, output_tokens: 0 }
        }

        for (const output of openaiData.output ?? []) {
            if (output.type === 'message') {
                for (const content of output.content ?? []) {
                    if (content.type === 'output_text') {
                        claudeResponse.content.push({ type: 'text', text: content.text })
                    }
                }
            } else if (output.type === 'function_call') {
                claudeResponse.content.push({
                    type: 'tool_use',
                    id: output.call_id,
                    name: output.name,
                    input: parseToolArguments(output.arguments)
                })
                claudeResponse.stop_reason = 'tool_use'
            }
        }

        if (claudeResponse.content.length === 0 && openaiData.output_text) {
            claudeResponse.content.push({ type: 'text', text: openaiData.output_text })
        }

        if (openaiData.status === 'incomplete') {
            claudeResponse.stop_reason = 'max_tokens'
        }

        if (openaiData.usage) {
            claudeResponse.usage = {
                input_tokens: openaiData.usage.input_tokens ?? 0,
                output_tokens: openaiData.usage.output_tokens ?? 0,
                cache_read_input_tokens: openaiData.usage.input_tokens_details?.cached_tokens,
                cache_creation_input_tokens: openaiData.usage.cache_creation_input_tokens
            }
        }

        return jsonResponse(claudeResponse, 200)
    }

    private convertStreamResponse(openaiResponse: Response): Response {
        const inputTokensEstimate = this.inputTokensEstimate
        const stream = new ReadableStream({
            async start(controller) {
                const state = initStreamState(inputTokensEstimate)
                const functionCalls = new Map<number, { name?: string; callId?: string; args: string }>()

                utils.sendMessageStart(controller, {
                    input_tokens: inputTokensEstimate,
                    output_tokens: 0
                })

                try {
                    await iterateSse(openaiResponse, (event: ResponsesStreamEvent) => {
                        const events: string[] = []

                        switch (event.type) {
                            case 'response.output_text.delta':
                                if (event.delta) {
                                    openTextBlockIfNeeded(events, state)
                                    events.push(utils.textDelta(event.delta, state.textBlockIndex))
                                }
                                break
                            case 'response.output_item.added':
                                if (event.item?.type === 'function_call') {
                                    const index = event.output_index ?? functionCalls.size
                                    functionCalls.set(index, {
                                        name: event.item.name,
                                        callId: event.item.call_id,
                                        args: event.item.arguments ?? ''
                                    })
                                }
                                break
                            case 'response.function_call_arguments.delta': {
                                const index = event.output_index ?? 0
                                const call = functionCalls.get(index) ?? { args: '' }
                                call.args += event.delta ?? ''
                                functionCalls.set(index, call)
                                break
                            }
                            case 'response.output_item.done':
                                if (event.item?.type === 'function_call') {
                                    closeTextBlockIfNeeded(events, state)
                                    const index = event.output_index ?? 0
                                    const call = functionCalls.get(index) ?? { args: '' }
                                    call.name = event.item.name ?? call.name
                                    call.callId = event.item.call_id ?? call.callId
                                    call.args = event.item.arguments ?? call.args
                                    if (call.name) {
                                        events.push(
                                            ...utils.processToolUsePart(
                                                { name: call.name, args: parseToolArguments(call.args) },
                                                state.nextBlockIndex
                                            )
                                        )
                                        state.nextBlockIndex++
                                        state.stopReason = 'tool_use'
                                    }
                                }
                                break
                            case 'response.completed':
                                closeTextBlockIfNeeded(events, state)
                                // tool_use must survive response.completed — it fires after the calls
                                if (state.stopReason !== 'tool_use') {
                                    state.stopReason = stopReasonFromResponseStatus(event.response?.status)
                                }
                                if (event.response?.usage) {
                                    state.usage = {
                                        input_tokens: event.response.usage.input_tokens ?? 0,
                                        output_tokens: event.response.usage.output_tokens ?? 0,
                                        cache_read_input_tokens:
                                            event.response.usage.input_tokens_details?.cached_tokens,
                                        cache_creation_input_tokens: event.response.usage.cache_creation_input_tokens
                                    }
                                }
                                break
                            case 'response.incomplete':
                                closeTextBlockIfNeeded(events, state)
                                if (state.stopReason !== 'tool_use') {
                                    state.stopReason = 'max_tokens'
                                }
                                if (event.response?.usage) {
                                    state.usage = {
                                        input_tokens: event.response.usage.input_tokens ?? 0,
                                        output_tokens: event.response.usage.output_tokens ?? 0,
                                        cache_read_input_tokens:
                                            event.response.usage.input_tokens_details?.cached_tokens,
                                        cache_creation_input_tokens: event.response.usage.cache_creation_input_tokens
                                    }
                                }
                                break
                        }

                        enqueueEvents(controller, events)
                    })

                    const events: string[] = []
                    closeTextBlockIfNeeded(events, state)
                    enqueueEvents(controller, events)
                    utils.sendMessageDelta(controller, state.stopReason, state.usage)
                    utils.sendMessageStop(controller)
                } catch (error) {
                    console.error(error)
                    utils.sendErrorEvent(controller, error instanceof Error ? error.message : String(error))
                } finally {
                    controller.close()
                }
            }
        })

        return streamResponse(stream)
    }
}

function streamResponse(stream: ReadableStream): Response {
    return new Response(stream, {
        status: 200,
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive'
        }
    })
}
