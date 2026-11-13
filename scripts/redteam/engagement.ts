import type { GateEngagement } from '../../src/shared/redteam/gate.ts'

const strings = (x: unknown): string[] => (Array.isArray(x) ? x.filter((v): v is string => typeof v === 'string') : [])

/** MCP replies may be plain JSON or a single SSE message; return the JSON-RPC object. */
function parseRpc(text: string): unknown {
    const t = text.trim()
    if (t.startsWith('{')) return JSON.parse(t)
    const data = t
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('')
    return JSON.parse(data)
}

/** Reads one engagement from the Worker's /mcp `engagement get` tool. Throws an Error whose message is the exit-2 text. */
export async function fetchEngagement(
    base: string,
    key: string,
    name: string,
    fetchFn: typeof fetch
): Promise<GateEngagement> {
    let res: Response
    try {
        res = await fetchFn(`${base.replace(/\/+$/, '')}/mcp`, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${key}`,
                'content-type': 'application/json',
                accept: 'application/json, text/event-stream'
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: { name: 'engagement', arguments: { action: 'get', name } }
            })
        })
    } catch (e) {
        throw new Error(`cannot reach ${base}/mcp: ${e instanceof Error ? e.message : String(e)}`)
    }
    if (!res.ok) throw new Error(`engagement lookup failed: /mcp returned ${res.status}`)
    let rpc: any
    try {
        rpc = parseRpc(await res.text())
    } catch {
        throw new Error('engagement lookup failed: unparseable /mcp reply')
    }
    if (rpc?.error) throw new Error(`engagement lookup failed: ${String(rpc.error.message ?? 'mcp error')}`)
    const text: unknown = rpc?.result?.content?.[0]?.text
    if (typeof text !== 'string') throw new Error('engagement lookup failed: no content in /mcp reply')
    if (rpc.result.isError === true) throw new Error(text)
    let e: any
    try {
        e = JSON.parse(text)
    } catch {
        throw new Error('engagement lookup failed: engagement is not JSON')
    }
    const start = Date.parse(e?.window?.start)
    const end = Date.parse(e?.window?.end)
    if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error('engagement lookup failed: bad window')
    return {
        name: typeof e.name === 'string' ? e.name : name,
        scope: { domains: strings(e.scope?.domains), llmTargets: strings(e.scope?.llmTargets) },
        exclude: { domains: strings(e.exclude?.domains), cidrs: strings(e.exclude?.cidrs) },
        window: { start, end }
    }
}
