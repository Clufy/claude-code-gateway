import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { ProxyConfig } from '../config'

export interface McpContext {
    config: ProxyConfig
    requestId: string
    now: () => number
    selfFetch: (req: Request) => Promise<Response>
}

export type ToolRegistrar = (server: McpServer, ctx: McpContext) => void

export const ok = (payload: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(payload) }] })
export const fail = (message: string): CallToolResult => ({ content: [{ type: 'text', text: message }], isError: true })

// Writes the one `mcp` log line per tools/call: no arguments, no results.
export async function logged(
    ctx: McpContext,
    tool: string,
    action: string,
    run: () => Promise<CallToolResult>
): Promise<CallToolResult> {
    const started = ctx.now()
    let ok = false
    try {
        const result = await run()
        ok = !result.isError
        return result
    } finally {
        console.log(
            JSON.stringify({
                event: 'mcp',
                requestId: ctx.requestId,
                tool,
                action,
                ok,
                durationMs: ctx.now() - started
            })
        )
    }
}
