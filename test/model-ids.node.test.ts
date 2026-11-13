import { readdirSync, readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

// Lines allowed to contain a Workers AI model id: user-facing example text only.
const ALLOWED: { file: string; includes: string }[] = [
    { file: 'src/mcp/redteam-tool.ts', includes: 'self:@cf/meta/llama-3.1-8b-instruct' }
]

function walk(dir: string): string[] {
    const files: string[] = []
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = `${dir}/${e.name}`
        if (e.isDirectory()) files.push(...walk(p))
        else if (p.endsWith('.ts')) files.push(p)
    }
    return files
}

describe('no model ids in src', () => {
    it('has no @cf/ id outside comments and the allowlist', () => {
        const offenders: string[] = []
        for (const file of walk('src')) {
            readFileSync(file, 'utf8')
                .split('\n')
                .forEach((line, i) => {
                    if (!line.includes('@cf/')) return
                    const t = line.trim()
                    if (t.startsWith('//') || t.startsWith('*')) return
                    if (ALLOWED.some((a) => file === a.file && line.includes(a.includes))) return
                    offenders.push(`${file}:${i + 1}: ${t}`)
                })
        }
        expect(offenders).toEqual([])
    })
})
