import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export interface Fixture {
    system: unknown
    tools: { name: string; description?: string; input_schema: unknown }[]
}

export const LOCAL_FIXTURE_PATH = 'test/fixtures/local/claude-code-request.json'
export const SYNTHETIC_FIXTURE_PATH = 'test/fixtures/claude-code-request.synthetic.json'

const repoRoot = resolve(import.meta.dirname, '../..')

/** Explicit path (relative to the current directory), else the local (real) capture if present, else the synthetic one. */
export function loadFixture(path?: string): Fixture {
    const local = resolve(repoRoot, LOCAL_FIXTURE_PATH)
    const file = path
        ? resolve(process.cwd(), path)
        : existsSync(local)
          ? local
          : resolve(repoRoot, SYNTHETIC_FIXTURE_PATH)
    const f = JSON.parse(readFileSync(file, 'utf8')) as Fixture
    if (!Array.isArray(f.tools)) throw new Error(`fixture ${file} has no tools array`)
    return f
}

const SECRET = /sk-[A-Za-z0-9_-]{10,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}/g

/** Keeps system + tools, scrubs paths, user name and secrets. Works on parsed strings, never on JSON text. */
export function redactFixture(raw: any, opts: { home: string; user: string }): Fixture {
    const homes = [opts.home, opts.home.replace(/\\/g, '/')]
    const scrub = (s: string): string => {
        for (const h of homes) if (h) s = s.replaceAll(h, '/home/user')
        if (opts.user) s = s.replaceAll(opts.user, 'user')
        return s.replace(SECRET, '[redacted]')
    }
    const walk = (v: unknown): unknown => {
        if (typeof v === 'string') return scrub(v)
        if (Array.isArray(v)) return v.map(walk)
        if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
        return v
    }
    return walk({ system: raw.system, tools: raw.tools }) as Fixture
}
