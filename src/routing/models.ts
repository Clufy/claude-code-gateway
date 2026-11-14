import type { ProxyConfig } from '../config'
import { anthropicError, jsonResponse } from '../http/errors'
import { MODE_ALIAS } from '../modes'
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

// Fallback when no route states a window, so Claude Code compacts before an unknown model overflows.
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
// Settings it leaves unset come from one hop: the route on the same provider whose exact key is its backing model (P8-D1a).
function toModel(id: string, env: Env, cfg: ProxyConfig): ClaudeModelListing {
    const visionModels = commaSet((env as { VISION_MODELS?: string }).VISION_MODELS)
    const multiToolModels = commaSet((env as { MULTI_TOOL_MODELS?: string }).MULTI_TOOL_MODELS)
    const own = findRouteEntry(id, cfg.routes)?.route
    const backing = own?.model ?? id
    const hop = cfg.routes.find(
        (e) =>
            e.pattern === backing && !e.pattern.includes('*') && e.route !== own && e.route.provider === own?.provider
    )?.route

    const legacy = (set: Set<string>) => set.has(id) || set.has(backing)

    return {
        id,
        type: 'model',
        display_name: id,
        created_at: 0,
        max_input_tokens: own?.contextTokens ?? hop?.contextTokens ?? DEFAULT_CONTEXT_TOKENS,
        max_tokens: null,
        capabilities: {
            tools: { name: 'tool_use', supported: true },
            vision: { name: 'vision', supported: own?.vision ?? hop?.vision ?? legacy(visionModels) },
            multi_tool_use: {
                name: 'multi_tool_use',
                supported: own?.multiTool ?? hop?.multiTool ?? legacy(multiToolModels)
            },
            thinking: { name: 'thinking', supported: own?.reasoning ?? hop?.reasoning ?? false }
        }
    }
}

function configuredModelIds(env: Env): string[] {
    return (
        (env as { MODELS?: string }).MODELS?.split(',')
            .map((s) => s.trim())
            .filter(Boolean) ?? []
    )
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
