import { randomUUID } from 'node:crypto';
import {localModelUsage,localModelFailureObservation,localModelRuntimeTiming} from './local-model-observation.js';
import {fetchOllamaLoopback} from './ollama-loopback-transport.js';

const ORIGIN = 'http://127.0.0.1:11434';
const MAX_BYTES = 2 * 1024 * 1024;

function fail(code) {
  return Object.assign(new Error(code), { code, retryable: false });
}

function validModelId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(value);
}

/** Local-only Ollama structured generation. No tools, credential, model pull, or remote endpoint is supported. */
export function createOllamaLocalModelProvider({ model, fetchImpl = fetchOllamaLoopback, timeoutMs = 180_000, numThreads = null } = {}) {
  if (!validModelId(model)) throw fail('A_LOCAL_MODEL_ID_REQUIRED');
  if (typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 600_000) {
    throw fail('A_LOCAL_MODEL_CONFIG_INVALID');
  }

  if (numThreads !== null && (!Number.isSafeInteger(numThreads) || numThreads < 1 || numThreads > 64)) throw fail('A_LOCAL_MODEL_CONFIG_INVALID');
  const generationOptions = Object.freeze({ temperature: 0, num_predict: 384, num_ctx: 8192, ...(numThreads === null ? {} : { num_thread: numThreads }) });

  async function request(path, body = null, signal = null, requestTimeoutMs = timeoutMs, observation = null) {
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 100 || requestTimeoutMs > 600_000) {
      throw fail('A_LOCAL_MODEL_TIMEOUT_INVALID');
    }
    if(signal?.aborted)throw fail('ABORT_ERR');
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, requestTimeoutMs);
    try {
      if(observation)observation.providerCalls++;
      const response = await fetchImpl(`${ORIGIN}${path}`, {
        method: body === null ? 'GET' : 'POST', redirect: 'error', signal: controller.signal,
        credentials: 'omit', cache: 'no-store',
        headers: body === null ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
        ...(body === null ? {} : { body: JSON.stringify(body) })
      });
      if(observation){observation.stage=body===null?'catalog-response':'generation-response';observation.httpStatus=response.status;}
      if (!response.ok) throw fail('A_LOCAL_MODEL_HTTP_ERROR');
      const text = await response.text();
      if (Buffer.byteLength(text) > MAX_BYTES) throw fail('A_LOCAL_MODEL_RESPONSE_TOO_LARGE');
      let parsed;
      try { parsed = JSON.parse(text); } catch { throw fail('A_LOCAL_MODEL_RESPONSE_INVALID'); }
      return parsed;
    } catch (error) {
      if(observation)observation.transportCode=error?.cause?.code??error?.code;
      if (typeof error?.code === 'string' && error.code.startsWith('A_LOCAL_MODEL_')) throw error;
      throw fail(controller.signal.aborted ? (signal?.aborted ? 'ABORT_ERR' : 'ETIMEDOUT') : 'A_LOCAL_MODEL_TRANSPORT_ERROR');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  async function ensureLocalModel(signal, requestTimeoutMs = timeoutMs, observation = null) {
    const result = await request('/api/tags', null, signal, requestTimeoutMs, observation);
    if (!Array.isArray(result?.models)) throw fail('A_LOCAL_MODEL_CATALOG_INVALID');
    const entry = result.models.find(item => item?.name === model || item?.model === model);
    if (!entry) throw fail('A_LOCAL_MODEL_NOT_INSTALLED');
    if (entry.remote_model || entry.remote_host || entry.size === 0) throw fail('A_LOCAL_MODEL_REMOTE_REJECTED');
    return { model: entry.name ?? entry.model, digest: typeof entry.digest === 'string' ? entry.digest : null,
      sizeBytes: Number.isSafeInteger(entry.size) && entry.size > 0 ? entry.size : null };
  }

  async function generateStructured({ prompt, schema, validate = null, signal, timeoutMs: requestTimeoutMs = timeoutMs } = {}) {
    if (typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt) > 512_000) throw fail('A_LOCAL_MODEL_PROMPT_INVALID');
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw fail('A_LOCAL_MODEL_SCHEMA_REQUIRED');
    if (validate !== null && typeof validate !== 'function') throw fail('A_LOCAL_MODEL_CONFIG_INVALID');
    const requestId = randomUUID();
    const startedAt = new Date().toISOString();
    const started = performance.now();
    const observation={version:'local-model-failure-v1',stage:'catalog-request',providerCalls:0,latencyMs:0,usage:null,doneReason:null,httpStatus:null};
    try {
    const localModel = await ensureLocalModel(signal, requestTimeoutMs, observation);
    observation.stage='generation-request';observation.httpStatus=null;
    const result = await request('/api/generate', { model, prompt, format: schema, stream: false,
      options: generationOptions, keep_alive: '5m' }, signal, requestTimeoutMs, observation);
    if(result?.model===model){observation.usage=localModelUsage({inputTokens:result.prompt_eval_count,outputTokens:result.eval_count});observation.doneReason=result.done_reason;}
    if (result?.model !== model || typeof result.response !== 'string' || result.done !== true || result.done_reason === 'length') {
      throw fail('A_LOCAL_MODEL_RESPONSE_INCOMPLETE');
    }
    observation.stage='output-validation';
    const runtimeTiming=localModelRuntimeTiming(result);
    let output;
    try { output = JSON.parse(result.response); } catch { throw fail('A_LOCAL_MODEL_OUTPUT_INVALID'); }
    if (validate && !validate(output)) throw fail('A_LOCAL_MODEL_OUTPUT_REJECTED');
    const usage=observation.usage;
    return { requestId, provider: 'ollama-local', externalService: 'loopback-ollama', model,
      startedAt, finishedAt: new Date().toISOString(), latencyMs: Math.max(0, performance.now() - started),
      usage, costUsd: null, costMeasurement: 'unmeasured', providerCalls: observation.providerCalls,
      executionAuthorized: false, transport: 'loopback-http', localModel, runtimeTiming, generationOptions, output };
    } catch(error) {
      observation.latencyMs=Math.max(0,performance.now()-started);
      const code=typeof error?.code==='string'&&/^(?:A_LOCAL_MODEL_[A-Z_]+|ABORT_ERR|ETIMEDOUT)$/u.test(error.code)?error.code:'A_LOCAL_MODEL_OUTPUT_REJECTED';
      throw Object.assign(fail(code),{requestId,diagnostics:localModelFailureObservation(observation)});
    }
  }

  return Object.freeze({ provider: 'ollama-local', model, externalService: 'loopback-ollama',
    ensureLocalModel, generateStructured, executionAuthorized: false });
}
