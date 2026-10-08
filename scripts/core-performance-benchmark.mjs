import { performance } from 'node:perf_hooks';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { readJsonl } from '../packages/shared/src/jsonl.js';

const tasksPerRound = positiveIntegerFlag('--tasks', 100);
const rounds = oddIntegerFlag('--rounds', 7);
const warmupTasks = positiveIntegerFlag('--warmup', 20);
const targetSpeedup = positiveNumberFlag('--target-speedup', 2);
const reportPath = resolve(readFlag('--report') ?? 'dist/verification/core-performance-report.json');
const markdownPath = reportPath.replace(/\.json$/i, '.md');
const workspace = await mkdtemp(join(tmpdir(), 'jarvis-core-performance-'));
const startedAt = new Date();

try {
  const common = {
    allowedRoots: [workspace],
    env: {},
    workerDaemonEnabled: false,
    corePerformanceSampleLimit: Math.max(256, tasksPerRound * rounds + warmupTasks)
  };
  const legacyRoot = join(workspace, 'legacy');
  const optimizedRoot = join(workspace, 'optimized');
  const legacy = createAgRuntime({ ...common, auditRoot: legacyRoot, coreDurabilityBatching: false });
  const optimized = createAgRuntime({ ...common, auditRoot: optimizedRoot, coreDurabilityBatching: true });

  warmRuntime(legacy, warmupTasks);
  warmRuntime(optimized, warmupTasks);

  const legacySamples = [];
  const optimizedSamples = [];
  for (let round = 0; round < rounds; round += 1) {
    const order = round % 2 === 0
      ? [[optimized, optimizedSamples], [legacy, legacySamples]]
      : [[legacy, legacySamples], [optimized, optimizedSamples]];
    for (const [runtime, samples] of order) {
      samples.push(measureRound(runtime, round, tasksPerRound));
    }
  }

  const legacySummary = summarize(legacySamples, tasksPerRound);
  const optimizedSummary = summarize(optimizedSamples, tasksPerRound);
  const speedup = legacySummary.medianMs / optimizedSummary.medianMs;
  const legacyEvents = await readJsonl(join(legacyRoot, 'core-events.jsonl'));
  const optimizedEvents = await readJsonl(join(optimizedRoot, 'core-events.jsonl'));
  const legacyJournal = await readJsonl(join(legacyRoot, 'core-orchestration.jsonl'));
  const optimizedJournal = await readJsonl(join(optimizedRoot, 'core-orchestration.jsonl'));
  const legacyTaskSemantics = taskSemanticProjection(legacy);
  const optimizedTaskSemantics = taskSemanticProjection(optimized);
  const telemetry = optimized.coreFacade.performanceTelemetry.snapshot();
  const checks = [
    check('median_speedup_at_least_target', speedup >= targetSpeedup, { actual: round(speedup), target: targetSpeedup }),
    check('event_record_semantics_preserved', sameProjection(legacyEvents, optimizedEvents, 'eventType'), {
      legacyCount: legacyEvents.length,
      optimizedCount: optimizedEvents.length
    }),
    check('orchestration_record_semantics_preserved', sameProjection(legacyJournal, optimizedJournal, 'recordType'), {
      legacyCount: legacyJournal.length,
      optimizedCount: optimizedJournal.length
    }),
    check('task_planning_and_policy_semantics_preserved', sameJson(legacyTaskSemantics, optimizedTaskSemantics), {
      legacyTaskCount: legacyTaskSemantics.length,
      optimizedTaskCount: optimizedTaskSemantics.length
    }),
    check('durability_writes_reduced', telemetry.durability.writeReductionRatio >= 0.5, {
      ...telemetry.durability
    }),
    check('performance_telemetry_is_content_free', telemetry.privacy.rawCommandStored === false && telemetry.privacy.rawContextStored === false, {
      privacy: telemetry.privacy
    })
  ];
  const finishedAt = new Date();
  const status = checks.every((item) => item.passed) ? 'passed' : 'failed';
  const report = {
    reportVersion: 'a-core-performance-gate-v1',
    generatedAt: finishedAt.toISOString(),
    status,
    targetSpeedup,
    measuredSpeedup: round(speedup),
    throughputGain: round(optimizedSummary.tasksPerSecond / legacySummary.tasksPerSecond),
    workload: {
      warmupTasks,
      tasksPerRound,
      rounds,
      measuredTasksPerMode: tasksPerRound * rounds,
      sameCommandsPerMode: true,
      externalLlmDisabled: true,
      durableLoggingEnabled: true,
      runtimeStartupExcluded: true
    },
    legacy: legacySummary,
    optimized: optimizedSummary,
    optimizedDurability: telemetry.durability,
    checks,
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    privacy: {
      rawCommandsStoredInReport: false,
      rawContextStoredInReport: false,
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

function warmRuntime(runtime, count) {
  for (let index = 0; index < count; index += 1) {
    runtime.coreFacade.createTask(commandFor(0, index, 'warmup'));
  }
}

function measureRound(runtime, round, count) {
  const started = performance.now();
  for (let index = 0; index < count; index += 1) {
    runtime.coreFacade.createTask(commandFor(round, index, 'measure'));
  }
  return performance.now() - started;
}

function commandFor(round, index, phase) {
  const commands = [
    '회의 메모 파일 만들어',
    '다운로드 폴더에서 보고서 찾아',
    '오늘 일정 보여줘',
    '방금 만든 문서 열어줘'
  ];
  return `${commands[index % commands.length]} ${phase}-${round}-${index}`;
}

function summarize(samples, taskCount) {
  const sorted = [...samples].sort((left, right) => left - right);
  const medianMs = percentile(sorted, 0.5);
  return {
    samplesMs: samples.map((value) => round(value)),
    medianMs: round(medianMs),
    p95Ms: round(percentile(sorted, 0.95)),
    perTaskMedianMs: round(medianMs / taskCount),
    tasksPerSecond: round(taskCount * 1000 / medianMs)
  };
}

function sameProjection(left, right, key) {
  if (left.length !== right.length) return false;
  return left.every((item, index) => item?.[key] === right[index]?.[key]);
}

function taskSemanticProjection(runtime) {
  return [...runtime.coreFacade.tasks.values()].map((task) => ({
    status: task.status,
    intentActionType: task.intent?.actionType ?? task.intent?.candidates?.[0]?.actionType ?? null,
    selectedActionType: task.ambiguity?.selected?.actionType ?? null,
    routeSkillId: task.route?.skillId ?? null,
    planActionType: task.plan?.action?.actionType ?? null,
    planToolName: task.plan?.action?.toolName ?? null,
    planNodeTypes: (task.plan?.planGraph?.nodes ?? []).map((node) => node.nodeType),
    policyDecision: task.policy?.decision ?? null,
    policyRiskTier: task.policy?.risk?.tier ?? null,
    approvalRiskTier: task.approvalCard?.riskTier ?? null,
    clarificationRequired: Boolean(task.approvalCard?.clarificationRequest)
  }));
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function check(checkId, passed, evidence = {}) {
  return { checkId, passed: passed === true, evidence };
}

function renderMarkdown(report) {
  const rows = report.checks.map((item) => `| ${item.checkId} | ${item.passed ? 'PASS' : 'FAIL'} |`).join('\n');
  return `# JARVIS Core Performance Gate\n\n`
    + `- Status: **${report.status}**\n`
    + `- Measured speedup: **${report.measuredSpeedup}x**\n`
    + `- Target speedup: **${report.targetSpeedup}x**\n`
    + `- Legacy median: **${report.legacy.perTaskMedianMs} ms/task**\n`
    + `- Optimized median: **${report.optimized.perTaskMedianMs} ms/task**\n`
    + `- Optimized throughput: **${report.optimized.tasksPerSecond} tasks/s**\n`
    + `- Durable write reduction: **${round(report.optimizedDurability.writeReductionRatio * 100, 2)}%**\n\n`
    + `| Check | Result |\n|---|---|\n${rows}\n`;
}

function percentile(sorted, ratio) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
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
