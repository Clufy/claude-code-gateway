import type { ProxyConfig } from './config'
import { anthropicError, jsonResponse } from './errors'
import { MODE_ALIAS } from './modes'
import { findRouteEntry } from './routing'

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

// An id a route matches (exact or glob) is served by that route, so the route describes it (P2-R24).
function toModel(id: string, env: Env, cfg: ProxyConfig): ClaudeModelListing {
    const visionModels = commaSet((env as { VISION_MODELS?: string }).VISION_MODELS)
    const multiToolModels = commaSet((env as { MULTI_TOOL_MODELS?: string }).MULTI_TOOL_MODELS)
    const route = findRouteEntry(id, cfg.routes)?.route
    const backing = route?.model ?? id

    const has = (set: Set<string>) => set.has(id) || set.has(backing)

    return {
        id,
        type: 'model',
        display_name: id,
        created_at: 0,
        max_input_tokens: route?.contextTokens ?? CONTEXT_TOKENS[backing] ?? DEFAULT_CONTEXT_TOKENS,
        max_tokens: null,
        capabilities: {
            tools: { name: 'tool_use', supported: true },
            vision: { name: 'vision', supported: has(visionModels) },
            multi_tool_use: { name: 'multi_tool_use', supported: has(multiToolModels) }
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

function listing(env: Env, cfg: ProxyConfig): ClaudeModelListing[] {
    const ids = configuredModelIds(env)
    const routed = cfg.routes.map((e) => e.pattern).filter((p) => !p.includes('*') && !ids.includes(p))
    return [...ids, ...routed].map((id) => toModel(id, env, cfg))
}

export function listModels(env: Env, cfg: ProxyConfig): Response {
    return jsonResponse({ data: listing(env, cfg), has_more: false, first_id: null, last_id: null }, 200)
}

export function getModel(id: string, env: Env, cfg: ProxyConfig, requestId: string): Response {
    id = id.replace(MODE_ALIAS, '') // redteam/claude-x is served as claude-x
    if (id === '' || (!configuredModelIds(env).includes(id) && !findRouteEntry(id, cfg.routes))) {
        return anthropicError(404, 'not_found_error', `Model '${id}' not found.`, requestId)
    }
    return jsonResponse(toModel(id, env, cfg), 200, requestId)
}
