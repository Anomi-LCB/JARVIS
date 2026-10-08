import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { ActionType, createIntentCandidate, stableId } from '../../../shared/src/types.js';
import { appendJsonlSync } from '../../../shared/src/jsonl.js';
import { IntentParser } from './intent-parser.js';
import { LocalSemanticIntentAdapter, PolicyGatedSemanticIntentAdapter } from './semantic-intent-adapter.js';
import { buildOpenAiPayload, extractOpenAiText, openAiEndpoint, resolveOpenAiApi } from './openai-api-protocol.js';

// LLM은 actionType 선택만 담당한다. 리스크 메타데이터는 이 고정 테이블에서만 부여되므로
// 모델 출력이 위험 등급을 낮추거나 카테고리를 조작할 수 없다.
export const actionProfiles = Object.freeze({
  [ActionType.CREATE_FILE]: { label: '로컬 산출물 생성', category: 'document', riskHint: 'local-reversible' },
  [ActionType.LIST_FILES]: { label: '파일 목록 조회', category: 'filesystem', riskHint: 'read-only-local' },
  [ActionType.COPY_FILE]: { label: '파일 복사', category: 'filesystem', riskHint: 'local-change' },
  [ActionType.MOVE_FILE]: { label: '파일 이동', category: 'filesystem', riskHint: 'local-change' },
  [ActionType.BROWSER_SEARCH]: { label: '브라우저 조사', category: 'browser', riskHint: 'read-only-web' },
  [ActionType.SHELL_EXECUTE]: { label: '셸 명령 실행', category: 'system', riskHint: 'system-command' },
  [ActionType.DESKTOP_CONTROL]: { label: 'Windows 데스크톱 제어', category: 'desktop', riskHint: 'interactive-desktop-control' },
  [ActionType.SEARCH_FILES]: { label: '파일 검색', category: 'filesystem', riskHint: 'read-only-local' },
  [ActionType.SEND_EMAIL]: { label: '메일 전송', category: 'external', riskHint: 'external-transfer' },
  [ActionType.EDIT_DOCUMENT]: { label: '문서 내용 편집', category: 'document', riskHint: 'local-change' },
  [ActionType.CAPABILITY_QUERY]: { label: '능력 조회', category: 'system', riskHint: 'read-only-local' },
  [ActionType.MACRO_SAVE]: { label: '작업을 이름 붙여 매크로로 저장', category: 'system', riskHint: 'read-only-local' },
  [ActionType.UPLOAD_FILE]: { label: '외부 전송 요청', category: 'external', riskHint: 'external-transfer' },
  [ActionType.DELETE_FILE]: { label: '삭제 요청', category: 'filesystem', riskHint: 'destructive' },
  [ActionType.MAKE_PAYMENT]: { label: '결제 요청', category: 'external', riskHint: 'forbidden' },
  [ActionType.CHANGE_SYSTEM_SETTING]: { label: '시스템 설정 변경', category: 'system', riskHint: 'forbidden' },
  [ActionType.READ_SECRET]: { label: '비밀정보 접근', category: 'system', riskHint: 'forbidden' }
});

const mergeableSlotKeys = Object.freeze(['fileName', 'outputFormat', 'destination', 'directoryHint', 'query', 'topic', 'dateHint', 'appName', 'windowTitle']);

export function buildIntentPrompt(commandText) {
  const actionLines = Object.entries(actionProfiles)
    .map(([actionType, profile]) => `- ${actionType}: ${profile.label}`)
    .join('\n');
  return [
    '당신은 JARVIS 로컬 비서의 의도 분류기입니다. 사용자 명령을 아래 actionType 중 정확히 하나로 분류하세요.',
    actionLines,
    '',
    '규칙:',
    '- 반드시 JSON 객체 하나만 출력한다. 설명 문장, 마크다운 코드펜스를 붙이지 않는다.',
    '- confidence는 0과 1 사이 숫자로, 분류 확신도를 나타낸다.',
    '- slots에는 명령에서 읽어낸 값만 채우고 없으면 null로 둔다.',
    '',
    '출력 형식:',
    '{"actionType":"...","confidence":0.0,"reasons":["짧은 근거 1","짧은 근거 2"],"slots":{"fileName":null,"outputFormat":null,"destination":null,"directoryHint":null,"query":null,"topic":null,"dateHint":null}}',
    '',
    `사용자 명령: ${commandText}`
  ].join('\n');
}

// Anthropic API 직접 호출 러너(동기, curl 경유). CLI와 달리 프로세스 시작 오버헤드가 없어 훨씬 빠르다.
// JARVIS_ANTHROPIC_API_KEY가 설정돼 있을 때만 쓰이며, 없으면 기존 claude CLI로 폴백한다.
const apiModelMap = { haiku: 'claude-haiku-4-5', sonnet: 'claude-sonnet-4-6', opus: 'claude-opus-4-8' };
const safeFallbackProviderIds = new Set([
  'anthropic-api', 'openai-api', 'claude-cli', 'xai', 'meta', 'gemini',
  'google-gemini-api', 'openai-agents-api', 'local-intent-cache'
]);
const safeFallbackErrorCodes = new Set([
  'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE',
  'A_MODEL_HTTP_ERROR', 'A_MODEL_TRANSPORT_ERROR', 'A_MODEL_RESPONSE_INVALID',
  'A_MODEL_RESPONSE_BLOCKED', 'A_MODEL_RESPONSE_INCOMPLETE', 'A_MODEL_CREDENTIAL_REQUIRED',
  'A_MODEL_PROMPT_INVALID', 'A_MODEL_TIMEOUT_INVALID', 'A_MODEL_BODY_UNAVAILABLE',
  'A_MODEL_RESPONSE_TOO_LARGE', 'A_MODEL_UNEXPECTED_TOOL_CALL', 'A_MODEL_EMPTY_RESPONSE',
  'claude-cli-authentication-required', 'claude-cli-rate-limited', 'provider-error'
]);
const safeFallbackRetryCodes = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNABORTED', 'EAI_AGAIN', 'EPIPE']);

function fallbackFailure(candidate, error) {
  const provider = safeFallbackProviderIds.has(candidate?.provider) ? candidate.provider : 'unknown';
  const code = safeFallbackErrorCodes.has(error?.code)
    || /^claude-cli-exit-(?:unknown|\d{1,3})$/u.test(error?.code ?? '')
    ? error.code : 'provider-error';
  const retryable = error?.retryable === true || safeFallbackRetryCodes.has(code)
    || [408, 425, 429, 500, 502, 503, 504].includes(error?.status);
  // Error messages and arbitrary fields may echo a prompt, key, or response body.
  return { provider, code, retryable };
}

function createSafeAbortError() {
  const error = new Error('llm-provider-chain-aborted');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function annotateRunner(runner, { provider, externalService, model, api }) {
  runner.provider = provider;
  runner.externalService = externalService;
  runner.model = model;
  if (api) runner.api = api;
  return runner;
}

export function createRunnerFallbackChain(runners) {
  const candidates = runners.filter((runner) => typeof runner === 'function');
  if (candidates.length === 0) throw new Error('llm-provider-chain: no runners configured');
  if (candidates.length === 1) return candidates[0];
  const primary = candidates[0];
  const chain = (prompt) => {
    const failures = [];
    for (const candidate of candidates) {
      try {
        const output = candidate(prompt);
        chain.lastProvider = candidate.lastProvider ?? candidate.provider ?? 'unknown';
        chain.lastExternalService = candidate.lastExternalService ?? candidate.externalService ?? 'unknown';
        chain.lastModel = candidate.lastModel ?? candidate.model ?? 'unknown';
        chain.lastUsage = candidate.lastUsage ?? null;
        chain.lastCostUsd = candidate.lastCostUsd ?? null;
        chain.lastApi = candidate.lastApi ?? candidate.api ?? null;
        chain.lastFailures = failures;
        return output;
      } catch (error) {
        failures.push(fallbackFailure(candidate, error));
      }
    }
    chain.lastFailures = failures;
    throw new Error(`llm-provider-chain-failed:${failures.map((failure) => failure.provider).join('>')}`);
  };
  annotateRunner(chain, {
    provider: primary.provider ?? 'unknown',
    externalService: primary.externalService ?? 'unknown',
    model: primary.model ?? 'unknown',
    api: primary.api
  });
  chain.providerChain = candidates.map((candidate) => ({
    provider: candidate.provider ?? 'unknown',
    externalService: candidate.externalService ?? 'unknown',
    model: candidate.model ?? 'unknown',
    ...(candidate.api ? { api: candidate.api } : {})
  }));
  return chain;
}

function executionMetadataFor(runner, fallbackModel = 'cli-default') {
  return {
    provider: runner?.lastProvider ?? runner?.provider ?? 'injected-runner',
    externalService: runner?.lastExternalService ?? runner?.externalService ?? 'anthropic-claude-cli',
    model: runner?.lastModel ?? runner?.model ?? fallbackModel
  };
}

function normalizedUsageNumber(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || value.trim() === '')) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function normalizedUsage(usage = {}) {
  usage ??= {};
  const entries = {
    inputTokens: usage.input_tokens ?? usage.prompt_tokens,
    outputTokens: usage.output_tokens ?? usage.completion_tokens,
    totalTokens: usage.total_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? usage.input_tokens_details?.cached_tokens,
    cacheCreationTokens: usage.cache_creation_input_tokens ?? usage.input_tokens_details?.cache_write_tokens,
    reasoningTokens: usage.output_tokens_details?.reasoning_tokens
  };
  const normalized = Object.fromEntries(
    Object.entries(entries)
      .map(([key, value]) => [key, normalizedUsageNumber(value)])
      .filter(([, value]) => value !== null)
  );
  return Object.keys(normalized).length > 0 ? normalized : null;
}

function curlConfigQuote(value) {
  return `"${String(value ?? '')
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\r', '\\r')
    .replaceAll('\n', '\\n')
    .replaceAll('\t', '\\t')}"`;
}

function runJsonApiRequest({ endpoint, headers, payload, timeoutMs, execFileSyncImpl = execFileSync, errorPrefix, captureHttpStatus = false }) {
  const config = [
    'silent',
    'show-error',
    `max-time = ${Math.max(5, Math.floor(timeoutMs / 1000))}`,
    `url = ${curlConfigQuote(endpoint)}`,
    'request = "POST"',
    ...headers.map((header) => `header = ${curlConfigQuote(header)}`),
    `data = ${curlConfigQuote(JSON.stringify(payload))}`,
    ...(captureHttpStatus ? ['write-out = "\\nJARVIS_HTTP_STATUS:%{http_code}"'] : [])
  ].join('\n');
  try {
    // Secrets stay in stdin. They never appear in argv or a temporary file.
    const output = execFileSyncImpl('curl', ['--config', '-'], {
      input: config,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true
    });
    if (!captureHttpStatus) return output;
    const envelope = String(output).match(/^([\s\S]*)\nJARVIS_HTTP_STATUS:(\d{3})$/);
    if (!envelope) throw new Error('missing HTTP status');
    const body = envelope[1];
    const status = Number(envelope[2]);
    if (status >= 400) {
      // Preserve structured API errors for parameter/model compatibility retry.
      let parsed;
      try { parsed = JSON.parse(body); } catch { /* status remains authoritative */ }
      if (!parsed?.error) throw new Error(`HTTP ${status}`);
    }
    return body;
  } catch (error) {
    throw new Error(`${errorPrefix}: ${String(error?.message ?? error).slice(0, 200)}`);
  }
}

export function runnerMetadataFor(runner, fallbackModel = 'cli-default') {
  return {
    provider: runner?.provider ?? 'injected-runner',
    externalService: runner?.externalService ?? 'anthropic-claude-cli',
    model: runner?.model ?? fallbackModel
  };
}

export function createApiRunner({
  apiKey,
  model = null,
  timeoutMs = 60000,
  maxTokens = 8000,
  endpoint = 'https://api.anthropic.com/v1/messages',
  execFileSyncImpl = execFileSync
}) {
  const apiModel = apiModelMap[model] ?? model ?? 'claude-haiku-4-5';
  const runner = (prompt) => {
    const out = runJsonApiRequest({
      endpoint,
      headers: [`x-api-key: ${apiKey}`, 'anthropic-version: 2023-06-01', 'content-type: application/json'],
      payload: { model: apiModel, max_tokens: maxTokens, messages: [{ role: 'user', content: String(prompt ?? '') }] },
      timeoutMs,
      execFileSyncImpl,
      errorPrefix: 'api-runner-error'
    });
    let parsed;
    try {
      parsed = JSON.parse(out);
    } catch {
      throw new Error('api-runner: invalid JSON response');
    }
    if (parsed.error) throw new Error(`api: ${parsed.error.message ?? 'unknown'}`);
    runner.lastProvider = 'anthropic-api';
    runner.lastExternalService = 'anthropic-api';
    runner.lastModel = parsed.model ?? apiModel;
    runner.lastUsage = normalizedUsage(parsed.usage);
    // 모델 응답 텍스트만 돌려준다(CLI 러너와 동일하게 이후 extractJsonObject가 파싱).
    return Array.isArray(parsed.content) ? parsed.content.map((b) => b.text ?? '').join('') : '';
  };
  return annotateRunner(runner, { provider: 'anthropic-api', externalService: 'anthropic-api', model: apiModel });
}

// OpenAI API 직접 호출 러너. Anthropic 키가 없고 OpenAI 키가 있으면 이걸 쓴다.
// 별칭(haiku/sonnet/opus)은 속도·품질이 비슷한 OpenAI 모델로 매핑한다.
const openAiModelMap = { haiku: 'gpt-5.4-mini', sonnet: 'gpt-5.6-terra', opus: 'gpt-5.6-sol' };
const openAiFallbackModelMap = {
  'gpt-5.6-luna': ['gpt-5.4-mini'],
  'gpt-5.6-terra': ['gpt-5.4'],
  'gpt-5.6-sol': ['gpt-5.4']
};

export function createOpenAiApiRunner({
  apiKey,
  model = null,
  timeoutMs = 60000,
  maxTokens = 8000,
  openAiModel = process.env.JARVIS_OPENAI_MODEL,
  openAiApi = process.env.JARVIS_OPENAI_API ?? 'chat-completions',
  fallbackModels = null,
  endpoint = null,
  execFileSyncImpl = execFileSync
}) {
  const api = resolveOpenAiApi(openAiApi);
  const apiModel = openAiModel ?? openAiModelMap[model] ?? model ?? 'gpt-5.4-mini';
  const configuredFallbackModels = fallbackModels === null
    ? (openAiModel ? [] : (openAiFallbackModelMap[apiModel] ?? []))
    : (Array.isArray(fallbackModels) ? fallbackModels : [fallbackModels]);
  const modelCandidates = [...new Set([
    apiModel,
    ...configuredFallbackModels
  ])];
  const callOnce = (prompt, modelId, { responseFormat = true, reasoningEffort = true }) => {
    const payload = buildOpenAiPayload({ api, prompt, model: modelId, maxTokens, responseFormat, reasoningEffort });
    const out = runJsonApiRequest({
      endpoint: endpoint ?? openAiEndpoint(api),
      headers: [`Authorization: Bearer ${apiKey}`, 'content-type: application/json'],
      payload,
      timeoutMs,
      execFileSyncImpl,
      errorPrefix: 'openai-runner-error',
      captureHttpStatus: api === 'responses'
    });
    let parsed;
    try {
      parsed = JSON.parse(out);
    } catch {
      throw new Error('openai-runner: invalid JSON response');
    }
    const output = extractOpenAiText(parsed, api);
    runner.lastUsage = normalizedUsage(parsed.usage);
    if (typeof parsed.model === 'string' && parsed.model) runner.lastModel = parsed.model;
    return output;
  };
  const callCompatible = (prompt, modelId) => {
    try {
      return callOnce(prompt, modelId, { responseFormat: true, reasoningEffort: true });
    } catch (error) {
      if (!error?.unsupportedParam) throw error;
      const fieldIdentified = error.unsupportedReasoningEffort || error.unsupportedResponseFormat;
      return callOnce(prompt, modelId, {
        responseFormat: fieldIdentified ? !error.unsupportedResponseFormat : false,
        reasoningEffort: fieldIdentified ? !error.unsupportedReasoningEffort : false
      });
    }
  };
  const runner = (prompt) => {
    runner.lastUsage = null;
    runner.lastCostUsd = null;
    runner.lastModel = null;
    for (let index = 0; index < modelCandidates.length; index += 1) {
      const modelId = modelCandidates[index];
      try {
        const output = callCompatible(prompt, modelId);
        runner.lastProvider = 'openai-api';
        runner.lastExternalService = 'openai-api';
        runner.lastApi = api;
        runner.lastModel = runner.lastModel ?? modelId;
        return output;
      } catch (error) {
        if (!error?.modelUnavailable || index === modelCandidates.length - 1) throw error;
      }
    }
    throw new Error('openai-runner: no model candidates');
  };
  annotateRunner(runner, { provider: 'openai-api', externalService: 'openai-api', model: apiModel, api });
  runner.modelCandidates = modelCandidates;
  return runner;
}

export function createClaudeCliRunner({
  command = 'claude',
  model = null,
  timeoutMs = 45000,
  shell = process.platform === 'win32',
  apiKey = process.env.JARVIS_ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY,
  openAiApiKey = process.env.JARVIS_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY,
  openAiModel = process.env.JARVIS_OPENAI_MODEL,
  openAiApi = process.env.JARVIS_OPENAI_API ?? 'chat-completions'
} = {}) {
  resolveOpenAiApi(openAiApi);
  const runners = [];
  if (apiKey) runners.push(createApiRunner({ apiKey, model, timeoutMs }));
  if (openAiApiKey) runners.push(createOpenAiApiRunner({ apiKey: openAiApiKey, model, timeoutMs, openAiModel, openAiApi }));
  runners.push(defaultRunner({ command, model, timeoutMs, shell }));
  return createRunnerFallbackChain(runners);
}

export function createAsyncRunnerFallbackChain(runners) {
  const candidates = runners.filter((runner) => typeof runner === 'function');
  if (candidates.length === 0) throw new Error('llm-provider-chain: no runners configured');
  if (candidates.length === 1) return candidates[0];
  const primary = candidates[0];
  const chain = async (prompt, options = {}) => {
    const failures = [];
    for (const candidate of candidates) {
      try {
        const output = await candidate(prompt, options);
        chain.lastProvider = candidate.lastProvider ?? candidate.provider ?? 'unknown';
        chain.lastExternalService = candidate.lastExternalService ?? candidate.externalService ?? 'unknown';
        chain.lastModel = candidate.lastModel ?? candidate.model ?? 'unknown';
        chain.lastUsage = candidate.lastUsage ?? null;
        chain.lastCostUsd = candidate.lastCostUsd ?? null;
        chain.lastApi = candidate.lastApi ?? candidate.api ?? null;
        chain.lastFailures = failures;
        return output;
      } catch (error) {
        if (options.signal?.aborted || error?.name === 'AbortError') throw createSafeAbortError();
        failures.push(fallbackFailure(candidate, error));
      }
    }
    chain.lastFailures = failures;
    throw new Error(`llm-provider-chain-failed:${failures.map((failure) => failure.provider).join('>')}`);
  };
  annotateRunner(chain, {
    provider: primary.provider ?? 'unknown',
    externalService: primary.externalService ?? 'unknown',
    model: primary.model ?? 'unknown',
    api: primary.api
  });
  chain.providerChain = candidates.map((candidate) => ({
    provider: candidate.provider ?? 'unknown',
    externalService: candidate.externalService ?? 'unknown',
    model: candidate.model ?? 'unknown',
    ...(candidate.api ? { api: candidate.api } : {})
  }));
  return chain;
}

async function requestJsonApiAsync({ endpoint, headers, payload, timeoutMs, fetchImpl, signal, errorPrefix }) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener?.('abort', onAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error(`${errorPrefix}: timeout`)), timeoutMs);
  try {
    if (controller.signal.aborted) throw controller.signal.reason;
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const text = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`${errorPrefix}: invalid JSON response (${response.status})`);
    }
    if (response.status >= 400 && !parsed?.error) throw new Error(`${errorPrefix}: HTTP ${response.status}`);
    return parsed;
  } catch (error) {
    if (controller.signal.aborted) {
      const aborted = new Error(`${errorPrefix}: aborted`);
      aborted.name = 'AbortError';
      throw aborted;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener?.('abort', onAbort);
  }
}

function createAsyncAnthropicApiRunner({ apiKey, model, timeoutMs, maxTokens = 8000, fetchImpl }) {
  const apiModel = apiModelMap[model] ?? model ?? 'claude-haiku-4-5';
  const runner = async (prompt, { signal, timeoutMs: requestedTimeoutMs } = {}) => {
    const parsed = await requestJsonApiAsync({
      endpoint: 'https://api.anthropic.com/v1/messages',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      payload: { model: apiModel, max_tokens: maxTokens, messages: [{ role: 'user', content: String(prompt ?? '') }] },
      timeoutMs: effectiveRunnerTimeout(timeoutMs, requestedTimeoutMs),
      fetchImpl,
      signal,
      errorPrefix: 'api-runner-error'
    });
    if (parsed.error) throw new Error(`api: ${parsed.error.message ?? 'unknown'}`);
    runner.lastProvider = 'anthropic-api';
    runner.lastExternalService = 'anthropic-api';
    runner.lastModel = parsed.model ?? apiModel;
    runner.lastUsage = normalizedUsage(parsed.usage);
    return Array.isArray(parsed.content) ? parsed.content.map((block) => block.text ?? '').join('') : '';
  };
  return annotateRunner(runner, { provider: 'anthropic-api', externalService: 'anthropic-api', model: apiModel });
}

export function createAsyncOpenAiApiRunner({
  apiKey,
  model = null,
  timeoutMs = 60000,
  maxTokens = 8000,
  openAiModel = process.env.JARVIS_OPENAI_MODEL,
  openAiApi = process.env.JARVIS_OPENAI_API ?? 'chat-completions',
  fallbackModels = null,
  endpoint = null,
  fetchImpl = globalThis.fetch
}) {
  const api = resolveOpenAiApi(openAiApi);
  const apiModel = openAiModel ?? openAiModelMap[model] ?? model ?? 'gpt-5.4-mini';
  const configuredFallbackModels = fallbackModels === null
    ? (openAiModel ? [] : (openAiFallbackModelMap[apiModel] ?? []))
    : (Array.isArray(fallbackModels) ? fallbackModels : [fallbackModels]);
  const modelCandidates = [...new Set([apiModel, ...configuredFallbackModels])];
  const callOnce = async (prompt, modelId, options, signal, requestedTimeoutMs) => {
    const payload = buildOpenAiPayload({ api, prompt, model: modelId, maxTokens, ...options });
    const parsed = await requestJsonApiAsync({
      endpoint: endpoint ?? openAiEndpoint(api),
      headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      payload,
      timeoutMs: effectiveRunnerTimeout(timeoutMs, requestedTimeoutMs),
      fetchImpl,
      signal,
      errorPrefix: 'openai-runner-error'
    });
    const output = extractOpenAiText(parsed, api);
    runner.lastUsage = normalizedUsage(parsed.usage);
    runner.lastModel = parsed.model ?? modelId;
    return output;
  };
  const callCompatible = async (prompt, modelId, signal, requestedTimeoutMs) => {
    try {
      return await callOnce(prompt, modelId, { responseFormat: true, reasoningEffort: true }, signal, requestedTimeoutMs);
    } catch (error) {
      if (!error?.unsupportedParam) throw error;
      const identified = error.unsupportedReasoningEffort || error.unsupportedResponseFormat;
      return await callOnce(prompt, modelId, {
        responseFormat: identified ? !error.unsupportedResponseFormat : false,
        reasoningEffort: identified ? !error.unsupportedReasoningEffort : false
      }, signal, requestedTimeoutMs);
    }
  };
  const runner = async (prompt, { signal, timeoutMs: requestedTimeoutMs } = {}) => {
    runner.lastUsage = null;
    runner.lastCostUsd = null;
    runner.lastModel = null;
    for (let index = 0; index < modelCandidates.length; index += 1) {
      try {
        const output = await callCompatible(prompt, modelCandidates[index], signal, requestedTimeoutMs);
        runner.lastProvider = 'openai-api';
        runner.lastExternalService = 'openai-api';
        runner.lastApi = api;
        return output;
      } catch (error) {
        if (!error?.modelUnavailable || index === modelCandidates.length - 1) throw error;
      }
    }
    throw new Error('openai-runner: no model candidates');
  };
  annotateRunner(runner, { provider: 'openai-api', externalService: 'openai-api', model: apiModel, api });
  runner.modelCandidates = modelCandidates;
  return runner;
}

export async function terminateLlmProcessTree(child, {
  platform = process.platform,
  spawnImpl = spawn,
  timeoutMs = 3_000
} = {}) {
  const pid = Number(child?.pid);
  if (platform !== 'win32' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    const killer = spawnImpl('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      shell: false,
      stdio: 'ignore',
      windowsHide: true
    });
    return await new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      timer = setTimeout(() => {
        try { killer.kill(); } catch {}
        finish(false);
      }, timeoutMs);
      timer.unref?.();
      killer.once('error', () => finish(false));
      killer.once('exit', (code) => finish(code === 0));
    });
  } catch {
    return false;
  }
}

function effectiveRunnerTimeout(configuredTimeoutMs, requestedTimeoutMs) {
  const configured = Number(configuredTimeoutMs);
  const requested = Number(requestedTimeoutMs);
  if (!Number.isFinite(requested) || requested <= 0) return configured;
  return Math.max(1, Math.min(configured, Math.floor(requested)));
}

function runCliProcessAsync({ command, args, prompt, timeoutMs, shell, spawnImpl, signal, terminateProcessTreeImpl }) {
  return new Promise((resolve, reject) => {
    const child = shell
      ? spawnImpl([command, ...args].join(' '), { shell: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      : spawnImpl(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener?.('abort', onAbort);
      callback(value);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener?.('abort', onAbort);
      Promise.resolve(terminateProcessTreeImpl(child))
        .catch(() => false)
        .then((treeStopped) => {
          if (!treeStopped) {
            try { child.kill(); } catch {}
          }
        })
        .finally(() => reject(error));
    };
    const onAbort = () => {
      const error = new Error('claude-cli-aborted');
      error.name = 'AbortError';
      fail(error);
    };
    const timeout = setTimeout(() => {
      const error = new Error('claude-cli-timeout');
      error.code = 'ETIMEDOUT';
      error.retryable = true;
      fail(error);
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > 4 * 1024 * 1024) fail(new Error('claude-cli-output-limit'));
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 4 * 1024 * 1024) fail(new Error('claude-cli-error-output-limit'));
    });
    child.once('error', (error) => finish(reject, error));
    child.once('close', (status) => finish(resolve, { status, stdout, stderr }));
    if (signal?.aborted) onAbort();
    else signal?.addEventListener?.('abort', onAbort, { once: true });
    if (!settled) child.stdin.end(String(prompt ?? ''));
  });
}

function defaultAsyncRunner({ command, model, timeoutMs, shell, spawnImpl, terminateProcessTreeImpl }) {
  const runner = async (prompt, { signal, timeoutMs: requestedTimeoutMs } = {}) => {
    const startedAt = Date.now();
    const args = ['-p', '--output-format', 'json', '--tools', shell ? '""' : '', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence'];
    if (model) args.push('--model', model);
    const result = await runCliProcessAsync({
      command,
      args,
      prompt,
      timeoutMs: effectiveRunnerTimeout(timeoutMs, requestedTimeoutMs),
      shell,
      spawnImpl,
      signal,
      terminateProcessTreeImpl
    });
    let envelope = null;
    try {
      envelope = JSON.parse(String(result.stdout ?? ''));
    } catch {
      envelope = null;
    }
    if (result.status !== 0 || envelope?.is_error === true) {
      const failure = classifyClaudeCliProcessFailure(result);
      const error = new Error(`${failure.code}: ${failure.summary}`);
      Object.assign(error, failure);
      throw error;
    }
    const actualModel = Object.keys(envelope?.modelUsage ?? {})[0];
    runner.lastProvider = 'claude-cli';
    runner.lastExternalService = 'anthropic-claude-cli';
    runner.lastModel = actualModel || model || 'cli-default';
    runner.lastUsage = normalizedUsage(envelope?.usage);
    runner.lastCostUsd = normalizedUsageNumber(envelope?.total_cost_usd);
    if (process.env.JARVIS_TIMING) {
      const head = String(prompt ?? '').slice(0, 50).replace(/\s+/g, ' ');
      process.stderr.write(`[LLM ${Date.now() - startedAt}ms ${model ?? 'default'}] ${head}\n`);
    }
    return String(result.stdout ?? '');
  };
  return annotateRunner(runner, { provider: 'claude-cli', externalService: 'anthropic-claude-cli', model: model ?? 'cli-default' });
}

export function createAsyncClaudeCliRunner({
  command = 'claude',
  model = null,
  timeoutMs = 45000,
  shell = process.platform === 'win32',
  apiKey = process.env.JARVIS_ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY,
  openAiApiKey = process.env.JARVIS_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY,
  openAiModel = process.env.JARVIS_OPENAI_MODEL,
  openAiApi = process.env.JARVIS_OPENAI_API ?? 'chat-completions',
  fetchImpl = globalThis.fetch,
  spawnImpl = spawn,
  terminateProcessTreeImpl = (child) => terminateLlmProcessTree(child)
} = {}) {
  resolveOpenAiApi(openAiApi);
  const runners = [];
  if (apiKey && typeof fetchImpl === 'function') {
    runners.push(createAsyncAnthropicApiRunner({ apiKey, model, timeoutMs, fetchImpl }));
  }
  if (openAiApiKey && typeof fetchImpl === 'function') {
    runners.push(createAsyncOpenAiApiRunner({ apiKey: openAiApiKey, model, timeoutMs, openAiModel, openAiApi, fetchImpl }));
  }
  runners.push(defaultAsyncRunner({ command, model, timeoutMs, shell, spawnImpl, terminateProcessTreeImpl }));
  return createAsyncRunnerFallbackChain(runners);
}

export function classifyClaudeCliProcessFailure({ status, stdout = '', stderr = '' } = {}) {
  let envelope = null;
  try {
    envelope = JSON.parse(String(stdout ?? ''));
  } catch {
    envelope = null;
  }
  const diagnosticText = [
    envelope?.api_error_status,
    envelope?.result,
    stderr
  ].filter(Boolean).join(' ');
  const exitStatus = Number.isInteger(status) ? status : null;

  if (envelope?.api_error_status === 401
    || /oauth.{0,40}expired|access token.{0,40}expired|failed to authenticate|unauthorized/i.test(diagnosticText)) {
    return {
      code: 'claude-cli-authentication-required',
      category: 'authentication',
      exitStatus,
      retryable: false,
      requiresUserAction: true,
      summary: 'Claude CLI authentication is missing or expired.'
    };
  }
  if (envelope?.api_error_status === 429 || /rate.?limit|quota exceeded/i.test(diagnosticText)) {
    return {
      code: 'claude-cli-rate-limited',
      category: 'rate-limit',
      exitStatus,
      retryable: true,
      requiresUserAction: false,
      summary: 'Claude CLI provider rate limit was reached.'
    };
  }
  return {
    code: `claude-cli-exit-${exitStatus ?? 'unknown'}`,
    category: envelope?.is_error ? 'provider-error' : 'process-error',
    exitStatus,
    retryable: true,
    requiresUserAction: false,
    summary: 'Claude CLI exited without a usable response.'
  };
}

function defaultRunner({ command, model, timeoutMs, shell }) {
  const runner = (prompt) => {
    const _startedAt = Date.now();
    const args = ['-p', '--output-format', 'json', '--tools', shell ? '""' : '', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence'];
    if (model) args.push('--model', model);
    // 인자는 전부 고정 리터럴이고 사용자 텍스트는 stdin으로만 전달된다.
    // win32에서는 .cmd 셔틀 해석을 위해 셸 모드로 단일 커맨드 문자열을 사용한다.
    const result = shell
      ? spawnSync([command, ...args].join(' '), {
          input: prompt,
          encoding: 'utf8',
          timeout: timeoutMs,
          windowsHide: true,
          shell: true,
          maxBuffer: 4 * 1024 * 1024
        })
      : spawnSync(command, args, {
          input: prompt,
          encoding: 'utf8',
          timeout: timeoutMs,
          windowsHide: true,
          maxBuffer: 4 * 1024 * 1024
        });
    if (result.error) throw result.error;
    const stdout = String(result.stdout ?? '');
    let envelope = null;
    try {
      envelope = JSON.parse(stdout);
    } catch {
      envelope = null;
    }
    if (result.status !== 0 || envelope?.is_error === true) {
      const failure = classifyClaudeCliProcessFailure(result);
      const error = new Error(`${failure.code}: ${failure.summary}`);
      Object.assign(error, failure);
      throw error;
    }
    if (process.env.JARVIS_TIMING) {
      const head = String(prompt ?? '').slice(0, 50).replace(/\s+/g, ' ');
      process.stderr.write(`[LLM ${Date.now() - _startedAt}ms ${model ?? 'default'}] ${head}\n`);
    }
    try {
      const wrapper = envelope ?? JSON.parse(stdout);
      const actualModel = Object.keys(wrapper.modelUsage ?? {})[0];
      runner.lastProvider = 'claude-cli';
      runner.lastExternalService = 'anthropic-claude-cli';
      runner.lastModel = actualModel || model || 'cli-default';
      runner.lastUsage = normalizedUsage(wrapper.usage);
      runner.lastCostUsd = normalizedUsageNumber(wrapper.total_cost_usd);
    } catch {
      runner.lastModel = model ?? 'cli-default';
      runner.lastUsage = null;
      runner.lastCostUsd = null;
    }
    return stdout;
  };
  return annotateRunner(runner, { provider: 'claude-cli', externalService: 'anthropic-claude-cli', model: model ?? 'cli-default' });
}

export function extractJsonObject(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

export class ClaudeCliSemanticIntentAdapter {
  constructor({
    parser = new IntentParser(),
    command = 'claude',
    model = null,
    timeoutMs = 45000,
    maxCommandLength = 2000,
    runner = null,
    apiKey = process.env.JARVIS_ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY,
    openAiApiKey = process.env.JARVIS_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY,
    openAiModel = process.env.JARVIS_OPENAI_MODEL,
    openAiApi = process.env.JARVIS_OPENAI_API ?? 'chat-completions',
    clock = () => new Date(),
    adapterId = 'claude-cli-semantic-intent-adapter-v1'
  } = {}) {
    this.parser = parser;
    this.command = command;
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.maxCommandLength = maxCommandLength;
    this.clock = clock;
    this.adapterId = adapterId;
    this.runner = runner ?? createClaudeCliRunner({
      command,
      model,
      timeoutMs,
      shell: process.platform === 'win32',
      apiKey,
      openAiApiKey,
      openAiModel,
      openAiApi
    });
    const runnerMetadata = runnerMetadataFor(this.runner, model ?? 'cli-default');
    this.runnerProvider = runnerMetadata.provider;
    this.runnerExternalService = runnerMetadata.externalService;
    this.runnerModel = runnerMetadata.model;
    // 결정화: (자연어→의도) 판정을 캐시해 같은 요청이면 claude 호출을 건너뛴다.
    // 파일에도 남겨 프로세스 재시작·다른 런타임(코어/브릿지/에이전트)에서도 즉시 재현한다.
    this.payloadCache = new Map();
    this.cachePath = process.env.JARVIS_INTENT_CACHE_PATH
      ?? (process.env.JARVIS_BRIDGE_STATE_DIR ? `${process.env.JARVIS_BRIDGE_STATE_DIR}/intent-cache.jsonl` : 'logs/intent-cache.jsonl');
    this.loadPayloadCache();
  }

  loadPayloadCache() {
    try {
      if (!existsSync(this.cachePath)) return;
      for (const line of readFileSync(this.cachePath, 'utf8').split(/\r?\n/).filter(Boolean)) {
        try {
          const rec = JSON.parse(line);
          if (rec?.key && actionProfiles[rec.payload?.actionType]) this.payloadCache.set(rec.key, rec.payload);
        } catch { /* skip bad line */ }
      }
    } catch { /* cache is optional */ }
  }

  parse(rawText, { requestId = 'request', createdAt = this.clock().toISOString() } = {}) {
    const text = String(rawText ?? '').trim().slice(0, this.maxCommandLength);
    if (!text) return this.failure('empty-command', { requestId });
    const cacheKey = text.toLowerCase().replace(/\s+/g, ' ');
    const prompt = buildIntentPrompt(text);
    const startedAt = Date.now();
    let payload;
    let latencyMs;
    let rawCommandSharedWithModel = true;
    let executionMetadata = {
      provider: this.runnerProvider,
      externalService: this.runnerExternalService,
      model: this.runnerModel
    };
    if (this.payloadCache.has(cacheKey)) {
      payload = this.payloadCache.get(cacheKey);
      latencyMs = 0;
      rawCommandSharedWithModel = false;
      executionMetadata = {
        provider: 'local-intent-cache',
        externalService: 'local-cache',
        model: 'cached-result'
      };
    } else {
      let stdout;
      try {
        stdout = this.runner(prompt);
        executionMetadata = executionMetadataFor(this.runner, this.runnerModel);
      } catch (error) {
        return this.failure(`cli-error:${error.message ?? error}`, { requestId });
      }
      latencyMs = Date.now() - startedAt;
      // --output-format json 래퍼({"result": "..."})와 모델이 직접 낸 JSON 둘 다 허용한다.
      const wrapper = extractJsonObject(stdout);
      payload = wrapper && typeof wrapper.result === 'string' ? extractJsonObject(wrapper.result) : wrapper;
      if (actionProfiles[payload?.actionType]) {
        this.payloadCache.set(cacheKey, payload);
        try { appendJsonlSync(this.cachePath, { key: cacheKey, payload, at: this.clock().toISOString() }); } catch { /* optional */ }
      }
    }
    const profile = actionProfiles[payload?.actionType];
    if (!profile) return this.failure('unrecognized-action-type', { requestId, latencyMs });

    const confidence = clampConfidence(payload.confidence);
    const ruleSlots = this.parser.extractSlots(text, payload.actionType);
    const slots = { ...ruleSlots };
    for (const key of mergeableSlotKeys) {
      const value = payload.slots?.[key];
      if ((slots[key] === undefined || slots[key] === null || slots[key] === '') && typeof value === 'string' && value.trim()) {
        slots[key] = value.trim().slice(0, 200);
      }
    }
    const reasons = Array.isArray(payload.reasons)
      ? payload.reasons.filter((item) => typeof item === 'string').slice(0, 4).map((item) => `llm:${item.slice(0, 120)}`)
      : [];
    const candidate = createIntentCandidate({
      intentId: stableId('intent_llm', `${requestId}:${payload.actionType}`, createdAt),
      label: profile.label,
      actionType: payload.actionType,
      category: profile.category,
      confidence,
      reasons: [`llm_adapter:${this.adapterId}`, `llm_runner:${executionMetadata.provider}`, ...reasons],
      riskHint: profile.riskHint,
      slots,
      entities: this.parser.extractEntities(text),
      missingSlots: this.parser.missingSlots(text, payload.actionType),
      complexity: this.parser.complexity(text)
    });
    return {
      ...candidate,
      title: candidate.label,
      candidates: [candidate],
      semantic: {
        adapterId: this.adapterId,
        matched: true,
        model: executionMetadata.model,
        latencyMs,
        externalService: executionMetadata.externalService,
        runnerProvider: executionMetadata.provider,
        providerChain: rawCommandSharedWithModel
          ? (this.runner.providerChain ?? [{ provider: this.runnerProvider }]).map((item) => item.provider)
          : ['local-intent-cache'],
        providerFallbackCount: rawCommandSharedWithModel ? (this.runner.lastFailures?.length ?? 0) : 0,
        providerUsage: rawCommandSharedWithModel ? (this.runner.lastUsage ?? null) : null,
        providerCostUsd: rawCommandSharedWithModel ? (this.runner.lastCostUsd ?? null) : null,
        rawCommandSharedWithModel,
        promptHash: createHash('sha256').update(prompt).digest('hex').slice(0, 16)
      }
    };
  }

  failure(reason, { requestId, latencyMs = 0 } = {}) {
    return {
      actionType: null,
      label: 'LLM 분류 실패',
      title: 'LLM 분류 실패',
      confidence: 0,
      candidates: [],
      blockedReason: null,
      semantic: {
        adapterId: this.adapterId,
        matched: false,
        failed: true,
        failureReason: String(reason).slice(0, 300),
        latencyMs,
        requestId,
        externalService: this.runnerExternalService,
        runnerProvider: this.runnerProvider
      }
    };
  }
}

function clampConfidence(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  // 외부 모델의 자기보고 확신도는 로컬 규칙 파서보다 높게 신뢰하지 않는다.
  return Math.min(0.93, Math.max(0, Math.round(numeric * 1000) / 1000));
}

export function createIntentParserFromEnv({ env = process.env, runner = null, clock = () => new Date() } = {}) {
  const enabled = env.JARVIS_LLM_INTENT === '1' || env.JARVIS_LLM_INTENT === 'true';
  if (!enabled) return null;
  const anthropicApiKey = env.JARVIS_ANTHROPIC_API_KEY ?? env.ANTHROPIC_API_KEY ?? '';
  const openAiApiKey = env.JARVIS_OPENAI_API_KEY ?? env.OPENAI_API_KEY ?? '';
  return new PolicyGatedSemanticIntentAdapter({
    localAdapter: new LocalSemanticIntentAdapter(),
    externalAdapter: new ClaudeCliSemanticIntentAdapter({
      command: env.JARVIS_LLM_INTENT_COMMAND ?? 'claude',
      model: env.JARVIS_LLM_INTENT_MODEL ?? 'haiku',
      timeoutMs: Number(env.JARVIS_LLM_INTENT_TIMEOUT_MS ?? 45000),
      apiKey: anthropicApiKey,
      openAiApiKey,
      openAiModel: env.JARVIS_OPENAI_MODEL ?? null,
      openAiApi: env.JARVIS_OPENAI_API ?? 'chat-completions',
      runner,
      clock
    }),
    externalEnabled: true,
    minLocalConfidence: Number(env.JARVIS_LLM_INTENT_MIN_LOCAL_CONFIDENCE ?? 0.72),
    minExternalConfidence: Number(env.JARVIS_LLM_INTENT_MIN_EXTERNAL_CONFIDENCE ?? 0.55)
  });
}
