import type { ClaudeToolChoice, OpenAIRequest } from './types'

// ponytail: centralize tool_choice mapping. OpenAI Responses supports all
// Anthropic shapes; Chat Completions only supports string or function pinning.

export function toOpenAIChatToolChoice(toolChoice: ClaudeToolChoice): OpenAIRequest['tool_choice'] {
    if (toolChoice === 'auto') return 'auto'
    if (toolChoice === 'any') return 'required'
    if (toolChoice === 'none') return 'none'
    if (typeof toolChoice === 'object' && toolChoice.type === 'tool') {
        return { type: 'function', function: { name: toolChoice.name } }
    }
    return undefined
}

export function toOpenAIResponsesToolChoice(
    toolChoice: ClaudeToolChoice
): 'auto' | 'required' | 'none' | { type: 'function'; function: { name: string } } | undefined {
    if (toolChoice === 'auto') return 'auto'
    if (toolChoice === 'any') return 'required'
    if (toolChoice === 'none') return 'none'
    if (typeof toolChoice === 'object' && toolChoice.type === 'tool') {
        return { type: 'function', function: { name: toolChoice.name } }
    }
    return undefined
}

export function toGeminiToolConfig(
    toolChoice: ClaudeToolChoice
): { functionCallingConfig: { mode: 'AUTO' | 'ANY' | 'NONE'; allowedFunctionNames?: string[] } } | undefined {
    if (toolChoice === 'auto' || toolChoice === undefined || toolChoice === null) return undefined
    if (toolChoice === 'any') {
        return { functionCallingConfig: { mode: 'ANY' } }
    }
    if (toolChoice === 'none') {
        return { functionCallingConfig: { mode: 'NONE' } }
    }
    if (typeof toolChoice === 'object' && toolChoice.type === 'tool') {
        return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [toolChoice.name] } }
    }
    return undefined
}
