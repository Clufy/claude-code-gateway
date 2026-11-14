/** How the tapped stream ended: source finished, source errored, or the client cancelled. */
export type SseEnd = 'done' | 'error' | 'cancel'

export interface SseHooks {
    onEvent(event: string, data: any): void
    onEnd(reason: SseEnd): string | void
}

const encoder = new TextEncoder()

/** Pass an SSE response through byte-for-byte while observing parsed events. */
export function tapSse(response: Response, hooks: SseHooks): Response {
    if (!response.body) return response
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let ended = false

    const parseBlock = (block: string) => {
        let event = ''
        let data = ''
        for (const line of block.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim()
            else if (line.startsWith('data:')) data += line.slice(5).trim()
        }
        if (!data) return
        try {
            hooks.onEvent(event, JSON.parse(data))
        } catch {
            // non-JSON data or a hook error must never break the stream
        }
    }
    const drain = (final: boolean) => {
        buffer = buffer.replace(/\r\n/g, '\n')
        const blocks = buffer.split('\n\n')
        buffer = final ? '' : (blocks.pop() ?? '')
        for (const block of blocks) if (block) parseBlock(block)
    }
    const finish = (reason: SseEnd): string | void => {
        if (ended) return
        ended = true
        drain(true)
        try {
            return hooks.onEnd(reason)
        } catch {
            return
        }
    }

    const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                const r = await reader.read()
                if (r.done) {
                    const tail = finish('done')
                    if (typeof tail === 'string') controller.enqueue(encoder.encode(tail))
                    controller.close()
                    return
                }
                buffer += decoder.decode(r.value, { stream: true })
                drain(false)
                controller.enqueue(r.value)
            } catch (error) {
                finish('error')
                controller.error(error)
            }
        },
        cancel(reason) {
            finish('cancel')
            return reader.cancel(reason)
        }
    })
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
}
