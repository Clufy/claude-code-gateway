// Copy of src/guard/config.ts unsafePatternReason; the shared core may not import src/guard (plan D1). Keep in sync.

const MAX_PATTERN = 256
const MAX_BOUND = 100
const MAX_SLACK = 128

interface Frame {
    quant: boolean // contains a quantifier (at any depth)
    alt: boolean // contains a `|` (at any depth)
}

const UNBOUNDED = 'unbounded quantifier (use {n,m}, m ≤ 100)'

interface Last {
    group?: Frame
}

/** D11. Returns why a custom pattern is unsafe, or null when it is safe. */
export function unsafePatternReason(source: string, flags: string): string | null {
    if (source.length < 1 || source.length > MAX_PATTERN) return 'length must be 1-256'
    if (!/^[imsu]*$/.test(flags) || new Set(flags).size !== flags.length) {
        return 'flags must be a subset of imsu, no repeats'
    }

    const stack: Frame[] = [{ quant: false, alt: false }]
    let slack = 1 // product of (max - min + 1) over every quantified atom
    let last: Last | null = null // the atom a following quantifier applies to
    const top = (): Frame => stack[stack.length - 1]!

    const atom = (group?: Frame): void => {
        last = { group }
    }

    let i = 0
    while (i < source.length) {
        const c = source[i]!
        if (c === '\\') {
            const n = source[i + 1]
            if (n === undefined) return 'dangling escape'
            if (/[1-9]/.test(n) || (n === 'k' && source[i + 2] === '<')) return 'backreference'
            if (n === 'b' || n === 'B') {
                last = null
                i += 2
                continue
            }
            i += 2
            if ((n === 'p' || n === 'P' || n === 'u') && source[i] === '{') {
                // without the u flag these braces are a quantifier on a letter
                if (!flags.includes('u')) return 'escape needs the u flag'
                const close = source.indexOf('}', i)
                if (close === -1) return 'unbalanced braces'
                i = close + 1
            }
            atom()
            continue
        }
        if (c === '[') {
            // JS semantics: the class ends at the first unescaped `]` ("[]" is empty, "[^]" is any)
            i++
            if (source[i] === '^') i++
            for (;;) {
                if (i >= source.length) return 'unterminated class'
                if (source[i] === '\\') i += 2
                else if (source[i] === ']') break
                else i++
            }
            i++
            atom()
            continue
        }
        if (c === '(') {
            if (source[i + 1] === '?') {
                const n = source[i + 2]
                if (n === ':') i += 3
                else if (n === '<' && source[i + 3] !== '=' && source[i + 3] !== '!') {
                    const close = source.indexOf('>', i)
                    if (close === -1) return 'unbalanced group'
                    i = close + 1
                } else if (n === '=' || n === '!' || n === '<') return 'lookaround'
                else return 'unsupported group'
            } else i++
            stack.push({ quant: false, alt: false })
            last = null
            continue
        }
        if (c === ')') {
            if (stack.length === 1) return 'unbalanced group'
            const f = stack.pop()!
            i++
            atom(f)
            continue
        }
        if (c === '|') {
            for (const f of stack) f.alt = true
            last = null
            i++
            continue
        }
        if (c === '^' || c === '$') {
            last = null
            i++
            continue
        }
        // a quantifier?
        let min = 0
        let max = 0 // -1: unbounded
        let len = 0
        if (c === '*') [min, max, len] = [0, -1, 1]
        else if (c === '+') [min, max, len] = [1, -1, 1]
        else if (c === '?') [min, max, len] = [0, 1, 1]
        else if (c === '{') {
            const re = /\{(\d+)(?:(,)(\d*))?\}/y
            re.lastIndex = i
            const m = re.exec(source)
            if (m) {
                min = Number(m[1])
                max = m[2] === undefined ? min : m[3] === '' ? -1 : Number(m[3])
                len = m[0].length
                if (max === -1) return UNBOUNDED
                if (min > max) return 'does not compile'
                if (max > MAX_BOUND) return 'repetition bound over 100'
            }
        }
        if (len === 0) {
            i++
            atom()
            continue
        }
        if (max === -1) return UNBOUNDED
        const prev = last as Last | null
        if (prev === null) return 'quantifier without an atom'
        if (prev.group && (prev.group.quant || prev.group.alt)) return 'nested quantifier'
        for (const f of stack) f.quant = true
        slack *= max - min + 1
        if (slack > MAX_SLACK) return 'too much backtracking slack'
        i += len
        if (source[i] === '?') i++ // lazy modifier
        last = null
    }
    if (stack.length !== 1) return 'unbalanced group'
    try {
        new RegExp(source, flags)
    } catch {
        return 'does not compile'
    }
    return null
}
