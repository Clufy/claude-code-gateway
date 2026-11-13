export type Target =
    | { kind: 'self'; model: string | 'all' }
    | { kind: 'external'; adapter: 'anthropic' | 'openai' | 'http'; url: string }

export function parseTarget(s: string): Target {
    const i = s.indexOf(':')
    const kind = i < 0 ? s : s.slice(0, i)
    const rest = i < 0 ? '' : s.slice(i + 1)
    if (kind === 'self') {
        if (rest === '') throw new Error('target self: needs a model or "all"')
        return { kind: 'self', model: rest }
    }
    if (kind === 'anthropic' || kind === 'openai' || kind === 'http') {
        let u: URL
        try {
            u = new URL(rest)
        } catch {
            throw new Error(`target ${kind}: needs a valid URL`)
        }
        if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`target ${kind}: URL must be http(s)`)
        return { kind: 'external', adapter: kind, url: rest }
    }
    throw new Error(`unknown target "${s}": use self:<model>, self:all, or anthropic|openai|http:<url>`)
}
