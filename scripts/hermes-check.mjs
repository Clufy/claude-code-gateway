// Self-check for src/hermes.ts: tag-scanned tool calls, JSON repair, bare-JSON fallback.
// ponytail: assert-based, no framework. Run via npm run check:hermes.
import assert from 'node:assert'
import { HermesFilter, repairJson } from '../.tmp-check/hermes.js'

const OPEN = '<' + 'tool_call' + '>'
const CLOSE = '<' + '/tool_call' + '>'

function collect(filter, chunks, known) {
    let text = ''
    const calls = []
    for (const c of chunks) {
        const r = filter.push(c)
        text += r.text
        calls.push(...r.calls)
    }
    const r = filter.flush()
    return { text: text + r.text, calls: calls.concat(r.calls) }
}

// 1. Whole tag in one token
{
    const r = collect(new HermesFilter(new Set(['get_weather'])), [
        `Hello! ${OPEN}\n{"name": "get_weather", "arguments": {"city": "Paris"}}\n${CLOSE}`
    ])
    assert.strictEqual(r.text, 'Hello! ')
    assert.strictEqual(r.calls.length, 1)
    assert.strictEqual(r.calls[0].name, 'get_weather')
    assert.deepStrictEqual(r.calls[0].input, { city: 'Paris' })
}

// 2. Tag split across token boundaries (incl. partial tag held at buffer tail)
{
    const raw = `${OPEN}{"name": "get_weather", "arguments": {"city": "Paris"}}${CLOSE}`
    const chunks = []
    for (let i = 0; i < raw.length; i += 7) chunks.push(raw.slice(i, i + 7))
    const r = collect(new HermesFilter(new Set(['get_weather'])), chunks)
    assert.strictEqual(r.text, '')
    assert.strictEqual(r.calls.length, 1)
    assert.strictEqual(r.calls[0].name, 'get_weather')
    assert.deepStrictEqual(r.calls[0].input, { city: 'Paris' })
}

// 3. Prose with newlines between calls; multiple calls
{
    const r = collect(new HermesFilter(new Set(['a', 'b'])), [
        `Thinking... ${OPEN}{"name": "a", "arguments": {}}${CLOSE}\n\nAlso: ${OPEN}{"name": "b", "arguments": {"x": 1}}${CLOSE} done.`
    ])
    assert.strictEqual(r.text, 'Thinking... \n\nAlso:  done.')
    assert.strictEqual(r.calls.length, 2)
    assert.strictEqual(r.calls[0].name, 'a')
    assert.strictEqual(r.calls[1].name, 'b')
}

// 4. Broken JSON repaired: trailing comma + unbalanced braces
{
    const r = collect(new HermesFilter(new Set(['f'])), [`${OPEN}{"name": "f", "arguments": {"a": "b",}}${CLOSE}`])
    assert.strictEqual(r.calls.length, 1)
    assert.deepStrictEqual(r.calls[0].input, { a: 'b' })
}
{
    const r = collect(new HermesFilter(new Set(['f'])), [`${OPEN}{"name": "f", "arguments": {"a": "b${CLOSE}`])
    assert.strictEqual(r.calls.length, 1)
    assert.strictEqual(r.calls[0].name, 'f')
    assert.deepStrictEqual(r.calls[0].input, { a: 'b' })
}

// 5. Name extractable but args hopeless → fires with {}
{
    const r = collect(new HermesFilter(new Set(['f'])), [`${OPEN}{"name": "f", "arguments": {"a": ${CLOSE}`])
    assert.strictEqual(r.calls.length, 1)
    assert.strictEqual(r.calls[0].name, 'f')
    assert.deepStrictEqual(r.calls[0].input, {})
}

// 6. Bare-JSON fallback: whole text is a call for a known tool
{
    const r = collect(new HermesFilter(new Set(['get_weather'])), [
        `{"name": "get_weather", "arguments": {"city": "Paris"}}`
    ])
    assert.strictEqual(r.text, '')
    assert.strictEqual(r.calls.length, 1)
    assert.strictEqual(r.calls[0].name, 'get_weather')
}
// 6b. Bare JSON for an UNKNOWN tool stays text
{
    const r = collect(new HermesFilter(new Set(['other_tool'])), [
        `{"name": "get_weather", "arguments": {"city": "Paris"}}`
    ])
    assert.strictEqual(r.calls.length, 0)
    assert.ok(r.text.includes('get_weather'))
}
// 6c. Prose + bare JSON (no tags): known tool converts, prose is dropped as part of the call
{
    const r = collect(new HermesFilter(new Set(['get_weather'])), [
        `I'll check. {"name": "get_weather", "arguments": {"city": "Paris"}}`
    ])
    // prose before '{' means bare-hold does not trigger; text streams, call not reconstructed
    assert.strictEqual(r.calls.length, 0)
    assert.ok(r.text.includes("I'll check."))
}

// 7. Plain text passes through untouched
{
    const r = collect(new HermesFilter(new Set(['get_weather'])), ['The weather in Paris is 21C. ', 'No tools here. '])
    assert.strictEqual(r.text, 'The weather in Paris is 21C. No tools here. ')
    assert.strictEqual(r.calls.length, 0)
}

// 8. repairJson direct cases
assert.deepStrictEqual(repairJson('```json\n{"a": 1}\n```'), { a: 1 })
assert.deepStrictEqual(repairJson('Sure: {"a": [1, 2,]}'), { a: [1, 2] })
assert.deepStrictEqual(repairJson('{"a": {"b": "c"'), { a: { b: 'c' } })
assert.deepStrictEqual(repairJson('{"a": "unterminated'), { a: 'unterminated' })
assert.deepStrictEqual(repairJson('{"name": "f", "arguments": {"x": "y"}'), {
    name: 'f',
    arguments: { x: 'y' }
})
assert.strictEqual(repairJson('no json at all'), null)
assert.strictEqual(repairJson(''), null)

// 9. Partial tag at very end of stream (no close ever arrives) → emitted as text at flush
{
    const r = collect(new HermesFilter(new Set(['f'])), ['answer ', OPEN.slice(0, 5)])
    assert.ok(r.text.startsWith('answer '))
    assert.strictEqual(r.calls.length, 0)
}

console.log('hermes check ok')
