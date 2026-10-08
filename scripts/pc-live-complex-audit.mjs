import { createHash } from 'node:crypto';
import { access, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { InputSource, ModuleId, TaskStatus } from '../packages/shared/src/types.js';

const reportPath = resolve(readFlag('--report') ?? 'dist/verification/pc-live-complex-audit.json');
const markdownPath = reportPath.replace(/\.json$/i, '.md');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const runRoot = resolve(dirname(reportPath), 'pc-live-complex-audit-runs', runId);
const workspace = join(runRoot, 'workspace');
const auditRoot = join(runRoot, 'audit');
const command = '작업 폴더의 파일 목록을 확인하고 그리고 live-complex-result.txt 파일을 만들어 내용은 실시간 복합 음성 작업 검증 완료라고 써줘';
const expectedContent = '실시간 복합 음성 작업 검증 완료';

await mkdir(workspace, { recursive: true });
await writeFile(join(workspace, 'input-evidence.txt'), 'JARVIS live complex workflow input.', 'utf8');
process.env.JARVIS_INTENT_CACHE_PATH = join(runRoot, 'intent-cache.jsonl');
process.env.JARVIS_PLAN_CACHE_PATH = join(runRoot, 'plan-cache.jsonl');
process.env.JARVIS_BACKUP_DIR = join(workspace, '.jarvis-backups');

const runtime = createAgRuntime({
  allowedRoots: [workspace],
  auditRoot,
  cwd: () => workspace,
  env: process.env,
  bridgeRealExecution: true,
  workerDaemonEnabled: false
});

const startedAt = new Date();
const planningStarted = performance.now();
let task = null;
let run = null;
let error = null;

try {
  task = runtime.coreFacade.createTask(command, {
    inputMode: 'voice',
    source: InputSource.VOICE,
    sourceModule: ModuleId.PC_AGENT,
    deviceId: 'pc_live_voice_audit',
    metadata: {
      voiceRecognition: {
        confidence: 0.96,
        locale: 'ko-KR',
        engine: 'live-audit-transcript-fixture',
        rawAudioStored: false,
        commandTextRetainedAsTask: true
      }
    }
  });
  const planningMs = performance.now() - planningStarted;
  const executionStarted = performance.now();
  run = await runtime.orchestrationWorker.runTask(task.taskId, { deviceId: 'pc_live_voice_audit' });
  const executionMs = performance.now() - executionStarted;
  const artifacts = await collectArtifacts(workspace);
  const textArtifacts = [];
  for (const artifact of artifacts.filter((item) => item.relativePath.toLowerCase().endsWith('.txt'))) {
    const body = await readFile(join(workspace, artifact.relativePath), 'utf8').catch(() => '');
    textArtifacts.push({
      ...artifact,
      expectedContentMatched: body.includes(expectedContent),
      contentSha256: createHash('sha256').update(body).digest('hex')
    });
  }
  const actionNodes = (task.plan?.planGraph?.nodes ?? [])
    .filter((node) => node.nodeId?.startsWith('action_'))
    .map((node) => ({
      nodeId: node.nodeId,
      actionType: node.actionType ?? null,
      toolName: node.toolName ?? null,
      status: task.planGraphRun?.nodeRuns?.find((item) => item.nodeId === node.nodeId)?.status ?? null
    }));
  const nodeRuns = task.planGraphRun?.nodeRuns ?? run?.planGraphRun?.nodeRuns ?? [];
  const completed = run?.success === true
    && run?.status === TaskStatus.COMPLETED
    && actionNodes.length >= 2
    && nodeRuns.filter((node) => node.status === 'completed').length >= 2
    && textArtifacts.some((item) => item.relativePath.toLowerCase().endsWith('live-complex-result.txt') && item.expectedContentMatched);
  const finishedAt = new Date();
  const report = {
    reportVersion: 'a-b-pc-live-complex-llm-audit-v1',
    generatedAt: finishedAt.toISOString(),
    status: completed ? 'passed' : 'failed',
    runId,
    scope: {
      inputMode: 'voice-transcript',
      physicalMicrophoneIncluded: false,
      externalLlmUsed: task.plan?.llmPlanning?.modelRoundTrips === 1,
      deterministicPlannerUsed: false,
      userFilesModified: false,
      dedicatedWorkspaceOnly: true
    },
    planning: {
      durationMs: round(planningMs),
      actionNodeCount: actionNodes.length,
      heterogeneous: task.plan?.llmPlanning?.heterogeneous === true,
      modelRoundTrips: task.plan?.llmPlanning?.modelRoundTrips ?? null,
      preparedArgumentCount: task.plan?.llmPlanning?.preparedArgumentCount ?? null,
      fromCache: task.plan?.llmPlanning?.fromCache === true,
      provider: task.plan?.llmPlanning?.runnerProvider ?? null,
      externalService: task.plan?.llmPlanning?.externalService ?? null,
      model: task.plan?.llmPlanning?.model ?? null,
      providerFallbackCount: task.plan?.llmPlanning?.providerFallbackCount ?? null,
      providerUsage: task.plan?.llmPlanning?.providerUsage ?? null,
      providerCostUsd: task.plan?.llmPlanning?.providerCostUsd ?? null,
      rawCommandSharedWithModel: task.plan?.llmPlanning?.rawCommandSharedWithModel === true
    },
    execution: {
      durationMs: round(executionMs),
      success: run?.success === true,
      status: run?.status ?? null,
      verificationStatus: run?.executionVerification?.status ?? run?.verificationStatus ?? null,
      actionNodes,
      completedNodeCount: nodeRuns.filter((node) => node.status === 'completed').length,
      failedNodeCount: nodeRuns.filter((node) => node.status === 'failed').length
    },
    artifacts: textArtifacts,
    command: {
      sha256: createHash('sha256').update(command).digest('hex'),
      rawStoredInReport: false,
      expectedContentSha256: createHash('sha256').update(expectedContent).digest('hex')
    },
    privacy: {
      rawAudioStored: false,
      rawCommandStoredInReport: false,
      rawProviderResponseStoredInReport: false,
      rawCapabilityTokenStoredInReport: false
    },
    durationMs: finishedAt.getTime() - startedAt.getTime()
  };
  await persist(report);
} catch (caught) {
  error = caught;
  const finishedAt = new Date();
  const report = {
    reportVersion: 'a-b-pc-live-complex-llm-audit-v1',
    generatedAt: finishedAt.toISOString(),
    status: 'failed',
    runId,
    scope: {
      inputMode: 'voice-transcript',
      physicalMicrophoneIncluded: false,
      externalLlmUsed: true,
      deterministicPlannerUsed: false,
      userFilesModified: false,
      dedicatedWorkspaceOnly: true
    },
    planning: task?.plan?.llmPlanning ?? null,
    execution: run ? { success: run.success === true, status: run.status ?? null } : null,
    failure: {
      code: caught?.code ?? 'PC_LIVE_COMPLEX_AUDIT_FAILED',
      messageFingerprint: createHash('sha256').update(String(caught?.message ?? caught)).digest('hex').slice(0, 16),
      rawErrorStored: false
    },
    command: {
      sha256: createHash('sha256').update(command).digest('hex'),
      rawStoredInReport: false
    },
    privacy: {
      rawAudioStored: false,
      rawCommandStoredInReport: false,
      rawProviderResponseStoredInReport: false,
      rawCapabilityTokenStoredInReport: false
    },
    durationMs: finishedAt.getTime() - startedAt.getTime()
  };
  await persist(report);
}

async function persist(report) {
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(markdownPath, renderMarkdown(report), 'utf8');
  process.stdout.write(`${JSON.stringify({
    status: report.status,
    reportPath,
    markdownPath,
    planning: report.planning,
    execution: report.execution,
    artifactCount: report.artifacts?.length ?? 0,
    failure: report.failure ?? null
  }, null, 2)}\n`);
  if (report.status !== 'passed') process.exitCode = 1;
}

async function collectArtifacts(root) {
  const results = [];
  const walk = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      const info = await stat(path);
      results.push({ relativePath: relative(root, path), size: info.size });
    }
  };
  await access(root);
  await walk(root);
  return results;
}

function renderMarkdown(report) {
  return `# JARVIS Live Complex PC Audit\n\n`
    + `- Status: **${report.status}**\n`
    + `- Planning: **${report.planning?.durationMs ?? 'failed'} ms**\n`
    + `- Provider: **${report.planning?.provider ?? 'unknown'}**\n`
    + `- Model: **${report.planning?.model ?? 'unknown'}**\n`
    + `- Model round trips: **${report.planning?.modelRoundTrips ?? 'unknown'}**\n`
    + `- Action nodes: **${report.planning?.actionNodeCount ?? 0}**\n`
    + `- Execution: **${report.execution?.durationMs ?? 'failed'} ms**\n`
    + `- Physical microphone included: **false**\n`;
}

function round(value) {
  return Number.isFinite(value) ? Number(value.toFixed(3)) : null;
}

function readFlag(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

if (error) process.exitCode = 1;
