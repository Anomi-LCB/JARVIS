import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';

const tasksPerRound = positiveIntegerFlag('--tasks', 8);
const rounds = oddIntegerFlag('--rounds', 5);
const ioDelayMs = positiveIntegerFlag('--io-delay-ms', 150);
const targetSpeedup = positiveNumberFlag('--target-speedup', 2);
const parallelism = positiveIntegerFlag('--parallelism', 4);
const reportPath = resolve(readFlag('--report') ?? 'dist/verification/core-worker-performance-report.json');
const markdownPath = reportPath.replace(/\.json$/i, '.md');
const workspace = await mkdtemp(join(tmpdir(), 'jarvis-core-worker-performance-'));
const startedAt = new Date();

try {
  const sequentialHarness = await createModeHarness({
    root: join(workspace, 'sequential'),
    concurrency: 1,
    ioDelayMs
  });
  const parallelHarness = await createModeHarness({
    root: join(workspace, 'parallel'),
    concurrency: parallelism,
    ioDelayMs
  });
  await runMode({ harness: sequentialHarness, taskCount: 2, label: 'warm-sequential' });
  await runMode({ harness: parallelHarness, taskCount: 2, label: 'warm-parallel' });

  const sequentialSamples = [];
  const parallelSamples = [];
  for (let round = 0; round < rounds; round += 1) {
    const order = round % 2 === 0
      ? [
          { target: parallelSamples, harness: parallelHarness, label: `parallel-${round}` },
          { target: sequentialSamples, harness: sequentialHarness, label: `sequential-${round}` }
        ]
      : [
          { target: sequentialSamples, harness: sequentialHarness, label: `sequential-${round}` },
          { target: parallelSamples, harness: parallelHarness, label: `parallel-${round}` }
        ];
    for (const item of order) {
      item.target.push(await runMode({
        harness: item.harness,
        taskCount: tasksPerRound,
        label: item.label
      }));
    }
  }

  const sequential = summarizeSamples(sequentialSamples, tasksPerRound);
  const optimized = summarizeSamples(parallelSamples, tasksPerRound);
  const measuredSpeedup = sequential.medianDurationMs / optimized.medianDurationMs;
  const mutationGuard = await runMutationGuard({
    root: join(workspace, 'mutation-guard'),
    concurrency: parallelism,
    taskCount: Math.min(4, Math.max(2, tasksPerRound)),
    ioDelayMs: 20
  });
  const checks = [
    check('worker_queue_median_speedup_at_least_target', measuredSpeedup >= targetSpeedup, {
      actual: round(measuredSpeedup),
      target: targetSpeedup
    }),
    check('read_only_parallelism_observed', optimized.maxObservedConcurrency >= Math.min(parallelism, tasksPerRound), {
      expected: Math.min(parallelism, tasksPerRound),
      actual: optimized.maxObservedConcurrency
    }),
    check('all_execution_results_succeeded', sequential.allSucceeded && optimized.allSucceeded, {
      sequentialSucceeded: sequential.succeededCount,
      optimizedSucceeded: optimized.succeededCount
    }),
    check('task_semantics_preserved', sequential.semanticHashes.every((hash) => optimized.semanticHashes.includes(hash)), {
      sequentialUniqueHashes: [...new Set(sequential.semanticHashes)].length,
      optimizedUniqueHashes: [...new Set(optimized.semanticHashes)].length
    }),
    check('queue_snapshot_writes_coalesced', optimized.maxQueueSavesPerTask <= 2, {
      maxQueueSavesPerTask: optimized.maxQueueSavesPerTask
    }),
    check('mutating_tasks_remain_sequential', mutationGuard.maxObservedConcurrency === 1 && mutationGuard.parallelWaveCount === 0, mutationGuard),
    check('scheduler_telemetry_is_content_free', optimized.rawCommandStored === false && optimized.rawAffectedItemsStored === false, {
      rawCommandStored: optimized.rawCommandStored,
      rawAffectedItemsStored: optimized.rawAffectedItemsStored
    })
  ];
  const finishedAt = new Date();
  const status = checks.every((item) => item.passed) ? 'passed' : 'failed';
  const report = {
    reportVersion: 'a-core-worker-performance-gate-v1',
    generatedAt: finishedAt.toISOString(),
    status,
    targetSpeedup,
    measuredSpeedup: round(measuredSpeedup),
    throughputGain: round(optimized.tasksPerSecond / sequential.tasksPerSecond),
    workload: {
      tasksPerRound,
      rounds,
      measuredTasksPerMode: tasksPerRound * rounds,
      parallelism,
      injectedAdapterIoDelayMs: ioDelayMs,
      workloadClass: 'approved-read-only-adapter-io',
      applicability: 'Independent read-only work with device, bridge, network-folder, or security-scan I/O. CPU-bound and mutating work is not claimed as 2x.',
      runtimeStartupAndTaskPlanningExcluded: true,
      externalLlmDisabled: true,
      durableQueueAndAuditLoggingEnabled: true
    },
    sequential,
    optimized,
    mutationGuard,
    checks,
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    privacy: {
      rawCommandsStoredInReport: false,
      rawAffectedItemsStoredInReport: false,
      temporaryBenchmarkDataRemoved: true
    }
  };

  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(markdownPath, renderMarkdown(report), 'utf8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = status === 'passed' ? 0 : 1;
} finally {
  await rm(workspace, { recursive: true, force: true });
}

async function createModeHarness({ root, concurrency, ioDelayMs: delayMs }) {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'fixture.txt'), 'worker performance fixture', 'utf8');
  const runtime = createAgRuntime({
    auditRoot: root,
    allowedRoots: [root],
    cwd: () => root,
    env: {},
    workerDaemonEnabled: false,
    workerQueueStorePath: join(root, 'worker-queue.json'),
    workerLeaseStorePath: join(root, 'worker-leases.json'),
    workerMaxQueueConcurrency: concurrency
  });
  const originalReceive = runtime.pcAgent.receiveExecutionPacket.bind(runtime.pcAgent);
  const originalSave = runtime.orchestrationWorker.queueStore.save.bind(runtime.orchestrationWorker.queueStore);
  const counters = { active: 0, maxActive: 0, queueSaveCount: 0, taskSequence: 0 };
  runtime.pcAgent.receiveExecutionPacket = async (...args) => {
    counters.active += 1;
    counters.maxActive = Math.max(counters.maxActive, counters.active);
    try {
      await delay(delayMs);
      return await originalReceive(...args);
    } finally {
      counters.active -= 1;
    }
  };
  runtime.orchestrationWorker.queueStore.save = (...args) => {
    counters.queueSaveCount += 1;
    return originalSave(...args);
  };
  return { runtime, concurrency, counters };
}

async function runMode({ harness, taskCount, label }) {
  const { runtime, concurrency, counters } = harness;
  for (let index = 0; index < taskCount; index += 1) {
    counters.taskSequence += 1;
    const task = runtime.coreFacade.createTask(`파일 목록 보여줘 성능-${counters.taskSequence}`);
    runtime.orchestrationWorker.enqueueTask(task.taskId, { userConfirmation: { confirmed: true } });
  }
  counters.maxActive = 0;
  counters.queueSaveCount = 0;
  const started = performance.now();
  const drained = await runtime.orchestrationWorker.drain({ limit: taskCount, concurrency });
  const durationMs = performance.now() - started;
  const projection = drained.results.map((result) => ({
    queueStatus: result.item?.status ?? null,
    runSuccess: result.run?.success === true,
    taskStatus: result.run?.status ?? null,
    actionType: runtime.coreFacade.getTask(result.item?.taskId)?.plan?.action?.actionType ?? null,
    planVerification: result.run?.planVerification?.status ?? null,
    policyVerification: result.run?.policyVerification?.status ?? null,
    executionVerification: result.run?.executionVerification?.status ?? null,
    learningVerification: result.run?.learning?.verification?.status ?? null
  }));
  return {
    label,
    durationMs,
    tasksPerSecond: taskCount * 1000 / durationMs,
    maxObservedConcurrency: counters.maxActive,
    queueSaveCount: counters.queueSaveCount,
    queueSavesPerTask: counters.queueSaveCount / taskCount,
    waveCount: drained.scheduler.waveCount,
    parallelWaveCount: drained.scheduler.parallelWaveCount,
    succeededCount: projection.filter((item) => item.queueStatus === 'succeeded' && item.runSuccess).length,
    semanticHash: sha256Json(projection),
    rawCommandStored: drained.status.scheduler.privacy.rawCommandsStored,
    rawAffectedItemsStored: drained.status.scheduler.privacy.rawAffectedItemsStored
  };
}

async function runMutationGuard({ root, concurrency, taskCount, ioDelayMs: delayMs }) {
  await mkdir(root, { recursive: true });
  const runtime = createAgRuntime({
    auditRoot: root,
    allowedRoots: [root],
    cwd: () => root,
    env: {},
    workerDaemonEnabled: false,
    workerMaxQueueConcurrency: concurrency
  });
  const originalReceive = runtime.pcAgent.receiveExecutionPacket.bind(runtime.pcAgent);
  let active = 0;
  let maxActive = 0;
  runtime.pcAgent.receiveExecutionPacket = async (...args) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      await delay(delayMs);
      return await originalReceive(...args);
    } finally {
      active -= 1;
    }
  };
  for (let index = 0; index < taskCount; index += 1) {
    const task = runtime.coreFacade.createTask(`파일 만들어 안전-${index}`);
    runtime.orchestrationWorker.enqueueTask(task.taskId, {
      dryRun: true,
      userConfirmation: { confirmed: true }
    });
  }
  const drained = await runtime.orchestrationWorker.drain({ limit: taskCount, concurrency });
  return {
    schedulerVersion: drained.scheduler.schedulerVersion,
    taskCount,
    maxObservedConcurrency: maxActive,
    waveCount: drained.scheduler.waveCount,
    parallelWaveCount: drained.scheduler.parallelWaveCount,
    profileReasons: [...new Set(drained.scheduler.waves.flatMap((wave) => wave.profileReasons))]
  };
}

function summarizeSamples(samples, taskCount) {
  const durations = samples.map((sample) => sample.durationMs).sort((left, right) => left - right);
  const medianDurationMs = percentile(durations, 0.5);
  return {
    sampleDurationsMs: samples.map((sample) => round(sample.durationMs)),
    medianDurationMs: round(medianDurationMs),
    p95DurationMs: round(percentile(durations, 0.95)),
    perTaskMedianMs: round(medianDurationMs / taskCount),
    tasksPerSecond: round(taskCount * 1000 / medianDurationMs),
    maxObservedConcurrency: Math.max(...samples.map((sample) => sample.maxObservedConcurrency)),
    maxQueueSavesPerTask: Math.max(...samples.map((sample) => sample.queueSavesPerTask)),
    succeededCount: samples.reduce((total, sample) => total + sample.succeededCount, 0),
    expectedSucceededCount: samples.length * taskCount,
    allSucceeded: samples.every((sample) => sample.succeededCount === taskCount),
    semanticHashes: samples.map((sample) => sample.semanticHash),
    rawCommandStored: samples.some((sample) => sample.rawCommandStored),
    rawAffectedItemsStored: samples.some((sample) => sample.rawAffectedItemsStored)
  };
}

function check(checkId, passed, evidence = {}) {
  return { checkId, passed: passed === true, evidence };
}

function renderMarkdown(report) {
  const rows = report.checks.map((item) => `| ${item.checkId} | ${item.passed ? 'PASS' : 'FAIL'} |`).join('\n');
  return `# JARVIS Core Worker Performance Gate\n\n`
    + `- Status: **${report.status}**\n`
    + `- Measured speedup: **${report.measuredSpeedup}x**\n`
    + `- Target speedup: **${report.targetSpeedup}x**\n`
    + `- Sequential throughput: **${report.sequential.tasksPerSecond} tasks/s**\n`
    + `- Optimized throughput: **${report.optimized.tasksPerSecond} tasks/s**\n`
    + `- Mutating max concurrency: **${report.mutationGuard.maxObservedConcurrency}**\n\n`
    + `| Check | Result |\n|---|---|\n${rows}\n`;
}

function sha256Json(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function percentile(sorted, ratio) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readFlag(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function positiveIntegerFlag(name, fallback) {
  const value = Number(readFlag(name));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function oddIntegerFlag(name, fallback) {
  const value = positiveIntegerFlag(name, fallback);
  return value % 2 === 0 ? value + 1 : value;
}

function positiveNumberFlag(name, fallback) {
  const value = Number(readFlag(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}
