import { vi } from 'vitest'
import worker from '../src/index'

const encoder = new TextEncoder()

type AIRun = (model: string, options: any) => Response | Promise<Response>

export function fakeAI(chunks: unknown[] | AIRun): { run(model: string, options?: any): Promise<Response> } {
    return {
        async run(model: string, options?: any) {
            if (typeof chunks === 'function') return chunks(model, options)
            const body = new ReadableStream({
                start(c) {
                    for (const chunk of chunks) c.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
                    c.close()
                }
            })
            return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
        }
    }
}

export function makeEnv(overrides: Record<string, unknown> = {}): Env {
    const env: Record<string, unknown> = { PROXY_KEY: 'test-key', AI: fakeAI([{ response: 'hi' }]) }
    for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined) delete env[key]
        else env[key] = value
    }
    return env as unknown as Env
}

export function callWorker(input: string | Request, init?: RequestInit, env?: Env): Promise<Response> {
    const request = typeof input === 'string' ? new Request(new URL(input, 'https://proxy.test'), init) : input
    return worker.fetch(request, env ?? makeEnv())
}

export async function readSse(res: Response): Promise<{ event: string; data: any }[]> {
    const text = await res.text()
    const events: { event: string; data: any }[] = []
    for (const block of text.split('\n\n')) {
        const lines = block.split('\n')
        const e = lines.find((l) => l.startsWith('event: '))
        const d = lines.find((l) => l.startsWith('data: '))
        if (e && d) events.push({ event: e.slice(7), data: JSON.parse(d.slice(6)) })
    }
    return events
}

export function stubFetch(handler: (req: Request) => Response | Promise<Response>): {
    calls: Request[]
    restore(): void
} {
    const calls: Request[] = []
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const req = new Request(input, init)
        calls.push(req)
        return handler(req)
    })
    return { calls, restore: () => spy.mockRestore() }
}

export function mcpCall(
    method: string,
    params?: unknown,
    opts: { env?: Env; headers?: Record<string, string>; id?: number | null } = {}
): Promise<Response> {
    const message: Record<string, unknown> = { jsonrpc: '2.0', method }
    if (params !== undefined) message.params = params
    if (opts.id !== null) message.id = opts.id ?? 1
    const headers = {
        authorization: 'Bearer test-key',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-06-18',
        ...opts.headers
    }
    return callWorker('/mcp', { method: 'POST', headers, body: JSON.stringify(message) }, opts.env)
}
