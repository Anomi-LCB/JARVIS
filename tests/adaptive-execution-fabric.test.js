import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecutionHealthRegistry } from '../packages/core/src/routing/execution-health-registry.js';
import { ExecutionChannel, ExecutionStrategyRouter } from '../packages/core/src/routing/execution-strategy-router.js';
import { createExecutionEnvironmentProfile } from '../packages/core/src/runtime/execution-environment-optimizer.js';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';

test('execution health opens, probes, and closes a circuit without retaining commands', () => {
  let now = new Date('2026-08-18T00:00:00.000Z');
  const registry = new ExecutionHealthRegistry({
    clock: () => new Date(now),
    failureThreshold: 3,
    cooldownMs: 5_000
  });

  for (let index = 0; index < 3; index += 1) {
    registry.record({ toolName: 'browser.search', status: 'failed', durationMs: 100 + index, errorCode: 'B_BROWSER_UNAVAILABLE' });
  }
  const opened = registry.statusFor('browser.search');
  assert.equal(opened.circuitState, 'open');
  assert.equal(opened.eligible, false);
  assert.equal(opened.consecutiveFailures, 3);
  assert.equal(opened.observedReliability, 0);

  now = new Date('2026-08-18T00:00:06.000Z');
  assert.equal(registry.statusFor('browser.search').circuitState, 'half_open');
  registry.record({ toolName: 'browser.search', status: 'completed', durationMs: 40 });
  const recovered = registry.statusFor('browser.search');
  assert.equal(recovered.circuitState, 'closed');
  assert.equal(recovered.consecutiveFailures, 0);
  assert.equal(JSON.stringify(registry.snapshot()).includes('rawText'), false);
});

test('execution health persists only bounded operational evidence across restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-execution-health-'));
  const storePath = join(root, 'health.json');
  try {
    const first = new ExecutionHealthRegistry({ storePath, sampleLimit: 8 });
    first.record({ toolName: 'filesystem.listFiles', status: 'completed', durationMs: 21 });
    first.record({ toolName: 'filesystem.listFiles', status: 'completed', durationMs: 17 });
    const second = new ExecutionHealthRegistry({ storePath, sampleLimit: 8 });
    const restored = second.statusFor('filesystem.listFiles');
    assert.equal(restored.sampleCount, 2);
    assert.equal(restored.successCount, 2);
    assert.equal(restored.circuitState, 'closed');
    assert.equal(second.snapshot().persistence.rawCommandStored, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('adaptive routing strongly demotes a tool with an open circuit', () => {
  const healthRegistry = new ExecutionHealthRegistry({ failureThreshold: 3 });
  const router = new ExecutionStrategyRouter({
    healthRegistry,
    maxCatalogSize: 4,
    profiles: {
      'web.primary': {
        channel: ExecutionChannel.HOSTED_AI_TOOL,
        expectedLatencyMs: 400,
        reliability: 0.99,
        modelRoundTrips: 0,
        fallbackToolNames: ['web.fallback']
      },
      'web.fallback': {
        channel: ExecutionChannel.WEB_DOM,
        expectedLatencyMs: 900,
        reliability: 0.82,
        modelRoundTrips: 0,
        fallbackToolNames: []
      }
    }
  });
  const capabilities = [
    syntheticSkill('web.primary', 'Hosted search'),
    syntheticSkill('web.fallback', 'Browser search')
  ];
  assert.equal(router.rank(capabilities, { objective: '웹에서 최신 자료를 검색해' })[0].skill.toolName, 'web.primary');
  for (let index = 0; index < 3; index += 1) {
    healthRegistry.record({ toolName: 'web.primary', status: 'failed', errorCode: 'UPSTREAM_UNAVAILABLE' });
  }
  const ranked = router.rank(capabilities, { objective: '웹에서 최신 자료를 검색해' });
  assert.equal(ranked[0].skill.toolName, 'web.fallback');
  assert.equal(ranked[1].health.circuitState, 'open');
  assert.equal(ranked[1].reasons.includes('health:circuit-open'), true);
});

test('environment optimizer applies machine-tier tuning and never exposes credentials', () => {
  const profile = createExecutionEnvironmentProfile({
    env: {
      JARVIS_OPENAI_API_KEY: 'secret-openai-value',
      JARVIS_MCP_SERVER_URLS: 'https://private.example/mcp'
    },
    system: {
      platform: 'win32',
      architecture: 'x64',
      nodeVersion: 'v24.8.0',
      logicalProcessors: 12,
      totalMemoryBytes: 32 * 1024 ** 3,
      freeMemoryBytes: 12 * 1024 ** 3
    }
  });

  assert.equal(profile.system.performanceTier, 'performance');
  assert.equal(profile.applied.workerMaxQueueConcurrency.value, 6);
  assert.equal(profile.applied.workerMaxPlanParallelism.value, 4);
  assert.equal(profile.channels.hostedAi.status, 'configured-unverified');
  assert.equal(profile.channels.mcp.status, 'configured-unverified');
  assert.equal(profile.privacy.credentialValuesStored, false);
  assert.doesNotMatch(JSON.stringify(profile), /secret-openai-value|private\.example/);
});

test('environment optimizer preserves explicit operator settings on constrained machines', () => {
  const profile = createExecutionEnvironmentProfile({
    env: {},
    requested: { workerMaxQueueConcurrency: 3, missionMaxPlannerTools: 9 },
    system: {
      platform: 'win32',
      logicalProcessors: 2,
      totalMemoryBytes: 4 * 1024 ** 3,
      freeMemoryBytes: 512 * 1024 ** 2
    }
  });
  assert.equal(profile.system.performanceTier, 'constrained');
  assert.deepEqual(profile.applied.workerMaxQueueConcurrency, { value: 3, source: 'explicit-configuration' });
  assert.deepEqual(profile.applied.missionMaxPlannerTools, { value: 9, source: 'explicit-configuration' });
  assert.equal(profile.applied.workerMaxPlanParallelism.value, 2);
});

test('real worker execution feeds adaptive health and admin diagnostics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-adaptive-worker-'));
  try {
    await writeFile(join(root, 'health-proof.txt'), 'ready', 'utf8');
    const runtime = createAgRuntime({
      allowedRoots: [root],
      auditRoot: join(root, 'audit'),
      cwd: () => root,
      env: {},
      workerDaemonEnabled: false
    });
    const task = runtime.coreFacade.createTask('작업공간 파일 목록을 보여줘');
    const result = await runtime.orchestrationWorker.runTask(task.taskId, {
      userConfirmation: { confirmed: true }
    });
    assert.equal(result.success, true, JSON.stringify(result));
    const health = runtime.coreFacade.executionHealthRegistry.statusFor('filesystem.listFiles');
    assert.equal(health.sampleCount, 1);
    assert.equal(health.successCount, 1);
    assert.equal(health.circuitState, 'closed');
    const diagnostics = runtime.coreFacade.adminDiagnostics();
    assert.equal(diagnostics.executionFabric.fabricVersion, 'a-adaptive-execution-fabric-v2');
    assert.equal(diagnostics.executionFabric.adaptiveRouting.enabled, true);
    assert.equal(diagnostics.executionHealth.summary.observedToolCount, 1);
    assert.ok(diagnostics.executionEnvironment.applied.workerMaxQueueConcurrency.value >= 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function syntheticSkill(toolName, label) {
  return {
    toolName,
    label,
    category: 'browser',
    actionType: 'BROWSER_SEARCH',
    match: { keywords: ['웹', '검색', '최신'] },
    capability: {
      externalNetwork: true,
      externalTransfer: false,
      writesLocalFiles: false
    },
    lifecycle: { routable: true }
  };
}
