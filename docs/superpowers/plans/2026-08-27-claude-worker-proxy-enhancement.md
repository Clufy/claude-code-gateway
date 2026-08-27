# Claude Worker Proxy Enhancement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the existing Cloudflare Workers AI Claude proxy in TypeScript, preserve the `/v1/messages` Workers AI backend exactly, and add multi-provider support (Gemini, OpenAI Chat Completions, OpenAI Responses) plus Anthropic compatibility endpoints (`/v1/models`, `/v1/messages/count_tokens`).

**Architecture:** A thin TypeScript router in `src/index.ts` dispatches `/v1/messages` to a ported `providers/workers-ai.ts` backend, and `/{type}/{provider_url}/v1/messages` to provider classes implementing a shared `Provider` interface. Shared utilities in `src/utils.ts` emit Anthropic SSE shapes, and `src/errors.ts` ensures all error responses carry Anthropic-style JSON and a `request-id` header.

**Tech Stack:** Cloudflare Workers, Wrangler, TypeScript, `openai` SDK, Prettier. `wrangler types` generates `Env` into `worker-configuration.d.ts`.

**Spec:** `docs/superpowers/specs/2026-08-27-claude-worker-proxy-enhancement-design.md`

## Global Constraints

- Keep the default `POST /v1/messages` behavior identical to the existing JS Worker.
- Generate a `request-id` (`req_<uuid>`) for every response and include it in the response header and Anthropic error body.
- Apply `env.PROXY_KEY` optionally via `x-api-key` for Workers AI and support endpoints; use `x-proxy-key` for external routes so `x-api-key` can carry the provider key.
- Set `compatibility_date` to `2026-08-27` during implementation.
- Enable `observability.enabled: true` in `wrangler.jsonc`.
- Use `wrangler types` to generate `Env`; never hand-write the binding interface.
- Ignore unknown Anthropic request fields rather than rejecting them.
- Provider non-2xx responses are passed through with a `request-id` header added.
- Use `crypto.subtle.timingSafeEqual` (via SHA-256 hashes) for secret comparison.

## Files

| File | Purpose |
|------|---------|
| `package.json` | Dependencies (`openai`, `wrangler`, `typescript`, `prettier`) and scripts. |
| `.prettierrc` | Formatting rules matching the reference repo. |
| `tsconfig.json` | TypeScript options, include generated `worker-configuration.d.ts`. |
| `wrangler.jsonc` | Wrangler config with AI binding, compatibility flags, observability. |
| `src/provider.ts` | Shared `Provider` interface. |
| `src/types.ts` | Anthropic-compatible and provider types. |
| `src/utils.ts` | SSE helpers, id generation, URL builder, schema cleaner. |
| `src/request-id.ts` | Generate `req_<uuid>`. |
| `src/errors.ts` | Anthropic error response helper and base JSON response helper. |
| `src/auth.ts` | Proxy-key verification and provider key extraction. |
| `src/models.ts` | `GET /v1/models` and `GET /v1/models/{id}`. |
| `src/tokens.ts` | `POST /v1/messages/count_tokens`. |
| `src/providers/workers-ai.ts` | Ported existing JS backend that calls `env.AI.run`. |
| `src/providers/gemini.ts` | Gemini multi-turn + tool-call provider. |
| `src/providers/openai.ts` | OpenAI Chat Completions and Responses providers. |
| `src/index.ts` | Router, auth, request-id wrapping, error handling. |
| `README.md` | Updated docs covering Workers AI and external providers. |
| `scripts/self-test.sh` | `curl` health, models, count_tokens and message smoke tests. |

---

### Task 1: Tooling and Configuration

**Files:**
- Create: `package.json`
- Create: `.prettierrc`
- Create: `tsconfig.json`
- Create: `wrangler.jsonc`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `Env` from `wrangler types`, install ready.

- [ ] **Step 1: Create `package.json`**

```json
{
    "name": "claude-worker-proxy",
    "version": "0.0.0",
    "license": "MIT",
    "scripts": {
        "deploy": "wrangler types && prettier --write . && wrangler deploy",
        "dev": "wrangler types && prettier --write . && wrangler dev --port 8080",
        "check": "wrangler types && tsc --noEmit && prettier --check ."
    },
    "devDependencies": {
        "prettier": "^3.6.2",
        "typescript": "^5.5.2",
        "wrangler": "^4.21.0"
    },
    "dependencies": {
        "openai": "^6.45.0"
    }
}
```

- [ ] **Step 2: Create `.prettierrc`**

```json
{
    "semi": false,
    "singleQuote": true,
    "tabWidth": 4,
    "trailingComma": "none",
    "printWidth": 120
}
```

- [ ] **Step 3: Create `tsconfig.json`**

```json
{
    "compilerOptions": {
        "target": "es2021",
        "lib": ["es2021"],
        "jsx": "react-jsx",
        "module": "es2022",
        "moduleResolution": "Bundler",
        "resolveJsonModule": true,
        "allowJs": true,
        "checkJs": false,
        "noEmit": true,
        "isolatedModules": true,
        "allowSyntheticDefaultImports": true,
        "forceConsistentCasingInFileNames": true,
        "strict": true,
        "skipLibCheck": true,
        "types": ["./worker-configuration.d.ts"]
    },
    "exclude": ["test"],
    "include": ["worker-configuration.d.ts", "src/**/*.ts"]
}
```

- [ ] **Step 4: Create `wrangler.jsonc`**

```jsonc
{
    "$schema": "node_modules/wrangler/config-schema.json",
    "name": "claude-workers-ai-proxy",
    "main": "src/index.ts",
    "compatibility_date": "2026-08-27",
    "workers_dev": true,
    "preview_urls": false,
    "vars": {},
    "observability": {
        "enabled": true
    },
    "compatibility_flags": ["global_fetch_strictly_public", "nodejs_compat"],
    "ai": {
        "binding": "AI",
        "remote": true
    }
}
```

- [ ] **Step 5: Extend `.gitignore` to ignore build/tool artifacts**

Append:

```gitignore
node_modules/
.wrangler/
worker-configuration.d.ts
.dev.vars
*.log
```

- [ ] **Step 6: Install dependencies and generate types**

```bash
npm install
npx wrangler types
```

Expected: `node_modules/`, `package-lock.json`, and `worker-configuration.d.ts` are created; no errors.

- [ ] **Step 7: Commit**

```bash
git add package.json .prettierrc tsconfig.json wrangler.jsonc .gitignore
git commit -m "chore: typescript build config and wrangler structure"
```

---

### Task 2: Provider Interface and Shared Types

**Files:**
- Create: `src/provider.ts`
- Create: `src/types.ts`

**Interfaces:**
- Produces: `Provider`, `ClaudeRequest`, `ClaudeResponse`, `ClaudeMessage`, `ClaudeTool`, `Gemini*`, `OpenAI*` types used by all later tasks.

- [ ] **Step 1: Create `src/provider.ts`**

```ts
export interface Provider {
    // Override for SDK-based providers that want full control over fetch/streaming.
    handle?(request: Request, baseUrl: string, apiKey: string): Promise<Response>

    // Convert an Anthropic request to a provider HTTP request.
    convertToProviderRequest(request: Request, baseUrl: string, apiKey: string): Promise<Request>

    // Convert a provider HTTP response to an Anthropic-format response.
    convertToClaudeResponse(providerResponse: Response): Promise<Response>
}
```

- [ ] **Step 2: Create `src/types.ts`**

```ts
export interface JsonSchema {
    type?: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'null'
    properties?: { [key: string]: JsonSchema }
    required?: string[]
    description?: string
    items?: JsonSchema
    enum?: Array<string | number | boolean | null>
    anyOf?: JsonSchema[]
    oneOf?: JsonSchema[]
    additionalProperties?: boolean | JsonSchema
}

export interface ClaudeTool {
    name: string
    description: string
    input_schema: JsonSchema
}

export type ClaudeContentBlock =
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: any }
    | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }

export type ClaudeContent = string | ClaudeContentBlock[]

export interface ClaudeMessage {
    role: 'user' | 'assistant'
    content: ClaudeContent
}

export interface ClaudeRequest {
    model: string
    messages: ClaudeMessage[]
    system?: string | Array<{ type: 'text'; text: string }>
    max_tokens?: number
    temperature?: number
    stream?: boolean
    tools?: ClaudeTool[]
}

export type ClaudeStopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence'

export interface ClaudeResponse {
    id: string
    type: 'message'
    role: 'assistant'
    model?: string
    content: Array<
        | { type: 'text'; text: string }
        | { type: 'tool_use'; id: string; name: string; input: any }
    >
    stop_reason?: ClaudeStopReason
    stop_sequence?: string | null
    usage: {
        input_tokens: number
        output_tokens: number
    }
}

export interface GeminiFunctionDeclaration {
    name: string
    description: string
    parameters: JsonSchema
}

export interface GeminiTool {
    functionDeclarations: GeminiFunctionDeclaration[]
}

export type GeminiPart =
    | { text: string }
    | { functionCall: { name: string; args: any } }
    | { functionResponse: { name: string; response: any } }

export interface GeminiContent {
    parts: GeminiPart[]
    role?: 'user' | 'model' | 'tool'
}

export interface GeminiRequest {
    model?: string
    contents: GeminiContent[]
    systemInstruction?: GeminiContent
    tools?: GeminiTool[]
    generationConfig?: {
        temperature?: number
        maxOutputTokens?: number
    }
}

export interface GeminiCandidate {
    content: {
        parts: GeminiPart[]
        role: 'model'
    }
    finishReason?: string
}

export interface GeminiResponse {
    candidates: GeminiCandidate[]
    usageMetadata?: {
        promptTokenCount: number
        candidatesTokenCount: number
        totalTokenCount: number
    }
}

export interface OpenAIMessage {
    role: 'system' | 'user' | 'assistant' | 'tool'
    content?: string | null
    tool_calls?: OpenAIToolCall[]
    tool_call_id?: string
}

export interface OpenAIToolCall {
    id: string
    type: 'function'
    function: {
        name: string
        arguments: string
    }
}

export interface OpenAITool {
    type: 'function'
    function: {
        name: string
        description?: string
        parameters?: any
    }
}

export interface OpenAIRequest {
    model: string
    messages: OpenAIMessage[]
    tools?: OpenAITool[]
    temperature?: number
    max_tokens?: number
    stream?: boolean
}

export interface OpenAIResponsesRequest {
    model: string
    input: OpenAIResponsesInputItem[]
    instructions?: string
    tools?: OpenAIResponsesTool[]
    temperature?: number
    max_output_tokens?: number
    stream?: boolean
}

export type OpenAIResponsesInputItem =
    | {
          type: 'message'
          role: 'user' | 'assistant' | 'system'
          content: Array<{ type: 'input_text'; text: string } | { type: 'output_text'; text: string }>
      }
    | {
          type: 'function_call'
          call_id: string
          name: string
          arguments: string
      }
    | {
          type: 'function_call_output'
          call_id: string
          output: string
      }

export interface OpenAIResponsesTool {
    type: 'function'
    name: string
    description?: string
    parameters?: any
}

export interface OpenAIResponsesResponse {
    id: string
    output?: Array<
        | {
              type: 'message'
              content?: Array<{ type: 'output_text'; text: string } | { type: string; [key: string]: any }>
          }
        | {
              type: 'function_call'
              call_id: string
              name: string
              arguments: string
          }
        | { type: string; [key: string]: any }
    >
    output_text?: string
    status?: string
    usage?: {
        input_tokens?: number
        output_tokens?: number
    }
}

export interface OpenAIChoice {
    index: number
    message: OpenAIMessage
    finish_reason: string | null
}

export interface OpenAIResponse {
    id: string
    object: string
    created: number
    model: string
    choices: OpenAIChoice[]
    usage?: {
        prompt_tokens: number
        completion_tokens: number
        total_tokens: number
    }
}

export interface OpenAIStreamChoice {
    index: number
    delta: {
        role?: string
        content?: string
        tool_calls?: Array<{
            index: number
            id?: string
            type?: 'function'
            function?: {
                name?: string
                arguments?: string
            }
        }>
    }
    finish_reason?: string | null
}

export interface OpenAIStreamResponse {
    id: string
    object: string
    created: number
    model: string
    choices: OpenAIStreamChoice[]
}
```

- [ ] **Step 3: Commit**

```bash
git add src/provider.ts src/types.ts
git commit -m "feat: provider interface and shared request/response types"
```

---

### Task 3: Utilities, Request IDs, Errors, and Auth

**Files:**
- Create: `src/utils.ts`
- Create: `src/request-id.ts`
- Create: `src/errors.ts`
- Create: `src/auth.ts`

**Interfaces:**
- Consumes: types from Task 2.
- Produces: `generateId`, `sse`, `processProviderStream`, `cleanJsonSchema`, `generateRequestId`, `anthropicError`, `jsonResponse`, `verifyProxyKey`, `extractProviderKey` for use by the router and providers.

- [ ] **Step 1: Create `src/utils.ts` (ported from reference repo)**

```ts
export function generateId(): string {
    return crypto.randomUUID()
}

const encoder = new TextEncoder()

export function safeJsonParse(value: string): any {
    try {
        return JSON.parse(value)
    } catch {
        return {}
    }
}

export function sse(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

export function enqueueSse(controller: ReadableStreamDefaultController, event: string, data: unknown): void {
    controller.enqueue(encoder.encode(sse(event, data)))
}

export function enqueueRawSse(controller: ReadableStreamDefaultController, event: string): void {
    controller.enqueue(encoder.encode(event))
}

export function sendMessageStart(
    controller: ReadableStreamDefaultController,
    usage: { input_tokens: number; output_tokens: number } = { input_tokens: 0, output_tokens: 0 }
): void {
    const event = sse('message_start', {
        type: 'message_start',
        message: {
            id: generateId(),
            type: 'message',
            role: 'assistant',
            content: [],
            usage
        }
    })
    controller.enqueue(encoder.encode(event))
}

export function sendMessageDelta(
    controller: ReadableStreamDefaultController,
    stopReason: string,
    usage: { input_tokens: number; output_tokens: number } = { input_tokens: 0, output_tokens: 0 }
): void {
    enqueueSse(controller, 'message_delta', {
        type: 'message_delta',
        delta: {
            stop_reason: stopReason,
            stop_sequence: null
        },
        usage
    })
}

export function sendMessageStop(controller: ReadableStreamDefaultController): void {
    const event = sse('message_stop', {
        type: 'message_stop'
    })
    controller.enqueue(encoder.encode(event))
}

export function startTextBlock(index: number): string {
    return sse('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: {
            type: 'text',
            text: ''
        }
    })
}

export function textDelta(text: string, index: number): string {
    return sse('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: {
            type: 'text_delta',
            text
        }
    })
}

export function stopContentBlock(index: number): string {
    return sse('content_block_stop', {
        type: 'content_block_stop',
        index
    })
}

export function processTextPart(text: string, index: number): string[] {
    const events: string[] = []
    events.push(startTextBlock(index))
    events.push(textDelta(text, index))
    events.push(stopContentBlock(index))
    return events
}

export function processToolUsePart(functionCall: { name: string; args: any }, index: number): string[] {
    const events: string[] = []
    const toolUseId = generateId()

    events.push(
        sse('content_block_start', {
            type: 'content_block_start',
            index,
            content_block: {
                type: 'tool_use',
                id: toolUseId,
                name: functionCall.name,
                input: {}
            }
        })
    )

    events.push(
        sse('content_block_delta', {
            type: 'content_block_delta',
            index,
            delta: {
                type: 'input_json_delta',
                partial_json: JSON.stringify(functionCall.args)
            }
        })
    )

    events.push(stopContentBlock(index))
    return events
}

export function buildUrl(baseUrl: string, endpoint: string): string {
    let finalUrl = baseUrl
    if (!finalUrl.endsWith('/')) {
        finalUrl += '/'
    }
    return finalUrl + endpoint
}

export async function processProviderStream(
    providerResponse: Response,
    processLine: (
        jsonStr: string,
        textIndex: number,
        toolIndex: number
    ) => { events: string[]; textBlockIndex: number; toolUseBlockIndex: number; stopReason?: string } | null
): Promise<Response> {
    const stream = new ReadableStream({
        async start(controller) {
            const reader = providerResponse.body?.getReader()
            if (!reader) {
                controller.close()
                return
            }

            const decoder = new TextDecoder()
            let buffer = ''
            let textBlockIndex = 0
            let toolUseBlockIndex = 0
            let stopReason = 'end_turn'

            sendMessageStart(controller)

            try {
                while (true) {
                    const { done, value } = await reader.read()
                    if (done) break

                    const chunk = buffer + decoder.decode(value, { stream: true })
                    const lines = chunk.split('\n')

                    buffer = lines.pop() || ''

                    for (const line of lines) {
                        if (!line.trim() || !line.startsWith('data: ')) continue

                        const jsonStr = line.slice(6)
                        if (jsonStr === '[DONE]') continue

                        const result = processLine(jsonStr, textBlockIndex, toolUseBlockIndex)
                        if (result) {
                            textBlockIndex = result.textBlockIndex
                            toolUseBlockIndex = result.toolUseBlockIndex
                            stopReason = result.stopReason ?? stopReason

                            for (const event of result.events) {
                                controller.enqueue(encoder.encode(event))
                            }
                        }
                    }
                }
            } finally {
                if (buffer.trim() && buffer.startsWith('data: ')) {
                    const result = processLine(buffer.slice(6), textBlockIndex, toolUseBlockIndex)
                    if (result) {
                        stopReason = result.stopReason ?? stopReason
                        for (const event of result.events) {
                            controller.enqueue(encoder.encode(event))
                        }
                    }
                }
                reader.releaseLock()
                sendMessageDelta(controller, stopReason)
                sendMessageStop(controller)
                controller.close()
            }
        }
    })

    return new Response(stream, {
        status: providerResponse.status,
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive'
        }
    })
}

export function cleanJsonSchema(schema: any): any {
    if (!schema || typeof schema !== 'object') {
        return schema
    }

    const cleaned = { ...schema }

    for (const key in cleaned) {
        if (key === '$schema' || key === 'additionalProperties' || key === 'title' || key === 'examples') {
            delete cleaned[key]
        } else if (key === 'format' && cleaned.type === 'string') {
            delete cleaned[key]
        } else if (key === 'properties' && typeof cleaned[key] === 'object') {
            cleaned[key] = cleanJsonSchema(cleaned[key])
        } else if (key === 'items' && typeof cleaned[key] === 'object') {
            cleaned[key] = cleanJsonSchema(cleaned[key])
        } else if (typeof cleaned[key] === 'object' && !Array.isArray(cleaned[key])) {
            cleaned[key] = cleanJsonSchema(cleaned[key])
        }
    }

    return cleaned
}
```

- [ ] **Step 2: Create `src/request-id.ts`**

```ts
export function generateRequestId(): string {
    return `req_${crypto.randomUUID()}`
}
```

- [ ] **Step 3: Create `src/errors.ts`**

```ts
export type ClaudeErrorType =
    | 'invalid_request_error'
    | 'authentication_error'
    | 'not_found_error'
    | 'api_error'
    | 'rate_limit_error'

export function jsonResponse(body: unknown, status: number, requestId?: string): Response {
    const headers = new Headers({ 'Content-Type': 'application/json' })
    if (requestId) {
        headers.set('request-id', requestId)
    }
    return new Response(JSON.stringify(body), { status, headers })
}

export function anthropicError(
    status: number,
    type: ClaudeErrorType,
    message: string,
    requestId: string
): Response {
    return jsonResponse(
        {
            type: 'error',
            error: { type, message },
            request_id: requestId
        },
        status,
        requestId
    )
}
```

- [ ] **Step 4: Create `src/auth.ts`**

```ts
export async function verifyProxyKey(provided: string | null, expected: string | undefined): Promise<boolean> {
    if (!expected) {
        return true
    }
    if (!provided) {
        return false
    }
    const enc = new TextEncoder()
    const [ha, hb] = await Promise.all([
        crypto.subtle.digest('SHA-256', enc.encode(provided)),
        crypto.subtle.digest('SHA-256', enc.encode(expected))
    ])
    return crypto.subtle.timingSafeEqual(ha, hb)
}

export function extractProviderKey(headers: Headers): { apiKey: string; headers: Headers } | null {
    const apiKey = headers.get('x-api-key') ?? authHeaderToken(headers.get('authorization'))
    if (!apiKey) {
        return null
    }
    const cleanHeaders = new Headers(headers)
    cleanHeaders.delete('x-api-key')
    cleanHeaders.delete('authorization')
    return { apiKey, headers: cleanHeaders }
}

function authHeaderToken(value: string | null): string | null {
    if (!value) return null
    const parts = value.trim().split(' ')
    if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
        return parts[1]
    }
    return parts[0]
}
```

- [ ] **Step 5: Commit**

```bash
git add src/utils.ts src/request-id.ts src/errors.ts src/auth.ts
git commit -m "feat: shared utilities, request-id, errors and auth helpers"
```

---

### Task 4: Supporting Endpoints (`/v1/models`, `/v1/models/{id}`, `/v1/messages/count_tokens`)

**Files:**
- Create: `src/models.ts`
- Create: `src/tokens.ts`

**Interfaces:**
- Consumes: `jsonResponse`, `anthropicError`, `Env` (generated).
- Produces: `listModels(env)`, `getModel(id, env, requestId)` return `Response`; `countTokensForRequest(body)` returns `{ input_tokens: number }`.

- [ ] **Step 1: Create `src/tokens.ts`**

```ts
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
```

- [ ] **Step 2: Create `src/models.ts`**

```ts
import { anthropicError, jsonResponse } from './errors'

interface ClaudeModelListing {
    id: string
    type: 'model'
    display_name: string
    created_at: number
    max_input_tokens: number | null
    max_tokens: number | null
    capabilities: Record<string, { name: string; supported: boolean }>
}

const DEFAULT_MODELS = [
    '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    '@cf/meta/llama-3.1-8b-instruct-fast',
    '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b'
]

function toModel(id: string): ClaudeModelListing {
    return {
        id,
        type: 'model',
        display_name: id,
        created_at: 0,
        max_input_tokens: null,
        max_tokens: null,
        capabilities: {
            tools: { name: 'tool_use', supported: false },
            vision: { name: 'vision', supported: false },
            multi_tool_use: { name: 'multi_tool_use', supported: false }
        }
    }
}

function configuredModelIds(env: Env): string[] {
    return (
        env.MODELS?.split(',')
            .map(s => s.trim())
            .filter(Boolean) ?? DEFAULT_MODELS
    )
}

export function listModels(env: Env): Response {
    const ids = configuredModelIds(env)
    return jsonResponse(
        {
            data: ids.map(toModel),
            has_more: false,
            first_id: null,
            last_id: null
        },
        200
    )
}

export function getModel(id: string, env: Env, requestId: string): Response {
    const ids = configuredModelIds(env)
    if (!ids.includes(id)) {
        return anthropicError(404, 'not_found_error', `Model '${id}' not found.`, requestId)
    }
    return jsonResponse({ ...toModel(id), type: 'model' }, 200, requestId)
}
```

- [ ] **Step 3: Commit**

```bash
git add src/models.ts src/tokens.ts
git commit -m "feat: /v1/models and /v1/messages/count_tokens compatibility endpoints"
```

---

### Task 5: Port the Workers AI Backend

**Files:**
- Delete: `src/index.js` (keep until final verification).
- Create: `src/providers/workers-ai.ts`

**Interfaces:**
- Consumes: `sse`, `estimateTokens` (own copy), `Env`.
- Produces: `WorkersAIProvider.handle(request): Response` returning Anthropic-format JSON or SSE.

- [ ] **Step 1: Create `src/providers/workers-ai.ts`**

```ts
const encoder = new TextEncoder()
const decoder = new TextDecoder()

function sse(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function estimateTokens(text: string): number {
    return Math.max(0, Math.ceil(text.length / 4))
}

function systemText(system: unknown): string {
    if (system == null) return ''
    if (typeof system === 'string') return system
    if (Array.isArray(system)) {
        return system
            .filter(p => p && p.type === 'text')
            .map(p => p.text ?? '')
            .join('\n')
    }
    return String(system)
}

function toolResultToText(content: unknown): string {
    return typeof content === 'string' ? content : JSON.stringify(content)
}

function cleanSchema(schema: any): any {
    if (!schema || typeof schema !== 'object') return schema
    if (Array.isArray(schema)) return schema.map(cleanSchema)
    const out: any = {}
    for (const key of Object.keys(schema)) {
        if (key === '$schema' || key === 'additionalProperties' || key === 'title' || key === 'examples') continue
        out[key] = cleanSchema(schema[key])
    }
    return out
}

function convertTools(tools: any): any {
    if (!Array.isArray(tools) || tools.length === 0) return undefined
    return tools
        .filter(t => t && t.name)
        .map(t => ({
            type: 'function',
            function: {
                name: t.name,
                description: t.description,
                parameters: cleanSchema(t.input_schema) || { type: 'object', properties: {} }
            }
        }))
}

function convertMessages(messages: any[]): any[] {
    const out: any[] = []
    for (const message of messages) {
        const role = message.role === 'assistant' ? 'assistant' : 'user'
        if (typeof message.content === 'string') {
            out.push({ role, content: message.content })
            continue
        }
        if (!Array.isArray(message.content)) {
            out.push({ role, content: String(message.content ?? '') })
            continue
        }

        const textParts: string[] = []
        const toolCalls: any[] = []
        const toolResults: any[] = []

        for (const part of message.content) {
            if (part.type === 'text') {
                textParts.push(part.text ?? '')
            } else if (part.type === 'tool_use') {
                toolCalls.push({
                    id: part.id,
                    type: 'function',
                    function: {
                        name: part.name,
                        arguments: JSON.stringify(part.input ?? {})
                    }
                })
            } else if (part.type === 'tool_result') {
                toolResults.push({
                    tool_call_id: part.tool_use_id,
                    content: toolResultToText(part.content)
                })
            }
        }

        if (textParts.length > 0 || toolCalls.length > 0) {
            out.push({
                role,
                content: textParts.length > 0 ? textParts.join('\n') : '',
                ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
            })
        }

        for (const result of toolResults) {
            out.push({ role: 'tool', tool_call_id: result.tool_call_id, content: result.content })
        }
    }
    return out
}

function extractText(payload: any): string {
    if (payload == null) return ''
    const parts: string[] = []
    const push = (v: any) => {
        if (typeof v === 'string' && v.length > 0) parts.push(v)
    }

    push(payload.response)
    push(payload.text)
    push(payload.reasoning_content)
    push(payload.reasoning)

    const choices = payload.choices
    if (Array.isArray(choices)) {
        for (const choice of choices) {
            push(choice?.delta?.content)
            push(choice?.delta?.reasoning_content)
            push(choice?.delta?.reasoning)
            push(choice?.message?.content)
            push(choice?.message?.reasoning_content)
        }
    }

    return parts.join('')
}

function collectToolCalls(payload: any, map: Map<number, any>): void {
    if (payload == null) return

    const choices = payload.choices
    if (Array.isArray(choices)) {
        for (const choice of choices) {
            const deltaCalls = choice?.delta?.tool_calls
            if (Array.isArray(deltaCalls)) {
                for (const call of deltaCalls) {
                    const idx = call.index ?? 0
                    const cur = map.get(idx) ?? { id: undefined, name: undefined, arguments: '' }
                    if (call.id) cur.id = call.id
                    if (call.function?.name) cur.name = call.function.name
                    if (call.function?.arguments) cur.arguments += call.function.arguments
                    map.set(idx, cur)
                }
            }

            const msgCalls = choice?.message?.tool_calls
            if (Array.isArray(msgCalls)) {
                for (let i = 0; i < msgCalls.length; i++) {
                    const call = msgCalls[i]
                    const idx = call.index ?? i
                    const cur = map.get(idx) ?? { id: undefined, name: undefined, arguments: '' }
                    if (call.id) cur.id = call.id
                    if (call.function?.name) cur.name = call.function.name
                    if (call.function?.arguments) cur.arguments = call.function.arguments
                    map.set(idx, cur)
                }
            }
        }
    }

    const legacy = payload.tool_calls
    if (Array.isArray(legacy) && legacy.length > 0 && !payload.choices) {
        for (let i = 0; i < legacy.length; i++) {
            const call = legacy[i]
            const cur = map.get(i) ?? { id: undefined, name: undefined, arguments: '' }
            if (call.name) cur.name = call.name
            if (call.arguments != null) {
                cur.arguments = typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments)
            }
            map.set(i, cur)
        }
    }
}

function finishReason(payload: any): string | null {
    return payload?.choices?.[0]?.finish_reason ?? null
}

function parseArguments(str: string): any {
    if (!str) return {}
    try {
        return JSON.parse(str)
    } catch {
        return {}
    }
}

function toolUseId(existing: string | undefined): string {
    return existing || `toolu_${crypto.randomUUID().replace(/-/g, '')}`
}

export class WorkersAIProvider {
    constructor(private env: Env) {}

    async handle(request: Request): Promise<Response> {
        const body = (await request.json()) as any
        const model = body?.model
        const messages = body?.messages
        const id = `msg_${crypto.randomUUID()}`

        if (typeof model !== 'string' || model.length === 0) {
            return this.error(400, 'invalid_request_error', "missing or invalid 'model'")
        }
        if (!Array.isArray(messages) || messages.length === 0) {
            return this.error(400, 'invalid_request_error', "missing or invalid 'messages'")
        }

        const system = systemText(body.system)
        const aiMessages = convertMessages(messages)
        if (system) {
            aiMessages.unshift({ role: 'system', content: system })
        }

        const stream = body.stream === true
        const options: any = { messages: aiMessages, stream: true }

        const tools = convertTools(body.tools)
        if (tools) options.tools = tools
        if (body.max_tokens != null) options.max_tokens = body.max_tokens
        if (body.temperature != null) options.temperature = body.temperature

        let rawStream
        try {
            rawStream = await this.env.AI.run(model, options, { returnRawResponse: true })
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e)
            return this.error(502, 'api_error', `Workers AI call failed: ${message}`)
        }

        let source: ReadableStream
        if (rawStream instanceof ReadableStream) {
            source = rawStream
        } else if (rawStream instanceof Response && rawStream.body) {
            source = rawStream.body
        } else {
            return this.error(502, 'api_error', 'Workers AI did not return a stream')
        }

        if (!stream) {
            return this.handleNonStreaming(source, model, id)
        }

        return this.handleStreaming(source, model, id)
    }

    private error(status: number, type: string, message: string): Response {
        return new Response(JSON.stringify({ type: 'error', error: { type, message } }), {
            status,
            headers: { 'content-type': 'application/json' }
        })
    }

    private async handleNonStreaming(source: ReadableStream, model: string, id: string): Promise<Response> {
        let text = ''
        const toolCalls = new Map<number, any>()
        let stopReason: any = 'end_turn'

        try {
            const reader = source.getReader()
            let buffer = ''
            while (true) {
                const { done, value } = await reader.read()
                if (done) break
                buffer += typeof value === 'string' ? value : decoder.decode(value, { stream: true })
                const lines = buffer.split('\n')
                buffer = lines.pop() ?? ''
                for (const line of lines) {
                    const payload = this.parseSsePayload(line)
                    if (!payload) continue
                    text += extractText(payload)
                    collectToolCalls(payload, toolCalls)
                    if (finishReason(payload) === 'tool_calls') stopReason = 'tool_use'
                }
            }
            if (buffer.trim()) {
                const payload = this.parseSsePayload(buffer)
                if (payload) {
                    text += extractText(payload)
                    collectToolCalls(payload, toolCalls)
                    if (finishReason(payload) === 'tool_calls') stopReason = 'tool_use'
                }
            }
            reader.releaseLock()
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e)
            return this.error(502, 'api_error', `Workers AI stream failed: ${message}`)
        }

        const content: any[] = []
        if (text) content.push({ type: 'text', text })

        const calls = [...toolCalls.entries()].sort(([a], [b]) => a - b)
        for (const [, call] of calls) {
            if (!call.name) continue
            content.push({
                type: 'tool_use',
                id: toolUseId(call.id),
                name: call.name,
                input: parseArguments(call.arguments)
            })
        }
        if (calls.length > 0) stopReason = 'tool_use'

        return new Response(
            JSON.stringify({
                id,
                type: 'message',
                role: 'assistant',
                model,
                content,
                stop_reason: stopReason,
                stop_sequence: null,
                usage: { input_tokens: 0, output_tokens: estimateTokens(text) }
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
        )
    }

    private parseSsePayload(line: string): any | null {
        const trimmed = line.trim()
        if (!trimmed || !trimmed.startsWith('data:')) return null
        const data = trimmed.slice(5).trim()
        if (data === '[DONE]') return null
        try {
            return JSON.parse(data)
        } catch {
            return null
        }
    }

    private handleStreaming(source: ReadableStream, model: string, id: string): Response {
        const state = {
            text: '',
            textBlockOpen: false,
            blockIndex: 0,
            toolCalls: new Map<number, any>(),
            toolBlocksEmitted: 0,
            stopReason: 'end_turn' as any,
            _buffer: '' as string
        }

        const openTextBlock = (controller: ReadableStreamDefaultController) => {
            if (state.textBlockOpen) return
            controller.enqueue(
                encoder.encode(
                    sse('content_block_start', {
                        type: 'content_block_start',
                        index: state.blockIndex,
                        content_block: { type: 'text', text: '' }
                    })
                )
            )
            state.textBlockOpen = true
        }

        const closeTextBlock = (controller: ReadableStreamDefaultController) => {
            if (!state.textBlockOpen) return
            controller.enqueue(
                encoder.encode(sse('content_block_stop', { type: 'content_block_stop', index: state.blockIndex }))
            )
            state.blockIndex++
            state.textBlockOpen = false
        }

        const emitText = (controller: ReadableStreamDefaultController, token: string) => {
            state.text += token
            openTextBlock(controller)
            controller.enqueue(
                encoder.encode(
                    sse('content_block_delta', {
                        type: 'content_block_delta',
                        index: state.blockIndex,
                        delta: { type: 'text_delta', text: token }
                    })
                )
            )
        }

        const emitToolCalls = (controller: ReadableStreamDefaultController) => {
            closeTextBlock(controller)
            const calls = [...state.toolCalls.entries()].sort(([a], [b]) => a - b)
            for (let i = state.toolBlocksEmitted; i < calls.length; i++) {
                const [, call] = calls[i]
                if (!call.name) continue
                const toolId = toolUseId(call.id)
                const input = parseArguments(call.arguments)
                const blockIndex = state.blockIndex + (i - state.toolBlocksEmitted)

                controller.enqueue(
                    encoder.encode(
                        sse('content_block_start', {
                            type: 'content_block_start',
                            index: blockIndex,
                            content_block: { type: 'tool_use', id: toolId, name: call.name, input: {} }
                        })
                    )
                )
                controller.enqueue(
                    encoder.encode(
                        sse('content_block_delta', {
                            type: 'content_block_delta',
                            index: blockIndex,
                            delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) }
                        })
                    )
                )
                controller.enqueue(
                    encoder.encode(sse('content_block_stop', { type: 'content_block_stop', index: blockIndex }))
                )
            }
            state.blockIndex += calls.length - state.toolBlocksEmitted
            state.toolBlocksEmitted = calls.length
            state.stopReason = 'tool_use'
        }

        const processLine = (controller: ReadableStreamDefaultController, line: string) => {
            const payload = this.parseSsePayload(line)
            if (!payload) return
            const token = extractText(payload)
            if (token) emitText(controller, token)
            collectToolCalls(payload, state.toolCalls)
            if (finishReason(payload) === 'tool_calls') {
                emitToolCalls(controller)
            }
        }

        const transform = new TransformStream({
            start(controller) {
                controller.enqueue(
                    encoder.encode(
                        sse('message_start', {
                            type: 'message_start',
                            message: {
                                id,
                                type: 'message',
                                role: 'assistant',
                                model,
                                content: [],
                                stop_reason: null,
                                stop_sequence: null,
                                usage: { input_tokens: 0, output_tokens: 0 }
                            }
                        })
                    )
                )
            },
            transform(chunk, controller) {
                const raw = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
                let buffer: string = state._buffer || ''
                buffer += raw
                const lines = buffer.split('\n')
                state._buffer = lines.pop() ?? ''
                for (const line of lines) processLine(controller, line)
            },
            flush(controller) {
                if (state._buffer) processLine(controller, state._buffer)
                state._buffer = ''

                if (state.toolCalls.size > state.toolBlocksEmitted) {
                    emitToolCalls(controller)
                } else {
                    closeTextBlock(controller)
                }

                controller.enqueue(
                    encoder.encode(
                        sse('message_delta', {
                            type: 'message_delta',
                            delta: { stop_reason: state.stopReason, stop_sequence: null },
                            usage: { output_tokens: estimateTokens(state.text) }
                        })
                    )
                )
                controller.enqueue(encoder.encode(sse('message_stop', { type: 'message_stop' })))
            }
        })

        return new Response(source.pipeThrough(transform), {
            status: 200,
            headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }
        })
    }
}
```

- [ ] **Step 2: Smoke test the Workers AI provider route without deploying**

Run:

```bash
npm run check
npx wrangler dev --port 8080
```

In another shell:

```bash
curl https://localhost:8080/
# Expected: ok
```

- [ ] **Step 3: Commit**

```bash
git add src/providers/workers-ai.ts
git commit -m "feat: port existing Workers AI backend to TypeScript provider"
```

---

### Task 6: Add the Gemini Provider

**Files:**
- Create: `src/providers/gemini.ts`

**Interfaces:**
- Consumes: `ClaudeRequest`/`Gemini*` types, `utils.buildUrl`, `utils.cleanJsonSchema`, `utils.processProviderStream`, SSE builders.
- Produces: `gemini.impl` class implementing `Provider`.

- [ ] **Step 1: Create `src/providers/gemini.ts`**

```ts
import * as types from '../types'
import * as provider from '../provider'
import * as utils from '../utils'

export class impl implements provider.Provider {
    async convertToProviderRequest(request: Request, baseUrl: string, apiKey: string): Promise<Request> {
        const claudeRequest = (await request.json()) as types.ClaudeRequest
        const geminiRequest = this.convertToGeminiRequestBody(claudeRequest)

        const endpoint = `models/${claudeRequest.model}:${claudeRequest.stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`
        const finalUrl = utils.buildUrl(baseUrl, endpoint)

        const headers = new Headers(request.headers)
        headers.set('x-goog-api-key', apiKey)
        headers.set('Content-Type', 'application/json')

        return new Request(finalUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(geminiRequest)
        })
    }

    async convertToClaudeResponse(geminiResponse: Response): Promise<Response> {
        if (!geminiResponse.ok) {
            return geminiResponse
        }

        const contentType = geminiResponse.headers.get('content-type') || ''
        const isStream = contentType.includes('text/event-stream')

        if (isStream) {
            return this.convertStreamResponse(geminiResponse)
        } else {
            return this.convertNormalResponse(geminiResponse)
        }
    }

    private convertToGeminiRequestBody(claudeRequest: types.ClaudeRequest): types.GeminiRequest {
        const toolUseMap = this.buildToolUseMap(claudeRequest.messages)
        const contents = this.convertMessages(claudeRequest.messages, toolUseMap)
        const systemInstruction = this.convertSystemInstruction(claudeRequest.system)

        const geminiRequest: types.GeminiRequest = {
            model: claudeRequest.model,
            contents
        }

        if (systemInstruction) {
            geminiRequest.systemInstruction = systemInstruction
        }

        if (claudeRequest.tools && claudeRequest.tools.length > 0) {
            geminiRequest.tools = [
                {
                    functionDeclarations: claudeRequest.tools.map(tool => ({
                        name: tool.name,
                        description: tool.description,
                        parameters: utils.cleanJsonSchema(tool.input_schema)
                    }))
                }
            ]
        }

        if (claudeRequest.temperature !== undefined || claudeRequest.max_tokens !== undefined) {
            geminiRequest.generationConfig = {}
            if (claudeRequest.temperature !== undefined) {
                geminiRequest.generationConfig.temperature = claudeRequest.temperature
            }
            if (claudeRequest.max_tokens !== undefined) {
                geminiRequest.generationConfig.maxOutputTokens = claudeRequest.max_tokens
            }
        }

        return geminiRequest
    }

    private convertSystemInstruction(system: types.ClaudeRequest['system']): types.GeminiContent | undefined {
        if (!system) return undefined
        const text =
            typeof system === 'string'
                ? system
                : system
                      .filter(part => part.type === 'text')
                      .map(part => part.text)
                      .join('\n')

        if (!text) return undefined
        return {
            parts: [{ text }]
        }
    }

    private buildToolUseMap(messages: types.ClaudeMessage[]): Map<string, string> {
        const toolUseMap = new Map<string, string>()

        for (const message of messages) {
            if (typeof message.content === 'string') continue

            for (const content of message.content) {
                if (content.type === 'tool_use') {
                    toolUseMap.set(content.id, content.name)
                }
            }
        }

        return toolUseMap
    }

    private convertMessages(messages: types.ClaudeMessage[], toolUseMap: Map<string, string>): types.GeminiContent[] {
        const contents: types.GeminiContent[] = []

        for (const message of messages) {
            if (typeof message.content === 'string') {
                contents.push({
                    parts: [{ text: message.content }],
                    role: message.role === 'assistant' ? 'model' : 'user'
                })
                continue
            }

            const textParts: types.GeminiPart[] = []
            const toolUseParts: types.GeminiPart[] = []
            const toolResultParts: types.GeminiPart[] = []

            for (const content of message.content) {
                switch (content.type) {
                    case 'text':
                        textParts.push({ text: content.text })
                        break
                    case 'tool_use':
                        toolUseParts.push({
                            functionCall: {
                                name: content.name,
                                args: content.input
                            }
                        })
                        break
                    case 'tool_result':
                        const functionName = toolUseMap.get(content.tool_use_id)
                        if (functionName) {
                            toolResultParts.push({
                                functionResponse: {
                                    name: functionName,
                                    response: { content: content.content }
                                }
                            })
                        }
                        break
                }
            }

            if (textParts.length > 0 || toolUseParts.length > 0) {
                contents.push({
                    parts: [...textParts, ...toolUseParts],
                    role: message.role === 'assistant' ? 'model' : 'user'
                })
            }

            if (toolResultParts.length > 0) {
                contents.push({
                    parts: toolResultParts,
                    role: 'tool'
                })
            }
        }

        return contents
    }

    private async convertNormalResponse(geminiResponse: Response): Promise<Response> {
        const geminiData = (await geminiResponse.json()) as types.GeminiResponse

        const claudeResponse: types.ClaudeResponse = {
            id: utils.generateId(),
            type: 'message',
            role: 'assistant',
            content: [],
            usage: {
                input_tokens: 0,
                output_tokens: 0
            }
        }

        if (geminiData.candidates && geminiData.candidates.length > 0) {
            const candidate = geminiData.candidates[0]
            let hasToolUse = false

            for (const part of candidate.content.parts) {
                if ('text' in part) {
                    claudeResponse.content.push({
                        type: 'text',
                        text: part.text
                    })
                } else if ('functionCall' in part) {
                    hasToolUse = true
                    claudeResponse.content.push({
                        type: 'tool_use',
                        id: utils.generateId(),
                        name: part.functionCall.name,
                        input: part.functionCall.args
                    })
                }
            }

            if (hasToolUse) {
                claudeResponse.stop_reason = 'tool_use'
            } else if (candidate.finishReason === 'MAX_TOKENS') {
                claudeResponse.stop_reason = 'max_tokens'
            } else {
                claudeResponse.stop_reason = 'end_turn'
            }
        }

        if (geminiData.usageMetadata) {
            claudeResponse.usage = {
                input_tokens: geminiData.usageMetadata.promptTokenCount,
                output_tokens: geminiData.usageMetadata.candidatesTokenCount
            }
        }

        return new Response(JSON.stringify(claudeResponse), {
            status: geminiResponse.status,
            headers: { 'Content-Type': 'application/json' }
        })
    }

    private async convertStreamResponse(geminiResponse: Response): Promise<Response> {
        let textBlockOpen = false

        return utils.processProviderStream(geminiResponse, (jsonStr, textBlockIndex, toolUseBlockIndex) => {
            const geminiData = JSON.parse(jsonStr) as types.GeminiResponse
            if (!geminiData.candidates || geminiData.candidates.length === 0) {
                return null
            }

            const candidate = geminiData.candidates[0]
            const events: string[] = []
            let currentTextIndex = textBlockIndex
            let currentToolIndex = toolUseBlockIndex
            let stopReason: types.ClaudeStopReason | undefined

            if (candidate.content) {
                for (const part of candidate.content.parts) {
                    if ('text' in part && part.text) {
                        if (!textBlockOpen) {
                            events.push(utils.startTextBlock(currentTextIndex))
                            textBlockOpen = true
                        }
                        events.push(utils.textDelta(part.text, currentTextIndex))
                    } else if ('functionCall' in part) {
                        if (textBlockOpen) {
                            events.push(utils.stopContentBlock(currentTextIndex))
                            currentTextIndex++
                            textBlockOpen = false
                        }
                        events.push(
                            ...utils.processToolUsePart(
                                { name: part.functionCall.name, args: part.functionCall.args ?? {} },
                                currentToolIndex
                            )
                        )
                        currentToolIndex++
                    }
                }
            }

            if (candidate.finishReason) {
                if (textBlockOpen) {
                    events.push(utils.stopContentBlock(currentTextIndex))
                    currentTextIndex++
                    textBlockOpen = false
                }
                stopReason = candidate.finishReason === 'MAX_TOKENS' ? 'max_tokens' : 'end_turn'
            }

            return {
                events,
                textBlockIndex: currentTextIndex,
                toolUseBlockIndex: currentToolIndex,
                stopReason
            }
        })
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/providers/gemini.ts
git commit -m "feat: add Gemini provider"
```

---

### Task 7: Add the OpenAI Providers

**Files:**
- Create: `src/providers/openai.ts`

**Interfaces:**
- Consumes: `ClaudeRequest`/`OpenAI*` types, `openai` SDK, `utils` SSE helpers.
- Produces: `ChatCompletionsProvider` and `ResponsesProvider` classes, both implementing `Provider`. The file also re-exports `ChatCompletionsProvider as impl` for symmetry.

- [ ] **Step 1: Create `src/providers/openai.ts`**

```ts
import OpenAI from 'openai'
import type {
    ChatCompletion,
    ChatCompletionChunk,
    ChatCompletionCreateParams,
    ChatCompletionMessageParam
} from 'openai/resources/chat/completions'
import type {
    FunctionTool,
    Response as OpenAIResponse,
    ResponseCreateParams,
    ResponseFunctionToolCall,
    ResponseInputItem,
    ResponseOutputMessage,
    ResponseStreamEvent
} from 'openai/resources/responses/responses'
import type { Stream } from 'openai/streaming'
import * as types from '../types'
import * as provider from '../provider'
import * as utils from '../utils'

type ClaudeStreamState = {
    textBlockOpen: boolean
    textBlockIndex: number
    toolUseBlockIndex: number
    stopReason: types.ClaudeStopReason
    usage: {
        input_tokens: number
        output_tokens: number
    }
}

function createClient(apiKey: string, baseUrl: string): OpenAI {
    return new OpenAI({
        apiKey: apiKey.startsWith('Bearer ') ? apiKey.slice('Bearer '.length) : apiKey,
        baseURL: baseUrl,
        timeout: 600_000,
        maxRetries: 0
    })
}

function systemText(system: types.ClaudeRequest['system']): string | undefined {
    if (!system) return undefined
    if (typeof system === 'string') return system
    return system
        .filter(part => part.type === 'text')
        .map(part => part.text)
        .join('\n')
}

function contentToText(content: types.ClaudeContent): string {
    if (typeof content === 'string') return content
    return content
        .filter(part => part.type === 'text')
        .map(part => part.text)
        .join('\n')
}

function toolResultToText(content: string | unknown): string {
    return typeof content === 'string' ? content : JSON.stringify(content)
}

function stopReasonFromOpenAI(finishReason?: string | null): types.ClaudeStopReason {
    switch (finishReason) {
        case 'tool_calls':
        case 'function_call':
            return 'tool_use'
        case 'length':
            return 'max_tokens'
        case 'stop':
        default:
            return 'end_turn'
    }
}

function stopReasonFromResponseStatus(status?: string): types.ClaudeStopReason {
    return status === 'incomplete' ? 'max_tokens' : 'end_turn'
}

function parseToolArguments(args: string): unknown {
    return utils.safeJsonParse(args || '{}')
}

function initStreamState(): ClaudeStreamState {
    return {
        textBlockOpen: false,
        textBlockIndex: 0,
        toolUseBlockIndex: 0,
        stopReason: 'end_turn',
        usage: { input_tokens: 0, output_tokens: 0 }
    }
}

function openTextBlockIfNeeded(events: string[], state: ClaudeStreamState): void {
    if (state.textBlockOpen) return
    events.push(utils.startTextBlock(state.textBlockIndex))
    state.textBlockOpen = true
}

function closeTextBlockIfNeeded(events: string[], state: ClaudeStreamState): void {
    if (!state.textBlockOpen) return
    events.push(utils.stopContentBlock(state.textBlockIndex))
    state.textBlockIndex++
    state.textBlockOpen = false
}

function enqueueEvents(controller: ReadableStreamDefaultController, events: string[]): void {
    for (const event of events) {
        utils.enqueueRawSse(controller, event)
    }
}

function errorToResponse(error: unknown): Response {
    if (error instanceof OpenAI.APIError) {
        const body = error.error ?? { error: { message: error.message, type: error.name } }
        return jsonResponse(body, error.status ?? 500)
    }
    console.error(error)
    return new Response('OpenAI SDK request failed', { status: 502 })
}

export class ChatCompletionsProvider implements provider.Provider {
    async handle(request: Request, baseUrl: string, apiKey: string): Promise<Response> {
        const claudeRequest = (await request.json()) as types.ClaudeRequest
        const openaiRequest = this.convertToOpenAIRequestBody(claudeRequest)
        const client = createClient(apiKey, baseUrl)

        try {
            if (claudeRequest.stream) {
                const stream = await client.chat.completions.create({
                    ...openaiRequest,
                    stream: true,
                    stream_options: { include_usage: true }
                } as ChatCompletionCreateParams)
                return this.convertStreamResponse(stream as Stream<ChatCompletionChunk>)
            }

            const completion = await client.chat.completions.create({
                ...openaiRequest,
                stream: false
            } as ChatCompletionCreateParams)
            return this.convertNormalResponse(completion as ChatCompletion)
        } catch (error) {
            return errorToResponse(error)
        }
    }

    async convertToProviderRequest(request: Request, baseUrl: string, apiKey: string): Promise<Request> {
        const claudeRequest = (await request.json()) as types.ClaudeRequest
        const openaiRequest = this.convertToOpenAIRequestBody(claudeRequest)
        const finalUrl = utils.buildUrl(baseUrl, 'chat/completions')

        const headers = new Headers(request.headers)
        headers.set('Authorization', apiKey.startsWith('Bearer ') ? apiKey : `Bearer ${apiKey}`)
        headers.set('Content-Type', 'application/json')

        return new Request(finalUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(openaiRequest)
        })
    }

    async convertToClaudeResponse(openaiResponse: Response): Promise<Response> {
        if (!openaiResponse.ok) {
            return openaiResponse
        }
        const openaiData = (await openaiResponse.json()) as ChatCompletion
        return this.convertNormalResponse(openaiData)
    }

    private convertToOpenAIRequestBody(claudeRequest: types.ClaudeRequest): ChatCompletionCreateParams {
        const openaiRequest: ChatCompletionCreateParams = {
            model: claudeRequest.model,
            messages: this.convertMessages(claudeRequest),
            stream: claudeRequest.stream ?? false
        }

        if (claudeRequest.tools && claudeRequest.tools.length > 0) {
            openaiRequest.tools = claudeRequest.tools.map(tool => ({
                type: 'function',
                function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: utils.cleanJsonSchema(tool.input_schema)
                }
            }))
        }

        if (claudeRequest.temperature !== undefined) {
            openaiRequest.temperature = claudeRequest.temperature
        }

        if (claudeRequest.max_tokens !== undefined) {
            openaiRequest.max_tokens = claudeRequest.max_tokens
        }

        return openaiRequest
    }

    private convertMessages(claudeRequest: types.ClaudeRequest): ChatCompletionMessageParam[] {
        const openaiMessages: ChatCompletionMessageParam[] = []
        const system = systemText(claudeRequest.system)
        if (system) {
            openaiMessages.push({ role: 'system', content: system })
        }

        for (const message of claudeRequest.messages) {
            if (typeof message.content === 'string') {
                openaiMessages.push({
                    role: message.role === 'assistant' ? 'assistant' : 'user',
                    content: message.content
                })
                continue
            }

            const textContents: string[] = []
            const toolCalls: NonNullable<types.OpenAIMessage['tool_calls']> = []
            const toolResults: Array<{ tool_call_id: string; content: string }> = []

            for (const content of message.content) {
                switch (content.type) {
                    case 'text':
                        textContents.push(content.text)
                        break
                    case 'tool_use':
                        toolCalls.push({
                            id: content.id,
                            type: 'function',
                            function: {
                                name: content.name,
                                arguments: JSON.stringify(content.input)
                            }
                        })
                        break
                    case 'tool_result':
                        toolResults.push({
                            tool_call_id: content.tool_use_id,
                            content: toolResultToText(content.content)
                        })
                        break
                }
            }

            if (textContents.length > 0 || toolCalls.length > 0) {
                openaiMessages.push({
                    role: message.role === 'assistant' ? 'assistant' : 'user',
                    content: textContents.length > 0 ? textContents.join('\n') : null,
                    tool_calls: toolCalls.length > 0 ? toolCalls : undefined
                } as ChatCompletionMessageParam)
            }

            for (const toolResult of toolResults) {
                openaiMessages.push({
                    role: 'tool',
                    tool_call_id: toolResult.tool_call_id,
                    content: toolResult.content
                })
            }
        }

        return openaiMessages
    }

    private convertNormalResponse(openaiData: ChatCompletion): Response {
        const claudeResponse: types.ClaudeResponse = {
            id: openaiData.id || utils.generateId(),
            type: 'message',
            role: 'assistant',
            content: [],
            usage: { input_tokens: 0, output_tokens: 0 }
        }

        if (openaiData.choices && openaiData.choices.length > 0) {
            const choice = openaiData.choices[0]
            const message = choice.message

            if (message.content) {
                claudeResponse.content.push({ type: 'text', text: message.content })
            }

            if (message.tool_calls) {
                for (const toolCall of message.tool_calls) {
                    if (toolCall.type !== 'function') continue
                    claudeResponse.content.push({
                        type: 'tool_use',
                        id: toolCall.id,
                        name: toolCall.function.name,
                        input: parseToolArguments(toolCall.function.arguments)
                    })
                }
            }

            claudeResponse.stop_reason = stopReasonFromOpenAI(choice.finish_reason)
        }

        if (openaiData.usage) {
            claudeResponse.usage = {
                input_tokens: openaiData.usage.prompt_tokens,
                output_tokens: openaiData.usage.completion_tokens
            }
        }

        return jsonResponse(claudeResponse, 200)
    }

    private convertStreamResponse(openaiStream: Stream<ChatCompletionChunk>): Response {
        const stream = new ReadableStream({
            async start(controller) {
                const state = initStreamState()
                const toolCallState = new Map<number, { id?: string; name?: string; args: string }>()

                utils.sendMessageStart(controller)

                try {
                    for await (const chunk of openaiStream) {
                        if (chunk.usage) {
                            state.usage = {
                                input_tokens: chunk.usage.prompt_tokens,
                                output_tokens: chunk.usage.completion_tokens
                            }
                        }

                        if (!chunk.choices || chunk.choices.length === 0) continue

                        const choice = chunk.choices[0]
                        const delta = choice.delta
                        const events: string[] = []

                        if (delta.content) {
                            openTextBlockIfNeeded(events, state)
                            events.push(utils.textDelta(delta.content, state.textBlockIndex))
                        }

                        if (delta.tool_calls) {
                            for (const toolCall of delta.tool_calls) {
                                const stateForTool = toolCallState.get(toolCall.index) ?? { args: '' }
                                stateForTool.id = toolCall.id ?? stateForTool.id
                                stateForTool.name = toolCall.function?.name ?? stateForTool.name
                                stateForTool.args += toolCall.function?.arguments ?? ''
                                toolCallState.set(toolCall.index, stateForTool)
                            }
                        }

                        if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'function_call') {
                            closeTextBlockIfNeeded(events, state)
                            for (const [, toolCall] of [...toolCallState].sort(([a], [b]) => a - b)) {
                                if (!toolCall.name) continue
                                events.push(
                                    ...utils.processToolUsePart(
                                        { name: toolCall.name, args: parseToolArguments(toolCall.args) },
                                        state.toolUseBlockIndex
                                    )
                                )
                                state.toolUseBlockIndex++
                            }
                            state.stopReason = 'tool_use'
                        } else if (choice.finish_reason) {
                            closeTextBlockIfNeeded(events, state)
                            state.stopReason = stopReasonFromOpenAI(choice.finish_reason)
                        }

                        enqueueEvents(controller, events)
                    }
                } catch (error) {
                    console.error(error)
                    controller.error(error)
                    return
                } finally {
                    const events: string[] = []
                    closeTextBlockIfNeeded(events, state)
                    enqueueEvents(controller, events)
                    utils.sendMessageDelta(controller, state.stopReason, state.usage)
                    utils.sendMessageStop(controller)
                    controller.close()
                }
            }
        })

        return streamResponse(stream)
    }
}

export class ResponsesProvider implements provider.Provider {
    async handle(request: Request, baseUrl: string, apiKey: string): Promise<Response> {
        const claudeRequest = (await request.json()) as types.ClaudeRequest
        const openaiRequest = this.convertToResponsesRequestBody(claudeRequest)
        const client = createClient(apiKey, baseUrl)

        try {
            if (claudeRequest.stream) {
                const stream = await client.responses.create({
                    ...openaiRequest,
                    stream: true
                } as ResponseCreateParams)
                return this.convertStreamResponse(stream as Stream<ResponseStreamEvent>)
            }

            const response = await client.responses.create({
                ...openaiRequest,
                stream: false
            } as ResponseCreateParams)
            return this.convertNormalResponse(response as OpenAIResponse)
        } catch (error) {
            return errorToResponse(error)
        }
    }

    async convertToProviderRequest(request: Request, baseUrl: string, apiKey: string): Promise<Request> {
        const claudeRequest = (await request.json()) as types.ClaudeRequest
        const openaiRequest = this.convertToResponsesRequestBody(claudeRequest)
        const finalUrl = utils.buildUrl(baseUrl, 'responses')

        const headers = new Headers(request.headers)
        headers.set('Authorization', apiKey.startsWith('Bearer ') ? apiKey : `Bearer ${apiKey}`)
        headers.set('Content-Type', 'application/json')

        return new Request(finalUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(openaiRequest)
        })
    }

    async convertToClaudeResponse(openaiResponse: Response): Promise<Response> {
        if (!openaiResponse.ok) {
            return openaiResponse
        }
        const openaiData = (await openaiResponse.json()) as OpenAIResponse
        return this.convertNormalResponse(openaiData)
    }

    private convertToResponsesRequestBody(claudeRequest: types.ClaudeRequest): ResponseCreateParams {
        const openaiRequest: ResponseCreateParams = {
            model: claudeRequest.model,
            input: this.convertInput(claudeRequest.messages),
            stream: claudeRequest.stream ?? false
        }

        const system = systemText(claudeRequest.system)
        if (system) {
            openaiRequest.instructions = system
        }

        if (claudeRequest.tools && claudeRequest.tools.length > 0) {
            openaiRequest.tools = claudeRequest.tools.map(tool => ({
                type: 'function',
                name: tool.name,
                description: tool.description,
                parameters: utils.cleanJsonSchema(tool.input_schema),
                strict: null
            })) as FunctionTool[]
        }

        if (claudeRequest.temperature !== undefined) {
            openaiRequest.temperature = claudeRequest.temperature
        }

        if (claudeRequest.max_tokens !== undefined) {
            openaiRequest.max_output_tokens = claudeRequest.max_tokens
        }

        return openaiRequest
    }

    private convertInput(messages: types.ClaudeMessage[]): ResponseInputItem[] {
        const input: ResponseInputItem[] = []

        for (const message of messages) {
            if (typeof message.content === 'string') {
                input.push({
                    type: 'message',
                    role: message.role,
                    content: [
                        {
                            type: message.role === 'assistant' ? 'output_text' : 'input_text',
                            text: message.content
                        }
                    ]
                } as ResponseInputItem)
                continue
            }

            const text = contentToText(message.content)
            if (text) {
                input.push({
                    type: 'message',
                    role: message.role,
                    content: [
                        {
                            type: message.role === 'assistant' ? 'output_text' : 'input_text',
                            text
                        }
                    ]
                } as ResponseInputItem)
            }

            for (const content of message.content) {
                if (content.type === 'tool_use') {
                    input.push({
                        type: 'function_call',
                        call_id: content.id,
                        name: content.name,
                        arguments: JSON.stringify(content.input)
                    } as ResponseInputItem)
                } else if (content.type === 'tool_result') {
                    input.push({
                        type: 'function_call_output',
                        call_id: content.tool_use_id,
                        output: toolResultToText(content.content)
                    } as ResponseInputItem)
                }
            }
        }

        return input
    }

    private convertNormalResponse(openaiData: OpenAIResponse): Response {
        const claudeResponse: types.ClaudeResponse = {
            id: openaiData.id || utils.generateId(),
            type: 'message',
            role: 'assistant',
            content: [],
            stop_reason: 'end_turn',
            usage: { input_tokens: 0, output_tokens: 0 }
        }

        for (const output of openaiData.output ?? []) {
            if (output.type === 'message') {
                const message = output as ResponseOutputMessage
                for (const content of message.content ?? []) {
                    if (content.type === 'output_text') {
                        claudeResponse.content.push({ type: 'text', text: content.text })
                    }
                }
            } else if (output.type === 'function_call') {
                const toolCall = output as ResponseFunctionToolCall
                claudeResponse.content.push({
                    type: 'tool_use',
                    id: toolCall.call_id,
                    name: toolCall.name,
                    input: parseToolArguments(toolCall.arguments)
                })
                claudeResponse.stop_reason = 'tool_use'
            }
        }

        if (claudeResponse.content.length === 0 && openaiData.output_text) {
            claudeResponse.content.push({ type: 'text', text: openaiData.output_text })
        }

        if (openaiData.status === 'incomplete') {
            claudeResponse.stop_reason = 'max_tokens'
        }

        if (openaiData.usage) {
            claudeResponse.usage = {
                input_tokens: openaiData.usage.input_tokens ?? 0,
                output_tokens: openaiData.usage.output_tokens ?? 0
            }
        }

        return jsonResponse(claudeResponse, 200)
    }

    private convertStreamResponse(openaiStream: Stream<ResponseStreamEvent>): Response {
        const stream = new ReadableStream({
            async start(controller) {
                const state = initStreamState()
                const functionCalls = new Map<number, { name?: string; callId?: string; args: string }>()

                utils.sendMessageStart(controller)

                try {
                    for await (const event of openaiStream) {
                        const events: string[] = []

                        switch (event.type) {
                            case 'response.output_text.delta':
                                if (event.delta) {
                                    openTextBlockIfNeeded(events, state)
                                    events.push(utils.textDelta(event.delta, state.textBlockIndex))
                                }
                                break
                            case 'response.output_item.added':
                                if (event.item?.type === 'function_call') {
                                    const item = event.item as ResponseFunctionToolCall
                                    const index = event.output_index ?? functionCalls.size
                                    functionCalls.set(index, {
                                        name: item.name,
                                        callId: item.call_id,
                                        args: item.arguments ?? ''
                                    })
                                }
                                break
                            case 'response.function_call_arguments.delta': {
                                const call = functionCalls.get(event.output_index) ?? { args: '' }
                                call.args += event.delta ?? ''
                                functionCalls.set(event.output_index, call)
                                break
                            }
                            case 'response.output_item.done':
                                if (event.item?.type === 'function_call') {
                                    closeTextBlockIfNeeded(events, state)
                                    const item = event.item as ResponseFunctionToolCall
                                    const call = functionCalls.get(event.output_index) ?? { args: '' }
                                    call.name = item.name ?? call.name
                                    call.callId = item.call_id ?? call.callId
                                    call.args = item.arguments ?? call.args
                                    if (call.name) {
                                        events.push(
                                            ...utils.processToolUsePart(
                                                { name: call.name, args: parseToolArguments(call.args) },
                                                state.toolUseBlockIndex
                                            )
                                        )
                                        state.toolUseBlockIndex++
                                        state.stopReason = 'tool_use'
                                    }
                                }
                                break
                            case 'response.completed':
                                closeTextBlockIfNeeded(events, state)
                                state.stopReason = stopReasonFromResponseStatus(event.response.status)
                                if (event.response.usage) {
                                    state.usage = {
                                        input_tokens: event.response.usage.input_tokens ?? 0,
                                        output_tokens: event.response.usage.output_tokens ?? 0
                                    }
                                }
                                break
                            case 'response.incomplete':
                                closeTextBlockIfNeeded(events, state)
                                state.stopReason = 'max_tokens'
                                if (event.response.usage) {
                                    state.usage = {
                                        input_tokens: event.response.usage.input_tokens ?? 0,
                                        output_tokens: event.response.usage.output_tokens ?? 0
                                    }
                                }
                                break
                        }

                        enqueueEvents(controller, events)
                    }
                } catch (error) {
                    console.error(error)
                    controller.error(error)
                    return
                } finally {
                    const events: string[] = []
                    closeTextBlockIfNeeded(events, state)
                    enqueueEvents(controller, events)
                    utils.sendMessageDelta(controller, state.stopReason, state.usage)
                    utils.sendMessageStop(controller)
                    controller.close()
                }
            }
        })

        return streamResponse(stream)
    }
}

export { ChatCompletionsProvider as impl }

function jsonResponse(body: unknown, status: number): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' }
    })
}

function streamResponse(stream: ReadableStream): Response {
    return new Response(stream, {
        status: 200,
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive'
        }
    })
}
```

- [ ] **Step 2: Commit**

```bash
git add src/providers/openai.ts
git commit -m "feat: add OpenAI Chat Completions and Responses providers"
```

---

### Task 8: Router and Entry Point

**Files:**
- Create: `src/index.ts`

**Interfaces:**
- Consumes: all prior tasks.
- Produces: default Worker fetch handler.

- [ ] **Step 1: Create `src/index.ts`**

```ts
import { generateRequestId } from './request-id'
import { anthropicError, jsonResponse } from './errors'
import { verifyProxyKey, extractProviderKey } from './auth'
import { Provider } from './provider'
import * as models from './models'
import * as tokens from './tokens'
import { WorkersAIProvider } from './providers/workers-ai'
import * as gemini from './providers/gemini'
import * as openai from './providers/openai'

type ProviderCtor = { new (): Provider }

const PROVIDERS: Record<string, ProviderCtor> = {
    gemini: gemini.impl,
    openai: openai.ChatCompletionsProvider,
    'openai-responses': openai.ResponsesProvider
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const requestId = generateRequestId()
        try {
            const response = await handleRequest(request, env, requestId)
            return withRequestId(response, requestId)
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            console.error(error)
            return anthropicError(500, 'api_error', message, requestId)
        }
    }
}

async function handleRequest(request: Request, env: Env, requestId: string): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === 'GET' && url.pathname === '/') {
        return new Response('ok', { status: 200 })
    }

    if (request.method === 'GET' && url.pathname === '/v1/models') {
        const auth = await requireProxyKey(request, env, requestId)
        if (auth) return auth
        return models.listModels(env)
    }

    const modelMatch = url.pathname.match(/^\/v1\/models\/(.+)$/)
    if (request.method === 'GET' && modelMatch) {
        const auth = await requireProxyKey(request, env, requestId)
        if (auth) return auth
        return models.getModel(decodeURIComponent(modelMatch[1]), env, requestId)
    }

    if (request.method === 'POST' && url.pathname === '/v1/messages/count_tokens') {
        const auth = await requireProxyKey(request, env, requestId)
        if (auth) return auth
        const body = await request.json()
        return jsonResponse(tokens.countTokensForRequest(body), 200, requestId)
    }

    if (request.method === 'POST' && url.pathname === '/v1/messages') {
        const auth = await requireProxyKey(request, env, requestId)
        if (auth) return auth
        return new WorkersAIProvider(env).handle(request, requestId)
    }

    const externalMatch = url.pathname.match(/^\/([^/]+)\/(.+)\/v1\/messages$/)
    if (request.method === 'POST' && externalMatch) {
        return handleExternal(
            request,
            env,
            decodeURIComponent(externalMatch[1]),
            decodeURIComponent(externalMatch[2]),
            requestId
        )
    }

    return anthropicError(404, 'not_found_error', 'Not found', requestId)
}

async function requireProxyKey(request: Request, env: Env, requestId: string): Promise<Response | null> {
    if (!env.PROXY_KEY) return null
    const provided = request.headers.get('x-api-key')
    if (!(await verifyProxyKey(provided, env.PROXY_KEY))) {
        return anthropicError(401, 'authentication_error', 'invalid x-api-key', requestId)
    }
    return null
}

async function handleExternal(
    request: Request,
    env: Env,
    type: string,
    providerUrl: string,
    requestId: string
): Promise<Response> {
    const ProviderCtor = PROVIDERS[type]
    if (!ProviderCtor) {
        return anthropicError(404, 'not_found_error', `Provider type '${type}' not found`, requestId)
    }

    if (env.PROXY_KEY) {
        const provided = request.headers.get('x-proxy-key')
        if (!(await verifyProxyKey(provided, env.PROXY_KEY))) {
            return anthropicError(401, 'authentication_error', 'invalid x-proxy-key', requestId)
        }
    }

    const keyResult = extractProviderKey(request.headers)
    if (!keyResult) {
        return anthropicError(401, 'authentication_error', 'missing provider api key', requestId)
    }

    const baseUrl = normalizeProviderUrl(providerUrl)
    const provider = new ProviderCtor()

    if (provider.handle) {
        return provider.handle(request, baseUrl, keyResult.apiKey)
    }

    const providerRequest = await provider.convertToProviderRequest(request, baseUrl, keyResult.apiKey)
    const providerResponse = await fetch(providerRequest)
    return provider.convertToClaudeResponse(providerResponse)
}

function normalizeProviderUrl(raw: string): string {
    let url = raw
        .replace(/^http:\/\/([^/])/, 'http:///$1')
        .replace(/^https:\/\/([^/])/, 'https:///$1')
    if (!/^(https?):\/\//i.test(url)) {
        url = `https://${url}`
    }
    return url.replace(/\/$/, '')
}

function withRequestId(response: Response, requestId: string): Response {
    const headers = new Headers(response.headers)
    if (!headers.has('request-id')) {
        headers.set('request-id', requestId)
    }
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers
    })
}
```

- [ ] **Step 2: Verify the Workers AI provider signature matches the router**

`src/index.ts` calls `new WorkersAIProvider(env).handle(request, requestId)`. Update Task 5's `WorkersAIProvider.handle(request: Request)` to `handle(request: Request, requestId: string)`, store `requestId`, and include `request_id` in `this.error(...)` bodies so Workers AI failures match the Anthropic error shape.

- [ ] **Step 3: Type-check without deploying**

```bash
npm run check
```

Expected: `tsc` passes and Prettier reports no issues.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: add router, auth, request-id wrapping and external-provider dispatch"
```

---

### Task 9: Cleanup, README, and Self-Test

**Files:**
- Delete: `src/index.js`
- Delete: `wrangler.toml` (replaced by `wrangler.jsonc`)
- Modify: `README.md`
- Create: `scripts/self-test.sh`

**Interfaces:**
- All prior tasks integrated; no new public interfaces.

- [ ] **Step 1: Delete the legacy files**

```bash
rm src/index.js wrangler.toml
```

Verify `src/index.ts` is now the only `main` file referenced by `wrangler.jsonc`.

- [ ] **Step 2: Replace `README.md` with updated documentation**

```markdown
# claude-worker-proxy

A Cloudflare Worker that lets [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
run against multiple AI backends through an Anthropic-compatible API.

The default `POST /v1/messages` route targets **Cloudflare Workers AI** via the local
`env.AI.run()` binding. Additional routes proxy to Gemini, OpenAI Chat Completions, or
the OpenAI Responses API using the provider path convention.

## Supported routes

| Method | Path | Purpose |
|--------|------|---------|
| `GET`  | `/` | Health check: `ok` |
| `GET`  | `/v1/models` | List supported models |
| `GET`  | `/v1/models/{id}` | Retrieve one model |
| `POST` | `/v1/messages/count_tokens` | Estimate input token count |
| `POST` | `/v1/messages` | Anthropic Messages API -> Workers AI |
| `POST` | `/{type}/{provider_url}/v1/messages` | External provider proxy |

## External provider path convention

The proxy key (if any) goes in `x-proxy-key`; the provider API key goes in `x-api-key`
or `Authorization: Bearer <key>`.

Examples:

```bash
# Gemini (Google AI Studio)
curl -X POST https://<worker>/gemini/generativelanguage.googleapis.com/v1/messages \
  -H 'x-api-key: $GOOGLE_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"model":"gemini-1.5-flash","messages":[{"role":"user","content":"hi"}]}'

# OpenAI Chat Completions
curl -X POST https://<worker>/openai/api.openai.com/v1/messages \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'

# OpenAI Responses API
curl -X POST https://<worker>/openai-responses/api.openai.com/v1/messages \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
```

## Deploy

### 1. Log in

```bash
npx wrangler login
```

### 2. Install and type-check

```bash
npm install
npm run check
```

### 3. Deploy

```bash
npm run deploy
```

After deploy, note the Worker URL.

### 4. Optional: protect the proxy

Set a proxy-scoped secret. If set, internal routes require `x-api-key`; external
provider routes require `x-proxy-key` (so `x-api-key`/`Authorization` can be the
provider key).

```bash
npx wrangler secret put PROXY_KEY
```

### 5. Optional: configure the model list

The `GET /v1/models` endpoint uses a default Workers AI model list. Override it with a
comma-separated `MODELS` variable:

```bash
npx wrangler vars put MODELS
# value: @cf/meta/llama-3.3-70b-instruct-fp8-fast,@cf/meta/llama-3.1-8b-instruct-fast
```

## Point Claude Code at the Worker

Edit `~/.claude/settings.json`. Replace the URL and pick a model that works with your
chosen backend.

### Without a `PROXY_KEY` (Workers AI)

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://<worker-subdomain>.workers.dev",
    "ANTHROPIC_MODEL": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    "ANTHROPIC_SMALL_FAST_MODEL": "@cf/meta/llama-3.1-8b-instruct-fast"
  }
}
```

### With a `PROXY_KEY` (Workers AI)

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://<worker-subdomain>.workers.dev",
    "ANTHROPIC_CUSTOM_HEADERS": "x-api-key: your-proxy-key-value",
    "ANTHROPIC_MODEL": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    "ANTHROPIC_SMALL_FAST_MODEL": "@cf/meta/llama-3.1-8b-instruct-fast"
  }
}
```

Claude Code still expects an API key; use a dummy value:

```bash
export ANTHROPIC_API_KEY="sk-ant-dummy"
```

## Test locally

```bash
npx wrangler dev --port 8080
./scripts/self-test.sh http://127.0.0.1:8080
```

## Revert to Anthropic's API

Remove the proxy-related entries from `~/.claude/settings.json` and unset any session
exports:

```bash
unset ANTHROPIC_BASE_URL ANTHROPIC_MODEL ANTHROPIC_SMALL_FAST_MODEL ANTHROPIC_API_KEY ANTHROPIC_CUSTOM_HEADERS
```

## How it works

- Unknown Anthropic request fields are ignored rather than rejected.
- Tool-use blocks are reconstructed from provider-native tool deltas where possible.
- Streaming responses emit Anthropic SSE events (`message_start`, `content_block_*`,
  `message_delta`, `message_stop`).
- Token usage is exact when the provider reports it; otherwise estimated from character
  count for Workers AI.

## Limitations

- Files API, Batches API, prompt caching, and managed-agent features are **not**
  implemented.
- `PROXY_KEY` is a single shared secret with no per-user rate limiting beyond
  Cloudflare's platform controls.
```

- [ ] **Step 3: Create `scripts/self-test.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

BASE="${1:-http://127.0.0.1:8080}"
MODEL="${2:-@cf/meta/llama-3.1-8b-instruct-fast}"

echo "== health =="
curl -sS "${BASE}/" | grep -q '^ok$' && echo "health ok"

echo "== list models =="
curl -sS "${BASE}/v1/models" | head -c 200
echo

echo "== count tokens =="
curl -sS -X POST "${BASE}/v1/messages/count_tokens" \
  -H 'Content-Type: application/json' \
  -d '{"model":"'"${MODEL}"'","messages":[{"role":"user","content":"hello world"}]}'
echo

echo "== non-streaming chat =="
curl -sS -X POST "${BASE}/v1/messages" \
  -H 'Content-Type: application/json' \
  -d '{"model":"'"${MODEL}"'","messages":[{"role":"user","content":"say hi"}],"max_tokens":50}' \
  | head -c 400
echo

echo "Self-test complete."
```

Make it executable:

```bash
chmod +x scripts/self-test.sh
```

- [ ] **Step 4: Commit**

```bash
git add README.md scripts/self-test.sh
git add -A
git commit -m "docs: update README and add self-test script; remove legacy JS/toml"
```

---

### Task 10: Validation and Deploy

**Files:**
- All files created/modified in prior tasks.

- [ ] **Step 1: Type-check and lint**

```bash
npm run check
```

Expected: `tsc --noEmit` passes; Prettier reports all files formatted.

- [ ] **Step 2: Run local smoke tests**

```bash
npx wrangler dev --port 8080
```

In another shell:

```bash
./scripts/self-test.sh http://127.0.0.1:8080
```

Expected: health returns `ok`, models list returns JSON, count_tokens returns a
positive integer, and `/v1/messages` returns a valid Anthropic JSON response.

- [ ] **Step 3: Deploy**

```bash
npm run deploy
```

Expected: Wrangler deploys successfully and prints the Worker URL.

- [ ] **Step 4: Optional end-to-end with Claude Code**

Set environment variables (or `~/.claude/settings.json`) to point at the deployed
Worker, then run:

```bash
claude -p "Say hello in one sentence"
```

For external providers, include the provider key and proxy key if configured.

- [ ] **Step 5: Tag the working commit**

```bash
git tag -a v0.1.0 -m "Multi-provider Claude worker proxy"
```

---

## Self-Review

- [ ] **Spec coverage:** every design-spec section maps to a task:
  - Workers AI `/v1/messages` -> Task 5
  - External providers (`gemini`, `openai`, `openai-responses`) -> Tasks 6, 7, 8
  - `/v1/models`, `/v1/models/{id}`, `/v1/messages/count_tokens` -> Task 4
  - Auth, request-id, error shape -> Tasks 3, 8
  - SSE streaming -> Tasks 2, 3, 5, 6, 7
  - Tool calls -> Tasks 5, 6, 7
  - Files API / Batches API / prompt caching -> explicitly excluded (extended features section of spec).
- [ ] **Placeholder scan:** no `TBD`, `TODO`, "add appropriate error handling", or "etc." remain.
- [ ] **Type consistency:** `Provider.handle?` and `Provider.convertToProviderRequest`/`convertToClaudeResponse` are implemented by all providers; `WorkersAIProvider.handle(request, requestId)` matches the router; `countTokensForRequest` accepts the parsed request body.
- [ ] **Naming consistency:** `request-id` header and `request_id` body field use the same generated value; `ClaudeStopReason` literals match the Anthropic spec.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-08-27-claude-worker-proxy-enhancement.md`.**

Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints for review.

Which approach do you want?
