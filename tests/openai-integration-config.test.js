import test from 'node:test';
import assert from 'node:assert/strict';
import { createIntentParserFromEnv, createRunnerFallbackChain } from '../packages/core/src/intent/claude-cli-intent-adapter.js';
import { createTaskPlannerFromEnv } from '../packages/core/src/planning/claude-cli-task-planner.js';
import { createMissionPlannerFromEnv } from '../packages/core/src/mission/mission-planner.js';
import { createLlmProviderReadiness, runLlmProviderDiagnostics } from '../scripts/llm-provider-diagnostics.mjs';

const configuredEnv = {
  JARVIS_LLM_INTENT: '1', JARVIS_LLM_PLANNER: '1', JARVIS_LLM_CONTENT: '1',
  JARVIS_OPENAI_API_KEY: 'fixture-key-never-transmitted',
  JARVIS_OPENAI_MODEL: 'fixture-selected-model',
  JARVIS_MISSION_OPENAI_MODEL: 'fixture-mission-model'
};

for (const api of ['responses', 'chat-completions']) {
  test(`explicit environment selects ${api} for intent, plan, content and mission without a model call`, () => {
    const env = { ...configuredEnv, JARVIS_OPENAI_API: api };
    const intent = createIntentParserFromEnv({ env });
    const planner = createTaskPlannerFromEnv({ env });
    const mission = createMissionPlannerFromEnv({ env });
    for (const runner of [intent.externalAdapter.runner, planner.runner, planner.contentRunner, mission.runner]) {
      assert.equal(runner.api, api);
      assert.equal(runner.providerChain.find((item) => item.provider === 'openai-api').api, api);
    }
    assert.equal(planner.runner.model, 'fixture-selected-model');
    assert.equal(mission.runner.model, 'fixture-mission-model');
  });
}

test('absent API selection preserves Chat Completions and invalid selection fails explicitly', () => {
  assert.equal(createMissionPlannerFromEnv({ env: configuredEnv }).runner.api, 'chat-completions');
  const env = { ...configuredEnv, JARVIS_OPENAI_API: 'response-typo' };
  for (const factory of [createIntentParserFromEnv, createTaskPlannerFromEnv, createMissionPlannerFromEnv]) {
    assert.throws(() => factory({ env }), /unsupported API mode/);
  }
});

test('readiness distinguishes Responses configuration from live verification and keeps keys private', async () => {
  const env = { ...configuredEnv, JARVIS_OPENAI_API: 'responses' };
  const readiness = createLlmProviderReadiness({ env });
  assert.deepEqual(readiness.openAiTransport, {
    api: 'responses', requestStore: false, toolExecutionEnabled: false, liveVerified: false
  });
  assert.doesNotMatch(JSON.stringify(readiness), /fixture-key-never-transmitted/);
  const offline = await runLlmProviderDiagnostics({ env, cliProbe: { available: false }, runnerFactory() {
    throw new Error('offline diagnostics must not call a model');
  } });
  assert.equal(offline.status, 'ready-unverified');
  assert.equal(offline.liveProbe.requested, false);
  const report = await runLlmProviderDiagnostics({
    env, live: true, cliProbe: { available: false },
    runnerFactory(options) {
      assert.equal(options.openAiApi, 'responses');
      return Object.assign(() => '{"ok":true}', {
        provider: 'openai-api', api: 'responses', model: options.openAiModel
      });
    }
  });
  assert.equal(report.liveProbe.api, 'responses');
  assert.equal(report.liveProbe.passed, true);
});

test('diagnostics does not attribute a Claude fallback success to configured OpenAI Responses', async () => {
  const runner = createRunnerFallbackChain([
    Object.assign(() => { throw new Error('OpenAI unavailable'); }, {
      provider: 'openai-api', api: 'responses', model: 'fixture-openai'
    }),
    Object.assign(() => '{"ok":true}', { provider: 'claude-cli', model: 'fixture-claude' })
  ]);
  const report = await runLlmProviderDiagnostics({
    env: { ...configuredEnv, JARVIS_OPENAI_API: 'responses' },
    live: true, cliProbe: { available: false }, runnerFactory: () => runner
  });
  assert.equal(report.status, 'passed');
  assert.equal(report.liveProbe.provider, 'claude-cli');
  assert.equal(report.liveProbe.api, null);
  assert.equal(report.liveProbe.providerFallbackCount, 1);
});
