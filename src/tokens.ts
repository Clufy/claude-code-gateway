export function estimateTokens(text: string): number {
    return Math.max(0, Math.ceil(text.length / 4))
}

export function countTokensForRequest(body: any): { input_tokens: number } {
    const parts: string[] = []

    if (body.system != null) {
        if (typeof body.system === 'string') {
            parts.push(body.system)
        } else if (Array.isArray(body.system)) {
            for (const part of body.system) {
                if (part?.type === 'text') parts.push(part.text)
            }
        }
    }

    for (const message of body.messages ?? []) {
        if (typeof message.content === 'string') {
            parts.push(message.content)
        } else if (Array.isArray(message.content)) {
            for (const content of message.content) {
                switch (content.type) {
                    case 'text':
                        parts.push(content.text)
                        break
                    case 'tool_use':
                        parts.push(content.name)
                        parts.push(JSON.stringify(content.input ?? {}))
                        break
                    case 'tool_result':
                        parts.push(
                            typeof content.content === 'string'
                                ? content.content
                                : JSON.stringify(content.content ?? {})
                        )
                        break
                }
            }
        }
    }

    for (const tool of body.tools ?? []) {
        parts.push(tool.name)
        parts.push(tool.description ?? '')
        parts.push(JSON.stringify(tool.input_schema ?? {}))
    }

    return { input_tokens: estimateTokens(parts.join('\n')) }
}
