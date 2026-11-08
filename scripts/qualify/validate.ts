import type { CollectedBlock } from './collect.ts'

const typeOk = (type: string, v: unknown): boolean => {
    switch (type) {
        case 'string':
            return typeof v === 'string'
        case 'number':
            return typeof v === 'number'
        case 'integer':
            return Number.isInteger(v)
        case 'boolean':
            return typeof v === 'boolean'
        case 'array':
            return Array.isArray(v)
        case 'object':
            return typeof v === 'object' && v !== null && !Array.isArray(v)
        default:
            return true
    }
}

/** Minimal check: required keys, top-level property types, enum membership. [] = valid. */
export function validateToolInput(schema: unknown, input: unknown): string[] {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return ['input is not an object']
    const s = (schema ?? {}) as {
        required?: string[]
        properties?: Record<string, { type?: string; enum?: unknown[] }>
    }
    const obj = input as Record<string, unknown>
    const errors: string[] = []
    for (const key of s.required ?? []) if (!(key in obj)) errors.push(`missing required property: ${key}`)
    for (const [key, prop] of Object.entries(s.properties ?? {})) {
        if (!(key in obj)) continue
        const v = obj[key]
        if (typeof prop.type === 'string' && !typeOk(prop.type, v)) errors.push(`${key}: expected ${prop.type}`)
        if (Array.isArray(prop.enum) && !prop.enum.includes(v)) errors.push(`${key}: not in enum`)
    }
    return errors
}

export function isValidToolCall(block: CollectedBlock, tools: { name: string; input_schema: unknown }[]): boolean {
    if (block.type !== 'tool_use' || block.inputError) return false
    const tool = tools.find((t) => t.name === block.name)
    return tool !== undefined && validateToolInput(tool.input_schema, block.input).length === 0
}
