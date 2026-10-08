import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExecutionHealthRegistry } from '../packages/core/src/routing/execution-health-registry.js';
import { ExecutionChannel, ExecutionStrategyRouter } from '../packages/core/src/routing/execution-strategy-router.js';
import { createExecutionEnvironmentProfile } from '../packages/core/src/runtime/execution-environment-optimizer.js';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = resolve(root, process.argv[2] ?? 'dist/verification/adaptive-execution-fabric-audit.json');
const markdownPath = outputPath.replace(/\.json$/i, '.md');
const labRoot = await mkdtemp(join(tmpdir(), 'jarvis-adaptive-fabric-audit-'));
const checks = [];

try {
  const profile = createExecutionEnvironmentProfile({ env: process.env });
  check('environment_tier_selected', ['constrained', 'balanced', 'performance'].includes(profile.system.performanceTier), {
    tier: profile.system.performanceTier
  });
  check('environment_tuning_applied', Object.values(profile.applied).every((item) => Number.isFinite(item.value) && item.value > 0), {
    applied: profile.applied
  });
  check('environment_profile_is_secret_free', profile.privacy.credentialValuesStored === false
    && profile.privacy.environmentValuesStored === false
    && !/sk-[a-z0-9]|api[_-]?key|bearer\s/i.test(JSON.stringify(profile)), {});

  let now = new Date('2026-08-18T00:00:00.000Z');
  const healthPath = join(labRoot, 'health.json');
  const registry = new ExecutionHealthRegistry({
    clock: () => new Date(now),
    storePath: healthPath,
    failureThreshold: 3,
    cooldownMs: 5_000
  });
  for (let index = 0; index < 3; index += 1) {
    registry.record({ toolName: 'hosted.search', status: 'failed', durationMs: 100, errorCode: 'UPSTREAM_UNAVAILABLE' });
  }
  check('repeated_failures_open_circuit', registry.statusFor('hosted.search').circuitState === 'open', registry.statusFor('hosted.search'));
  const restored = new ExecutionHealthRegistry({
    clock: () => new Date(now),
    storePath: healthPath,
    failureThreshold: 3,
    cooldownMs: 5_000
  });
  check('health_survives_restart', restored.statusFor('hosted.search').sampleCount === 3
    && restored.statusFor('hosted.search').circuitState === 'open', restored.statusFor('hosted.search'));
  now = new Date('2026-08-18T00:00:06.000Z');
  check('cooldown_enters_half_open_probe', restored.statusFor('hosted.search').circuitState === 'half_open', restored.statusFor('hosted.search'));
  restored.record({ toolName: 'hosted.search', status: 'completed', durationMs: 35 });
  check('successful_probe_recovers_circuit', restored.statusFor('hosted.search').circuitState === 'closed', restored.statusFor('hosted.search'));

  for (let index = 0; index < 3; index += 1) {
    restored.record({ toolName: 'hosted.search', status: 'failed', durationMs: 100, errorCode: 'UPSTREAM_UNAVAILABLE' });
  }
  const router = new ExecutionStrategyRouter({
    healthRegistry: restored,
    profiles: {
      'hosted.search': routeProfile(ExecutionChannel.HOSTED_AI_TOOL, 300, 0.99, ['browser.search']),
      'browser.search': routeProfile(ExecutionChannel.WEB_DOM, 900, 0.84, [])
    }
  });
  const candidates = [syntheticSkill('hosted.search'), syntheticSkill('browser.search')];
  const ranked = router.rank(candidates, { objective: '웹에서 최신 자료를 검색해' });
  check('open_route_is_automatically_demoted', ranked[0].skill.toolName === 'browser.search'
    && ranked[1].reasons.includes('health:circuit-open'), {
    order: ranked.map((item) => item.skill.toolName),
    openedToolState: ranked[1].health?.circuitState
  });

  const workspace = join(labRoot, 'workspace');
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, 'adaptive-proof.txt'), 'ready', 'utf8');
  const runtime = createAgRuntime({
    allowedRoots: [workspace],
    auditRoot: join(labRoot, 'runtime-audit'),
    cwd: () => workspace,
    env: {},
    workerDaemonEnabled: false
  });
  const task = runtime.coreFacade.createTask('작업공간 파일 목록을 보여줘');
  const run = await runtime.orchestrationWorker.runTask(task.taskId, { userConfirmation: { confirmed: true } });
  const diagnostics = runtime.coreFacade.adminDiagnostics();
  const fileHealth = runtime.coreFacade.executionHealthRegistry.statusFor('filesystem.listFiles');
  check('real_worker_feeds_execution_health', run.success === true && fileHealth.successCount === 1, {
    success: run.success,
    health: fileHealth
  });
  check('admin_diagnostics_exposes_adaptive_fabric', diagnostics.executionFabric.fabricVersion === 'a-adaptive-execution-fabric-v2'
    && diagnostics.executionFabric.adaptiveRouting.enabled === true
    && diagnostics.executionHealth.summary.observedToolCount === 1
    && diagnostics.executionEnvironment.profileVersion === 'a-execution-environment-profile-v1', {
    fabricVersion: diagnostics.executionFabric.fabricVersion,
    adaptiveRouting: diagnostics.executionFabric.adaptiveRouting,
    observedToolCount: diagnostics.executionHealth.summary.observedToolCount
  });

  const passedCount = checks.filter((item) => item.passed).length;
  const report = {
    reportVersion: 'jarvis-adaptive-execution-fabric-audit-v1',
    generatedAt: new Date().toISOString(),
    status: passedCount === checks.length ? 'passed' : 'failed',
    scope: {
      realCoreWorker: true,
      isolatedWorkspace: true,
      externalNetworkUsed: false,
      externalModelUsed: false,
      productionUndoJournalModified: false
    },
    summary: {
      checksPassed: passedCount,
      checkCount: checks.length,
      machineTier: profile.system.performanceTier,
      workerMaxQueueConcurrency: profile.applied.workerMaxQueueConcurrency.value,
      workerMaxPlanParallelism: profile.applied.workerMaxPlanParallelism.value,
      missionMaxPlannerTools: profile.applied.missionMaxPlannerTools.value,
      liveToolSamples: fileHealth.sampleCount
    },
    channelReadiness: profile.channels,
    providerReadiness: profile.providers,
    checks,
    privacy: {
      rawCommandStored: false,
      rawArgumentsStored: false,
      credentialValuesStored: false,
      taskIdStored: false,
      objectiveStored: false
    },
    integrity: {
      checksSha256: sha256(JSON.stringify(checks.map(({ checkId, passed }) => ({ checkId, passed }))))
    }
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(markdownPath, markdownReport(report), 'utf8');
  console.log(JSON.stringify({
    status: report.status,
    checks: `${passedCount}/${checks.length}`,
    machineTier: report.summary.machineTier,
    applied: {
      queueConcurrency: report.summary.workerMaxQueueConcurrency,
      planParallelism: report.summary.workerMaxPlanParallelism,
      plannerTools: report.summary.missionMaxPlannerTools
    },
    reportPath: outputPath,
    markdownPath
  }, null, 2));
  if (report.status !== 'passed') process.exitCode = 1;
} finally {
  await rm(labRoot, { recursive: true, force: true });
}

function check(checkId, passed, evidence) {
  checks.push({ checkId, passed: Boolean(passed), evidence });
}

function routeProfile(channel, expectedLatencyMs, reliability, fallbackToolNames) {
  return { channel, expectedLatencyMs, reliability, modelRoundTrips: 0, fallbackToolNames };
}

function syntheticSkill(toolName) {
  return {
    toolName,
    label: toolName,
    category: 'browser',
    actionType: 'BROWSER_SEARCH',
    match: { keywords: ['웹', '검색', '최신'] },
    capability: { externalNetwork: true, externalTransfer: false, writesLocalFiles: false },
    lifecycle: { routable: true }
  };
}

function markdownReport(report) {
  return [
    '# JARVIS Adaptive Execution Fabric Audit',
    '',
    `- Status: **${report.status}**`,
    `- Checks: **${report.summary.checksPassed}/${report.summary.checkCount}**`,
    `- Machine tier: **${report.summary.machineTier}**`,
    `- Queue concurrency: **${report.summary.workerMaxQueueConcurrency}**`,
    `- Plan parallelism: **${report.summary.workerMaxPlanParallelism}**`,
    `- Planner tools: **${report.summary.missionMaxPlannerTools}**`,
    '',
    '## Checks',
    '',
    ...report.checks.map((item) => `- ${item.passed ? 'PASS' : 'FAIL'} ${item.checkId}`),
    '',
    'No raw command, arguments, objective, task ID, or credential value is stored in this report.',
    ''
  ].join('\n');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
