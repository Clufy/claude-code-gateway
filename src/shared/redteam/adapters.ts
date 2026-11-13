import type { AdapterResult, RedteamCase, Turn } from './types.ts'

export type AdapterOpts = {
    url: string
    model?: string
    headers: Record<string, string>
    fetch: typeof fetch
    timeoutMs: number
    checkHop: (url: string) => string | null
    template?: string
    replyPath?: string
}

export type Adapter = (c: RedteamCase, opts: AdapterOpts) => Promise<AdapterResult>

const MAX_TEXT = 32768
const MAX_JSON_BYTES = 1024 * 1024
const MAX_HOPS = 5

class AdapterError extends Error {}

const fail = (msg: string): never => {
    throw new AdapterError(msg)
}

async function readBody(res: Response, truncate: boolean): Promise<string> {
    const reader = res.body?.getReader()
    if (!reader) return ''
    const decoder = new TextDecoder()
    let text = ''
    let bytes = 0
    for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.length
        if (!truncate && bytes > MAX_JSON_BYTES) {
            await reader.cancel().catch(() => {})
            return fail('reply too large')
        }
        text += decoder.decode(value, { stream: true })
        if (truncate && text.length >= MAX_TEXT) {
            await reader.cancel().catch(() => {})
            return text.slice(0, MAX_TEXT)
        }
    }
    text += decoder.decode()
    return truncate ? text.slice(0, MAX_TEXT) : text
}

async function send(opts: AdapterOpts, body: string, extraHeaders: Record<string, string>): Promise<Response> {
    const signal = AbortSignal.timeout(opts.timeoutMs)
    let url = opts.url
    let headers: Record<string, string> = { 'content-type': 'application/json', ...extraHeaders, ...opts.headers }
    for (let hops = 0; ; hops++) {
        const res = await opts.fetch(url, { method: 'POST', headers, body, redirect: 'manual', signal })
        if (res.status < 300 || res.status >= 400) return res
        await res.body?.cancel().catch(() => {})
        const loc = res.headers.get('location')
        if (!loc) return res
        if (hops >= MAX_HOPS) return fail('too many redirects')
        let next: URL
        try {
            next = new URL(loc, url)
        } catch {
            return fail('redirect blocked: invalid redirect URL')
        }
        const refused = opts.checkHop(next.href)
        if (refused !== null) return fail(`redirect blocked: ${refused}`)
        // Credentials stay with the origin they were issued for.
        if (next.origin !== new URL(url).origin) headers = { 'content-type': 'application/json', ...extraHeaders }
        url = next.href
    }
}

function parseJson(text: string): any {
    try {
        return JSON.parse(text)
    } catch {
        return fail('unparseable reply')
    }
}

function lastTurn(c: RedteamCase): Turn {
    return c.turns[c.turns.length - 1]
}

async function run(
    opts: AdapterOpts,
    body: string,
    extraHeaders: Record<string, string>,
    parse: (res: Response, text: string) => Omit<AdapterResult, 'status' | 'detections'>,
    raw = false
): Promise<AdapterResult> {
    const result: AdapterResult = { text: '', toolCalls: [], detections: [], status: 0 }
    try {
        const res = await send(opts, body, extraHeaders)
        result.status = res.status
        result.detections = (res.headers.get('x-proxy-detections') ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        const text = await readBody(res, raw)
        if (res.status < 200 || res.status >= 300) {
            result.error = `http ${res.status}`
            result.text = raw ? text : text.slice(0, MAX_TEXT)
            return result
        }
        const parsed = parse(res, text)
        result.text = parsed.text.slice(0, MAX_TEXT)
        result.toolCalls = parsed.toolCalls
    } catch (e) {
        const name = (e as { name?: string } | null)?.name
        if (name === 'TimeoutError' || name === 'AbortError') result.error = 'timeout'
        else if (e instanceof AdapterError) result.error = e.message
        else result.error = `request failed${name ? `: ${name}` : ''}`
    }
    return result
}

const anthropic: Adapter = (c, opts) => {
    const messages: unknown[] = []
    let n = 0
    for (const t of c.turns) {
        if (t.role === 'tool_result') {
            const id = `toolu_rt_${++n}`
            messages.push({ role: 'assistant', content: [{ type: 'tool_use', id, name: t.tool, input: {} }] })
            messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: t.content }] })
        } else messages.push({ role: t.role, content: t.content })
    }
    const body: Record<string, unknown> = { model: opts.model, max_tokens: 1024, messages }
    if (c.system) body.system = c.system
    if (c.tools?.length) body.tools = c.tools
    return run(opts, JSON.stringify(body), { 'anthropic-version': '2023-06-01' }, (_r, text) => {
        const j = parseJson(text)
        const blocks: any[] = Array.isArray(j?.content) ? j.content : []
        return {
            text: blocks
                .filter((b) => b?.type === 'text' && typeof b.text === 'string')
                .map((b) => b.text)
                .join(''),
            toolCalls: blocks
                .filter((b) => b?.type === 'tool_use')
                .map((b) => ({ name: String(b.name), args: JSON.stringify(b.input ?? {}) }))
        }
    })
}

const openai: Adapter = (c, opts) => {
    const messages: unknown[] = []
    if (c.system) messages.push({ role: 'system', content: c.system })
    let n = 0
    for (const t of c.turns) {
        if (t.role === 'tool_result') {
            const id = `call_rt_${++n}`
            messages.push({
                role: 'assistant',
                content: null,
                tool_calls: [{ id, type: 'function', function: { name: t.tool, arguments: '{}' } }]
            })
            messages.push({ role: 'tool', tool_call_id: id, content: t.content })
        } else messages.push({ role: t.role, content: t.content })
    }
    const body: Record<string, unknown> = { model: opts.model, messages }
    if (c.tools?.length) {
        body.tools = c.tools.map((t) => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.input_schema }
        }))
    }
    return run(opts, JSON.stringify(body), {}, (_r, text) => {
        const msg = parseJson(text)?.choices?.[0]?.message
        const calls: any[] = Array.isArray(msg?.tool_calls) ? msg.tool_calls : []
        return {
            text: typeof msg?.content === 'string' ? msg.content : '',
            toolCalls: calls.map((k) => ({
                name: String(k?.function?.name),
                args:
                    typeof k?.function?.arguments === 'string'
                        ? k.function.arguments
                        : JSON.stringify(k?.function?.arguments ?? {})
            }))
        }
    })
}

function walkPath(root: unknown, path: string): unknown {
    let cur: any = root
    for (const m of path.matchAll(/([^.[\]]+)|\[(\d+)\]/g)) {
        const key = m[1] ?? m[2]
        if (cur === null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, key))
            return fail('reply path not found')
        cur = cur[key]
    }
    return cur
}

const http: Adapter = (c, opts) => {
    const template = opts.template
    if (!template)
        return Promise.resolve({
            text: '',
            toolCalls: [],
            detections: [],
            status: 0,
            error: 'http adapter needs a template'
        })
    const last = lastTurn(c)
    const prompt = JSON.stringify(last.content).slice(1, -1)
    const history = JSON.stringify(c.turns.slice(0, -1).map((t) => ({ role: t.role, content: t.content })))
    // One pass, so attacker text containing a placeholder is never re-substituted.
    const body = template.replace(/\{\{(prompt|history)\}\}/g, (_m, k: string) => (k === 'prompt' ? prompt : history))
    try {
        JSON.parse(body)
    } catch {
        return Promise.resolve({
            text: '',
            toolCalls: [],
            detections: [],
            status: 0,
            error: 'template did not produce valid JSON'
        })
    }
    const path = opts.replyPath
    return run(
        opts,
        body,
        {},
        (_r, text) => {
            if (!path) return { text, toolCalls: [] }
            const v = walkPath(parseJson(text), path)
            return { text: typeof v === 'string' ? v : JSON.stringify(v), toolCalls: [] }
        },
        !path
    )
}

export const ADAPTERS: Record<'anthropic' | 'openai' | 'http', Adapter> = { anthropic, openai, http }
