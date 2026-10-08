import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { ClaudeCliTaskPlanner } from '../packages/core/src/planning/claude-cli-task-planner.js';
import { ActionType, ApprovalDecision, TaskStatus } from '../packages/shared/src/types.js';

const reportPath = resolve(readFlag('--report') ?? 'dist/verification/product-frontier-experience-gate.json');
const markdownPath = reportPath.replace(/\.json$/i, '.md');
const thresholds = {
  requestToApprovalMs: positiveNumberFlag('--max-request-to-approval-ms', 2500),
  executionMs: positiveNumberFlag('--max-execution-ms', 5000),
  rollbackMs: positiveNumberFlag('--max-rollback-ms', 3000),
  totalMs: positiveNumberFlag('--max-total-ms', 10000)
};
const root = await mkdtemp(join(tmpdir(), 'jarvis-frontier-product-gate-'));
const workspace = join(root, 'workspace');
const auditRoot = join(root, 'audit');
const stagingPath = join(workspace, 'staging', 'frontier-evidence.txt');
const deliveredPath = join(workspace, 'delivered', 'frontier-evidence.txt');
const command = '작업 폴더를 확인하고 제품 검증 메모를 만든 다음 완료 폴더로 옮겨줘';
const outputContent = 'JARVIS frontier product experience gate: executed, verified, learned, and recoverable.';
const startedAt = new Date();
const started = performance.now();
const previousPlanCachePath = process.env.JARVIS_PLAN_CACHE_PATH;

try {
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, 'input-evidence.txt'), 'frontier gate input fixture', 'utf8');
  process.env.JARVIS_PLAN_CACHE_PATH = join(root, 'plan-cache.jsonl');

  const planner = new ClaudeCliTaskPlanner({
    contentEnabled: true,
    runner: () => plannerResponse({
      summary: '작업공간을 확인하고 검증 메모를 작성한 뒤 완료 폴더로 이동합니다.',
      parts: [
        {
          actionType: ActionType.LIST_FILES,
          text: '작업 폴더를 확인하고',
          description: '작업 폴더 확인',
          slots: { directoryHint: 'workspace' },
          arguments: { directory: workspace, maxItems: 20 }
        },
        {
          actionType: ActionType.CREATE_FILE,
          text: '제품 검증 메모를 만든 다음',
          description: '제품 검증 메모 생성',
          slots: { fileName: 'frontier-evidence.txt', outputFormat: 'txt' },
          arguments: {
            fileName: 'frontier-evidence.txt',
            outputFormat: 'txt',
            path: stagingPath,
            contentDraft: { kind: 'txt', content: outputContent }
          }
        },
        {
          actionType: ActionType.MOVE_FILE,
          text: '완료 폴더로 옮겨줘',
          description: '검증 메모를 완료 폴더로 이동',
          slots: { sourcePath: stagingPath, targetPath: deliveredPath },
          arguments: { from: stagingPath, to: deliveredPath }
        }
      ]
    })
  });
  const runtime = createAgRuntime({
    allowedRoots: [workspace],
    auditRoot,
    cwd: () => workspace,
    env: {},
    taskPlanner: planner,
    bridgeRealExecution: true,
    workerDaemonEnabled: false
  });
  const pairing = runtime.bridgeRuntime.pairing.start();
  const paired = runtime.bridgeRuntime.pairing.confirm({
    deviceId: 'frontier_gate_phone',
    deviceName: 'Frontier Gate Phone',
    pairingCode: pairing.pairingCode
  });
  requireSuccess(paired, 'device-pairing');

  const requestStarted = performance.now();
  const created = runtime.bridgeRuntime.createTask({
    taskRequest: {
      requestId: `req_frontier_${startedAt.getTime()}`,
      createdAt: startedAt.toISOString(),
      userId: 'local_user',
      source: {
        type: 'mobile',
        module: 'C_MOBILE',
        deviceId: 'frontier_gate_phone',
        inputMode: 'voice'
      },
      command: { rawText: command, locale: 'ko-KR' },
      metadata: {
        voiceRecognition: {
          confidence: 0.97,
          engine: 'deterministic-frontier-fixture',
          rawAudioStored: false,
          alternativesStored: false
        }
      }
    },
    token: paired.deviceToken
  });
  requireSuccess(created, 'task-creation');
  const task = runtime.coreFacade.getTask(created.taskId);
  const approvals = runtime.bridgeRuntime.listApprovals({ token: paired.deviceToken }).items
    .filter((item) => item.taskId === created.taskId);
  if (approvals.length !== 1) throw new Error(`approval-card-count:${approvals.length}`);
  const requestToApprovalMs = performance.now() - requestStarted;

  const decision = await runtime.bridgeRuntime.decideApproval({
    approvalId: approvals[0].approvalId,
    decision: ApprovalDecision.APPROVE,
    token: paired.deviceToken,
    responseText: 'frontier gate approval'
  });
  requireSuccess(decision, 'approval-decision');
  const executionStarted = performance.now();
  const executed = await runtime.bridgeRuntime.confirmExecutionHandoff({
    handoffId: decision.handoffId,
    token: paired.deviceToken
  });
  requireSuccess(executed, 'execution-handoff');
  const executionMs = performance.now() - executionStarted;
  const deliveredContent = await readFile(deliveredPath, 'utf8');
  const resultBeforeRollback = runtime.bridgeRuntime.getResult({
    taskId: created.taskId,
    token: paired.deviceToken
  });
  requireSuccess(resultBeforeRollback, 'result-read');
  const rollbackPlan = await runtime.pcAgent.rollbackPlan(created.taskId);
  requireSuccess(rollbackPlan, 'rollback-preview');

  const unconfirmedRollback = await runtime.bridgeRuntime.rollbackResult({
    taskId: created.taskId,
    token: paired.deviceToken,
    reason: 'frontier gate unconfirmed rollback',
    confirmed: false
  });
  const artifactPreservedAfterBlockedRollback = await fileExists(deliveredPath);

  const rollbackStarted = performance.now();
  const rollback = await runtime.bridgeRuntime.rollbackResult({
    taskId: created.taskId,
    token: paired.deviceToken,
    reason: 'frontier gate confirmed rollback',
    confirmed: true
  });
  requireSuccess(rollback, 'confirmed-rollback');
  const rollbackMs = performance.now() - rollbackStarted;
  const finalTask = runtime.coreFacade.getTask(created.taskId);
  const resultAfterRollback = runtime.bridgeRuntime.getResult({
    taskId: created.taskId,
    token: paired.deviceToken
  });
  requireSuccess(resultAfterRollback, 'result-read-after-rollback');
  const eventFeed = runtime.bridgeRuntime.eventFeed({ token: paired.deviceToken });
  requireSuccess(eventFeed, 'event-feed');

  const actionNodes = task.plan?.planGraph?.nodes?.filter((node) => node.nodeId?.startsWith('action_')) ?? [];
  const nodeVerifications = task.executionVerification?.nodeVerifications ?? [];
  const rollbackProof = rollback.rollback ?? null;
  const totalMs = performance.now() - started;
  const checks = [
    check('voice_request_provenance_retained', task.request?.source?.inputMode === 'voice'
      && task.request?.metadata?.voiceRecognition?.rawAudioStored === false),
    check('single_approval_card_for_multi_action_plan', approvals.length === 1 && actionNodes.length === 3, {
      approvalCards: approvals.length,
      actionNodes: actionNodes.length
    }),
    check('cross_device_execution_completed', executed.status === TaskStatus.COMPLETED),
    check('every_action_node_verified', nodeVerifications.length === actionNodes.length
      && nodeVerifications.every((item) => item.status === 'passed'), {
      verifiedNodes: nodeVerifications.length,
      actionNodes: actionNodes.length
    }),
    check('artifact_content_matches', deliveredContent === outputContent, {
      sha256: sha256(deliveredContent)
    }),
    check('learning_ingested_after_verified_execution', task.learningResult?.ingest?.stored === true),
    check('rollback_preview_is_complete_and_integral', rollbackPlan.planningMode === 'sequential-virtual-state-v1'
      && rollbackPlan.readyCount === 2
      && rollbackPlan.blockedCount === 0
      && rollbackPlan.chain?.status === 'valid', {
      planningMode: rollbackPlan.planningMode,
      readyCount: rollbackPlan.readyCount,
      blockedCount: rollbackPlan.blockedCount,
      chainStatus: rollbackPlan.chain?.status
    }),
    check('unconfirmed_rollback_is_blocked_without_mutation', unconfirmedRollback?.error?.code === 'D_ROLLBACK_CONFIRMATION_REQUIRED'
      && artifactPreservedAfterBlockedRollback),
    check('confirmed_rollback_restores_pre_execution_state', rollbackProof?.success === true
      && !(await fileExists(stagingPath))
      && !(await fileExists(deliveredPath))),
    check('core_and_bridge_share_compensated_state', finalTask.status === TaskStatus.COMPENSATED
      && resultAfterRollback.status === TaskStatus.COMPENSATED
      && resultAfterRollback.executionResult?.rollbackAvailable === false),
    check('rollback_transaction_and_journal_are_verified', rollbackProof?.transaction?.status === 'completed'
      && rollbackProof?.plan?.chain?.status === 'valid'
      && rollbackProof?.rolledBack?.length === 2),
    check('rollback_completion_reaches_cross_device_event_feed', eventFeed.items?.some((event) => (
      event.eventType === 'result.rollback.completed' && event.payload?.success === true
    )) === true),
    check('request_to_approval_latency_budget', requestToApprovalMs <= thresholds.requestToApprovalMs, {
      measuredMs: round(requestToApprovalMs),
      thresholdMs: thresholds.requestToApprovalMs
    }),
    check('execution_latency_budget', executionMs <= thresholds.executionMs, {
      measuredMs: round(executionMs),
      thresholdMs: thresholds.executionMs
    }),
    check('rollback_latency_budget', rollbackMs <= thresholds.rollbackMs, {
      measuredMs: round(rollbackMs),
      thresholdMs: thresholds.rollbackMs
    }),
    check('total_experience_latency_budget', totalMs <= thresholds.totalMs, {
      measuredMs: round(totalMs),
      thresholdMs: thresholds.totalMs
    })
  ];
  const dimensions = [
    dimension('natural_input', ['voice_request_provenance_retained']),
    dimension('multi_action_execution', ['single_approval_card_for_multi_action_plan', 'cross_device_execution_completed']),
    dimension('postcondition_verification', ['every_action_node_verified', 'artifact_content_matches']),
    dimension('learning', ['learning_ingested_after_verified_execution']),
    dimension('safe_recovery', ['rollback_preview_is_complete_and_integral', 'unconfirmed_rollback_is_blocked_without_mutation', 'confirmed_rollback_restores_pre_execution_state']),
    dimension('cross_surface_consistency', ['core_and_bridge_share_compensated_state', 'rollback_completion_reaches_cross_device_event_feed']),
    dimension('integrity', ['rollback_transaction_and_journal_are_verified']),
    dimension('latency', ['request_to_approval_latency_budget', 'execution_latency_budget', 'rollback_latency_budget', 'total_experience_latency_budget'])
  ].map((item) => ({
    ...item,
    passed: item.checkIds.every((id) => checks.find((candidate) => candidate.checkId === id)?.passed === true)
  }));
  const finishedAt = new Date();
  const report = {
    reportVersion: 'jarvis-frontier-product-experience-gate-v1',
    generatedAt: finishedAt.toISOString(),
    status: checks.every((item) => item.passed) ? 'passed' : 'failed',
    verdict: checks.every((item) => item.passed)
      ? 'frontier-product-standard-demonstrated'
      : 'frontier-product-standard-not-yet-demonstrated',
    score: Math.round((checks.filter((item) => item.passed).length / checks.length) * 100),
    claimBoundary: 'This gate proves the measured JARVIS local cross-device workflow. It does not claim universal superiority across every third-party product or benchmark.',
    scenario: {
      input: 'Korean mobile voice transcript',
      actionNodeCount: actionNodes.length,
      approvalCardCount: approvals.length,
      flow: ['request', 'plan', 'approve', 'execute', 'verify', 'learn', 'preview-undo', 'confirm-undo', 'verify-recovery'],
      commandSha256: sha256(command),
      expectedArtifactSha256: sha256(outputContent),
      rawCommandStored: false,
      rawArtifactPathStored: false
    },
    performance: {
      requestToApprovalMs: round(requestToApprovalMs),
      executionMs: round(executionMs),
      rollbackMs: round(rollbackMs),
      totalMs: round(totalMs),
      thresholds
    },
    dimensions,
    checks,
    privacy: {
      rawAudioStored: false,
      deviceTokenStored: false,
      rawCommandStored: false,
      rawArtifactPathStored: false,
      isolatedWorkspaceRemoved: true
    }
  };

  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(markdownPath, renderMarkdown(report), 'utf8');
  process.stdout.write(`${JSON.stringify({
    status: report.status,
    verdict: report.verdict,
    score: report.score,
    performance: report.performance,
    failedChecks: checks.filter((item) => !item.passed).map((item) => item.checkId),
    reportPath,
    markdownPath
  }, null, 2)}\n`);
  if (report.status !== 'passed') process.exitCode = 1;
} finally {
  if (previousPlanCachePath === undefined) delete process.env.JARVIS_PLAN_CACHE_PATH;
  else process.env.JARVIS_PLAN_CACHE_PATH = previousPlanCachePath;
  await rm(root, { recursive: true, force: true });
}

function plannerResponse(payload) {
  return JSON.stringify({ result: JSON.stringify(payload) });
}

function requireSuccess(value, stage) {
  if (!value || value.success === false || value.error) {
    const code = value?.error?.code ?? value?.reason ?? 'unknown';
    const message = value?.error?.message ? `:${value.error.message}` : '';
    throw new Error(`${stage}:${code}${message}`);
  }
}

function check(checkId, passed, evidence = {}) {
  return { checkId, passed: passed === true, evidence };
}

function dimension(dimensionId, checkIds) {
  return { dimensionId, checkIds };
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function round(value) {
  return Number.isFinite(value) ? Number(value.toFixed(3)) : null;
}

function readFlag(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function positiveNumberFlag(name, fallback) {
  const value = Number(readFlag(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function renderMarkdown(report) {
  const checks = report.checks.map((item) => `| ${item.checkId} | ${item.passed ? 'PASS' : 'FAIL'} |`).join('\n');
  const dimensions = report.dimensions.map((item) => `| ${item.dimensionId} | ${item.passed ? 'PASS' : 'FAIL'} |`).join('\n');
  return `# JARVIS Frontier Product Experience Gate\n\n`
    + `- Status: **${report.status}**\n`
    + `- Verdict: **${report.verdict}**\n`
    + `- Score: **${report.score}/100**\n`
    + `- Total measured time: **${report.performance.totalMs} ms**\n`
    + `- Boundary: ${report.claimBoundary}\n\n`
    + `## Dimensions\n\n| Dimension | Result |\n|---|---|\n${dimensions}\n\n`
    + `## Checks\n\n| Check | Result |\n|---|---|\n${checks}\n`;
}
