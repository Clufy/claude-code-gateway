const encoder = new TextEncoder();
const decoder = new TextDecoder();

function jsonError(status, type, message) {
  return new Response(
    JSON.stringify({ type: "error", error: { type, message } }),
    { status, headers: { "content-type": "application/json" } }
  );
}

function estimateTokens(text) {
  return Math.max(0, Math.ceil((text || "").length / 4));
}

async function constantTimeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

function sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function systemText(system) {
  if (system == null) return "";
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system
      .filter((p) => p && p.type === "text")
      .map((p) => p.text ?? "")
      .join("\n");
  }
  return String(system);
}

function toolResultToText(content) {
  return typeof content === "string" ? content : JSON.stringify(content);
}

// Claude tools -> OpenAI/Workers AI "function" tool shape.
function cleanSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(cleanSchema);
  const out = {};
  for (const key of Object.keys(schema)) {
    if (key === "$schema" || key === "additionalProperties" || key === "title" || key === "examples") {
      continue;
    }
    out[key] = cleanSchema(schema[key]);
  }
  return out;
}

function convertTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools
    .filter((t) => t && t.name)
    .map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: cleanSchema(t.input_schema) || { type: "object", properties: {} },
      },
    }));
}

// Claude messages -> OpenAI/Workers AI chat messages, preserving tool use.
function convertMessages(messages) {
  const out = [];
  for (const message of messages) {
    const role = message.role === "assistant" ? "assistant" : "user";

    if (typeof message.content === "string") {
      out.push({ role, content: message.content });
      continue;
    }

    if (!Array.isArray(message.content)) {
      out.push({ role, content: String(message.content ?? "") });
      continue;
    }

    const textParts = [];
    const toolCalls = [];
    const toolResults = [];

    for (const part of message.content) {
      if (part.type === "text") {
        textParts.push(part.text ?? "");
      } else if (part.type === "tool_use") {
        toolCalls.push({
          id: part.id,
          type: "function",
          function: {
            name: part.name,
            arguments: JSON.stringify(part.input ?? {}),
          },
        });
      } else if (part.type === "tool_result") {
        toolResults.push({
          tool_call_id: part.tool_use_id,
          content: toolResultToText(part.content),
        });
      }
    }

    if (textParts.length > 0 || toolCalls.length > 0) {
      out.push({
        role,
        content: textParts.length > 0 ? textParts.join("\n") : "",
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
    }

    for (const result of toolResults) {
      out.push({ role: "tool", tool_call_id: result.tool_call_id, content: result.content });
    }
  }
  return out;
}

// A single SSE chunk may carry text in one of several shapes:
//   - legacy Workers AI:      { response: "token" }
//   - OpenAI chat.completions: { choices: [{ delta: { content: "token" } }] }
//   - OpenAI reasoning:        { choices: [{ delta: { reasoning_content } }] }
function extractText(payload) {
  if (payload == null) return "";
  const parts = [];
  const push = (v) => {
    if (typeof v === "string" && v.length > 0) parts.push(v);
  };

  push(payload.response);
  push(payload.text);
  push(payload.reasoning_content);
  push(payload.reasoning);

  const choices = payload.choices;
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      push(choice?.delta?.content);
      push(choice?.delta?.reasoning_content);
      push(choice?.delta?.reasoning);
      push(choice?.message?.content);
      push(choice?.message?.reasoning_content);
    }
  }

  return parts.join("");
}

// Accumulate tool-call deltas (OpenAI streaming shape), plus legacy/one-shot
// tool_calls arrays and OpenAI non-streaming message.tool_calls.
function collectToolCalls(payload, map) {
  if (payload == null) return;

  const choices = payload.choices;
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      const deltaCalls = choice?.delta?.tool_calls;
      if (Array.isArray(deltaCalls)) {
        for (const call of deltaCalls) {
          const idx = call.index ?? 0;
          const cur = map.get(idx) ?? { id: undefined, name: undefined, arguments: "" };
          if (call.id) cur.id = call.id;
          if (call.function?.name) cur.name = call.function.name;
          if (call.function?.arguments) cur.arguments += call.function.arguments;
          map.set(idx, cur);
        }
      }

      const msgCalls = choice?.message?.tool_calls;
      if (Array.isArray(msgCalls)) {
        for (let i = 0; i < msgCalls.length; i++) {
          const call = msgCalls[i];
          const idx = call.index ?? i;
          const cur = map.get(idx) ?? { id: undefined, name: undefined, arguments: "" };
          if (call.id) cur.id = call.id;
          if (call.function?.name) cur.name = call.function.name;
          if (call.function?.arguments) cur.arguments = call.function.arguments;
          map.set(idx, cur);
        }
      }
    }
  }

  // Legacy Workers AI shape: tool_calls = [{ name, arguments }]
  const legacy = payload.tool_calls;
  if (Array.isArray(legacy) && legacy.length > 0 && !payload.choices) {
    for (let i = 0; i < legacy.length; i++) {
      const call = legacy[i];
      const cur = map.get(i) ?? { id: undefined, name: undefined, arguments: "" };
      if (call.name) cur.name = call.name;
      if (call.arguments != null) {
        cur.arguments = typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments);
      }
      map.set(i, cur);
    }
  }
}

function finishReason(payload) {
  return payload?.choices?.[0]?.finish_reason ?? null;
}

function parseArguments(str) {
  if (!str) return {};
  try {
    return JSON.parse(str);
  } catch {
    return {};
  }
}

function toolUseId(existing) {
  return existing || `toolu_${crypto.randomUUID().replace(/-/g, "")}`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("ok", { status: 200 });
    }

    if (request.method !== "POST" || url.pathname !== "/v1/messages") {
      return jsonError(404, "not_found_error", "Not found");
    }

    if (env.PROXY_KEY) {
      const provided = request.headers.get("x-api-key");
      if (!provided || !(await constantTimeEqual(provided, env.PROXY_KEY))) {
        return jsonError(401, "authentication_error", "invalid x-api-key");
      }
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonError(400, "invalid_request_error", "invalid JSON body");
    }

    const model = body?.model;
    const messages = body?.messages;
    if (typeof model !== "string" || model.length === 0) {
      return jsonError(400, "invalid_request_error", "missing or invalid 'model'");
    }
    if (!Array.isArray(messages) || messages.length === 0) {
      return jsonError(400, "invalid_request_error", "missing or invalid 'messages'");
    }

    const system = systemText(body.system);
    const aiMessages = convertMessages(messages);
    if (system) {
      aiMessages.unshift({ role: "system", content: system });
    }

    const stream = body.stream === true;
    // Always stream internally; it is the only reliable Workers AI path and it
    // lets us support both legacy and OpenAI-format chunks uniformly.
    const options = { messages: aiMessages, stream: true };

    const tools = convertTools(body.tools);
    if (tools) options.tools = tools;
    if (body.max_tokens != null) options.max_tokens = body.max_tokens;
    if (body.temperature != null) options.temperature = body.temperature;

    let rawStream;
    try {
      rawStream = await env.AI.run(model, options, { returnRawResponse: true });
    } catch (e) {
      const message = e && e.message ? e.message : String(e);
      return jsonError(502, "api_error", `Workers AI call failed: ${message}`);
    }

    let source;
    if (rawStream instanceof ReadableStream) {
      source = rawStream;
    } else if (rawStream instanceof Response && rawStream.body) {
      source = rawStream.body;
    } else {
      return jsonError(502, "api_error", "Workers AI did not return a stream");
    }

    const id = `msg_${crypto.randomUUID()}`;

    // ---- Non-streaming: accumulate the internal stream into a single message.
    if (!stream) {
      let text = "";
      const toolCalls = new Map();
      let stopReason = "end_turn";

      try {
        const reader = source.getReader();
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += typeof value === "string" ? value : decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("data:")) continue;
            const data = trimmed.slice(5).trim();
            if (data === "[DONE]") continue;
            let payload;
            try {
              payload = JSON.parse(data);
            } catch {
              continue;
            }
            text += extractText(payload);
            collectToolCalls(payload, toolCalls);
            if (finishReason(payload) === "tool_calls") stopReason = "tool_use";
          }
        }
        if (buffer.trim()) {
          const trimmed = buffer.trim();
          if (trimmed.startsWith("data:")) {
            const data = trimmed.slice(5).trim();
            if (data !== "[DONE]") {
              try {
                const payload = JSON.parse(data);
                text += extractText(payload);
                collectToolCalls(payload, toolCalls);
                if (finishReason(payload) === "tool_calls") stopReason = "tool_use";
              } catch {}
            }
          }
        }
      } catch (e) {
        const message = e && e.message ? e.message : String(e);
        return jsonError(502, "api_error", `Workers AI stream failed: ${message}`);
      }

      const content = [];
      if (text) content.push({ type: "text", text });

      const calls = [...toolCalls.entries()].sort(([a], [b]) => a - b);
      for (const [, call] of calls) {
        if (!call.name) continue;
        content.push({
          type: "tool_use",
          id: toolUseId(call.id),
          name: call.name,
          input: parseArguments(call.arguments),
        });
      }
      if (calls.length > 0) stopReason = "tool_use";

      return new Response(
        JSON.stringify({
          id,
          type: "message",
          role: "assistant",
          model,
          content,
          stop_reason: stopReason,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: estimateTokens(text) },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }

    // ---- Streaming: translate the internal stream into Anthropic SSE events.
    const state = {
      text: "",
      textBlockOpen: false,
      blockIndex: 0,
      toolCalls: new Map(),
      toolBlocksEmitted: 0,
      stopReason: "end_turn",
    };

    function openTextBlock(controller) {
      if (state.textBlockOpen) return;
      controller.enqueue(
        encoder.encode(
          sse("content_block_start", {
            type: "content_block_start",
            index: state.blockIndex,
            content_block: { type: "text", text: "" },
          })
        )
      );
      state.textBlockOpen = true;
    }

    function closeTextBlock(controller) {
      if (!state.textBlockOpen) return;
      controller.enqueue(
        encoder.encode(
          sse("content_block_stop", { type: "content_block_stop", index: state.blockIndex })
        )
      );
      state.blockIndex++;
      state.textBlockOpen = false;
    }

    function emitText(controller, token) {
      state.text += token;
      openTextBlock(controller);
      controller.enqueue(
        encoder.encode(
          sse("content_block_delta", {
            type: "content_block_delta",
            index: state.blockIndex,
            delta: { type: "text_delta", text: token },
          })
        )
      );
    }

    function emitToolCalls(controller) {
      closeTextBlock(controller);
      const calls = [...state.toolCalls.entries()].sort(([a], [b]) => a - b);
      for (let i = state.toolBlocksEmitted; i < calls.length; i++) {
        const [idx, call] = calls[i];
        if (!call.name) continue;
        const toolId = toolUseId(call.id);
        const input = parseArguments(call.arguments);
        const blockIndex = state.blockIndex + (i - state.toolBlocksEmitted);

        controller.enqueue(
          encoder.encode(
            sse("content_block_start", {
              type: "content_block_start",
              index: blockIndex,
              content_block: { type: "tool_use", id: toolId, name: call.name, input: {} },
            })
          )
        );
        controller.enqueue(
          encoder.encode(
            sse("content_block_delta", {
              type: "content_block_delta",
              index: blockIndex,
              delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
            })
          )
        );
        controller.enqueue(
          encoder.encode(
            sse("content_block_stop", { type: "content_block_stop", index: blockIndex })
          )
        );
      }
      state.blockIndex += calls.length - state.toolBlocksEmitted;
      state.toolBlocksEmitted = calls.length;
      state.stopReason = "tool_use";
    }

    function processLine(controller, line) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data:")) return;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") return;
      let payload;
      try {
        payload = JSON.parse(data);
      } catch {
        return;
      }

      const token = extractText(payload);
      if (token) emitText(controller, token);

      collectToolCalls(payload, state.toolCalls);

      if (finishReason(payload) === "tool_calls") {
        emitToolCalls(controller);
      }
    }

    const transform = new TransformStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            sse("message_start", {
              type: "message_start",
              message: {
                id,
                type: "message",
                role: "assistant",
                model,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 0, output_tokens: 0 },
              },
            })
          )
        );
      },
      transform(chunk, controller) {
        const raw = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
        let buffer = state._buffer || "";
        buffer += raw;
        const lines = buffer.split("\n");
        state._buffer = lines.pop() ?? "";
        for (const line of lines) processLine(controller, line);
      },
      flush(controller) {
        if (state._buffer) processLine(controller, state._buffer);
        state._buffer = "";

        // If tool calls arrived without a finish_reason (some models), emit now.
        if (state.toolCalls.size > state.toolBlocksEmitted) {
          emitToolCalls(controller);
        } else {
          closeTextBlock(controller);
        }

        controller.enqueue(
          encoder.encode(
            sse("message_delta", {
              type: "message_delta",
              delta: { stop_reason: state.stopReason, stop_sequence: null },
              usage: { output_tokens: estimateTokens(state.text) },
            })
          )
        );
        controller.enqueue(
          encoder.encode(sse("message_stop", { type: "message_stop" }))
        );
      },
    });

    return new Response(source.pipeThrough(transform), {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      },
    });
  },
};
