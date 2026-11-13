import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker'
import type { ProxyConfig } from '../config'
import { readLimitedBody } from '../body-limit'
import { anthropicError } from '../errors'
import { registerEngagementTool } from './engagement-tool'
import { registerLogsTool } from './logs-tool'
import type { McpContext, ToolRegistrar } from './tool-kit'

export const MCP_MAX_BODY_BYTES = 65536

// Task 5 appends the logs registrar here.
const TOOLS: ToolRegistrar[] = [registerEngagementTool, registerLogsTool]

// Assumes auth has already passed.
export async function handleMcp(
    request: Request,
    config: ProxyConfig,
    requestId: string,
    now: () => number = Date.now
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
    const headers = new Headers(request.headers)
    headers.delete('content-length')
    headers.delete('transfer-encoding')
    const bounded = new Request(request.url, { method: 'POST', headers, body: body.text })

    const server = new McpServer(
        { name: 'claude-worker-proxy', version: '0.5.0' },
        { capabilities: { tools: {} }, jsonSchemaValidator: new CfWorkerJsonSchemaValidator() }
    )
    const ctx: McpContext = { config, requestId, now }
    for (const register of TOOLS) register(server, ctx)

    const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
        maxRequestBodySize: MCP_MAX_BODY_BYTES
    })
    await server.connect(transport)
    return transport.handleRequest(bounded)
}
