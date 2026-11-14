import { describe, expect, it } from 'vitest'
import { HermesFilter, repairJson } from '../../src/translate/hermes'

const OPEN = '<' + 'tool_call' + '>'
const CLOSE = '<' + '/tool_call' + '>'

function collect(filter: HermesFilter, chunks: string[]) {
    let text = ''
    const calls: any[] = []
    for (const c of chunks) {
        const r = filter.push(c)
        text += r.text
        calls.push(...r.calls)
    }
    const r = filter.flush()
    return { text: text + r.text, calls: calls.concat(r.calls) }
}

describe('HermesFilter', () => {
    it('1. whole tag in one token', () => {
        const r = collect(new HermesFilter(new Set(['get_weather'])), [
            `Hello! ${OPEN}\n{"name": "get_weather", "arguments": {"city": "Paris"}}\n${CLOSE}`
        ])
        expect(r.text).toBe('Hello! ')
        expect(r.calls.length).toBe(1)
        expect(r.calls[0].name).toBe('get_weather')
        expect(r.calls[0].input).toEqual({ city: 'Paris' })
    })

    it('2. tag split across token boundaries (incl. partial tag held at buffer tail)', () => {
        const raw = `${OPEN}{"name": "get_weather", "arguments": {"city": "Paris"}}${CLOSE}`
        const chunks: string[] = []
        for (let i = 0; i < raw.length; i += 7) chunks.push(raw.slice(i, i + 7))
        const r = collect(new HermesFilter(new Set(['get_weather'])), chunks)
        expect(r.text).toBe('')
        expect(r.calls.length).toBe(1)
        expect(r.calls[0].name).toBe('get_weather')
        expect(r.calls[0].input).toEqual({ city: 'Paris' })
    })

    it('3. prose with newlines between calls; multiple calls', () => {
        const r = collect(new HermesFilter(new Set(['a', 'b'])), [
            `Thinking... ${OPEN}{"name": "a", "arguments": {}}${CLOSE}\n\nAlso: ${OPEN}{"name": "b", "arguments": {"x": 1}}${CLOSE} done.`
        ])
        expect(r.text).toBe('Thinking... \n\nAlso:  done.')
        expect(r.calls.length).toBe(2)
        expect(r.calls[0].name).toBe('a')
        expect(r.calls[1].name).toBe('b')
    })

    it('4. broken JSON repaired: trailing comma + unbalanced braces', () => {
        {
            const r = collect(new HermesFilter(new Set(['f'])), [
                `${OPEN}{"name": "f", "arguments": {"a": "b",}}${CLOSE}`
            ])
            expect(r.calls.length).toBe(1)
            expect(r.calls[0].input).toEqual({ a: 'b' })
        }
        {
            const r = collect(new HermesFilter(new Set(['f'])), [`${OPEN}{"name": "f", "arguments": {"a": "b${CLOSE}`])
            expect(r.calls.length).toBe(1)
            expect(r.calls[0].name).toBe('f')
            expect(r.calls[0].input).toEqual({ a: 'b' })
        }
    })

    it('5. name extractable but args hopeless fires with {}', () => {
        const r = collect(new HermesFilter(new Set(['f'])), [`${OPEN}{"name": "f", "arguments": {"a": ${CLOSE}`])
        expect(r.calls.length).toBe(1)
        expect(r.calls[0].name).toBe('f')
        expect(r.calls[0].input).toEqual({})
    })

    it('6. bare-JSON fallback: whole text is a call for a known tool', () => {
        const r = collect(new HermesFilter(new Set(['get_weather'])), [
            `{"name": "get_weather", "arguments": {"city": "Paris"}}`
        ])
        expect(r.text).toBe('')
        expect(r.calls.length).toBe(1)
        expect(r.calls[0].name).toBe('get_weather')
    })

    it('6b. bare JSON for an UNKNOWN tool stays text', () => {
        const r = collect(new HermesFilter(new Set(['other_tool'])), [
            `{"name": "get_weather", "arguments": {"city": "Paris"}}`
        ])
        expect(r.calls.length).toBe(0)
        expect(r.text).toContain('get_weather')
    })

    it('6c. prose + bare JSON (no tags): text streams, call not reconstructed', () => {
        const r = collect(new HermesFilter(new Set(['get_weather'])), [
            `I'll check. {"name": "get_weather", "arguments": {"city": "Paris"}}`
        ])
        // prose before '{' means bare-hold does not trigger; text streams, call not reconstructed
        expect(r.calls.length).toBe(0)
        expect(r.text).toContain("I'll check.")
    })

    it('7. plain text passes through untouched', () => {
        const r = collect(new HermesFilter(new Set(['get_weather'])), [
            'The weather in Paris is 21C. ',
            'No tools here. '
        ])
        expect(r.text).toBe('The weather in Paris is 21C. No tools here. ')
        expect(r.calls.length).toBe(0)
    })

    it('9. partial tag at very end of stream is emitted as text at flush', () => {
        const r = collect(new HermesFilter(new Set(['f'])), ['answer ', OPEN.slice(0, 5)])
        expect(r.text.startsWith('answer ')).toBe(true)
        expect(r.calls.length).toBe(0)
    })

    it('10. push() drains complete text AND calls; flush() returns only the tail', () => {
        // The non-streaming path must merge BOTH returns; flush() alone sees an empty buffer.
        const f = new HermesFilter(new Set(['get_weather']))
        const pushed = f.push(`Answer. ${OPEN}{"name": "get_weather", "arguments": {"city": "Paris"}}${CLOSE}`)
        const flushed = f.flush()
        expect(pushed.text).toBe('Answer. ')
        expect(pushed.calls.length).toBe(1)
        expect(pushed.calls[0].input).toEqual({ city: 'Paris' })
        expect(flushed.text).toBe('')
        expect(flushed.calls.length).toBe(0)
    })

    it('droppedCall: set when a tool_call payload cannot be rebuilt, unset for good calls (P4-R30)', () => {
        const unclosed = new HermesFilter(new Set(['f']))
        expect(collect(unclosed, [`Sure. ${OPEN}{"name":`])).toEqual({ text: 'Sure. ', calls: [] })
        expect(unclosed.droppedCall).toBe(true)

        const closedJunk = new HermesFilter(new Set(['f']))
        collect(closedJunk, [`${OPEN}not a call${CLOSE} ok`])
        expect(closedJunk.droppedCall).toBe(true)

        const good = new HermesFilter(new Set(['f']))
        expect(collect(good, [`${OPEN}{"name": "f", "arguments": {}}${CLOSE}`]).calls).toHaveLength(1)
        expect(good.droppedCall).toBe(false)
    })
})

describe('repairJson', () => {
    it('8. direct cases', () => {
        expect(repairJson('```json\n{"a": 1}\n```')).toEqual({ a: 1 })
        expect(repairJson('Sure: {"a": [1, 2,]}')).toEqual({ a: [1, 2] })
        expect(repairJson('{"a": {"b": "c"')).toEqual({ a: { b: 'c' } })
        expect(repairJson('{"a": "unterminated')).toEqual({ a: 'unterminated' })
        expect(repairJson('{"name": "f", "arguments": {"x": "y"}')).toEqual({
            name: 'f',
            arguments: { x: 'y' }
        })
        expect(repairJson('no json at all')).toBeNull()
        expect(repairJson('')).toBeNull()
    })
})
