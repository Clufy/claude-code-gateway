import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir, userInfo } from 'node:os'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { LOCAL_FIXTURE_PATH, redactFixture } from './fixture.ts'

const { values } = parseArgs({ options: { port: { type: 'string', default: '8787' } } })
if (!/^[0-9]+$/.test(values.port) || Number(values.port) > 65535) {
    console.error(`capture: --port must be a port number, got "${values.port}"`)
    process.exit(2)
}

const target = resolve(import.meta.dirname, '../..', LOCAL_FIXTURE_PATH)

const MAX_BODY = 64 * 1024 * 1024

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

function message(model: string, stream: boolean): { type: string; body: string } {
    const usage = { input_tokens: 1, output_tokens: 1 }
    const base = { id: 'msg_capture', type: 'message', role: 'assistant', model, stop_sequence: null }
    if (!stream) {
        return {
            type: 'application/json',
            body: JSON.stringify({
                ...base,
                content: [{ type: 'text', text: 'captured' }],
                stop_reason: 'end_turn',
                usage
            })
        }
    }
    return {
        type: 'text/event-stream',
        body: [
            sse('message_start', {
                type: 'message_start',
                message: { ...base, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } }
            }),
            sse('content_block_start', {
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'text', text: '' }
            }),
            sse('content_block_delta', {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: 'captured' }
            }),
            sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
            sse('message_delta', {
                type: 'message_delta',
                delta: { stop_reason: 'end_turn', stop_sequence: null },
                usage: { output_tokens: 1 }
            }),
            sse('message_stop', { type: 'message_stop' })
        ].join('')
    }
}

const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0]
    if (req.method === 'GET' && path === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [], has_more: false, first_id: null, last_id: null }))
        return
    }
    if (req.method !== 'POST' || path !== '/v1/messages') {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'not found' } }))
        return
    }
    const chunks: Buffer[] = []
    let size = 0
    let tooLarge = false
    req.on('data', (c: Buffer) => {
        size += c.length
        if (size > MAX_BODY) tooLarge = true
        else chunks.push(c)
    })
    req.on('end', () => {
        if (tooLarge) {
            res.writeHead(413, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ type: 'error', error: { type: 'request_too_large', message: 'body too large' } }))
            return
        }
        let body: any
        try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bad json' } }))
            return
        }
        const reply = message(String(body?.model ?? 'capture'), Boolean(body?.stream))
        // Requests without tools (title, quota checks) get the same reply; keep waiting for the real one.
        const captured = Array.isArray(body?.tools) && body.tools.length > 0
        if (captured) {
            mkdirSync(dirname(target), { recursive: true })
            const fixture = redactFixture(body, { home: homedir(), user: userInfo().username })
            writeFileSync(target, JSON.stringify(fixture, null, 2) + '\n')
        }
        res.writeHead(200, { 'content-type': reply.type })
        res.end(reply.body, () => {
            if (!captured) return
            console.log(`Captured ${(body.tools as unknown[]).length} tools to ${target}`)
            server.close()
            process.exit(0)
        })
    })
})

server.listen(Number(values.port), '127.0.0.1', () => {
    console.log(`Waiting for a Claude Code request on http://127.0.0.1:${values.port} ...`)
})
