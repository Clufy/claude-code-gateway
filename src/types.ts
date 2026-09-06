export interface JsonSchema {
    type?: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'null'
    properties?: { [key: string]: JsonSchema }
    required?: string[]
    description?: string
    items?: JsonSchema
    enum?: Array<string | number | boolean | null>
    anyOf?: JsonSchema[]
    oneOf?: JsonSchema[]
    additionalProperties?: boolean | JsonSchema
}

export interface ClaudeTool {
    name: string
    description: string
    input_schema: JsonSchema
}

export type ClaudeImageSource = { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string }

export type ClaudeDocumentSource =
    { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string } | { type: 'text'; text: string }

export type ClaudeContentBlock =
    | { type: 'text'; text: string; cache_control?: any }
    | { type: 'image'; source: ClaudeImageSource; cache_control?: any }
    | { type: 'document'; source: ClaudeDocumentSource; title?: string; cache_control?: any }
    | { type: 'tool_use'; id: string; name: string; input: any; cache_control?: any }
    | {
          type: 'tool_result'
          tool_use_id: string
          content: string | ClaudeContentBlock[]
          is_error?: boolean
          cache_control?: any
      }
    | { type: 'thinking'; thinking: string; signature?: string }
    | { type: 'redacted_thinking'; data: string }
    | { type: 'cache_control'; cache_control: any }

export type ClaudeContent = string | ClaudeContentBlock[]

export interface ClaudeMessage {
    role: 'user' | 'assistant'
    content: ClaudeContent
}

export type ClaudeToolChoice =
    'auto' | 'any' | 'none' | { type: 'tool'; name: string } | { type: string; [key: string]: any }

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface ClaudeRequest {
    model: string
    messages: ClaudeMessage[]
    system?: string | Array<{ type: 'text'; text: string }>
    max_tokens?: number
    temperature?: number
    stop_sequences?: string[]
    stream?: boolean
    tools?: ClaudeTool[]
    tool_choice?: ClaudeToolChoice
    reasoning_effort?: ReasoningEffort
}

export type ClaudeStopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence'

export interface ClaudeUsage {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
}

export type ClaudeResponseContentBlock =
    | { type: 'text'; text: string }
    | { type: 'thinking'; thinking: string; signature?: string }
    | { type: 'redacted_thinking'; data: string }
    | { type: 'tool_use'; id: string; name: string; input: any }

export interface ClaudeResponse {
    id: string
    type: 'message'
    role: 'assistant'
    model?: string
    content: ClaudeResponseContentBlock[]
    stop_reason?: ClaudeStopReason
    stop_sequence?: string | null
    usage: ClaudeUsage
}

export interface GeminiFunctionDeclaration {
    name: string
    description: string
    parameters: JsonSchema
}

export interface GeminiTool {
    functionDeclarations: GeminiFunctionDeclaration[]
}

export type GeminiPart =
    | { text: string }
    | { inlineData: { mimeType: string; data: string } }
    | { functionCall: { name: string; args: any } }
    | { functionResponse: { name: string; response: any } }

export interface GeminiContent {
    parts: GeminiPart[]
    role?: 'user' | 'model' | 'tool'
}

export interface GeminiRequest {
    model?: string
    contents: GeminiContent[]
    systemInstruction?: GeminiContent
    tools?: GeminiTool[]
    generationConfig?: {
        temperature?: number
        maxOutputTokens?: number
        stopSequences?: string[]
        thinkingConfig?: { thinkingBudget: number }
    }
}

export interface GeminiCandidate {
    content: {
        parts: GeminiPart[]
        role: 'model'
    }
    finishReason?: string
}

export interface GeminiResponse {
    candidates: GeminiCandidate[]
    usageMetadata?: {
        promptTokenCount: number
        candidatesTokenCount: number
        totalTokenCount: number
        cachedContentTokenCount?: number
    }
}

export type OpenAIContentPart =
    { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string; detail?: string } }

export interface OpenAIMessage {
    role: 'system' | 'user' | 'assistant' | 'tool'
    content?: string | null | OpenAIContentPart[]
    tool_calls?: OpenAIToolCall[]
    tool_call_id?: string
}

export interface OpenAIToolCall {
    id: string
    type: 'function'
    function: {
        name: string
        arguments: string
    }
}

export interface OpenAITool {
    type: 'function'
    function: {
        name: string
        description?: string
        parameters?: any
    }
}

export interface OpenAIRequest {
    model: string
    messages: OpenAIMessage[]
    tools?: OpenAITool[]
    tool_choice?: 'none' | 'auto' | 'required' | { type: 'function'; function: { name: string } } | string
    stop?: string[]
    temperature?: number
    max_tokens?: number
    stream?: boolean
    stream_options?: { include_usage?: boolean }
    reasoning_effort?: 'low' | 'medium' | 'high'
}

export interface OpenAIResponsesRequest {
    model: string
    input: OpenAIResponsesInputItem[]
    instructions?: string
    tools?: OpenAIResponsesTool[]
    temperature?: number
    max_output_tokens?: number
    stream?: boolean
    reasoning?: { effort: ReasoningEffort }
}

export type OpenAIResponsesContentPart =
    | { type: 'input_text'; text: string }
    | { type: 'output_text'; text: string }
    | { type: 'input_image'; image_url: string }

export type OpenAIResponsesInputItem =
    | {
          type: 'message'
          role: 'user' | 'assistant' | 'system'
          content: OpenAIResponsesContentPart[]
      }
    | {
          type: 'function_call'
          call_id: string
          name: string
          arguments: string
      }
    | {
          type: 'function_call_output'
          call_id: string
          output: string
      }

export interface OpenAIResponsesTool {
    type: 'function'
    name: string
    description?: string
    parameters?: any
}

export interface OpenAIResponsesResponse {
    id: string
    output?: Array<
        | {
              type: 'message'
              content?: Array<{ type: 'output_text'; text: string } | { type: string; [key: string]: any }>
          }
        | {
              type: 'function_call'
              call_id: string
              name: string
              arguments: string
          }
        | { type: string; [key: string]: any }
    >
    output_text?: string
    status?: string
    usage?: {
        input_tokens?: number
        output_tokens?: number
        input_tokens_details?: { cached_tokens?: number }
        cache_creation_input_tokens?: number
    }
}

export interface OpenAIChoice {
    index: number
    message: OpenAIMessage
    finish_reason: string | null
}

export interface OpenAIResponse {
    id: string
    object: string
    created: number
    model: string
    choices: OpenAIChoice[]
    usage?: {
        prompt_tokens: number
        completion_tokens: number
        total_tokens: number
        prompt_tokens_details?: { cached_tokens?: number }
        cache_creation_input_tokens?: number
    }
}

export interface OpenAIStreamChoice {
    index: number
    delta: {
        role?: string
        content?: string
        tool_calls?: Array<{
            index: number
            id?: string
            type?: 'function'
            function?: {
                name?: string
                arguments?: string
            }
        }>
    }
    finish_reason?: string | null
}

export interface OpenAIStreamResponse {
    id: string
    object: string
    created: number
    model: string
    choices: OpenAIStreamChoice[]
    usage?: {
        prompt_tokens?: number
        completion_tokens?: number
        prompt_tokens_details?: { cached_tokens?: number }
        cache_creation_input_tokens?: number
    }
}
