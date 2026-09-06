import { anthropicError, jsonResponse } from './errors';
const DEFAULT_MODELS = [
    '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    '@cf/meta/llama-3.1-8b-instruct-fast',
    '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b'
];
// Real context windows from developers.cloudflare.com/workers-ai/models;
// conservative default so Claude Code compacts before an unknown model overflows.
const CONTEXT_TOKENS = {
    '@cf/meta/llama-3.3-70b-instruct-fp8-fast': 24000,
    '@cf/meta/llama-3.1-8b-instruct-fast': 128000,
    '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b': 80000,
    '@cf/zai-org/glm-5.3-flash': 1048576
};
const DEFAULT_CONTEXT_TOKENS = 24000;
function commaSet(value) {
    return new Set(value
        ?.split(',')
        .map((s) => s.trim())
        .filter(Boolean) ?? []);
}
function toModel(id, env) {
    const visionModels = commaSet(env.VISION_MODELS);
    const multiToolModels = commaSet(env.MULTI_TOOL_MODELS);
    return {
        id,
        type: 'model',
        display_name: id,
        created_at: 0,
        max_input_tokens: CONTEXT_TOKENS[id] ?? DEFAULT_CONTEXT_TOKENS,
        max_tokens: null,
        capabilities: {
            tools: { name: 'tool_use', supported: true },
            vision: { name: 'vision', supported: visionModels.has(id) },
            multi_tool_use: { name: 'multi_tool_use', supported: multiToolModels.has(id) }
        }
    };
}
function configuredModelIds(env) {
    const models = env.MODELS;
    const ids = models
        ?.split(',')
        .map((s) => s.trim())
        .filter(Boolean) ?? [];
    return ids.length > 0 ? ids : DEFAULT_MODELS;
}
export function listModels(env) {
    const ids = configuredModelIds(env);
    return jsonResponse({
        data: ids.map((id) => toModel(id, env)),
        has_more: false,
        first_id: null,
        last_id: null
    }, 200);
}
export function getModel(id, env, requestId) {
    const ids = configuredModelIds(env);
    if (!ids.includes(id)) {
        return anthropicError(404, 'not_found_error', `Model '${id}' not found.`, requestId);
    }
    return jsonResponse({ ...toModel(id, env), type: 'model' }, 200, requestId);
}
