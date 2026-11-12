export interface CollectedBlock {
    type: 'text' | 'tool_use' | 'thinking'
    text?: string
    name?: string
    input?: unknown
    inputError?: string
    rawInput?: string // joined partial_json, kept when it failed to parse
}

// Mirrors the proxy's debug stats shape on purpose; scripts/ never imports from src/.
export interface ProxyStats {
    backend: string
    model: string
    fallbackUsed: boolean
    ttfbMs: number
    toolCallsFromText: number
    unparsedToolText: boolean
}

export interface Collected {
    status: number
    /** Time to the first content_block_start/delta event; null for non-stream responses or no content. */
    ttfbMs: number | null
    totalMs: number
    blocks: CollectedBlock[]
    stopReason: string | null
    usage: { input_tokens?: number; output_tokens?: number }
    proxyStats: ProxyStats | null
    error: string | null
}

const STATS_PREFIX = ': proxy-stats '
// The model's first token, not the proxy's own message_start or keepalive pings.
const FIRST_CONTENT = /(^|\n)event:\s*content_block_(start|delta)\b|"type"\s*:\s*"content_block_(start|delta)"/

function parseStats(raw: string | null | undefined): ProxyStats | null {
    if (!raw) return null
    try {
        return JSON.parse(raw) as ProxyStats
    } catch {
        return null
    }
}

function describeError(body: unknown, fallback: string): string {
    const e = (body as { error?: { type?: string; message?: string } } | null)?.error
    return e?.message ? `${e.type ? e.type + ': ' : ''}${e.message}` : fallback
}

/** Reads a whole Anthropic-style response (JSON or SSE). Never throws. */
export async function collectResponse(res: Response, startedAt: number): Promise<Collected> {
    const out: Collected = {
        status: res.status,
        ttfbMs: null,
        totalMs: 0,
        blocks: [],
        stopReason: null,
        usage: {},
        proxyStats: parseStats(res.headers.get('x-proxy-stats')),
        error: null
    }
    const isSse = (res.headers.get('content-type') ?? '').includes('text/event-stream')
    let raw = ''
    try {
        const decoder = new TextDecoder()
        if (res.body) {
            const reader = res.body.getReader()
            for (;;) {
                const { done, value } = await reader.read()
                if (done) break
                // Rescan a small overlap so a marker split across chunks is still found.
                const scanFrom = Math.max(0, raw.length - 64)
                raw += decoder.decode(value, { stream: true })
                if (isSse && out.ttfbMs === null && FIRST_CONTENT.test(raw.slice(scanFrom))) {
                    out.ttfbMs = Date.now() - startedAt
                }
            }
            raw += decoder.decode()
        }
    } catch (e) {
        out.error = `body read failed: ${e instanceof Error ? e.message : String(e)}`
    }
    out.totalMs = Date.now() - startedAt

    try {
        if (isSse) parseSse(raw, out)
        else parseJson(raw, out)
    } catch (e) {
        out.error ??= `unparseable body: ${e instanceof Error ? e.message : String(e)}`
    }
    if (res.status >= 400) out.error ??= `HTTP ${res.status}`
    return out
}

function parseJson(raw: string, out: Collected): void {
    let body: any
    try {
        body = JSON.parse(raw)
    } catch {
        out.error =
            out.status >= 400 ? `HTTP ${out.status}: ${raw.slice(0, 200)}` : `unparseable body: ${raw.slice(0, 80)}`
        return
    }
    if (out.status >= 400) {
        out.error = `HTTP ${out.status}: ${describeError(body, raw.slice(0, 200))}`
        return
    }
    for (const b of Array.isArray(body?.content) ? body.content : []) {
        if (b.type === 'text') out.blocks.push({ type: 'text', text: b.text ?? '' })
        else if (b.type === 'thinking') out.blocks.push({ type: 'thinking', text: b.thinking ?? '' })
        else if (b.type === 'tool_use') out.blocks.push({ type: 'tool_use', name: b.name, input: b.input })
    }
    out.stopReason = body?.stop_reason ?? null
    out.usage = body?.usage ?? {}
}

function parseSse(raw: string, out: Collected): void {
    const frames = raw.replace(/\r\n?/g, '\n').split('\n\n')
    const blocks = new Map<number, CollectedBlock>()
    const jsonParts = new Map<number, string>()
    for (const frame of frames) {
        let event = ''
        const data: string[] = []
        for (const line of frame.split('\n')) {
            if (line.startsWith(STATS_PREFIX))
                out.proxyStats = parseStats(line.slice(STATS_PREFIX.length)) ?? out.proxyStats
            else if (line.startsWith('event:')) event = line.slice(6).trim()
            else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
        }
        if (!data.length) continue
        let d: any
        try {
            d = JSON.parse(data.join('\n'))
        } catch {
            out.error ??= `unparseable SSE data for event ${event || '?'}`
            continue
        }
        const type = d?.type ?? event
        if (type === 'error') out.error ??= describeError(d, 'SSE error event')
        else if (type === 'message_start') Object.assign(out.usage, d.message?.usage)
        else if (type === 'message_delta') {
            out.stopReason = d.delta?.stop_reason ?? out.stopReason
            Object.assign(out.usage, d.usage)
        } else if (type === 'content_block_start') {
            const cb = d.content_block ?? {}
            const block: CollectedBlock =
                cb.type === 'tool_use'
                    ? { type: 'tool_use', name: cb.name }
                    : cb.type === 'thinking'
                      ? { type: 'thinking', text: cb.thinking ?? '' }
                      : { type: 'text', text: cb.text ?? '' }
            blocks.set(d.index, block)
            jsonParts.set(d.index, '')
        } else if (type === 'content_block_delta') {
            const block = blocks.get(d.index)
            if (!block) continue
            const delta = d.delta ?? {}
            if (delta.type === 'text_delta') block.text = (block.text ?? '') + delta.text
            else if (delta.type === 'thinking_delta') block.text = (block.text ?? '') + delta.thinking
            else if (delta.type === 'input_json_delta')
                jsonParts.set(d.index, (jsonParts.get(d.index) ?? '') + (delta.partial_json ?? ''))
        }
    }
    for (const [index, block] of [...blocks.entries()].sort((a, b) => a[0] - b[0])) {
        if (block.type === 'tool_use') {
            const json = jsonParts.get(index) ?? ''
            try {
                block.input = json === '' ? {} : JSON.parse(json)
            } catch (e) {
                block.inputError = e instanceof Error ? e.message : String(e)
                block.rawInput = json
            }
        }
        out.blocks.push(block)
    }
}
