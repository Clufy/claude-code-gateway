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

const DEFAULT_MODELS = ['@cf/zai-org/glm-5.3', '@cf/moonshotai/kimi-k2.6', '@cf/deepseek-ai/deepseek-v4-pro-0813']

// Real context windows from developers.cloudflare.com/workers-ai/models;
// conservative default so Claude Code compacts before an unknown model overflows.
const CONTEXT_TOKENS: Record<string, number> = {
    '@cf/zai-org/glm-5.3': 1048576,
    '@cf/moonshotai/kimi-k2.6': 262144,
    '@cf/deepseek-ai/deepseek-v4-pro-0813': 1048576
}
const DEFAULT_CONTEXT_TOKENS = 24000

function commaSet(value?: string): Set<string> {
    return new Set(
        value
            ?.split(',')
            .map((s) => s.trim())
            .filter(Boolean) ?? []
    )
}

function toModel(id: string, env: Env): ClaudeModelListing {
    const visionModels = commaSet((env as { VISION_MODELS?: string }).VISION_MODELS)
    const multiToolModels = commaSet((env as { MULTI_TOOL_MODELS?: string }).MULTI_TOOL_MODELS)

    return {
        id,
        type: 'model',
        display_name: id,
        created_at: 0,
        max_input_tokens: CONTEXT_TOKENS[id] ?? DEFAULT_CONTEXT_TOKENS,
        max_tokens: null,
        capabilities: {
            tools: { name: 'tool_use', supported: true },
            vision: { name: 'vision', supported: visionModels.has(id) },
            multi_tool_use: { name: 'multi_tool_use', supported: multiToolModels.has(id) }
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
            data: ids.map((id) => toModel(id, env)),
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
    return jsonResponse({ ...toModel(id, env), type: 'model' }, 200, requestId)
}
