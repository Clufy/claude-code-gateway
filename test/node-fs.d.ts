// Minimal typing for the node:fs calls in *.node.test.ts; the workers test config deliberately omits @types/node.
declare module 'node:fs' {
    export function readdirSync(path: string, opts: { withFileTypes: true }): { name: string; isDirectory(): boolean }[]
    export function readFileSync(path: string, encoding: 'utf8'): string
}
