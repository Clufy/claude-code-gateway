import { ConfigError, type BackendType, type ProxyConfig, type Route, type RouteEntry } from './config'

export interface Target {
    backend: BackendType
    model: string
    baseUrl?: string
    apiKey?: string
    label: string
}

function globToRegex(pattern: string): RegExp {
    const body = pattern
        .split('*')
        .map((part) => part.replace(/[.+?^${}()|[\]\\/-]/g, '\\$&'))
        .join('.*')
    return new RegExp(`^${body}$`)
}

export function findRouteEntry(model: string, routes: RouteEntry[]): RouteEntry | null {
    const exact = routes.find((e) => !e.pattern.includes('*') && e.pattern === model)
    if (exact) return exact
    return routes.find((e) => e.pattern.includes('*') && globToRegex(e.pattern).test(model)) ?? null
}

export function resolveRoute(model: string, routes: RouteEntry[]): Route | null {
    return findRouteEntry(model, routes)?.route ?? null
}

function toTarget(model: string, route: Route | null, env: Record<string, unknown>): Target {
    if (!route || route.provider === 'workers-ai') {
        const m = route?.model ?? model
        return { backend: 'workers-ai', model: m, label: `workers-ai:${m}` }
    }
    const key = route.keySecret ? env[route.keySecret] : undefined
    if (typeof key !== 'string' || key === '') {
        throw new ConfigError(route.keySecret ?? 'MODEL_ROUTES', 'secret not set')
    }
    return {
        backend: route.provider,
        model: route.model,
        baseUrl: route.baseUrl,
        apiKey: key,
        label: `${route.provider}:${route.model}`
    }
}

export function planTargets(requestedModel: string, cfg: ProxyConfig, env: Record<string, unknown>): Target[] {
    const primary = resolveRoute(requestedModel, cfg.routes)
    const targets = [toTarget(requestedModel, primary, env)]
    for (const name of primary?.fallback ?? []) targets.push(toTarget(name, resolveRoute(name, cfg.routes), env))
    const seen = new Set<string>()
    return targets.filter((t) => !seen.has(t.label) && seen.add(t.label))
}
