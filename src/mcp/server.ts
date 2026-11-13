import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker'
import type { ProxyConfig } from '../config'
import { readLimitedBody } from '../body-limit'
import { anthropicError } from '../errors'
import { registerEngagementTool } from './engagement-tool'
import { registerLogsTool } from './logs-tool'
import { registerRedteamTool } from './redteam-tool'
import type { McpContext, ToolRegistrar } from './tool-kit'

export const MCP_MAX_BODY_BYTES = 65536

const TOOLS: ToolRegistrar[] = [registerEngagementTool, registerLogsTool, registerRedteamTool]

// Assumes auth has already passed.
export async function handleMcp(
    request: Request,
    config: ProxyConfig,
    requestId: string,
    now: () => number = Date.now,
    opts?: { selfFetch?: (req: Request) => Promise<Response> }
): Promise<Response> {
    const body = await readLimitedBody(request, MCP_MAX_BODY_BYTES)
    if (!body.ok) {
        return anthropicError(
            413,
            'invalid_request_error',
            `request body too large (max ${MCP_MAX_BODY_BYTES} bytes)`,
            requestId
        )
    }
    if (body.text.trimStart().startsWith('[')) {
        return new Response(
            JSON.stringify({
                jsonrpc: '2.0',
                id: null,
                error: { code: -32600, message: 'batch requests are not supported' }
            }),
            { status: 400, headers: { 'content-type': 'application/json' } }
        )
    }
    const headers = new Headers(request.headers)
    headers.delete('content-length')
    headers.delete('transfer-encoding')
    const bounded = new Request(request.url, { method: 'POST', headers, body: body.text })

    const server = new McpServer(
        { name: 'claude-worker-proxy', version: '0.5.0' },
        { capabilities: { tools: {} }, jsonSchemaValidator: new CfWorkerJsonSchemaValidator() }
    )
    const selfFetch =
        opts?.selfFetch ??
        (async () => {
            throw new Error('selfFetch not configured')
        })
    const ctx: McpContext = { config, requestId, now, selfFetch }
    for (const register of TOOLS) register(server, ctx)

    const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
        maxRequestBodySize: MCP_MAX_BODY_BYTES
    })
    await server.connect(transport)
    return transport.handleRequest(bounded)
}
