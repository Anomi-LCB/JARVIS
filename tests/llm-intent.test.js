import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { ActionType } from '../packages/shared/src/types.js';

// 결정화 캐시가 repo logs/를 오염시키거나 이전 실행의 캐시가 호출 횟수 단언을 깨지 않도록 격리한다.
const intentCacheRoot = mkdtempSync(join(tmpdir(), 'jarvis-test-intent-cache-'));
process.env.JARVIS_INTENT_CACHE_PATH = join(intentCacheRoot, 'intent-cache.jsonl');
after(() => rmSync(intentCacheRoot, { recursive: true, force: true }));
import {
  buildIntentPrompt,
  ClaudeCliSemanticIntentAdapter,
  createApiRunner,
  createAsyncClaudeCliRunner,
  createAsyncRunnerFallbackChain,
  classifyClaudeCliProcessFailure,
  createOpenAiApiRunner,
  createRunnerFallbackChain,
  createIntentParserFromEnv,
  terminateLlmProcessTree
} from '../packages/core/src/intent/claude-cli-intent-adapter.js';
import { createDefaultContractRegistry } from '../packages/core/src/contracts/default-contracts.js';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import {
  createLlmProviderReadiness,
  createPublicLlmProviderStatus,
  runLlmProviderDiagnostics
} from '../scripts/llm-provider-diagnostics.mjs';

function llmResponse(payload) {
  return JSON.stringify({ result: JSON.stringify(payload) });
}

test('Claude CLI process failure reads structured stdout without retaining the raw auth error', () => {
  const rawProviderError = 'Failed to authenticate. API Error: 401 OAuth access token has expired.';
  const failure = classifyClaudeCliProcessFailure({
    status: 1,
    stdout: JSON.stringify({ is_error: true, api_error_status: 401, result: rawProviderError }),
    stderr: ''
  });

  assert.equal(failure.code, 'claude-cli-authentication-required');
  assert.equal(failure.category, 'authentication');
  assert.equal(failure.requiresUserAction, true);
  assert.equal(failure.retryable, false);
  assert.doesNotMatch(JSON.stringify(failure), /OAuth access token has expired/);
});

test('claude cli intent adapter maps LLM output into a valid IntentCandidate', () => {
  const adapter = new ClaudeCliSemanticIntentAdapter({
    model: 'haiku',
    runner: () => llmResponse({
      actionType: ActionType.BROWSER_SEARCH,
      confidence: 0.88,
      reasons: ['사용자가 웹에서 정보를 요청함'],
      slots: { query: '이번 주 서울 날씨', topic: '날씨' }
    })
  });
  const intent = adapter.parse('이번 주 서울 날씨가 어떤지 궁금하네', { requestId: 'req_test_1' });
  assert.equal(intent.actionType, ActionType.BROWSER_SEARCH);
  assert.equal(intent.category, 'browser');
  assert.equal(intent.riskHint, 'read-only-web');
  assert.ok(intent.confidence > 0.5 && intent.confidence <= 0.93);
  assert.ok(intent.reasons.some((reason) => reason.startsWith('llm:')));
  assert.equal(intent.semantic.matched, true);
  assert.equal(intent.semantic.externalService, 'anthropic-claude-cli');
  assert.equal(intent.semantic.rawCommandSharedWithModel, true);
  const registry = createDefaultContractRegistry();
  registry.assert('IntentCandidate', intent);
});

test('claude cli intent adapter derives risk metadata from its own table, not from the model', () => {
  const adapter = new ClaudeCliSemanticIntentAdapter({
    runner: () => llmResponse({
      actionType: ActionType.DELETE_FILE,
      confidence: 0.99,
      // 모델이 위험도를 낮추려는 출력을 흉내낸다.
      riskHint: 'read-only-local',
      category: 'document',
      reasons: ['안전한 요청으로 보임']
    })
  });
  const intent = adapter.parse('임시 파일 지워줘', { requestId: 'req_test_2' });
  assert.equal(intent.actionType, ActionType.DELETE_FILE);
  assert.equal(intent.riskHint, 'destructive');
  assert.equal(intent.category, 'filesystem');
  assert.ok(intent.confidence <= 0.93, 'confidence is clamped below the local parser ceiling');
});

test('claude cli intent adapter fails safe on garbage output and cli errors', () => {
  const garbage = new ClaudeCliSemanticIntentAdapter({ runner: () => '분류할 수 없습니다. JSON이 아님.' });
  const failed = garbage.parse('엑셀 만들어', { requestId: 'req_test_3' });
  assert.equal(failed.actionType, null);
  assert.equal(failed.confidence, 0);
  assert.equal(failed.semantic.failed, true);

  const throwing = new ClaudeCliSemanticIntentAdapter({
    runner: () => {
      throw new Error('spawn claude ENOENT');
    }
  });
  const errored = throwing.parse('엑셀 만들어', { requestId: 'req_test_4' });
  assert.equal(errored.actionType, null);
  assert.match(errored.semantic.failureReason, /ENOENT/);

  const unknownAction = new ClaudeCliSemanticIntentAdapter({
    runner: () => llmResponse({ actionType: 'LAUNCH_MISSILE', confidence: 0.9 })
  });
  const rejected = unknownAction.parse('미사일 발사해', { requestId: 'req_test_5' });
  assert.equal(rejected.actionType, null);
  assert.equal(rejected.semantic.failureReason, 'unrecognized-action-type');
});

test('policy-gated parser skips the LLM when local confidence is high and falls back on LLM failure', () => {
  let llmCalls = 0;
  const parser = createIntentParserFromEnv({
    env: { JARVIS_LLM_INTENT: '1' },
    runner: () => {
      llmCalls += 1;
      throw new Error('unavailable');
    }
  });
  assert.ok(parser, 'parser is created when the env flag is on');

  const clear = parser.parse('보고서 엑셀 만들어줘', { requestId: 'req_test_6' });
  assert.equal(clear.actionType, ActionType.CREATE_FILE);
  assert.equal(llmCalls, 0, 'high-confidence local parse must not call the LLM');

  const vague = parser.parse('음 그거 있잖아 어제 그거 어떻게 됐는지 좀', { requestId: 'req_test_7' });
  assert.ok(vague.actionType, 'LLM failure still yields the local fallback candidate');
  assert.equal(llmCalls, 1, 'vague command consults the LLM once');

  assert.equal(createIntentParserFromEnv({ env: {} }), null, 'flag off returns null so CoreFacade keeps the rule parser');
});

test('policy-gated parser keeps high-confidence rule parses unambiguous when LLM mode is enabled', () => {
  let llmCalls = 0;
  const parser = createIntentParserFromEnv({
    env: { JARVIS_LLM_INTENT: '1' },
    runner: () => {
      llmCalls += 1;
      throw new Error('must not be called for clear local commands');
    }
  });
  const intent = parser.parse('엑셀 만들어', { requestId: 'req_clear_xlsx' });
  assert.equal(intent.actionType, ActionType.CREATE_FILE);
  assert.equal(intent.confidence >= 0.85, true);
  assert.equal(intent.semantic?.rulePrimary, true);
  assert.equal(intent.candidates.length, 1);
  assert.equal(llmCalls, 0);
});

test('intent parser env selects API runners before the claude CLI fallback', () => {
  const openAiParser = createIntentParserFromEnv({
    env: {
      JARVIS_LLM_INTENT: '1',
      JARVIS_OPENAI_API_KEY: 'sk-test',
      JARVIS_OPENAI_MODEL: 'gpt-test-fast'
    }
  });
  assert.equal(openAiParser.externalAdapter.runnerProvider, 'openai-api');
  assert.equal(openAiParser.externalAdapter.runnerExternalService, 'openai-api');
  assert.equal(openAiParser.externalAdapter.runnerModel, 'gpt-test-fast');

  const anthropicParser = createIntentParserFromEnv({
    env: {
      JARVIS_LLM_INTENT: '1',
      JARVIS_ANTHROPIC_API_KEY: 'anthropic-test',
      JARVIS_OPENAI_API_KEY: 'sk-test'
    }
  });
  assert.equal(anthropicParser.externalAdapter.runnerProvider, 'anthropic-api');
  assert.equal(anthropicParser.externalAdapter.runnerExternalService, 'anthropic-api');
});

test('direct API runners keep credentials out of process arguments', () => {
  const calls = [];
  const execFileSyncImpl = (file, args, options) => {
    calls.push({ file, args, input: options.input });
    return calls.length === 1
      ? JSON.stringify({ choices: [{ message: { content: '{"actionType":"LIST_FILES"}' } }] })
      : JSON.stringify({ content: [{ type: 'text', text: '{"actionType":"LIST_FILES"}' }] });
  };
  const openAiKey = 'sk-openai-command-line-secret';
  const anthropicKey = 'sk-ant-command-line-secret';

  const openAi = createOpenAiApiRunner({ apiKey: openAiKey, execFileSyncImpl });
  const anthropic = createApiRunner({ apiKey: anthropicKey, execFileSyncImpl });
  assert.match(openAi('list files'), /LIST_FILES/);
  assert.match(anthropic('list files'), /LIST_FILES/);

  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.file, 'curl');
    assert.deepEqual(call.args, ['--config', '-']);
    assert.doesNotMatch(JSON.stringify(call.args), /command-line-secret/);
    assert.match(call.input, /command-line-secret/);
  }
  assert.match(calls[0].input, /reasoning_effort.*none/);
  assert.match(calls[0].input, /response_format.*json_object/);
});

test('OpenAI runner removes only the unsupported strict field on retry', () => {
  const inputs = [];
  const runner = createOpenAiApiRunner({
    apiKey: 'sk-retry-test',
    execFileSyncImpl: (_file, _args, options) => {
      inputs.push(options.input);
      if (inputs.length === 1) {
        return JSON.stringify({ error: { message: 'Unsupported parameter: reasoning_effort' } });
      }
      return JSON.stringify({
        model: 'gpt-5.4-2026-03-05',
        usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 },
        choices: [{ message: { content: '{"ok":true}' } }]
      });
    }
  });

  assert.equal(runner('return json'), '{"ok":true}');
  assert.equal(inputs.length, 2);
  assert.match(inputs[0], /reasoning_effort/);
  assert.match(inputs[0], /response_format/);
  assert.doesNotMatch(inputs[1], /reasoning_effort/);
  assert.match(inputs[1], /response_format/);
});

test('OpenAI runner maps balanced work to Terra and falls back when model access is unavailable', () => {
  const inputs = [];
  const runner = createOpenAiApiRunner({
    apiKey: 'sk-model-fallback-test',
    model: 'sonnet',
    execFileSyncImpl: (_file, _args, options) => {
      inputs.push(options.input);
      if (inputs.length === 1) {
        return JSON.stringify({ error: { message: 'The model gpt-5.6-terra does not exist or you do not have access to it.' } });
      }
      return JSON.stringify({
        model: 'gpt-5.4-2026-03-05',
        usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 },
        choices: [{ message: { content: '{"ok":true}' } }]
      });
    }
  });

  assert.equal(runner.model, 'gpt-5.6-terra');
  assert.deepEqual(runner.modelCandidates, ['gpt-5.6-terra', 'gpt-5.4']);
  assert.equal(runner('return json'), '{"ok":true}');
  assert.equal(inputs.length, 2);
  assert.match(inputs[0], /gpt-5\.6-terra/);
  assert.match(inputs[1], /gpt-5\.4/);
  assert.equal(runner.lastModel, 'gpt-5.4-2026-03-05');
  assert.deepEqual(runner.lastUsage, { inputTokens: 20, outputTokens: 3, totalTokens: 23 });
});

test('LLM provider chain uses the next configured runner and records effective telemetry', () => {
  const primary = Object.assign(() => {
    throw new Error('temporary provider failure with private details');
  }, { provider: 'anthropic-api', externalService: 'anthropic-api', model: 'claude-test' });
  const secondary = Object.assign(() => '{"ok":true}', {
    provider: 'openai-api',
    externalService: 'openai-api',
    model: 'gpt-test'
  });
  const chain = createRunnerFallbackChain([primary, secondary]);

  assert.equal(chain('return json'), '{"ok":true}');
  assert.equal(chain.provider, 'anthropic-api');
  assert.equal(chain.lastProvider, 'openai-api');
  assert.equal(chain.lastExternalService, 'openai-api');
  assert.equal(chain.lastModel, 'gpt-test');
  assert.deepEqual(chain.providerChain.map((item) => item.provider), ['anthropic-api', 'openai-api']);
  assert.equal(chain.lastFailures.length, 1);
});

test('async mission runner keeps provider fallback and telemetry without blocking the caller', async () => {
  const primary = Object.assign(async () => {
    await new Promise((resolve) => setTimeout(resolve, 2));
    throw new Error('temporary async provider failure');
  }, { provider: 'anthropic-api', externalService: 'anthropic-api', model: 'claude-test' });
  const secondary = Object.assign(async () => '{"ok":true}', {
    provider: 'openai-api',
    externalService: 'openai-api',
    model: 'gpt-test'
  });
  const chain = createAsyncRunnerFallbackChain([primary, secondary]);

  assert.equal(await chain('return json'), '{"ok":true}');
  assert.equal(chain.lastProvider, 'openai-api');
  assert.equal(chain.lastFailures.length, 1);
});

test('sync and async fallback telemetry redacts provider error messages and untrusted codes', async () => {
  const secret = 'private-article-body-and-fixture-api-key';
  const syncPrimary = Object.assign(() => { throw Object.assign(new Error(secret), {
    code: secret, detail: secret, responseBody: secret
  }); }, { provider: 'anthropic-api' });
  const asyncPrimary = Object.assign(async () => { throw Object.assign(new Error(secret), {
    code: secret, detail: secret, responseBody: secret
  }); }, { provider: 'anthropic-api' });
  const secondary = Object.assign(() => '{"ok":true}', { provider: 'openai-api' });

  const syncChain = createRunnerFallbackChain([syncPrimary, secondary]);
  assert.equal(syncChain('request prompt'), '{"ok":true}');
  assert.deepEqual(syncChain.lastFailures, [{ provider: 'anthropic-api', code: 'provider-error', retryable: false }]);
  const asyncChain = createAsyncRunnerFallbackChain([asyncPrimary,
    Object.assign(async () => '{"ok":true}', { provider: 'openai-api' })]);
  assert.equal(await asyncChain('request prompt'), '{"ok":true}');
  assert.deepEqual(asyncChain.lastFailures, [{ provider: 'anthropic-api', code: 'provider-error', retryable: false }]);
  assert.doesNotMatch(JSON.stringify([syncChain.lastFailures, asyncChain.lastFailures]), /private-article-body|fixture-api-key/);
});

test('async provider aborts preserve cancellation without retaining provider error text', async () => {
  const secret = 'private-prompt-and-provider-token';
  const abortRunner = Object.assign(async () => {
    const error = new Error(secret);
    error.name = 'AbortError';
    error.code = secret;
    throw error;
  }, { provider: 'anthropic-api' });
  const chain = createAsyncRunnerFallbackChain([
    abortRunner,
    Object.assign(async () => 'must-not-run', { provider: 'openai-api' })
  ]);

  await assert.rejects(chain('private user request'), (error) => {
    assert.equal(error.name, 'AbortError');
    assert.equal(error.code, 'ABORT_ERR');
    assert.equal(error.message, 'llm-provider-chain-aborted');
    assert.doesNotMatch(JSON.stringify(error), /private-prompt-and-provider-token/);
    return true;
  });
  assert.equal(chain.lastFailures, undefined);
});

test('exhausted sync and async provider chains expose only safe failure summaries', async () => {
  const secret = 'private-prompt-provider-key-and-response-body';
  const throwing = (provider) => Object.assign(() => {
    const error = new Error(secret);
    error.code = secret;
    error.responseBody = secret;
    throw error;
  }, { provider });
  const syncChain = createRunnerFallbackChain([throwing('anthropic-api'), throwing('openai-api')]);
  assert.throws(() => syncChain('private user request'), (error) => {
    assert.equal(error.message, 'llm-provider-chain-failed:anthropic-api>openai-api');
    assert.doesNotMatch(error.message, /private-prompt-provider-key-and-response-body/);
    return true;
  });
  assert.deepEqual(syncChain.lastFailures, [
    { provider: 'anthropic-api', code: 'provider-error', retryable: false },
    { provider: 'openai-api', code: 'provider-error', retryable: false }
  ]);

  const asyncChain = createAsyncRunnerFallbackChain([
    Object.assign(async () => { throw Object.assign(new Error(secret), { code: secret, responseBody: secret }); }, { provider: 'xai' }),
    Object.assign(async () => { throw Object.assign(new Error(secret), { code: secret, responseBody: secret }); }, { provider: 'gemini' })
  ]);
  await assert.rejects(asyncChain('private user request'), (error) => {
    assert.equal(error.message, 'llm-provider-chain-failed:xai>gemini');
    assert.doesNotMatch(error.message, /private-prompt-provider-key-and-response-body/);
    return true;
  });
  assert.deepEqual(asyncChain.lastFailures, [
    { provider: 'xai', code: 'provider-error', retryable: false },
    { provider: 'gemini', code: 'provider-error', retryable: false }
  ]);
  assert.doesNotMatch(JSON.stringify([syncChain.lastFailures, asyncChain.lastFailures]), /private-prompt-provider-key-and-response-body/);
});

test('Windows Claude cleanup targets the whole spawned shell process tree without another shell', async () => {
  let invocation = null;
  const child = { pid: 43210 };
  const stopped = await terminateLlmProcessTree(child, {
    platform: 'win32',
    spawnImpl(command, args, options) {
      invocation = { command, args, options };
      const killer = new EventEmitter();
      queueMicrotask(() => killer.emit('exit', 0, null));
      return killer;
    }
  });

  assert.equal(stopped, true);
  assert.equal(invocation.command, 'taskkill.exe');
  assert.deepEqual(invocation.args, ['/PID', '43210', '/T', '/F']);
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.windowsHide, true);
});

test('async Claude timeout is retryable and invokes process-tree cleanup', async () => {
  const child = new EventEmitter();
  child.pid = 54321;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = { end() {} };
  child.kill = () => {
    throw new Error('single-process kill must not be used after tree cleanup');
  };
  const cleaned = [];
  const runner = createAsyncClaudeCliRunner({
    apiKey: '',
    openAiApiKey: '',
    command: 'claude-test',
    model: 'sonnet',
    timeoutMs: 15,
    shell: true,
    spawnImpl: () => child,
    terminateProcessTreeImpl: async (spawned) => {
      cleaned.push(spawned.pid);
      return true;
    }
  });

  await assert.rejects(
    runner('bounded timeout test'),
    (error) => error?.code === 'ETIMEDOUT' && error?.retryable === true
  );
  assert.deepEqual(cleaned, [54321]);
});

test('async OpenAI mission runner uses fetch and preserves model telemetry', async () => {
  const requests = [];
  const runner = createAsyncClaudeCliRunner({
    apiKey: '',
    openAiApiKey: 'sk-async-test',
    openAiModel: 'gpt-test',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return {
        status: 200,
        text: async () => JSON.stringify({
          model: 'gpt-test-2026-08-17',
          usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
          choices: [{ message: { content: '{"ok":true}' } }]
        })
      };
    },
    spawnImpl: () => {
      throw new Error('CLI fallback must not run');
    }
  });

  assert.equal(await runner('return json'), '{"ok":true}');
  assert.equal(requests.length, 1);
  assert.equal(runner.lastProvider, 'openai-api');
  assert.equal(runner.lastModel, 'gpt-test-2026-08-17');
  assert.deepEqual(runner.lastUsage, { inputTokens: 12, outputTokens: 4, totalTokens: 16 });
});

test('semantic intent evidence names the provider that actually completed a fallback call', () => {
  const primary = Object.assign(() => {
    throw new Error('anthropic temporarily unavailable');
  }, { provider: 'anthropic-api', externalService: 'anthropic-api', model: 'claude-test' });
  const secondary = Object.assign(() => JSON.stringify({
    actionType: ActionType.LIST_FILES,
    confidence: 0.9,
    reasons: ['local directory listing'],
    slots: { directoryHint: 'workspace' }
  }), { provider: 'openai-api', externalService: 'openai-api', model: 'gpt-test' });
  const adapter = new ClaudeCliSemanticIntentAdapter({
    runner: createRunnerFallbackChain([primary, secondary])
  });
  const intent = adapter.parse('workspace 파일 목록을 보여줘', { requestId: 'req_provider_fallback_evidence' });

  assert.equal(intent.actionType, ActionType.LIST_FILES);
  assert.equal(intent.semantic.runnerProvider, 'openai-api');
  assert.equal(intent.semantic.externalService, 'openai-api');
  assert.equal(intent.semantic.model, 'gpt-test');
  assert.deepEqual(intent.semantic.providerChain, ['anthropic-api', 'openai-api']);
  assert.equal(intent.semantic.providerFallbackCount, 1);
  assert.equal(intent.reasons.includes('llm_runner:openai-api'), true);
});

test('semantic intent cache evidence does not claim a second external raw-command disclosure', () => {
  let calls = 0;
  const runner = Object.assign(() => {
    calls += 1;
    return JSON.stringify({ actionType: ActionType.LIST_FILES, confidence: 0.9, slots: {} });
  }, { provider: 'openai-api', externalService: 'openai-api', model: 'gpt-test' });
  const adapter = new ClaudeCliSemanticIntentAdapter({ runner });
  const first = adapter.parse('캐시 증거용 로컬 파일 목록 보여줘', { requestId: 'req_cache_first' });
  const second = adapter.parse('캐시 증거용 로컬 파일 목록 보여줘', { requestId: 'req_cache_second' });

  assert.equal(calls, 1);
  assert.equal(first.semantic.rawCommandSharedWithModel, true);
  assert.equal(first.semantic.runnerProvider, 'openai-api');
  assert.equal(second.semantic.rawCommandSharedWithModel, false);
  assert.equal(second.semantic.runnerProvider, 'local-intent-cache');
  assert.equal(second.semantic.externalService, 'local-cache');
  assert.deepEqual(second.semantic.providerChain, ['local-intent-cache']);
  assert.equal(second.semantic.providerFallbackCount, 0);
  assert.equal(second.semantic.latencyMs, 0);
});

test('LLM provider diagnostics report readiness without retaining credentials', async () => {
  const env = {
    JARVIS_ANTHROPIC_API_KEY: 'anthropic-diagnostic-secret-value',
    JARVIS_OPENAI_API_KEY: 'openai-diagnostic-secret-value'
  };
  const readiness = createLlmProviderReadiness({
    env,
    cliProbe: { available: true, version: 'test-cli' }
  });
  assert.deepEqual(readiness.providerOrder, ['anthropic-api', 'openai-api', 'claude-cli']);
  assert.equal(readiness.credentials.rawCredentialStored, false);
  assert.doesNotMatch(JSON.stringify(readiness), /diagnostic-secret-value/);

  const report = await runLlmProviderDiagnostics({
    env,
    live: true,
    cliProbe: { available: true, version: 'test-cli' },
    runnerFactory: () => Object.assign(() => '{"ok":true}', {
      provider: 'openai-api',
      externalService: 'openai-api',
      model: 'gpt-test',
      lastProvider: 'openai-api',
      lastExternalService: 'openai-api',
      lastModel: 'gpt-test',
      lastUsage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      lastCostUsd: 0.001,
      lastFailures: [{ provider: 'anthropic-api' }]
    }),
    clock: () => new Date(0)
  });
  assert.equal(report.status, 'passed');
  assert.equal(report.liveProbe.provider, 'openai-api');
  assert.equal(report.liveProbe.providerFallbackCount, 1);
  assert.deepEqual(report.liveProbe.usage, { inputTokens: 10, outputTokens: 2, totalTokens: 12 });
  assert.equal(report.liveProbe.providerCostUsd, 0.001);
  assert.equal(report.liveProbe.rawResponseStored, false);
  assert.doesNotMatch(JSON.stringify(report), /diagnostic-secret-value/);
});

test('LLM provider diagnostics classifies expired Claude auth without retaining the provider error', async () => {
  const rawProviderError = 'Failed to authenticate. API Error: 401 OAuth access token has expired.';
  const runner = Object.assign(() => {
    const error = new Error('claude-cli-authentication-required: Claude CLI authentication is missing or expired.');
    error.code = 'claude-cli-authentication-required';
    throw error;
  }, {
    provider: 'claude-cli',
    externalService: 'anthropic-claude-cli',
    model: 'cli-default'
  });

  const report = await runLlmProviderDiagnostics({
    env: {},
    live: true,
    cliProbe: { available: true, version: 'test-cli' },
    runnerFactory: () => runner,
    clock: () => new Date(0)
  });

  assert.equal(report.status, 'blocked-authentication');
  assert.equal(report.liveProbe.errorCode, 'provider-authentication-required');
  assert.equal(report.liveProbe.category, 'authentication');
  assert.equal(report.liveProbe.requiresUserAction, true);
  assert.equal(report.liveProbe.retryable, false);
  assert.deepEqual(report.liveProbe.attemptedProviders, ['claude-cli']);
  assert.match(report.liveProbe.nextAction, /claude auth login/);
  assert.doesNotMatch(JSON.stringify(report), /OAuth access token has expired/);
  assert.doesNotMatch(JSON.stringify(report), new RegExp(rawProviderError.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('LLM public status exposes only the allowed recovery contract', () => {
  const publicStatus = createPublicLlmProviderStatus({
    generatedAt: '2026-07-21T00:00:00.000Z',
    status: 'blocked-authentication',
    readiness: {
      ready: true,
      providerOrder: ['claude-cli'],
      credentials: { openAiApiKey: 'must-not-leak' }
    },
    liveProbe: {
      passed: false,
      category: 'authentication',
      requiresUserAction: true,
      attemptedProviders: ['claude-cli'],
      nextAction: 'raw provider advice must not be exposed',
      errorFingerprint: 'private-fingerprint',
      rawPrompt: 'private prompt',
      rawResponse: 'private response',
      providerCostUsd: 99,
      usage: { inputTokens: 999 }
    }
  });

  assert.equal(publicStatus.status, 'blocked-authentication');
  assert.equal(publicStatus.liveVerified, false);
  assert.equal(publicStatus.recovery.command, 'claude auth login');
  assert.equal(publicStatus.recovery.verificationCommand, 'npm run llm:diagnose -- --live');
  assert.equal(publicStatus.rawReportsExposed, false);
  assert.doesNotMatch(
    JSON.stringify(publicStatus),
    /must-not-leak|raw provider advice|private-fingerprint|private prompt|private response|inputTokens|providerCostUsd/
  );
});

test('OpenAI runner completes an actual local HTTP round trip through curl stdin config', async () => {
  const server = spawn(process.execPath, ['tests/fixtures/openai-api-stub.mjs'], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  const exitPromise = once(server, 'exit');
  try {
    const [portChunk] = await once(server.stdout, 'data');
    const port = Number(String(portChunk).trim());
    assert.equal(Number.isInteger(port) && port > 0, true);

    const runner = createOpenAiApiRunner({
      apiKey: 'sk-local-roundtrip',
      openAiModel: 'gpt-test-roundtrip',
      endpoint: `http://127.0.0.1:${port}/v1/chat/completions`,
      timeoutMs: 5000
    });
    const received = JSON.parse(runner('한글 JSON 왕복'));
    assert.equal(received.method, 'POST');
    assert.equal(received.authorization, 'Bearer sk-local-roundtrip');
    assert.equal(received.model, 'gpt-test-roundtrip');
    assert.equal(received.prompt, '한글 JSON 왕복');
    assert.equal(received.reasoningEffort, 'none');
    assert.equal(received.responseFormat, 'json_object');

    const [exitCode] = await exitPromise;
    assert.equal(exitCode, 0);
  } finally {
    if (server.exitCode === null) server.kill();
  }
});

test('vague command routes through the LLM adapter and completes task creation end to end', () => {
  const runner = () => llmResponse({
    actionType: ActionType.BROWSER_SEARCH,
    confidence: 0.86,
    reasons: ['최근 소식 조회 요청'],
    slots: { query: '로키드 맥스 신제품 소식' }
  });
  const runtime = createAgRuntime({
    intentParser: createIntentParserFromEnv({ env: { JARVIS_LLM_INTENT: '1' }, runner }),
    auditRoot: 'logs/test-llm-intent',
    workerQueueStorePath: null,
    workerLeaseStorePath: null
  });
  const created = runtime.coreFacade.createTask('로키드 맥스 신제품 소식 좀 궁금한데');
  const task = created.task ?? created;
  const intent = task.intent ?? created.intent;
  assert.ok(intent, 'created task exposes intent');
  assert.equal(intent.actionType, ActionType.BROWSER_SEARCH);
  assert.equal(intent.semantic?.policyGate?.usedExternal, true);
  assert.equal(intent.semantic?.externalCandidate?.actionType, ActionType.BROWSER_SEARCH);
});
