import { expect, it } from 'vitest'
import { toOpenAIChatToolChoice, toOpenAIResponsesToolChoice, toGeminiToolConfig } from '../src/tool-choice'

it('maps tool_choice for OpenAI Chat Completions', () => {
    expect(toOpenAIChatToolChoice('auto')).toBe('auto')
    expect(toOpenAIChatToolChoice('any')).toBe('required')
    expect(toOpenAIChatToolChoice('none')).toBe('none')
    expect(toOpenAIChatToolChoice({ type: 'tool', name: 'foo' })).toEqual({
        type: 'function',
        function: { name: 'foo' }
    })
    expect(toOpenAIChatToolChoice('unknown' as any)).toBeUndefined()
})

it('maps tool_choice for OpenAI Responses', () => {
    expect(toOpenAIResponsesToolChoice('auto')).toBe('auto')
    expect(toOpenAIResponsesToolChoice('any')).toBe('required')
    expect(toOpenAIResponsesToolChoice('none')).toBe('none')
    expect(toOpenAIResponsesToolChoice({ type: 'tool', name: 'foo' })).toEqual({
        type: 'function',
        function: { name: 'foo' }
    })
})

it('maps tool_choice for Gemini', () => {
    expect(toGeminiToolConfig('auto')).toBeUndefined()
    expect(toGeminiToolConfig(undefined as any)).toBeUndefined()
    expect(toGeminiToolConfig('any')).toEqual({ functionCallingConfig: { mode: 'ANY' } })
    expect(toGeminiToolConfig('none')).toEqual({ functionCallingConfig: { mode: 'NONE' } })
    expect(toGeminiToolConfig({ type: 'tool', name: 'foo' })).toEqual({
        functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['foo'] }
    })
})
