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

export function planTargets(requestedModel: string, cfg: ProxyConfig, env: Record<string, unknown>): Target[] {
    const primary = resolveRoute(requestedModel, cfg.routes)
    const seen = new Set<string>()
    const targets: Target[] = []
    // Dedupe before reading keys: a dropped duplicate's secret is never required.
    for (const name of [requestedModel, ...(primary?.fallback ?? [])]) {
        const route = resolveRoute(name, cfg.routes)
        const backend = route?.provider ?? 'workers-ai'
        const model = route?.model ?? name
        const label = `${backend}:${model}`
        if (seen.has(label)) continue
        seen.add(label)
        if (!route || route.provider === 'workers-ai') {
            targets.push({ backend: 'workers-ai', model, label })
            continue
        }
        const key = route.keySecret ? env[route.keySecret] : undefined
        if (typeof key !== 'string' || key === '') {
            throw new ConfigError(route.keySecret ?? 'MODEL_ROUTES', 'secret not set')
        }
        targets.push({ backend, model, baseUrl: route.baseUrl, apiKey: key, label })
    }
    return targets
}
