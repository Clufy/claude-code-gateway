import { PSL_ICANN } from './psl-data'

let rules: Set<string> | undefined

// PSL algorithm: exception rules win, otherwise the longest match. No default '*' rule: null when nothing matches.
export function publicSuffixOf(host: string): string | null {
    rules ??= new Set(PSL_ICANN.split('\n'))
    const labels = host.split('.')
    for (let i = 0; i < labels.length; i++) {
        const cand = labels.slice(i).join('.')
        if (rules.has('!' + cand)) return labels.slice(i + 1).join('.')
        if (rules.has(cand)) return cand
        if (i + 1 < labels.length && rules.has('*.' + labels.slice(i + 1).join('.'))) return cand
    }
    return null
}

export function isRegistrable(host: string): boolean {
    const s = publicSuffixOf(host)
    return s !== null && host !== s
}
