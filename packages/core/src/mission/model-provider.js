import { randomUUID } from 'node:crypto';
import { createOllamaLocalModelProvider } from './ollama-local-model-provider.js';
import {localModelFailureObservation} from './local-model-observation.js';

const providers = Object.freeze({
  xai: { endpoint: 'https://api.x.ai/v1/responses', service: 'xai-api', key: 'JARVIS_XAI_API_KEY',
    surfaceLabel: 'xAI 모델 API', integrationScope: 'JARVIS Mission 텍스트 계획', productBoundary: 'Grok Bot 완제품의 봇·루틴·작업환경을 연결하지 않음' },
  meta: { endpoint: 'https://api.meta.ai/v1/chat/completions', service: 'meta-model-api', key: 'JARVIS_META_API_KEY',
    surfaceLabel: 'Meta Model API · Muse Spark 모델', integrationScope: 'JARVIS Mission 텍스트 계획', productBoundary: 'Muse 개인 에이전트 완제품·개인 앱 연결을 제어하지 않음' },
  gemini: { endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/', service: 'google-gemini-api', key: 'JARVIS_GEMINI_API_KEY',
    surfaceLabel: 'Gemini 개발자 API', integrationScope: 'JARVIS Mission 텍스트 계획', productBoundary: 'Gemini Spark 완제품의 Tasks·Skills·Schedules에 연결하지 않음' },
  'gemini-interactions': { endpoint: 'https://generativelanguage.googleapis.com/v1/interactions', service: 'google-gemini-interactions-api', key: 'JARVIS_GEMINI_API_KEY',
    surfaceLabel: 'Gemini Interactions API', integrationScope: 'JARVIS Mission 텍스트 계획', productBoundary: 'Gemini Spark 완제품의 Tasks·Skills·Schedules에 연결하지 않음' },
  'ollama-local': { endpoint: 'http://127.0.0.1:11434', service: 'loopback-ollama', key: null,
    surfaceLabel: 'Ollama 로컬 모델 API', integrationScope: 'JARVIS Mission 텍스트 계획', productBoundary: '로컬 런타임·모델 상태는 별도 점검 필요' }
});
const limitBytes = 4 * 1024 * 1024;
const ownErrors = new WeakSet();
const failure = (code, extra = {}) => {
  const error = Object.assign(new Error(code), { code, retryable: false, ...extra });
  ownErrors.add(error);
  return error;
};
const count = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

// Constrain the outer planning contract while leaving per-tool `arguments`
// open-ended. The Mission planner still validates every action against its
// registered tool schema before it can enter E/B/G.
const MISSION_PLAN_RESPONSE_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    decision: { type: 'string', enum: ['continue', 'complete', 'ask_user', 'blocked'] },
    summary: { type: 'string' },
    question: { type: ['string', 'null'] },
    questions: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 500 } },
    blockedReason: { type: ['string', 'null'] },
    actions: { type: 'array', items: {
      type: 'object',
      properties: {
        id: { type: 'string' }, title: { type: 'string' }, command: { type: 'string' },
        expectedToolName: { type: 'string' }, arguments: { type: 'object', additionalProperties: true },
        dependencies: { type: 'array', items: { type: 'string' } },
        requirementIds: { type: 'array', items: { type: 'string' } },
        constraintRequirementIds: { type: 'array', items: { type: 'string' } },
        clarificationIndependent: { type: 'boolean' },
        successSignal: { type: 'string' }
      },
      required: ['id', 'title', 'command', 'expectedToolName', 'arguments', 'dependencies',
        'requirementIds', 'constraintRequirementIds', 'successSignal'],
      additionalProperties: false
    } },
    sourceNotes:{type:'array',maxItems:4,items:{type:'object',properties:{
      noteKey:{type:'string',minLength:1,maxLength:120},sourceObservationId:{type:'string',minLength:1,maxLength:160},
      expectedRevision:{type:'integer',minimum:0},throughOffset:{type:'integer',minimum:0},draft:{type:'string',minLength:1,maxLength:4000}
    },required:['noteKey','sourceObservationId','expectedRevision','throughOffset','draft'],additionalProperties:false}},
    criteriaAssessment: { type: 'array', items: {
      type: 'object', properties: {
        criterionId: { type: 'string' }, status: { type: 'string', enum: ['satisfied', 'unsatisfied'] },
        evidenceActionIds: { type: 'array', items: { type: 'string' } }, reason: { type: 'string' }
      }, required: ['criterionId', 'status', 'evidenceActionIds', 'reason'], additionalProperties: false
    } }
  },
  required: ['decision', 'summary', 'question', 'blockedReason', 'actions', 'criteriaAssessment'],
  additionalProperties: false
});

function structuredResponseSchema() { return structuredClone(MISSION_PLAN_RESPONSE_SCHEMA); }

// Ollama's grammar can constrain decision/action combinations while the other
// providers retain their already-tested schema dialects. This is a generation
// constraint, never authority to execute: Mission still validates each plan.
function localStructuredResponseSchema() {
  return { anyOf: ['continue', 'complete', 'ask_user', 'blocked'].map(decision => {
    const branch = structuredResponseSchema();
    branch.properties.decision = { type: 'string', enum: [decision] };
    branch.properties.actions = { ...branch.properties.actions,
      minItems: decision === 'continue' ? 1 : 0,
      maxItems: ['complete', 'blocked'].includes(decision) ? 0 : 8 };
    if (decision !== 'ask_user') {
      branch.properties.question = { type: 'null' };
      delete branch.properties.questions;
    }
    if (decision !== 'blocked') branch.properties.blockedReason = { type: 'null' };
    return branch;
  }) };
}

export function normalizeModelUsage(provider, raw) {
  if (!raw || typeof raw !== 'object') return null;
  const values = provider === 'gemini-interactions' ? {
    inputTokens: raw.total_input_tokens, outputTokens: raw.total_output_tokens,
    totalTokens: raw.total_tokens, cacheReadTokens: raw.total_cached_tokens,
    reasoningTokens: raw.total_thought_tokens
  } : provider === 'gemini' ? {
    inputTokens: raw.promptTokenCount, outputTokens: raw.candidatesTokenCount,
    totalTokens: raw.totalTokenCount, cacheReadTokens: raw.cachedContentTokenCount,
    reasoningTokens: raw.thoughtsTokenCount
  } : provider === 'xai' ? {
    inputTokens: raw.input_tokens, outputTokens: raw.output_tokens, totalTokens: raw.total_tokens,
    cacheReadTokens: raw.input_tokens_details?.cached_tokens, reasoningTokens: raw.output_tokens_details?.reasoning_tokens
  } : {
    inputTokens: raw.prompt_tokens, outputTokens: raw.completion_tokens, totalTokens: raw.total_tokens,
    cacheReadTokens: raw.prompt_tokens_details?.cached_tokens,
    reasoningTokens: raw.completion_tokens_details?.reasoning_tokens
  };
  const result = Object.fromEntries(Object.entries(values).filter(([, value]) => count(value) !== null));
  return Object.keys(result).length ? result : null;
}

/** Text planning transport only. It never executes tools, installs code, or grants authority. */
export function createModelProvider({ provider, model, apiKey, resolveApiKey = null, fetchImpl = globalThis.fetch, timeoutMs = 90_000,
  reasoningEffort = null } = {}) {
  const spec = Object.hasOwn(providers, provider) ? providers[provider] : null;
  if (!spec) throw failure('A_MODEL_PROVIDER_UNSUPPORTED');
  const modelPattern = provider === 'ollama-local' ? /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u : /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
  if (typeof model !== 'string' || !modelPattern.test(model)) throw failure('A_MODEL_ID_REQUIRED');
  if (provider === 'meta' && /contributor/iu.test(model)) throw failure('A_MODEL_TRAINING_TIER_DISABLED');
  if (reasoningEffort !== null && (provider !== 'meta' || !['minimal', 'low', 'medium', 'high', 'xhigh'].includes(reasoningEffort))) {
    throw failure('A_MODEL_REASONING_EFFORT_INVALID');
  }
  if (resolveApiKey !== null && typeof resolveApiKey !== 'function') throw failure('A_MODEL_CONFIG_INVALID');
  const hasConfiguredApiKey = apiKey !== undefined && apiKey !== null && apiKey !== '';
  if (hasConfiguredApiKey && (typeof apiKey !== 'string' || !apiKey.trim() || /[\r\n]/u.test(apiKey))) throw failure('A_MODEL_CREDENTIAL_REQUIRED');
  if (!hasConfiguredApiKey && !resolveApiKey && provider !== 'ollama-local') throw failure('A_MODEL_CREDENTIAL_REQUIRED');
  if (typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 600_000) throw failure('A_MODEL_CONFIG_INVALID');
  const configuredSecret = typeof apiKey === 'string' && apiKey.trim() && !/[\r\n]/u.test(apiKey) ? apiKey.trim() : null;

  if (provider === 'ollama-local') {
    if (apiKey || resolveApiKey) throw failure('A_LOCAL_MODEL_CREDENTIALS_UNSUPPORTED');
    const local = createOllamaLocalModelProvider({ model, fetchImpl:fetchImpl===globalThis.fetch?undefined:fetchImpl, timeoutMs });
    async function generateLocal({ prompt, signal, timeoutMs: requestTimeout = timeoutMs, stream = false, onText = null } = {}) {
      if (stream || onText !== null) throw failure('A_LOCAL_MODEL_STREAM_UNSUPPORTED');
      if (!Number.isSafeInteger(requestTimeout) || requestTimeout < 100 || requestTimeout > 600_000) throw failure('A_MODEL_TIMEOUT_INVALID');
      const requestId = randomUUID();
      const startedAt = new Date().toISOString();
      const started = performance.now();
      try {
        const result = await local.generateStructured({ prompt, schema: localStructuredResponseSchema(), signal, timeoutMs: requestTimeout,
          validate: value => Boolean(value && typeof value === 'object' && !Array.isArray(value)) });
        return { ...result, requestId, startedAt, provider, externalService: spec.service, model,
          output: JSON.stringify(result.output), executionAuthorized: false };
      } catch (error) {
        const observed=localModelFailureObservation(error.diagnostics);
        error.modelReceipt ??= { requestId, provider, externalService: spec.service, model,
          startedAt, finishedAt: new Date().toISOString(), latencyMs: Math.max(0, performance.now() - started),
          usage: observed?.usage??null, costUsd: null, costMeasurement: 'unmeasured',
          providerCalls: observed?.providerCalls??null, executionAuthorized: false };
        throw error;
      }
    }
    return Object.freeze({ provider, model, externalService: spec.service, generate: generateLocal, executionAuthorized: false });
  }

  async function generate({ prompt, signal, timeoutMs: requestTimeout = timeoutMs, stream = false, onText = null } = {}) {
    if (typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt) > limitBytes) throw failure('A_MODEL_PROMPT_INVALID');
    if (!Number.isSafeInteger(requestTimeout) || requestTimeout < 100 || requestTimeout > 600_000) throw failure('A_MODEL_TIMEOUT_INVALID');
    if (onText !== null && typeof onText !== 'function') throw failure('A_MODEL_CALLBACK_INVALID');
    if (provider === 'gemini-interactions' && (stream || onText !== null)) throw failure('A_MODEL_STREAM_UNSUPPORTED');
    const requestId = randomUUID();
    const startedAt = new Date().toISOString();
    const started = performance.now();
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, requestTimeout);
    let output = '', usage = null, finished = false, finishReason = null, providerCalls = 0;
    let costUsd = null;
    const calls = new Map();
    const receipt = () => ({
      requestId, provider, externalService: spec.service, model, startedAt,
      finishedAt: new Date().toISOString(), latencyMs: Math.max(0, performance.now() - started),
      usage, costUsd, costMeasurement: costUsd === null ? 'unmeasured' : 'provider-reported', providerCalls,
      executionAuthorized: false
    });
    function ingest(payload, incremental) {
      if (!payload || typeof payload !== 'object' || payload.error) throw failure('A_MODEL_RESPONSE_INVALID');
      let delta = '';
      if (provider === 'gemini') {
        usage = normalizeModelUsage(provider, payload.usageMetadata) ?? usage;
        if (payload.promptFeedback?.blockReason) throw failure('A_MODEL_RESPONSE_BLOCKED');
        if (payload.candidates?.length > 1) throw failure('A_MODEL_MULTIPLE_CANDIDATES');
        const candidate = payload.candidates?.[0];
        for (const part of candidate?.content?.parts ?? []) {
          if (typeof part.text === 'string' && !part.thought) delta += part.text;
          if (part.functionCall) calls.set(`call_${calls.size}`, { ...part.functionCall });
        }
        if (candidate?.finishReason) { finishReason = candidate.finishReason; finished = true; }
      } else if (provider === 'xai') {
        if (payload.type === 'response.output_text.delta') delta = typeof payload.delta === 'string' ? payload.delta : '';
        else if (payload.type === 'response.completed') {
          const response = payload.response ?? payload;
          usage = normalizeModelUsage(provider, response.usage) ?? usage;
          const ticks = response.usage?.cost_in_usd_ticks;
          if (Number.isSafeInteger(ticks) && ticks >= 0) costUsd = ticks / 10_000_000_000;
          const completedText = [];
          for (const item of response.output ?? []) {
            if (item?.type !== 'message' && item?.type !== 'reasoning') calls.set(`call_${calls.size}`, { ...item });
            for (const part of item?.content ?? []) {
              if (part?.type === 'output_text' && typeof part.text === 'string') completedText.push(part.text);
              if (part?.type === 'refusal') throw failure('A_MODEL_RESPONSE_BLOCKED');
            }
          }
          if (completedText.length) output = completedText.join('');
          finished = true;
          finishReason = 'stop';
        } else if (payload.type === 'response.incomplete') {
          const response = payload.response ?? payload;
          usage = normalizeModelUsage(provider, response.usage) ?? usage;
          const ticks = response.usage?.cost_in_usd_ticks;
          if (Number.isSafeInteger(ticks) && ticks >= 0) costUsd = ticks / 10_000_000_000;
          finished = true;
          finishReason = 'length';
        } else if (payload.type === 'response.failed' || payload.type === 'response.refusal.delta') {
          throw failure('A_MODEL_RESPONSE_BLOCKED');
        } else if (payload.type === 'response.output_item.done' && payload.item?.type === 'function_call') {
          calls.set(`call_${calls.size}`, { ...payload.item });
        } else if (payload.type && !['response.created', 'response.queued', 'response.in_progress',
          'response.output_item.added', 'response.content_part.added', 'response.content_part.done',
          'response.output_text.done', 'response.reasoning_summary_text.delta', 'response.reasoning_summary_text.done'].includes(payload.type)) {
          throw failure('A_MODEL_RESPONSE_INVALID');
        }
      } else {
        usage = normalizeModelUsage(provider, payload.usage) ?? usage;
        if (payload.choices?.length > 1) throw failure('A_MODEL_MULTIPLE_CANDIDATES');
        const choice = payload.choices?.[0];
        const message = incremental ? choice?.delta : choice?.message;
        if (message?.refusal) throw failure('A_MODEL_RESPONSE_BLOCKED');
        if (typeof message?.content === 'string') delta = message.content;
        for (const call of message?.tool_calls ?? []) {
          const index = incremental ? call.index : calls.size;
          if (!Number.isInteger(index) || index < 0 || index > 63) throw failure('A_MODEL_TOOL_CALL_INVALID');
          const prior = calls.get(index) ?? { id: '', name: '', arguments: '' };
          calls.set(index, { id: call.id ?? prior.id, name: prior.name + (call.function?.name ?? ''),
            arguments: prior.arguments + (call.function?.arguments ?? '') });
        }
        if (choice?.finish_reason) { finishReason = choice.finish_reason; finished = true; }
      }
      output += delta;
      if (Buffer.byteLength(output) > limitBytes || calls.size > 64) throw failure('A_MODEL_RESPONSE_TOO_LARGE');
      // Streaming text is preview-only, never an executable partial plan.
      if (delta && onText) onText({ requestId, text: delta, provisional: true });
    }
    try {
      if (controller.signal.aborted) throw failure('ABORT_ERR');
      const resolvedSecret = configuredSecret ?? await resolveApiKey?.();
      if (typeof resolvedSecret !== 'string' || !resolvedSecret.trim() || /[\r\n]/u.test(resolvedSecret)) throw failure('A_MODEL_CREDENTIAL_REQUIRED');
      const secret = resolvedSecret.trim();
      const gemini = provider === 'gemini';
      const geminiInteractions = provider === 'gemini-interactions';
      const url = gemini ? `${spec.endpoint}${encodeURIComponent(model)}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}` : spec.endpoint;
      const schema = structuredResponseSchema();
      const body = geminiInteractions ? {
        model, input: prompt, store: false,
        response_format: { type: 'text', mime_type: 'application/json', schema }
      } : gemini ? {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', responseJsonSchema: schema, candidateCount: 1 }
      } : provider === 'xai' ? {
        model, input: [{ role: 'user', content: prompt }], store: false,
        text: { format: { type: 'json_schema', name: 'jarvis_mission_plan', schema, strict: false } }, stream
      } : {
        model, messages: [{ role: 'user', content: prompt }], stream,
        ...(provider === 'meta' && reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
        response_format: { type: 'json_schema', json_schema: {
          name: 'jarvis_mission_plan', schema, strict: false
        } }
      };
      providerCalls++;
      const response = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Accept: stream ? 'text/event-stream' : 'application/json',
          ...(gemini || geminiInteractions ? { 'x-goog-api-key': secret } : { Authorization: `Bearer ${secret}` }) },
        body: JSON.stringify(body) });
      if (!response.ok) {
        await response.body?.cancel?.();
        throw failure('A_MODEL_HTTP_ERROR', { status: response.status, retryable: [408, 429, 500, 502, 503, 504].includes(response.status) });
      }
      if (!response.body?.getReader) throw failure('A_MODEL_BODY_UNAVAILABLE');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '', bytes = 0;
      let sawDone = false;
      function consumeEvent(event) {
        const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data) return;
        if (data === '[DONE]') { sawDone = true; return; }
        if (sawDone) throw failure('A_MODEL_STREAM_INVALID');
        let parsed;
        try { parsed = JSON.parse(data); } catch { throw failure('A_MODEL_RESPONSE_INVALID'); }
        ingest(parsed, true);
      }
      try {
        while (true) {
          if (controller.signal.aborted) throw failure('ABORT_ERR');
          const { value, done } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > limitBytes) throw failure('A_MODEL_RESPONSE_TOO_LARGE');
          buffer += decoder.decode(value, { stream: true });
          if (stream) {
            buffer = buffer.replace(/\r\n/g, '\n');
            let index;
            while ((index = buffer.indexOf('\n\n')) !== -1) {
              consumeEvent(buffer.slice(0, index)); buffer = buffer.slice(index + 2);
            }
          }
        }
        buffer += decoder.decode();
        if (stream) {
          if (buffer.trim()) consumeEvent(buffer.replace(/\r\n/g, '\n'));
          if (provider === 'meta' && !sawDone) throw failure('A_MODEL_RESPONSE_INCOMPLETE');
        } else {
          let parsed;
          try { parsed = JSON.parse(buffer); } catch { throw failure('A_MODEL_RESPONSE_INVALID'); }
          if (provider === 'xai') {
            if (parsed.status === 'failed' || parsed.error) throw failure('A_MODEL_RESPONSE_INVALID');
            if (parsed.status === 'incomplete') ingest({ type: 'response.incomplete', response: parsed }, true);
            else if (parsed.status === 'completed') ingest({ type: 'response.completed', response: parsed }, true);
            else throw failure('A_MODEL_RESPONSE_INCOMPLETE');
          } else if (geminiInteractions) {
            if (!parsed || parsed.status === 'failed' || parsed.status === 'cancelled') throw failure('A_MODEL_RESPONSE_INVALID');
            if (parsed.status === 'incomplete' || parsed.status === 'budget_exceeded') {
              usage = normalizeModelUsage(provider, parsed.usage) ?? usage;
              finishReason = 'length'; finished = true;
            } else if (parsed.status === 'requires_action') {
              usage = normalizeModelUsage(provider, parsed.usage) ?? usage;
              for (const [index, step] of (parsed.steps ?? []).entries()) {
                if (step?.type === 'function_call') calls.set(`call_${index}`, { ...step });
              }
              finishReason = 'tool_calls'; finished = true;
            } else if (parsed.status === 'completed') {
              usage = normalizeModelUsage(provider, parsed.usage) ?? usage;
              for (const [index, step] of (parsed.steps ?? []).entries()) {
                if (step?.type === 'function_call' || step?.type === 'function_result') calls.set(`call_${index}`, { ...step });
                if (step?.type === 'model_output') {
                  for (const item of step.content ?? []) {
                    if (item?.type === 'text' && typeof item.text === 'string') output += item.text;
                    if (item?.type === 'refusal') throw failure('A_MODEL_RESPONSE_BLOCKED');
                  }
                }
              }
              if (parsed.output_text && !output) output = parsed.output_text;
              finishReason = 'stop'; finished = true;
            } else throw failure('A_MODEL_RESPONSE_INCOMPLETE');
          } else ingest(parsed, false);
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      if (controller.signal.aborted) throw failure('ABORT_ERR');
      if (!finished || !['stop', 'STOP', 'tool_calls'].includes(finishReason)) throw failure('A_MODEL_RESPONSE_INCOMPLETE');
      // This transport has no advertised native functions. Unexpected calls must
      // not be executed or silently discarded, even alongside a valid text plan.
      if (calls.size) throw failure('A_MODEL_UNEXPECTED_TOOL_CALL');
      if (!output.trim()) throw failure('A_MODEL_EMPTY_RESPONSE');
      return { ...receipt(), output };
    } catch (error) {
      const safe = controller.signal.aborted
        ? failure(signal?.aborted ? 'ABORT_ERR' : 'ETIMEDOUT', { retryable: !signal?.aborted })
        : ownErrors.has(error) ? error : failure('A_MODEL_TRANSPORT_ERROR');
      // No raw provider body, URL, prompt, key, stack from fetch, or cause is persisted.
      safe.modelReceipt = receipt();
      throw safe;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  return Object.freeze({ provider, model, externalService: spec.service, generate, executionAuthorized: false });
}

export function createModelPlanningRunner(options) {
  const adapter = createModelProvider(options);
  const runner = async (prompt, request = {}) => (await runner.runWithReceipt(prompt, request)).output;
  runner.runWithReceipt = (prompt, request = {}) => adapter.generate({ ...request, prompt });
  runner.provider = adapter.provider;
  runner.externalService = adapter.externalService;
  runner.model = adapter.model;
  return runner;
}

export function createModelPlanningRunnerFromEnv({ env = process.env, fetchImpl = globalThis.fetch, credentialResolver = null } = {}) {
  const provider = env.JARVIS_MISSION_PROVIDER;
  if (!provider || provider === 'legacy') return null;
  if (!Object.hasOwn(providers, provider)) throw failure('A_MODEL_PROVIDER_UNSUPPORTED');
  return createModelPlanningRunner({ provider, model: env.JARVIS_MISSION_MODEL,
    apiKey: provider === 'ollama-local' ? undefined : env[providers[provider].key],
    resolveApiKey: provider !== 'ollama-local' && credentialResolver ? () => credentialResolver(provider) : null,
    timeoutMs: Number(env.JARVIS_MISSION_TIMEOUT_MS ?? 90_000),
    reasoningEffort: provider === 'meta' ? env.JARVIS_META_REASONING_EFFORT ?? null : null, fetchImpl });
}

/** Read-only setup diagnostics: credential presence is never connection proof. */
export function describeModelProviders(env = process.env, { credentialStatus = null, credentialResolverConfigured = false } = {}) {
  return Object.entries(providers).map(([provider, spec]) => {
    const selected = env.JARVIS_MISSION_PROVIDER === provider;
    const model = selected ? env.JARVIS_MISSION_MODEL ?? null : null;
    const environmentCredentialPresent = typeof spec.key === 'string' && typeof env[spec.key] === 'string' && Boolean(env[spec.key].trim());
    let vaultCredentialPresent = false;
    try { vaultCredentialPresent = credentialStatus?.(provider) === true; } catch { vaultCredentialPresent = false; }
    const credentialPresent = environmentCredentialPresent || vaultCredentialPresent;
    let configurationError = null;
    if (selected) {
      try { createModelPlanningRunnerFromEnv({ env, credentialResolver: credentialResolverConfigured ? async () => 'diagnostic-placeholder-not-used' : null }); }
      catch (error) { configurationError = ownErrors.has(error) ? error.code : 'A_MODEL_CONFIG_INVALID'; }
      if (!configurationError && !credentialPresent && provider !== 'ollama-local') configurationError = 'A_MODEL_CREDENTIAL_REQUIRED';
    }
    const modelPattern = provider === 'ollama-local' ? /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u : /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
    return { provider, surfaceLabel: spec.surfaceLabel, integrationScope: spec.integrationScope,
      productBoundary: spec.productBoundary, productAgentApiStatus: 'not-integrated',
      selected, model: typeof model === 'string' && modelPattern.test(model) ? model : null,
      ...(provider === 'meta' && selected ? { reasoningEffort: env.JARVIS_META_REASONING_EFFORT ?? 'provider-default' } : {}),
      credentialPresent, connectionStatus: 'unverified', executionAuthorized: false,
      configurationError,
      stage: selected && !configurationError ? 'configured-unverified' : 'setup-required',
      nextAction: !selected ? 'select-provider-and-pin-model' : provider === 'ollama-local' && !configurationError ? 'verify-local-model-catalog'
        : configurationError === 'A_MODEL_CREDENTIAL_REQUIRED' ? 'store-provider-key-in-dpapi-vault-or-runtime-environment'
        : configurationError ? 'correct-provider-configuration' : 'run-authorized-public-data-pilot',
      credentialSource: environmentCredentialPresent ? 'environment' : vaultCredentialPresent ? 'dpapi-vault' : 'none',
      externalService: spec.service };
  });
}
