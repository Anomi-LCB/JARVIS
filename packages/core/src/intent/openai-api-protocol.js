// The shared wire contract keeps synchronous and asynchronous runners equivalent.
// This adapter returns a single JSON text result; it does not execute model tools.
export function resolveOpenAiApi(value = 'chat-completions') {
  if (value === 'responses' || value === 'chat-completions') return value;
  throw new Error(`openai-runner: unsupported API mode ${String(value)}`);
}

export function openAiEndpoint(api) {
  return `https://api.openai.com/v1/${api === 'responses' ? 'responses' : 'chat/completions'}`;
}

export function buildOpenAiPayload({ api, prompt, model, maxTokens, responseFormat = true, reasoningEffort = true }) {
  if (api === 'responses') {
    const payload = {
      model,
      input: [{ role: 'user', content: String(prompt ?? '') }],
      max_output_tokens: maxTokens,
      store: false,
      text: { format: { type: 'json_object' } }
    };
    if (reasoningEffort) payload.reasoning = { effort: 'none' };
    return payload;
  }
  const payload = { model, messages: [{ role: 'user', content: String(prompt ?? '') }], max_completion_tokens: maxTokens };
  if (responseFormat) payload.response_format = { type: 'json_object' };
  if (reasoningEffort) payload.reasoning_effort = 'none';
  return payload;
}

export function openAiApiError(detail, api) {
  const message = String(detail?.message ?? 'unknown');
  const error = new Error(`openai: ${message}`);
  const errorCode = String(detail?.code ?? detail?.type ?? '');
  error.code = errorCode || 'openai-api-error';
  if (api === 'responses') {
    // Only an identified unsupported reasoning option may be omitted. Never
    // remove JSON mode or store:false in response to a generic API error.
    const parameter = String(detail?.param ?? '');
    const unsupported = /unsupported|unknown parameter|not supported/i.test(`${errorCode} ${message}`);
    error.unsupportedReasoningEffort = unsupported && (parameter
      ? /^reasoning(?:\.effort)?$/.test(parameter)
      : /(?:parameter|value|field)\s*:?\s*['"]?reasoning(?:\.effort)?\b/i.test(message));
    error.unsupportedResponseFormat = /^(?:text|text\.format)(?:\.|$)/.test(parameter)
      || /text\.format|json_object/i.test(message);
    error.unsupportedParam = error.unsupportedReasoningEffort && !error.unsupportedResponseFormat;
  } else {
    // Keep the established Chat Completions compatibility behavior unchanged.
    error.unsupportedParam = /(?:unsupported|unknown)\s+parameter|response_format|reasoning_effort/i.test(message);
    error.unsupportedReasoningEffort = /reasoning_effort/i.test(message);
    error.unsupportedResponseFormat = /response_format/i.test(message);
  }
  error.modelUnavailable = /model_not_found|model_not_available/i.test(errorCode)
    || /model.+(?:does not exist|not found|not available|access)|(?:access|permission).+model/i.test(message);
  return error;
}

function invalidOutput(code, message) {
  const error = new Error(`openai-responses: ${message}`);
  error.code = code;
  return error;
}

export function extractOpenAiText(parsed, api) {
  if (parsed?.error) throw openAiApiError(parsed.error, api);
  if (api !== 'responses') return String(parsed?.choices?.[0]?.message?.content ?? '');
  if (parsed?.status !== 'completed') {
    throw invalidOutput('openai-response-not-completed', `response status ${parsed?.status ?? 'missing'}${parsed?.incomplete_details?.reason ? ` (${parsed.incomplete_details.reason})` : ''}`);
  }
  if (!Array.isArray(parsed.output)) throw invalidOutput('openai-response-invalid-output', 'output array missing');
  const chunks = [];
  for (const item of parsed.output) {
    if (item?.type === 'reasoning') continue;
    if (item?.type !== 'message') {
      throw invalidOutput('openai-response-unsupported-item', `unsupported output item ${item?.type ?? 'missing'}`);
    }
    if (item.role !== 'assistant' || item.status !== 'completed' || !Array.isArray(item.content)) {
      throw invalidOutput('openai-response-invalid-message', 'assistant message is not complete');
    }
    for (const block of item.content) {
      if (block?.type === 'refusal') throw invalidOutput('openai-response-refusal', 'model refused the request');
      if (block?.type !== 'output_text' || typeof block.text !== 'string') {
        throw invalidOutput('openai-response-invalid-content', 'unsupported message content');
      }
      chunks.push(block.text);
    }
  }
  const output = chunks.join('');
  if (!output.trim()) throw invalidOutput('openai-response-empty-output', 'completed response has no output text');
  return output;
}
