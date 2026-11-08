export type LimitedBody = { ok: true; text: string } | { ok: false }

// Reads a request body as text, refusing anything over maxBytes. A declared
// content-length over the limit is rejected without reading; otherwise the
// stream is counted and cancelled as soon as it passes the limit.
export async function readLimitedBody(request: Request, maxBytes: number): Promise<LimitedBody> {
    const declared = Number(request.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > maxBytes) return { ok: false }
    if (!request.body) return { ok: true, text: '' }

    const reader = request.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > maxBytes) {
            await reader.cancel()
            return { ok: false }
        }
        chunks.push(value)
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
    }
    return { ok: true, text: new TextDecoder().decode(bytes) }
}
