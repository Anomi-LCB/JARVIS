import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { ClaudeCliTaskPlanner } from '../packages/core/src/planning/claude-cli-task-planner.js';
import { ActionType, ApprovalDecision, TaskStatus } from '../packages/shared/src/types.js';

function plannerResponse(payload) {
  return JSON.stringify({ result: JSON.stringify(payload) });
}

test('voice transcript keeps provenance and completes a real multi-tool PC workflow', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-voice-complex-e2e-'));
  const workspace = join(root, 'workspace');
  const previousPlanCachePath = process.env.JARVIS_PLAN_CACHE_PATH;
  let modelCalls = 0;
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, 'existing-note.txt'), 'existing evidence', 'utf8');
    process.env.JARVIS_PLAN_CACHE_PATH = join(root, 'plan-cache.jsonl');
    const command = '작업 폴더 파일을 확인하고 그리고 확인 결과 메모 파일을 만들어줘';
    const createdAt = new Date().toISOString();
    const planner = new ClaudeCliTaskPlanner({
      contentEnabled: true,
      runner: () => {
        modelCalls += 1;
        return plannerResponse({
          summary: '작업 폴더를 확인한 뒤 결과 메모를 만듭니다.',
          parts: [
            {
              actionType: ActionType.LIST_FILES,
              text: '작업 폴더 파일을 확인하고',
              description: '작업 폴더 파일 확인',
              slots: { directoryHint: 'workspace' },
              arguments: { directory: workspace }
            },
            {
              actionType: ActionType.CREATE_FILE,
              text: '확인 결과 메모 파일을 만들어줘',
              description: '확인 결과 메모 작성',
              slots: { fileName: 'voice-result.txt', outputFormat: 'txt' },
              arguments: {
                fileName: 'voice-result.txt',
                outputFormat: 'txt',
                path: join(workspace, 'voice-result.txt'),
                contentDraft: { kind: 'txt', content: '작업 폴더 확인 결과를 기록했습니다.' }
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
      deviceId: 'voice_phone_e2e',
      deviceName: 'Voice Phone E2E',
      pairingCode: pairing.pairingCode
    });
    const created = runtime.bridgeRuntime.createTask({
      taskRequest: {
        requestId: 'req_voice_complex_1',
        createdAt,
        userId: 'local_user',
        source: { type: 'mobile', module: 'C_MOBILE', deviceId: 'voice_phone_e2e', inputMode: 'voice' },
        command: { rawText: command, locale: 'ko-KR' },
        metadata: {
          voiceRecognition: {
            confidence: 0.94,
            alternativesCount: 1,
            engine: 'expo-speech-recognition',
            rawAudioStored: false,
            alternativesStored: false,
            commandTextRetainedAsTask: true
          }
        }
      },
      token: paired.deviceToken
    });
    assert.equal(created.status, TaskStatus.WAITING_APPROVAL);
    const task = runtime.coreFacade.getTask(created.taskId);
    assert.equal(task.request.source.inputMode, 'voice');
    assert.equal(task.request.metadata.voiceRecognition.confidence, 0.94);
    assert.equal(task.request.metadata.voiceRecognition.rawAudioStored, false);
    assert.equal(task.plan.llmPlanning.modelRoundTrips, 1);
    assert.equal(task.plan.planGraph.nodes.filter((node) => node.nodeId.startsWith('action_')).length, 2);

    const approval = runtime.bridgeRuntime.listApprovals({ token: paired.deviceToken }).items
      .find((item) => item.taskId === created.taskId);
    const approved = await runtime.bridgeRuntime.decideApproval({
      approvalId: approval.approvalId,
      decision: ApprovalDecision.APPROVE,
      token: paired.deviceToken
    });
    assert.equal(approved.status, TaskStatus.APPROVED);
    const completed = await runtime.bridgeRuntime.confirmExecutionHandoff({
      handoffId: approved.handoffId,
      token: paired.deviceToken
    });
    assert.equal(completed.status, TaskStatus.COMPLETED, JSON.stringify(completed));
    assert.equal(completed.verificationStatus, 'passed');
    assert.equal(await readFile(join(workspace, 'voice-result.txt'), 'utf8'), '작업 폴더 확인 결과를 기록했습니다.');
    assert.deepEqual(task.planGraphRun.nodeRuns.map((run) => run.status), ['completed', 'completed']);
    assert.equal(modelCalls, 1);

    const repeated = runtime.bridgeRuntime.createTask({
      taskRequest: {
        requestId: 'req_voice_complex_2',
        createdAt: new Date(Date.now() + 1_000).toISOString(),
        source: { type: 'mobile', module: 'C_MOBILE', deviceId: 'voice_phone_e2e', inputMode: 'voice' },
        command: { rawText: command, locale: 'ko-KR' },
        metadata: { voiceRecognition: { confidence: 0.97, rawAudioStored: false } }
      },
      token: paired.deviceToken
    });
    const repeatedTask = runtime.coreFacade.getTask(repeated.taskId);
    assert.equal(modelCalls, 1);
    assert.equal(repeatedTask.plan.llmPlanning.fromCache, true);
    assert.equal(repeatedTask.plan.llmPlanning.modelRoundTrips, 0);
  } finally {
    if (previousPlanCachePath === undefined) delete process.env.JARVIS_PLAN_CACHE_PATH;
    else process.env.JARVIS_PLAN_CACHE_PATH = previousPlanCachePath;
    await rm(root, { recursive: true, force: true });
  }
});

test('G verification failure blocks completion after PC execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-voice-verification-fail-'));
  try {
    await writeFile(join(root, 'visible.txt'), 'verification fixture', 'utf8');
    const runtime = createAgRuntime({
      allowedRoots: [root],
      auditRoot: join(root, 'audit'),
      cwd: () => root,
      env: {},
      bridgeRealExecution: true,
      workerDaemonEnabled: false
    });
    runtime.verificationRuntime.verifyExecution = async ({ verificationId, taskId }) => runtime.verificationRuntime.result({
      verificationId,
      taskId,
      checks: [{
        checkId: 'forced_execution_evidence_failure',
        checkName: 'forced_execution_evidence_failure',
        status: 'failed',
        severity: 'critical',
        message: 'Regression fixture rejects execution evidence.',
        evidence: { fixture: true }
      }]
    });

    const task = runtime.coreFacade.createTask('작업 폴더 파일 목록 보여줘', {
      source: 'mobile',
      sourceModule: 'C_MOBILE',
      inputMode: 'voice',
      metadata: {
        voiceRecognition: { confidence: 0.99, rawAudioStored: false }
      }
    });
    const run = await runtime.orchestrationWorker.runTask(task.taskId, {
      deviceId: 'voice_verification_fail_fixture',
      userConfirmation: { confirmed: true }
    });
    const stored = runtime.coreFacade.getTask(task.taskId);

    assert.equal(run.success, false);
    assert.equal(run.execution.status, TaskStatus.COMPLETED, 'the PC action completed before G rejected its evidence');
    assert.equal(run.executionVerification.status, 'failed');
    assert.equal(run.failure.success, true);
    assert.equal(stored.status, TaskStatus.FAILED);
    assert.equal(stored.learningResult, null, 'failed execution evidence must not become successful workflow learning');
    assert.equal(stored.orchestrationTrace.steps.some((step) => step.phase === 'worker.verification.failed'), true);
    assert.equal(stored.orchestrationTrace.status === 'completed', false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
