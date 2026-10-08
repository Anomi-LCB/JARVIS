import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { ClaudeCliTaskPlanner } from '../packages/core/src/planning/claude-cli-task-planner.js';
import { ActionType, ApprovalDecision, TaskStatus } from '../packages/shared/src/types.js';

const rounds = positiveIntegerFlag('--rounds', 5);
const modelDelayMs = nonNegativeNumberFlag('--model-delay-ms', 120);
const targetPlanningSpeedup = positiveNumberFlag('--target-planning-speedup', 2);
const reportPath = resolve(readFlag('--report') ?? 'dist/verification/voice-complex-workflow-benchmark.json');
const markdownPath = reportPath.replace(/\.json$/i, '.md');
const root = await mkdtemp(join(tmpdir(), 'jarvis-voice-complex-benchmark-'));
const workspace = join(root, 'workspace');
const outputPath = join(workspace, 'voice-benchmark-result.txt');
const command = '작업 폴더의 파일 목록을 확인하고 그리고 음성 성능 검증 메모를 만들어줘';
const outputContent = '음성 복합 작업의 실제 PC 실행과 검증을 완료했습니다.';
const previousPlanCachePath = process.env.JARVIS_PLAN_CACHE_PATH;
const startedAt = new Date();

try {
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, 'input-evidence.txt'), 'voice benchmark fixture', 'utf8');
  process.env.JARVIS_PLAN_CACHE_PATH = join(root, 'plan-cache.jsonl');

  let modelCalls = 0;
  const planner = new ClaudeCliTaskPlanner({
    contentEnabled: true,
    runner: () => {
      modelCalls += 1;
      sleepSync(modelDelayMs);
      return plannerResponse({
        summary: '작업 폴더를 확인하고 검증 메모를 생성합니다.',
        parts: [
          {
            actionType: ActionType.LIST_FILES,
            text: '작업 폴더의 파일 목록을 확인하고',
            description: '작업 폴더 파일 목록 확인',
            slots: { directoryHint: 'workspace' },
            arguments: { directory: workspace }
          },
          {
            actionType: ActionType.CREATE_FILE,
            text: '음성 성능 검증 메모를 만들어줘',
            description: '음성 성능 검증 메모 생성',
            slots: { fileName: 'voice-benchmark-result.txt', outputFormat: 'txt' },
            arguments: {
              fileName: 'voice-benchmark-result.txt',
              outputFormat: 'txt',
              path: outputPath,
              contentDraft: { kind: 'txt', content: outputContent }
            }
          }
        ]
      });
    }
  });
  const runtime = createAgRuntime({
    allowedRoots: [workspace],
    auditRoot: join(root, 'audit'),
    cwd: () => root,
    env: {},
    taskPlanner: planner,
    bridgeRealExecution: true,
    workerDaemonEnabled: false
  });
  const pairing = runtime.bridgeRuntime.pairing.start();
  const paired = runtime.bridgeRuntime.pairing.confirm({
    deviceId: 'voice_benchmark_phone',
    deviceName: 'Voice Benchmark Phone',
    pairingCode: pairing.pairingCode
  });
  assertSuccessful(paired, 'device pairing');

  const samples = [];
  for (let index = 0; index < rounds; index += 1) {
    await rm(outputPath, { force: true });
    const requestStarted = performance.now();
    const created = runtime.bridgeRuntime.createTask({
      taskRequest: {
        requestId: `req_voice_benchmark_${index + 1}`,
        createdAt: new Date(Date.now() + index).toISOString(),
        userId: 'local_user',
        source: {
          type: 'mobile',
          module: 'C_MOBILE',
          deviceId: 'voice_benchmark_phone',
          inputMode: 'voice'
        },
        command: { rawText: command, locale: 'ko-KR' },
        metadata: {
          voiceRecognition: {
            confidence: 0.95,
            alternativesCount: 1,
            locale: 'ko-KR',
            engine: 'benchmark-stt-fixture',
            rawAudioStored: false,
            alternativesStored: false,
            commandTextRetainedAsTask: true
          }
        }
      },
      token: paired.deviceToken
    });
    assertSuccessful(created, `task creation ${index + 1}`);
    const planningMs = performance.now() - requestStarted;
    const task = runtime.coreFacade.getTask(created.taskId);
    const approval = runtime.bridgeRuntime.listApprovals({ token: paired.deviceToken }).items
      .find((item) => item.taskId === created.taskId);
    if (!approval) throw new Error(`approval-not-found:${created.taskId}`);
    const approved = await runtime.bridgeRuntime.decideApproval({
      approvalId: approval.approvalId,
      decision: ApprovalDecision.APPROVE,
      token: paired.deviceToken
    });
    assertSuccessful(approved, `approval ${index + 1}`);
    const executionStarted = performance.now();
    const completed = await runtime.bridgeRuntime.confirmExecutionHandoff({
      handoffId: approved.handoffId,
      token: paired.deviceToken
    });
    assertSuccessful(completed, `execution ${index + 1}`);
    const executionMs = performance.now() - executionStarted;
    const artifact = await readFile(outputPath, 'utf8');
    const stored = runtime.bridgeRuntime.results.get(created.taskId);
    const planNodes = task.plan?.planGraph?.nodes?.filter((node) => node.nodeId?.startsWith('action_')) ?? [];
    const nodeVerifications = stored?.verification?.nodeVerifications ?? [];
    samples.push({
      index: index + 1,
      planningMs: round(planningMs),
      executionMs: round(executionMs),
      totalMs: round(performance.now() - requestStarted),
      taskStatus: completed.status,
      verificationStatus: completed.verificationStatus,
      modelRoundTrips: task.plan?.llmPlanning?.modelRoundTrips ?? null,
      planCacheHit: task.plan?.llmPlanning?.fromCache === true,
      preparedArgumentCount: task.plan?.llmPlanning?.preparedArgumentCount ?? 0,
      actionNodeCount: planNodes.length,
      nodeVerificationCount: nodeVerifications.length,
      nodeVerificationsPassed: nodeVerifications.length === planNodes.length
        && nodeVerifications.every((item) => item.status === 'passed'),
      voiceProvenanceRetained: task.request?.source?.inputMode === 'voice',
      rawAudioStored: task.request?.metadata?.voiceRecognition?.rawAudioStored === true,
      artifactMatched: artifact === outputContent,
      artifactSha256: sha256(artifact)
    });
  }

  const first = samples[0];
  const warm = samples.slice(1);
  const warmPlanningMedianMs = percentile(warm.map((sample) => sample.planningMs), 0.5);
  const measuredPlanningSpeedup = warmPlanningMedianMs > 0 ? first.planningMs / warmPlanningMedianMs : null;
  const checks = [
    check('all_voice_tasks_completed', samples.every((sample) => sample.taskStatus === TaskStatus.COMPLETED)),
    check('all_execution_verifications_passed', samples.every((sample) => sample.verificationStatus === 'passed')),
    check('all_plan_nodes_verified_individually', samples.every((sample) => sample.nodeVerificationsPassed)),
    check('all_artifacts_match_expected_content', samples.every((sample) => sample.artifactMatched)),
    check('voice_provenance_retained', samples.every((sample) => sample.voiceProvenanceRetained)),
    check('raw_audio_not_retained', samples.every((sample) => sample.rawAudioStored === false)),
    check('cold_plan_uses_one_model_round_trip', first?.modelRoundTrips === 1 && modelCalls === 1, {
      coldModelRoundTrips: first?.modelRoundTrips,
      totalModelCalls: modelCalls
    }),
    check('warm_plans_use_zero_model_round_trips', warm.length > 0 && warm.every((sample) => sample.modelRoundTrips === 0 && sample.planCacheHit), {
      warmSampleCount: warm.length
    }),
    check('decomposition_prepares_all_node_arguments', samples.every((sample) => sample.preparedArgumentCount >= sample.actionNodeCount)),
    check('planning_speedup_reaches_target', Number.isFinite(measuredPlanningSpeedup) && measuredPlanningSpeedup >= targetPlanningSpeedup, {
      measured: round(measuredPlanningSpeedup),
      target: targetPlanningSpeedup
    })
  ];
  const finishedAt = new Date();
  const report = {
    reportVersion: 'a-d-voice-complex-workflow-performance-gate-v1',
    generatedAt: finishedAt.toISOString(),
    status: checks.every((item) => item.passed) ? 'passed' : 'failed',
    scope: {
      covered: 'Korean STT transcript through mobile request, D bridge, A plan, E approval, B multi-tool execution, G node verification, and F learning.',
      excluded: 'Physical microphone acoustics and vendor STT network quality; run the Android live-device harness for those layers.',
      externalLlmUsed: false,
      deterministicModelDelayMs: modelDelayMs
    },
    workload: {
      rounds,
      actionNodesPerTask: 2,
      commandSha256: sha256(command),
      rawCommandStoredInReport: false
    },
    performance: {
      coldPlanningMs: first?.planningMs ?? null,
      warmPlanningMedianMs: round(warmPlanningMedianMs),
      warmPlanningP95Ms: round(percentile(warm.map((sample) => sample.planningMs), 0.95)),
      measuredPlanningSpeedup: round(measuredPlanningSpeedup),
      targetPlanningSpeedup,
      executionMedianMs: round(percentile(samples.map((sample) => sample.executionMs), 0.5)),
      executionP95Ms: round(percentile(samples.map((sample) => sample.executionMs), 0.95)),
      totalMedianMs: round(percentile(samples.map((sample) => sample.totalMs), 0.5)),
      modelCalls
    },
    samples,
    checks,
    privacy: {
      rawCommandStoredInReport: false,
      rawAudioStored: false,
      temporaryWorkspaceRemoved: true,
      deviceTokenStoredInReport: false
    },
    durationMs: finishedAt.getTime() - startedAt.getTime()
  };

  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(markdownPath, renderMarkdown(report), 'utf8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.status === 'passed' ? 0 : 1;
} finally {
  if (previousPlanCachePath === undefined) delete process.env.JARVIS_PLAN_CACHE_PATH;
  else process.env.JARVIS_PLAN_CACHE_PATH = previousPlanCachePath;
  await rm(root, { recursive: true, force: true });
}

function plannerResponse(payload) {
  return JSON.stringify({ result: JSON.stringify(payload) });
}

function sleepSync(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, ms);
}

function assertSuccessful(value, label) {
  if (!value || value.success === false || value.error) {
    throw new Error(`${label}-failed:${value?.error?.code ?? value?.reason ?? 'unknown'}`);
  }
}

function check(checkId, passed, evidence = {}) {
  return { checkId, passed: passed === true, evidence };
}

function percentile(values, ratio) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

function round(value) {
  return Number.isFinite(value) ? Number(value.toFixed(3)) : null;
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function renderMarkdown(report) {
  const rows = report.checks
    .map((item) => `| ${item.checkId} | ${item.passed ? 'PASS' : 'FAIL'} |`)
    .join('\n');
  return `# JARVIS Voice Complex Workflow Performance Gate\n\n`
    + `- Status: **${report.status}**\n`
    + `- Cold planning: **${report.performance.coldPlanningMs} ms**\n`
    + `- Warm planning median: **${report.performance.warmPlanningMedianMs} ms**\n`
    + `- Planning speedup: **${report.performance.measuredPlanningSpeedup}x**\n`
    + `- Model calls: **${report.performance.modelCalls}** across ${report.workload.rounds} runs\n`
    + `- Execution median: **${report.performance.executionMedianMs} ms**\n\n`
    + `| Check | Result |\n|---|---|\n${rows}\n`;
}

function readFlag(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function positiveIntegerFlag(name, fallback) {
  const value = Number(readFlag(name));
  return Number.isInteger(value) && value > 1 ? value : fallback;
}

function positiveNumberFlag(name, fallback) {
  const value = Number(readFlag(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegativeNumberFlag(name, fallback) {
  const raw = readFlag(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}
