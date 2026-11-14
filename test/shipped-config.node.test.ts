import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { loadConfig } from '../src/config'
import { listModels } from '../src/routing/models'

// Drops // comments and trailing commas, leaving string contents (including https://) untouched.
function parseJsonc(text: string): any {
    let out = ''
    let inString = false
    for (let i = 0; i < text.length; i++) {
        const c = text[i]
        if (inString) {
            out += c
            if (c === '\\') out += text[++i]
            else if (c === '"') inString = false
        } else if (c === '"') {
            inString = true
            out += c
        } else if (c === '/' && text[i + 1] === '/') {
            while (i < text.length && text[i] !== '\n') i++
            out += '\n'
        } else {
            out += c
        }
    }
    return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

describe('shipped wrangler.jsonc', () => {
    it("lists today's three models with their context windows", async () => {
        const vars = parseJsonc(readFileSync('wrangler.jsonc', 'utf8')).vars
        const env = vars as unknown as Env
        const res = listModels(env, loadConfig(env))
        const data = ((await res.json()) as any).data
        expect(data.map((m: any) => m.id)).toEqual([
            '@cf/zai-org/glm-5.3',
            '@cf/moonshotai/kimi-k2.6',
            '@cf/deepseek-ai/deepseek-v4-pro-0813'
        ])
        expect(data.map((m: any) => m.max_input_tokens)).toEqual([1048576, 262144, 1048576])
        expect(data.map((m: any) => m.capabilities.vision.supported)).toEqual([false, false, false])
        expect(data.map((m: any) => m.capabilities.multi_tool_use.supported)).toEqual([false, false, false])
        expect(data.map((m: any) => m.capabilities.thinking.supported)).toEqual([true, true, true])
    })
})
