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

interface Planned {
    route: Route | null
    backend: BackendType
    model: string
    label: string
}

function plan(model: string, route: Route | null): Planned {
    const backend = route?.provider ?? 'workers-ai'
    const m = route?.model ?? model
    return { route, backend, model: m, label: `${backend}:${m}` }
}

function attachKey(p: Planned, env: Record<string, unknown>): Target {
    const { route } = p
    if (!route || route.provider === 'workers-ai') return { backend: 'workers-ai', model: p.model, label: p.label }
    const key = route.keySecret ? env[route.keySecret] : undefined
    if (typeof key !== 'string' || key === '') {
        throw new ConfigError(route.keySecret ?? 'MODEL_ROUTES', 'secret not set')
    }
    return { backend: p.backend, model: p.model, baseUrl: route.baseUrl, apiKey: key, label: p.label }
}

export function planTargets(requestedModel: string, cfg: ProxyConfig, env: Record<string, unknown>): Target[] {
    const primary = resolveRoute(requestedModel, cfg.routes)
    const planned = [plan(requestedModel, primary)]
    for (const name of primary?.fallback ?? []) planned.push(plan(name, resolveRoute(name, cfg.routes)))
    const seen = new Set<string>()
    // Dedupe first, then attach keys: a dropped duplicate's secret is never required.
    return planned.filter((p) => !seen.has(p.label) && seen.add(p.label)).map((p) => attachKey(p, env))
}
