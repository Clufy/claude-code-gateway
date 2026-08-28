import { anthropicError, jsonResponse } from './errors'

interface ClaudeModelListing {
    id: string
    type: 'model'
    display_name: string
    created_at: number
    max_input_tokens: number | null
    max_tokens: number | null
    capabilities: Record<string, { name: string; supported: boolean }>
}

const DEFAULT_MODELS = [
    '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    '@cf/meta/llama-3.1-8b-instruct-fast',
    '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b'
]

function toModel(id: string): ClaudeModelListing {
    return {
        id,
        type: 'model',
        display_name: id,
        created_at: 0,
        max_input_tokens: null,
        max_tokens: null,
        capabilities: {
            tools: { name: 'tool_use', supported: false },
            vision: { name: 'vision', supported: false },
            multi_tool_use: { name: 'multi_tool_use', supported: false }
        }
    }
}

function configuredModelIds(env: Env): string[] {
    const models = (env as { MODELS?: string }).MODELS
    const ids =
        models
            ?.split(',')
            .map((s) => s.trim())
            .filter(Boolean) ?? []
    return ids.length > 0 ? ids : DEFAULT_MODELS
}

export function listModels(env: Env): Response {
    const ids = configuredModelIds(env)
    return jsonResponse(
        {
            data: ids.map(toModel),
            has_more: false,
            first_id: null,
            last_id: null
        },
        200
    )
}

export function getModel(id: string, env: Env, requestId: string): Response {
    const ids = configuredModelIds(env)
    if (!ids.includes(id)) {
        return anthropicError(404, 'not_found_error', `Model '${id}' not found.`, requestId)
    }
    return jsonResponse({ ...toModel(id), type: 'model' }, 200, requestId)
}
