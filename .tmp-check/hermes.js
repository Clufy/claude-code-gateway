// Reconstructs tool calls that open models emit as plain text in the Hermes format
// (open tag, JSON payload, close tag) instead of native tool_calls deltas.
// ponytail: tag literals are assembled below so the raw tag never appears in this
// file (some tool-call parsers misinterpret it). No backslash characters appear in
// this file for the same reason.
const OPEN_TAG = '<' + 'tool_call' + '>';
const CLOSE_TAG = '<' + '/tool_call' + '>';
const BSLASH = String.fromCharCode(92);
const TAB = String.fromCharCode(9);
const NL = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const FENCE = String.fromCharCode(96, 96, 96);
// ponytail: exact-format match (Hermes/Qwen). Extend tags here if models drift to variants.
export class HermesFilter {
    buffer = '';
    knownTools;
    constructor(knownTools = new Set()) {
        this.knownTools = knownTools;
    }
    // Push a streamed text token. Returns visible text to emit now plus any completed calls.
    push(token) {
        this.buffer += token;
        return this.drain(false);
    }
    // Call at end of stream.
    flush() {
        return this.drain(true);
    }
    drain(final) {
        const calls = [];
        let text = '';
        for (;;) {
            const open = this.buffer.indexOf(OPEN_TAG);
            if (open === -1)
                break;
            if (open > 0) {
                text += this.buffer.slice(0, open);
                this.buffer = this.buffer.slice(open);
            }
            const close = this.buffer.indexOf(CLOSE_TAG, OPEN_TAG.length);
            if (close === -1) {
                if (!final)
                    break;
                const call = toCall(this.buffer.slice(OPEN_TAG.length));
                this.buffer = '';
                if (call)
                    calls.push(call);
                break;
            }
            const call = toCall(this.buffer.slice(OPEN_TAG.length, close));
            this.buffer = this.buffer.slice(close + CLOSE_TAG.length);
            if (call)
                calls.push(call);
        }
        if (this.buffer.length > 0) {
            if (!final && (this.buffer.startsWith(OPEN_TAG) || looksLikeBareCall(this.buffer))) {
                // hold: mid-call (open tag seen, close pending) or potential bare-JSON call
            }
            else if (final && calls.length === 0 && !this.buffer.includes('<')) {
                const call = this.bareCall(this.buffer);
                if (call)
                    calls.push(call);
                else
                    text += this.buffer;
                this.buffer = '';
            }
            else {
                const keep = final ? 0 : partialTagSuffix(this.buffer, OPEN_TAG);
                if (keep < this.buffer.length) {
                    text += this.buffer.slice(0, this.buffer.length - keep);
                    this.buffer = keep > 0 ? this.buffer.slice(this.buffer.length - keep) : '';
                }
            }
        }
        return { text, calls };
    }
    // Bare-JSON fallback: the whole visible text is a JSON object naming a known tool.
    // ponytail: gated on knownTools; a prose JSON example naming a tool is a false positive.
    bareCall(buffer) {
        if (this.knownTools.size === 0)
            return null;
        const json = repairJson(buffer);
        const name = jsonCallName(json);
        if (!name || !this.knownTools.has(name))
            return null;
        return { name, input: normalizeArgs(json.arguments ?? json.parameters ?? json.function?.arguments) };
    }
}
// Hold back a tail that could be the start of an open tag arriving split across tokens.
function partialTagSuffix(buffer, tag) {
    const max = Math.min(tag.length - 1, buffer.length);
    for (let len = max; len > 0; len--) {
        if (buffer.endsWith(tag.slice(0, len)))
            return len;
    }
    return 0;
}
function looksLikeBareCall(buffer) {
    const trimmed = buffer.trimStart();
    return trimmed.startsWith('{') && trimmed.includes('"name"');
}
function toCall(payload) {
    const json = repairJson(payload);
    if (json) {
        const name = jsonCallName(json);
        if (name) {
            return { name, input: normalizeArgs(json.arguments ?? json.parameters ?? json.function?.arguments) };
        }
    }
    // Unrepairable args but a visible name: still fire with {} so the tool errors
    // and the model retries with corrected format instead of stalling.
    const name = quotedName(payload);
    return name ? { name, input: {} } : null;
}
// Extract the value of a "name" key from text JSON.parse cannot recover,
// e.g. arguments truncated mid-string. Index-based: no regex escaping needed.
function quotedName(payload) {
    const key = payload.indexOf('"name"');
    if (key === -1)
        return null;
    const colon = payload.indexOf(':', key);
    if (colon === -1)
        return null;
    const open = payload.indexOf('"', colon);
    if (open === -1)
        return null;
    const end = payload.indexOf('"', open + 1);
    if (end === -1)
        return null;
    return payload.slice(open + 1, end) || null;
}
function jsonCallName(json) {
    const name = json?.name ?? json?.function?.name;
    return typeof name === 'string' && name.length > 0 ? name : null;
}
function normalizeArgs(raw) {
    if (raw == null)
        return {};
    if (typeof raw === 'string') {
        try {
            return JSON.parse(raw);
        }
        catch {
            return {};
        }
    }
    return raw;
}
// Repair chain for streamed/partial JSON: markdown fences, leading prose, direct parse,
// trailing prose, then one string-aware pass that drops trailing commas and closes
// unbalanced braces/brackets and unterminated strings.
export function repairJson(payload) {
    let s = stripFences(payload.trim());
    if (!s)
        return null;
    const brace = s.indexOf('{');
    if (brace === -1)
        return null;
    s = s.slice(brace);
    try {
        return JSON.parse(s);
    }
    catch {
        // continue repairs
    }
    const last = s.lastIndexOf('}');
    if (last !== -1 && last < s.length - 1) {
        try {
            return JSON.parse(s.slice(0, last + 1));
        }
        catch {
            // continue repairs
        }
    }
    const repaired = closeAndRepair(s);
    if (repaired) {
        try {
            return JSON.parse(repaired);
        }
        catch {
            // give up
        }
    }
    return null;
}
function stripFences(s) {
    let t = s.trim();
    if (t.startsWith(FENCE)) {
        t = t.slice(FENCE.length);
        if (t.startsWith('json'))
            t = t.slice(4);
        t = t.trim();
    }
    if (t.endsWith(FENCE))
        t = t.slice(0, -FENCE.length).trimEnd();
    return t;
}
// Single string-aware pass: holds commas so a comma directly before a closing
// bracket is dropped (trailing comma), records open brackets so the result can be
// closed, and closes an unterminated string. Mismatched closers are dropped.
function closeAndRepair(s) {
    let out = '';
    let held = '';
    const stack = [];
    let inString = false;
    let escaped = false;
    for (const ch of s) {
        if (inString) {
            out += ch;
            if (escaped)
                escaped = false;
            else if (ch === BSLASH)
                escaped = true;
            else if (ch === '"')
                inString = false;
            continue;
        }
        if (ch === '"') {
            inString = true;
            out += held;
            held = '';
            out += ch;
            continue;
        }
        if (ch === ' ' || ch === TAB || ch === NL || ch === CR) {
            held += ch;
            continue;
        }
        if (ch === ',') {
            held += ch;
            continue;
        }
        if (ch === '}' || ch === ']') {
            const open = stack[stack.length - 1];
            const matches = (ch === '}' && open === '{') || (ch === ']' && open === '[');
            if (matches) {
                stack.pop();
                out += ch;
            }
            // mismatched closer: drop it; a held comma before a closer is trailing: drop it
            held = '';
            continue;
        }
        out += held;
        held = '';
        if (ch === '{' || ch === '[')
            stack.push(ch);
        out += ch;
    }
    if (inString) {
        if (escaped)
            out = out.slice(0, -1); // trailing backslash would escape the quote we add
        out += '"';
    }
    while (stack.length > 0) {
        out += stack.pop() === '{' ? '}' : ']';
    }
    return out.length > 0 ? out : null;
}
