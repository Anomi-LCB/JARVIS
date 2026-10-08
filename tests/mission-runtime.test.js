import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { CoreClient } from '../packages/core/src/client/core-client.js';
import { createCoreServer } from '../packages/core/src/main.mjs';
import { GoalExecutivePlanner, buildMissionPlanningPrompt } from '../packages/core/src/mission/mission-planner.js';
import { MissionGrant, MissionStatus } from '../packages/core/src/mission/mission-runtime.js';
import { FileMissionStore, replaceFileWithRetry } from '../packages/core/src/mission/mission-store.js';
import { MissionRoleAgentSessionPool } from '../packages/core/src/mission/mission-role-agent-session-pool.js';
import { listenOnFetchSafePort } from '../packages/shared/src/http.js';
import { ApprovalDecision, createApprovalDecision, TaskStatus } from '../packages/shared/src/types.js';

class ScriptedMissionPlanner {
  constructor(plan) {
    this.plan = plan;
    this.calls = 0;
  }

  async planNextWave(context) {
    this.calls += 1;
    return await this.plan(context, this.calls);
  }
}

function continueWith(actions, summary = '다음 실행 웨이브') {
  return {
    decision: 'continue',
    summary,
    actions,
    criteriaAssessment: []
  };
}

function completeFromLatestSuccess(context) {
  const successful = context.observations.filter((observation) => observation.outcome === 'success');
  const evidenceActionId = successful.at(-1)?.actionId;
  return {
    decision: 'complete',
    summary: '검증된 실행 증거로 목표를 완료합니다.',
    actions: [],
    criteriaAssessment: context.mission.successCriteria.map((criterion) => ({
      criterionId: criterion.criterionId,
      status: 'satisfied',
      evidenceActionIds: [evidenceActionId],
      reason: 'A-G 실행 검증을 통과한 행동 증거가 있습니다.'
    }))
  };
}

test('Mission Runtime replans after a route mismatch, parallelizes reads, and completes a verified write', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-mission-executive-'));
  const workspace = join(root, 'workspace');
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, 'alpha.txt'), 'alpha', 'utf8');
    await writeFile(join(workspace, 'beta.txt'), 'beta', 'utf8');
    const planner = new ScriptedMissionPlanner((context, call) => {
      if (call === 1) {
        return continueWith([{
          id: 'wrong_route_probe',
          title: '도구 라우팅 검증',
          command: '작업 폴더 파일 목록 보여줘',
          expectedToolName: 'browser.search',
          dependencies: [],
          successSignal: '파일 목록 확인'
        }], '의도적으로 잘못된 예상 도구를 검증합니다.');
      }
      if (call === 2) {
        return continueWith([
          {
            id: 'read_workspace_a',
            title: '첫 번째 파일 목록 확인',
            command: '작업 폴더 파일 목록 보여줘',
            expectedToolName: 'filesystem.listFiles',
            dependencies: [],
            successSignal: '파일 목록 반환'
          },
          {
            id: 'read_workspace_b',
            title: '두 번째 파일 목록 확인',
            command: '작업 폴더의 파일 리스트를 다시 보여줘',
            expectedToolName: 'filesystem.listFiles',
            dependencies: [],
            successSignal: '파일 목록 반환'
          }
        ], '독립적인 두 관찰을 병렬로 실행합니다.');
      }
      if (call === 3) {
        return continueWith([{
          id: 'write_result',
          title: '검증 결과 파일 작성',
          command: 'mission-result 메모 파일을 만들어줘. 내용은 목표 달성 완료',
          expectedToolName: 'filesystem.createTextFile',
          dependencies: [],
          successSignal: 'mission-result.txt 생성 및 검증'
        }], '관찰 결과를 실제 산출물로 만듭니다.');
      }
      return completeFromLatestSuccess(context);
    });
    const runtime = createAgRuntime({
      allowedRoots: [workspace],
      auditRoot: join(root, 'audit'),
      cwd: () => workspace,
      env: {},
      missionPlanner: planner,
      workerDaemonEnabled: false
    });
    const created = runtime.missionRuntime.createMission({
      objective: '작업 폴더를 점검하고 검증 결과 파일을 만들어라.',
      successCriteria: ['mission-result.txt가 생성되고 G 검증을 통과한다.'],
      authorization: { grants: [MissionGrant.READ_ONLY, MissionGrant.LOCAL_REVERSIBLE] }
    });
    const completed = await runtime.missionRuntime.runMission(created.missionId);

    assert.equal(completed.status, MissionStatus.COMPLETED, JSON.stringify(completed));
    assert.equal(completed.metrics.routeMismatches, 1);
    assert.equal(completed.metrics.parallelBatches >= 1, true);
    assert.equal(completed.metrics.maxObservedParallelism >= 2, true);
    assert.equal(completed.metrics.successfulActions, 3);
    assert.equal(completed.waveCount, 3);
    assert.equal(planner.calls, 3);
    assert.equal(completed.completion.status, 'verified');
    assert.equal(completed.observations.some((item) => item.error?.code === 'A_MISSION_ROUTE_MISMATCH'), true);
    const discardedTask = runtime.coreFacade.getTask(completed.waves[0].actions[0].taskId);
    assert.equal(discardedTask.status, TaskStatus.CANCELLED);
    await access(join(workspace, 'mission-result.txt'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Mission Runtime accepts a safer equivalent local-file route without an extra recovery wave', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-mission-route-adapt-'));
  try {
    await writeFile(join(root, 'package.json'), '{"name":"route-adaptation"}', 'utf8');
    const planner = new ScriptedMissionPlanner((context) => {
      if (context.observations.some((observation) => observation.outcome === 'success')) {
        return completeFromLatestSuccess(context);
      }
      return continueWith([{
        id: 'find_package_file',
        title: 'package.json 존재 확인',
        command: `${root} 폴더에서 package.json 파일을 찾아줘`,
        expectedToolName: 'filesystem.listFiles',
        dependencies: [],
        successSignal: 'package.json 검색 결과가 검증됨'
      }]);
    });
    const runtime = createAgRuntime({
      allowedRoots: [root],
      auditRoot: join(root, 'audit'),
      cwd: () => root,
      env: {},
      missionPlanner: planner,
      workerDaemonEnabled: false
    });
    const created = runtime.missionRuntime.createMission({
      objective: 'package.json 파일이 존재하는지 읽기 전용으로 확인한다.',
      authorization: { grants: [MissionGrant.READ_ONLY] }
    });
    const completed = await runtime.missionRuntime.runMission(created.missionId);
    const action = completed.waves[0].actions[0];

    assert.equal(completed.status, MissionStatus.COMPLETED, JSON.stringify(completed));
    assert.equal(completed.metrics.routeMismatches, 0);
    assert.equal(completed.metrics.routeAdaptations, 1);
    assert.equal(completed.waveCount, 1);
    assert.equal(planner.calls, 1, 'the default criterion now retains the concrete objective and can complete from its exact file evidence');
    assert.equal(action.expectedToolName, 'filesystem.listFiles');
    assert.equal(action.actualToolName, 'filesystem.searchFiles');
    assert.equal(action.routeAdaptation.reason, 'equivalent-local-file-read');
    assert.equal(action.status, 'succeeded');
    const routedTask = runtime.coreFacade.getTask(action.taskId);
    assert.equal(routedTask.plan.trustedMissionRoute.reason, 'safe-equivalent-local-read-route-preserved');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Mission Runtime stops before a local write, resumes after a scoped gate, and persists completion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-mission-gate-'));
  const workspace = join(root, 'workspace');
  const auditRoot = join(root, 'audit');
  try {
    await mkdir(workspace, { recursive: true });
    const planner = new ScriptedMissionPlanner((context) => {
      if (context.observations.some((observation) => observation.outcome === 'success')) {
        return completeFromLatestSuccess(context);
      }
      return continueWith([{
        id: 'write_gated_result',
        title: '승인 대상 파일 생성',
        command: 'gated-result 메모 파일을 만들어줘. 내용은 승인 완료',
        expectedToolName: 'filesystem.createTextFile',
        dependencies: [],
        successSignal: 'gated-result.txt 생성'
      }]);
    });
    const runtime = createAgRuntime({
      allowedRoots: [workspace],
      auditRoot,
      cwd: () => workspace,
      env: {},
      missionPlanner: planner,
      workerDaemonEnabled: false
    });
    const created = runtime.missionRuntime.createMission({
      objective: 'gated-result.txt 결과 파일을 생성하라.',
      successCriteria: [{ statement: '승인한 내용으로 결과 파일을 저장한다.',
        verificationSpec: { version: 1, kind: 'text.equals', path: 'gated-result.txt', equals: '승인 완료' } }],
      authorization: { grants: [MissionGrant.READ_ONLY] }
    });
    const waiting = await runtime.missionRuntime.runMission(created.missionId);

    assert.equal(waiting.status, MissionStatus.WAITING_APPROVAL);
    assert.equal(waiting.pendingGates.length, 1);
    await assert.rejects(access(join(workspace, 'gated-result.txt')));

    const gate = waiting.pendingGates[0];
    const decided = runtime.missionRuntime.decideGate(created.missionId, gate.gateId, {
      decision: 'approve',
      decidedBy: 'mission-test'
    });
    assert.equal(decided.status, MissionStatus.PAUSED);
    const completed = await runtime.missionRuntime.runMission(created.missionId);
    assert.equal(completed.status, MissionStatus.COMPLETED, JSON.stringify(completed));
    await access(join(workspace, 'gated-result.txt'));

    const restored = createAgRuntime({
      allowedRoots: [workspace],
      auditRoot,
      cwd: () => workspace,
      env: {},
      missionPlanner: planner,
      workerDaemonEnabled: false
    });
    assert.equal(restored.missionRuntime.getMission(created.missionId).status, MissionStatus.COMPLETED);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a late mission gate creates a fresh scoped approval window before execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-mission-late-gate-'));
  const nowMs = Date.now();
  const clock = () => new Date(nowMs);
  try {
    const planner = new ScriptedMissionPlanner((context) => {
      if (context.observations.some((observation) => observation.outcome === 'success')) {
        return completeFromLatestSuccess(context);
      }
      return continueWith([{
        id: 'late_gate_write',
        title: '늦은 승인 파일 생성',
        command: 'late-gate-result 메모 파일을 만들어줘. 내용은 새 승인만 허용',
        expectedToolName: 'filesystem.createTextFile',
        dependencies: [],
        successSignal: 'late-gate-result.txt 생성'
      }]);
    });
    const runtime = createAgRuntime({
      allowedRoots: [root],
      auditRoot: join(root, 'audit'),
      cwd: () => root,
      clock,
      env: {},
      missionPlanner: planner,
      workerDaemonEnabled: false
    });
    const created = runtime.missionRuntime.createMission({
      objective: '오래 열린 게이트를 새 동의로 승인한다.',
      successCriteria: ['late-gate-result.txt 파일이 생성된다.'],
      authorization: { grants: [MissionGrant.READ_ONLY] }
    });
    const waiting = await runtime.missionRuntime.runMission(created.missionId);
    const gate = waiting.pendingGates[0];
    const action = waiting.waves[0].actions[0];
    const waitingTask = runtime.coreFacade.getTask(action.taskId);
    waitingTask.approvalCard.expiresAt = new Date(nowMs - 1).toISOString();
    const staleExpiry = waitingTask.approvalCard.expiresAt;

    const decided = runtime.missionRuntime.decideGate(created.missionId, gate.gateId, {
      decision: 'approve',
      decidedBy: 'late-gate-test'
    });
    const refreshedTask = runtime.coreFacade.getTask(action.taskId);

    assert.equal(decided.status, MissionStatus.PAUSED, JSON.stringify(decided));
    assert.equal(Date.parse(refreshedTask.approvalCard.expiresAt) > nowMs, true);
    assert.equal(Date.parse(refreshedTask.approvalCard.expiresAt) > Date.parse(staleExpiry), true);
    assert.equal(decided.gates[0].approvalExpiresAt, refreshedTask.approvalCard.expiresAt);
    const completed = await runtime.missionRuntime.runMission(created.missionId);
    assert.equal(completed.status, MissionStatus.COMPLETED, JSON.stringify(completed));
    await access(join(root, 'late-gate-result.txt'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('approval decisions reject a different card id and an expired card', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-approval-replay-'));
  let nowMs = Date.parse('2026-08-30T00:00:00.000Z');
  const clock = () => new Date(nowMs);
  try {
    const runtime = createAgRuntime({
      allowedRoots: [root],
      auditRoot: join(root, 'audit'),
      cwd: () => root,
      clock,
      env: {},
      workerDaemonEnabled: false
    });
    const task = runtime.coreFacade.createTask('approval-replay 메모 파일을 만들어줘. 내용은 실행 금지');
    assert.equal(task.status, TaskStatus.WAITING_APPROVAL);

    const wrongCard = runtime.coreFacade.submitApprovalDecision(createApprovalDecision({
      approvalId: 'approval_from_another_task',
      taskId: task.taskId,
      decision: ApprovalDecision.APPROVE,
      deviceId: 'approval-security-test',
      decidedAt: clock().toISOString()
    }));
    assert.equal(wrongCard.success, false);
    assert.equal(wrongCard.reason, 'approval-card-mismatch');
    assert.equal(runtime.coreFacade.getTask(task.taskId).status, TaskStatus.WAITING_APPROVAL);

    nowMs = Date.parse(task.approvalCard.expiresAt) + 1;
    const stale = runtime.coreFacade.submitApprovalDecision(createApprovalDecision({
      approvalId: task.approvalCard.approvalId,
      taskId: task.taskId,
      decision: ApprovalDecision.APPROVE,
      deviceId: 'approval-security-test',
      decidedAt: clock().toISOString()
    }));
    assert.equal(stale.success, false);
    assert.equal(stale.reason, 'approval-expired');
    assert.equal(runtime.coreFacade.getTask(task.taskId).status, TaskStatus.EXPIRED);
    await assert.rejects(access(join(root, 'approval-replay.txt')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Mission cancellation closes its decision gate and discards the waiting child task', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-mission-cancel-'));
  try {
    const planner = new ScriptedMissionPlanner(() => continueWith([{
      id: 'write_then_cancel',
      title: '취소 대상 파일 생성',
      command: 'cancelled-result 메모 파일을 만들어줘. 내용은 생성 금지',
      expectedToolName: 'filesystem.createTextFile',
      dependencies: [],
      successSignal: '실행되면 안 됨'
    }]));
    const runtime = createAgRuntime({
      allowedRoots: [root],
      auditRoot: join(root, 'audit'),
      cwd: () => root,
      env: {},
      missionPlanner: planner,
      workerDaemonEnabled: false
    });
    const created = runtime.missionRuntime.createMission({
      // The grant creates the approval gate. An unverified natural-language
      // condition would exercise a different requirement-coverage boundary.
      objective: 'cancelled-result.txt 결과 파일을 생성하라.',
      successCriteria: ['cancelled-result.txt 파일이 생성된다.'],
      authorization: { grants: [MissionGrant.READ_ONLY] }
    });
    const waiting = await runtime.missionRuntime.runMission(created.missionId);
    const action = waiting.waves[0].actions[0];

    assert.equal(waiting.status, MissionStatus.WAITING_APPROVAL, JSON.stringify({stopReason:waiting.stopReason,observations:waiting.observations,coverage:action.requirementCoverage}));
    assert.equal(runtime.coreFacade.getTask(action.taskId).status, TaskStatus.WAITING_APPROVAL);
    const cancelled = runtime.missionRuntime.cancelMission(created.missionId, { reason: 'test-cancel' });

    assert.equal(cancelled.status, MissionStatus.CANCELLED);
    assert.equal(cancelled.pendingGates.length, 0);
    assert.equal(cancelled.gates[0].status, 'cancelled');
    assert.equal(cancelled.waves[0].actions[0].status, 'skipped');
    assert.equal(runtime.coreFacade.getTask(action.taskId).status, TaskStatus.CANCELLED);
    await assert.rejects(access(join(root, 'cancelled-result.txt')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Mission cancellation aborts an in-flight asynchronous planning call', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-mission-abort-'));
  try {
    let plannerEntered;
    const entered = new Promise((resolve) => { plannerEntered = resolve; });
    const planner = {
      async planNextWave(_context, { signal } = {}) {
        plannerEntered();
        return await new Promise((resolve, reject) => {
          const onAbort = () => {
            const error = new Error('planning-aborted');
            error.name = 'AbortError';
            reject(error);
          };
          if (signal?.aborted) onAbort();
          else signal?.addEventListener('abort', onAbort, { once: true });
        });
      }
    };
    const runtime = createAgRuntime({
      allowedRoots: [root],
      auditRoot: join(root, 'audit'),
      cwd: () => root,
      env: {},
      missionPlanner: planner,
      workerDaemonEnabled: false
    });
    const created = runtime.missionRuntime.createMission({ objective: '계획 중 취소를 검증한다.' });
    const running = runtime.missionRuntime.runMission(created.missionId);
    await entered;

    const cancelled = runtime.missionRuntime.cancelMission(created.missionId, { reason: 'test-abort' });
    const finished = await running;

    assert.equal(cancelled.status, MissionStatus.CANCELLED);
    assert.equal(finished.status, MissionStatus.CANCELLED);
    assert.equal(finished.stopReason, 'test-abort');
    assert.equal(runtime.missionRuntime.status().activeRunCount, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('G08 Core cancellation preserves a completed draft and fences a late planner wave', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-g08-cancel-'));
  const workspace = join(root, 'workspace');
  const auditRoot = join(root, 'audit');
  const eventLogPath = join(auditRoot, 'mission-events.jsonl');
  await mkdir(workspace, { recursive: true });
  await mkdir(auditRoot, { recursive: true });
  let plannerCalls = 0;
  let enteredSecondPlan;
  let releaseSecondPlan;
  const secondPlanEntered = new Promise(resolve => { enteredSecondPlan = resolve; });
  const latePlanReleased = new Promise(resolve => { releaseSecondPlan = resolve; });
  const planner = {
    async planNextWave(_context, { signal } = {}) {
      plannerCalls += 1;
      if (plannerCalls === 1) return continueWith([{
        id: 'write_draft_before_cancel', title: '취소 전에 초안 저장',
        command: 'cancel-draft.md 메모 파일을 만들어줘. 내용은 취소 전에 저장된 초안',
        arguments: { path: join(workspace, 'cancel-draft.md'), content: '취소 전에 저장된 초안' },
        expectedToolName: 'filesystem.createTextFile', dependencies: [], successSignal: 'cancel-draft.md 생성 및 검증'
      }], '취소 전에 재검증 가능한 초안을 저장합니다.');
      if (plannerCalls === 2) {
        enteredSecondPlan();
        await latePlanReleased;
        return continueWith([{
          id: 'write_after_cancel', title: '취소 뒤 후속 파일 생성',
          command: 'cancel-followup.txt 메모 파일을 만들어줘. 내용은 취소 뒤에는 생성되면 안 됨',
          arguments: { path: join(workspace, 'cancel-followup.txt'), content: '취소 뒤에는 생성되면 안 됨' },
          expectedToolName: 'filesystem.createTextFile', dependencies: [], successSignal: '후속 파일 생성'
        }], signal?.aborted ? '취소 응답 뒤 늦게 도착한 계획' : '정상 후속 계획');
      }
      return completeFromLatestSuccess(_context);
    }
  };
  const runtime = createAgRuntime({
    allowedRoots: [workspace], auditRoot, cwd: () => workspace, env: {}, missionPlanner: planner, workerDaemonEnabled: false
  });
  const server = createCoreServer(runtime.coreFacade, {
    adminToken: 'g08-fixture-admin-token', missionRuntime: runtime.missionRuntime
  });
  const serverAddress = await listenOnFetchSafePort(server);
  t.after(async () => {
    releaseSecondPlan();
    try { await runtime.missionRuntime.requestShutdown({ reason: 'test-cleanup' }); } catch {}
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });

  const created = runtime.missionRuntime.createMission({
    objective: '보고서 초안을 저장한 다음 추가 요청과 파일 변경을 멈춰라.',
    successCriteria: ['cancel-followup.txt가 생성되어 G 검증을 통과한다.'],
    authorization: { grants: [MissionGrant.READ_ONLY, MissionGrant.LOCAL_REVERSIBLE] }
  });
  const running = runtime.missionRuntime.runMission(created.missionId);
  await Promise.race([secondPlanEntered, running.then(result => {
    throw new Error(`G08 mission ended before the cancellation boundary: ${result.status}/${result.stopReason}`);
  })]);
  const beforeCancel = runtime.missionRuntime.getMission(created.missionId);
  const beforeCancelPlannerCalls = plannerCalls;
  const cancelResponse = await fetch(`http://127.0.0.1:${serverAddress.port}/missions/${created.missionId}/cancel`, {
    method: 'POST', headers: { authorization: 'Bearer g08-fixture-admin-token', 'content-type': 'application/json' },
    body: JSON.stringify({ reason: 'g08-user-cancel' })
  });
  const cancelResult = await cancelResponse.json();
  releaseSecondPlan();
  const finished = await running;
  const draftPath = join(workspace, 'cancel-draft.md');
  const followupPath = join(workspace, 'cancel-followup.txt');
  const draftBytes = await readFile(draftPath);
  const followupExists = await access(followupPath).then(() => true, () => false);
  const finalMission = runtime.missionRuntime.getMission(created.missionId);
  const eventLines = (await readFile(eventLogPath, 'utf8')).trim().split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
  assert.equal(cancelResponse.status, 200);
  assert.equal(cancelResult.status, MissionStatus.CANCELLED);
  assert.equal(beforeCancel.status, MissionStatus.PLANNING);
  assert.equal(beforeCancelPlannerCalls, 2);
  assert.equal(finished.status, MissionStatus.CANCELLED);
  assert.equal(plannerCalls, 2);
  assert.equal(finished.waves.length, 1);
  assert.equal(finished.waves[0].actions[0].status, 'succeeded');
  assert.equal(finished.observations.some(item => item.actionId === finished.waves[0].actions[0].actionId && item.verification?.status === 'passed'), true);
  assert.equal(followupExists, false);
  assert.equal(eventLines.some(item => item.eventType === 'mission.cancelled' && item.status === MissionStatus.CANCELLED), true);
  assert.equal(eventLines.at(-1)?.eventType, 'mission.run.finished');
  assert.equal(eventLines.at(-1)?.status, MissionStatus.CANCELLED);

  const capturePath = process.env.JARVIS_G08_ORACLE_EVIDENCE_PATH;
  if (capturePath) {
    await writeFile(capturePath, `${JSON.stringify({
      schemaVersion: 1,
      scenarioId: 'G08',
      request: '이 보고서를 만들다가 취소하면 추가 호출과 파일 변경을 멈추고 이미 생긴 결과를 구분해줘.',
      cancelResponse: { statusCode: cancelResponse.status, missionStatus: cancelResult.status, stopReason: cancelResult.stopReason },
      planner: { callsBeforeCancel: beforeCancelPlannerCalls, callsAfterLatePlanRelease: plannerCalls, latePlanReturned: true },
      mission: {
        missionId: finalMission.missionId, status: finalMission.status, stopReason: finalMission.stopReason,
        waveCount: finalMission.waves.length, executedActions: finalMission.metrics.executedActions,
        firstActionStatus: finalMission.waves[0]?.actions[0]?.status,
        firstActionObservationVerified: finalMission.observations.some(item => item.actionId === finalMission.waves[0]?.actions[0]?.actionId && item.verification?.status === 'passed'),
        followupActionPresent: finalMission.waves.some(wave => wave.actions.some(action => action.id === 'write_after_cancel'))
      },
      priorArtifact: {
        relativePath: 'cancel-draft.md', base64: draftBytes.toString('base64'), byteLength: draftBytes.length,
        sha256: createHash('sha256').update(draftBytes).digest('hex')
      },
      followupArtifactExists: followupExists,
      eventTypes: eventLines.map(item => ({ eventType: item.eventType, status: item.status }))
    }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  }
});

test('G09 a reduced Mission grant blocks the planned write while the still-authorized read completes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-g09-revoke-'));
  const workspace = join(root, 'workspace');
  const auditRoot = join(root, 'audit');
  const eventLogPath = join(auditRoot, 'mission-events.jsonl');
  await mkdir(workspace, { recursive: true });
  await mkdir(auditRoot, { recursive: true });
  await writeFile(join(workspace, 'allowed.txt'), '읽기 허용 fixture', 'utf8');
  let plannerCalls = 0;
  const planner = {
    async planNextWave() {
      plannerCalls += 1;
      if (plannerCalls === 1) {
        return continueWith([
          { id: 'revoked_write', title: '권한 축소 후 파일 생성',
            command: 'restricted.txt 메모 파일을 만들어줘. 내용은 권한 축소 후 생성되면 안 됨',
            expectedToolName: 'filesystem.createTextFile', dependencies: [], successSignal: '제한된 파일이 생성됨' },
          { id: 'still_allowed_read', title: '권한 축소 후 파일 목록 읽기',
            command: '현재 작업 폴더의 파일 목록을 보여줘',
            expectedToolName: 'filesystem.listFiles', dependencies: [], successSignal: '파일 목록 반환' }
        ], '철회된 쓰기와 남은 읽기 권한을 각각 검사합니다.');
      }
      return completeFromLatestSuccess({ mission: { successCriteria: [] }, observations: [] });
    }
  };
  const runtime = createAgRuntime({ allowedRoots: [workspace], auditRoot, cwd: () => workspace, env: {},
    missionPlanner: planner, workerDaemonEnabled: false });
  let reduced = null;
  const checkAvailability = runtime.missionRuntime.checkActionAvailability.bind(runtime.missionRuntime);
  runtime.missionRuntime.checkActionAvailability = async (...args) => {
    const available = await checkAvailability(...args);
    const phase = args[4];
    if (phase === 'dispatch' && reduced === null) {
      reduced = runtime.missionRuntime.updateMission(created.missionId, {
        authorization: { grants: [MissionGrant.READ_ONLY] }
      });
    }
    return available;
  };
  t.after(async () => {
    try { await runtime.missionRuntime.requestShutdown({ reason: 'test-cleanup' }); } catch {}
    await rm(root, { recursive: true, force: true });
  });

  const created = runtime.missionRuntime.createMission({
    objective: '권한을 줄이는 동안 진행 중인 업무는 새 권한으로 다시 판단하고 허용된 읽기만 이어가줘.',
    successCriteria: ['허용된 읽기만 실행하고 권한이 줄어든 쓰기는 실행하지 않는다.'],
    authorization: { grants: [MissionGrant.READ_ONLY, MissionGrant.LOCAL_REVERSIBLE] }
  });
  const beforeRevocation = runtime.missionRuntime.getMission(created.missionId);
  const running = runtime.missionRuntime.runMission(created.missionId);
  const finished = await running;
  const restrictedExists = await access(join(workspace, 'restricted.txt')).then(() => true, () => false);
  const allowedBytes = await readFile(join(workspace, 'allowed.txt'));
  const eventLines = (await readFile(eventLogPath, 'utf8')).trim().split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
  const writeAction = finished.waves.flatMap(wave => wave.actions).find(action => action.localActionId === 'revoked_write');
  const readAction = finished.waves.flatMap(wave => wave.actions).find(action => action.localActionId === 'still_allowed_read');
  const blockedEvent = eventLines.find(item => item.eventType === 'mission.action.authorization-blocked'
    && item.details?.actionId === writeAction?.actionId);
  assert.equal(created.authorizationRevision, 1);
  assert.equal(beforeRevocation.authorizationRevision, 1);
  assert.equal(reduced.authorizationRevision, 2);
  assert.deepEqual(reduced.authorization.grants, [MissionGrant.READ_ONLY]);
  assert.equal(finished.authorizationRevision, 2);
  assert.equal(restrictedExists, false);
  assert.equal(writeAction?.status, 'waiting_approval');
  assert.equal(writeAction?.authorizationRevision, 1);
  assert.equal(writeAction?.authorizationCheckRevision, 2);
  assert.equal(readAction?.status, 'succeeded');
  assert.equal(readAction?.authorizationRevision, 2);
  assert.equal(blockedEvent?.details?.authorizationRevision, 2);
  assert.equal(blockedEvent?.details?.phase, 'dispatch');
  assert.deepEqual(blockedEvent?.details?.grants, [MissionGrant.READ_ONLY]);
  assert.equal(finished.status, MissionStatus.WAITING_APPROVAL);
  assert.equal(eventLines.some(item => item.eventType === 'mission.settings.updated'
    && item.details?.authorizationRevision === 2), true);

  const capturePath = process.env.JARVIS_G09_ORACLE_EVIDENCE_PATH;
  if (capturePath) {
    await writeFile(capturePath, `${JSON.stringify({
      schemaVersion: 1,
      scenarioId: 'G09',
      request: '권한을 줄이는 동안 진행 중인 업무는 새 권한으로 다시 판단하고 허용된 읽기만 이어가줘.',
      planner: { calls: plannerCalls, grantReducedBetweenPrepareAndDispatch: true },
      authorization: {
        initialRevision: created.authorizationRevision,
        beforeRevocation: beforeRevocation.authorizationRevision,
        afterRevocation: reduced.authorizationRevision,
        effectiveGrants: reduced.authorization.grants
      },
      mission: {
        status: finished.status,
        authorizationRevision: finished.authorizationRevision,
        writeAction: writeAction && { actionId: writeAction.actionId, status: writeAction.status, taskId: writeAction.taskId,
          executionCount: writeAction.attempts, authorizationRevision: writeAction.authorizationRevision ?? null,
          authorizationCheckRevision: writeAction.authorizationCheckRevision ?? null },
        readAction: readAction && { actionId: readAction.actionId, status: readAction.status, taskId: readAction.taskId,
          executionCount: readAction.attempts, authorizationRevision: readAction.authorizationRevision ?? null,
          observationId: readAction.observationId },
        observations: finished.observations.map(item => ({ actionId: item.actionId, outcome: item.outcome,
          verificationStatus: item.verification?.status ?? null, verificationId: item.verification?.verificationId ?? null }))
      },
      restrictedFileExists: restrictedExists,
      allowedFile: { relativePath: 'allowed.txt', base64: allowedBytes.toString('base64'), byteLength: allowedBytes.length,
        sha256: createHash('sha256').update(allowedBytes).digest('hex') },
      blockedAuthorizationDecision: blockedEvent && { actionId: blockedEvent.details.actionId,
        authorizationRevision: blockedEvent.details.authorizationRevision, executionClass: blockedEvent.details.executionClass,
        grants: blockedEvent.details.grants },
      events: eventLines.map(item => ({ eventType: item.eventType,
        authorizationRevision: item.details?.authorizationRevision ?? null,
        actionId: item.details?.actionId ?? null }))
    }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  }
});

test('runtime composition never reuses the synchronous task planner runner for missions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-mission-runner-boundary-'));
  try {
    const synchronousTaskRunner = () => {
      throw new Error('synchronous-task-runner-must-not-reach-missions');
    };
    const taskPlanner = {
      runner: synchronousTaskRunner,
      configureWorkspaceRoot() {}
    };
    const runtime = createAgRuntime({
      allowedRoots: [root],
      auditRoot: join(root, 'audit'),
      taskPlanner,
      env: {
        JARVIS_MISSION_EXECUTIVE: '1',
        JARVIS_MISSION_COMMAND: 'missing-async-mission-runner-for-contract-test'
      },
      workerDaemonEnabled: false
    });

    assert.notEqual(runtime.missionRuntime.planner.runner, synchronousTaskRunner);
    assert.equal(typeof runtime.missionRuntime.planner.runner, 'function');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Mission Runtime detects semantically repeated plans even when the wording changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-mission-stall-'));
  try {
    const repeatedCommands = [
      'package.json 파일을 검색해줘',
      'package.json 파일을 직접 찾아줘',
      'package.json 파일이 있는지 검색해서 확인해줘'
    ];
    const planner = new ScriptedMissionPlanner((_context, call) => continueWith([{
      id: 'same_bad_route',
      title: `반복 라우팅 실패 ${call}`,
      command: repeatedCommands[Math.min(call - 1, repeatedCommands.length - 1)],
      expectedToolName: 'browser.search',
      dependencies: [],
      successSignal: '도달하지 않음'
    }]));
    const runtime = createAgRuntime({
      allowedRoots: [root],
      auditRoot: join(root, 'audit'),
      cwd: () => root,
      env: {},
      missionPlanner: planner,
      workerDaemonEnabled: false
    });
    const created = runtime.missionRuntime.createMission({ objective: '반복 실패 차단을 검증한다.' });
    const result = await runtime.missionRuntime.runMission(created.missionId, { maxWaves: 10 });

    assert.equal(result.status, MissionStatus.BLOCKED);
    assert.equal(result.stopReason, 'repeated-plan-stall-detected');
    assert.equal(result.waveCount, 2);
    assert.equal(result.metrics.routeMismatches, 2);
    assert.equal(planner.calls, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('GoalExecutivePlanner rejects invalid action graphs while preserving valid observation identifiers', async () => {
  const runner = () => JSON.stringify({
    result: JSON.stringify({
      decision: 'continue',
      summary: '등록 도구만 사용합니다.',
      actions: [
        {
          id: 'read_files',
          title: '파일 읽기',
          command: '작업 폴더 파일 목록 보여줘',
          expectedToolName: 'filesystem.listFiles',
          dependencies: ['missing_action', 'read_files'],
          successSignal: '목록 반환'
        },
        {
          id: 'hallucinated',
          title: '존재하지 않는 도구',
          command: '존재하지 않는 도구를 실행해',
          expectedToolName: 'pc.omnipotent',
          dependencies: [],
          successSignal: '실행되면 안 됨'
        }
      ],
      criteriaAssessment: [{
        criterionId: 'criterion_1',
        status: 'satisfied',
        evidenceActionIds: ['mission_wave_한글-목표:action:1'],
        reason: '한글 행동 식별자를 그대로 인용합니다.'
      }]
    })
  });
  const planner = new GoalExecutivePlanner({ runner });
  const context = {
    mission: {
      objective: '작업 폴더를 확인한다.',
      successCriteria: [{ criterionId: 'criterion_1', statement: '파일 목록을 확인한다.' }],
      constraints: [],
      remainingBudget: { waves: 3, actions: 5, plannerCalls: 5, activeRuntimeMs: 10000 }
    },
    capabilities: [{
      toolName: 'filesystem.listFiles',
      actionType: 'LIST_FILES',
      readOnly: true,
      mutatesSystem: false,
      rollback: false,
      externalNetwork: false,
      externalTransfer: false
    }],
    observations: [{
      observationId: 'observation_1',
      actionId: 'read_files',
      outcome: 'success',
      toolName: 'filesystem.searchFiles',
      summary: '2개의 파일을 찾았습니다.',
      data: {
        matches: [
          { name: 'package.json', path: 'C:\\workspace\\package.json' },
          { name: 'package-lock.json', path: 'C:\\workspace\\package-lock.json' }
        ]
      },
      trustBoundary: 'UNTRUSTED_CONTENT',
      untrusted: true
    }]
  };
  const plan = await planner.planNextWave(context);

  assert.equal(plan.decision, 'pause');
  assert.deepEqual(plan.actions, []);
  assert.equal(plan.planning.degraded, true);
  assert.equal(plan.planning.errorCode, 'A_MISSION_PLANNER_INVALID_RESPONSE');
  const validPayload = JSON.parse(JSON.parse(runner()).result);
  validPayload.actions = [{ ...validPayload.actions[0], dependencies: [] }];
  const valid = planner.sanitizePlan(validPayload, context);
  assert.deepEqual(valid.criteriaAssessment[0].evidenceActionIds, ['mission_wave_한글-목표:action:1']);
  const rolePayload = { ...validPayload, actions: [{ ...validPayload.actions[0],
    collaborationGroupId: 'source-report', workerRole: 'researcher' }] };
  const rolePlan = planner.sanitizePlan(rolePayload, context);
  assert.equal(rolePlan.actions[0].collaborationGroupId, 'source-report');
  assert.equal(rolePlan.actions[0].workerRole, 'researcher');
  const invalidRolePlan = planner.sanitizePlan({ ...rolePayload,
    actions: [{ ...rolePayload.actions[0], workerRole: 'superuser' }] }, context);
  assert.equal(invalidRolePlan, null);
  const prompt = buildMissionPlanningPrompt({ ...context, maxActionsPerWave: 4, today: '2026-08-17' });
  assert.match(prompt, /신뢰할 수 없는 데이터/);
  assert.match(prompt, /등록된 도구만/);
  assert.match(prompt, /관찰 사실은 목표 판정 증거/);
  assert.match(prompt, /"matchNames":\["package.json","package-lock.json"\]/);
});

test('mission planning prompt bounds large observations and asks for safe dependency wave packing', () => {
  const observations = Array.from({ length: 20 }, (_, index) => ({
    observationId: `observation_${index + 1}`,
    actionId: `action_${index + 1}`,
    outcome: 'success',
    toolName: 'browser.search',
    summary: `공식 문서 ${index + 1}을 읽었습니다.`,
    data: {
      searchResults: Array.from({ length: 8 }, (_, resultIndex) => ({
        title: `문서 ${index + 1}-${resultIndex + 1}`,
        url: `https://developer.mozilla.org/example/${index + 1}/${resultIndex + 1}`,
        snippet: '공식 문서 본문 '.repeat(500)
      })),
      webProvenance: { live: true, capturedAt: '2026-09-03T00:00:00.000Z', navigationStatus: 200 }
    },
    verification: { status: 'passed', score: 100 },
    trustBoundary: 'WEB_CONTENT',
    untrusted: true
  }));
  const prompt = buildMissionPlanningPrompt({
    mission: {
      objective: '공식 문서를 읽고 결과 파일을 만든 뒤 다시 확인한다.',
      successCriteria: [{ criterionId: 'criterion_1', statement: '결과 파일이 검증된다.' }],
      constraints: [],
      remainingBudget: { waves: 5, actions: 15, plannerCalls: 8, activeRuntimeMs: 300000 }
    },
    capabilities: [{
      toolName: 'browser.search',
      actionType: 'BROWSER_SEARCH',
      readOnly: true,
      externalNetwork: true,
      executionStrategy: { channel: 'web-dom', rank: 1, expectedLatencyMs: 2000, fallbackToolNames: [] }
    }],
    observations,
    maxActionsPerWave: 8,
    today: '2026-09-03'
  });

  assert.equal(prompt.length < 24_000, true, `prompt length was ${prompt.length}`);
  assert.match(prompt, /dependencies에 지정해 같은 웨이브/);
  assert.match(prompt, /https:\/\/developer\.mozilla\.org\/example\/20\/1/);
  assert.match(prompt, /"webProvenance":\{"live":true/);
});

test('mission planning prompt keeps generated artifact language aligned with the objective', () => {
  const base = {
    successCriteria: [{ criterionId: 'criterion_1', statement: '결과 문서가 검증된다.' }],
    constraints: [],
    remainingBudget: { waves: 3, actions: 8, plannerCalls: 4, activeRuntimeMs: 60_000 }
  };
  const options = {
    capabilities: [{ toolName: 'filesystem.createTextFile', actionType: 'CREATE_FILE', readOnly: false }],
    observations: [],
    maxActionsPerWave: 4,
    today: '2026-09-03'
  };
  const koreanPrompt = buildMissionPlanningPrompt({
    ...options,
    mission: {
      ...base,
      objective: '검증 규칙·실제 값·통과 여부를 config-validation.md 파일에 정리해줘.'
    }
  });
  const englishPrompt = buildMissionPlanningPrompt({
    ...options,
    mission: {
      ...base,
      objective: 'Write validation rules, actual values, and pass status to config-validation.md.'
    }
  });

  assert.match(koreanPrompt, /산출물 언어: 이 목표는 한국어입니다/);
  assert.match(koreanPrompt, /상태는 "통과"\/"실패"처럼 한국어로/);
  assert.match(koreanPrompt, /원본 데이터·파일명·코드·API 이름은 번역하거나 바꾸지 마세요/);
  assert.match(koreanPrompt, /config-validation\.md/);
  assert.match(englishPrompt, /Artifact language: Write generated artifact prose, headings, and status labels in the objective language/);
  assert.doesNotMatch(englishPrompt, /산출물 언어: 이 목표는 한국어입니다/);
  assert.doesNotMatch(englishPrompt, /상태는 "통과"\/"실패"처럼 한국어로/);
  assert.match(englishPrompt, /config-validation\.md/);
});

test('GoalExecutivePlanner retries one transient timeout with the same Sonnet model', async () => {
  const attemptTimeouts = [];
  let calls = 0;
  const runner = Object.assign(async (_prompt, options) => {
    calls += 1;
    attemptTimeouts.push(options.timeoutMs);
    if (calls === 1) {
      const error = new Error('claude-cli-timeout');
      error.code = 'ETIMEDOUT';
      error.retryable = true;
      throw error;
    }
    return JSON.stringify({ result: JSON.stringify({
      decision: 'continue',
      summary: '같은 고품질 모델로 재계획했습니다.',
      actions: [{
        id: 'list_after_retry',
        title: '목록 확인',
        command: '작업 폴더 파일 목록을 보여줘',
        expectedToolName: 'filesystem.listFiles',
        arguments: { directory: '.' },
        dependencies: [],
        successSignal: '목록 반환'
      }],
      criteriaAssessment: []
    }) });
  }, {
    provider: 'claude-cli',
    externalService: 'anthropic-claude-cli',
    model: 'claude-sonnet-4-6'
  });
  const planner = new GoalExecutivePlanner({
    runner,
    model: 'sonnet',
    timeoutMs: 120_000,
    retryTimeoutMs: 45_000,
    maxTransientRetries: 1,
    runtimeReserveMs: 5_000
  });
  const plan = await planner.planNextWave({
    mission: {
      objective: '작업 폴더를 확인하고 결과를 검증한다.',
      successCriteria: [{ criterionId: 'criterion_1', statement: '목록을 확인한다.' }],
      constraints: [],
      remainingBudget: { waves: 5, actions: 15, plannerCalls: 8, activeRuntimeMs: 180_000 }
    },
    capabilities: [{ toolName: 'filesystem.listFiles', readOnly: true }],
    capabilitySelection: null,
    observations: []
  });

  assert.equal(plan.decision, 'continue');
  assert.equal(calls, 2);
  assert.deepEqual(attemptTimeouts, [120_000, 45_000]);
  assert.equal(plan.planning.model, 'claude-sonnet-4-6');
  assert.equal(plan.planning.attemptCount, 2);
  assert.equal(plan.planning.retryCount, 1);
  assert.deepEqual(plan.planning.transientFailures.map((failure) => failure.code), ['ETIMEDOUT']);
  assert.doesNotMatch(plan.planning.model, /haiku/i);
});

function invalidResponseRetryContext({ plannerCalls = 2, activeRuntimeMs = 60_000 } = {}) {
  return {
    mission: {
      objective: '회의록을 읽고 실행 항목을 정리한다.',
      successCriteria: [{ criterionId: 'criterion_1', statement: '실행 항목이 검증된다.' }],
      constraints: [],
      remainingBudget: { waves: 4, actions: 10, plannerCalls, activeRuntimeMs }
    },
    capabilities: [{ toolName: 'filesystem.listFiles', actionType: 'LIST_FILES', readOnly: true }],
    capabilitySelection: null,
    observations: [{
      observationId: 'observation_meeting',
      actionId: 'read_meeting',
      outcome: 'success',
      toolName: 'filesystem.readText',
      summary: 'meeting.txt 내용을 읽었습니다.',
      data: { stdoutPreview: '회의 실행 항목' },
      trustBoundary: 'UNTRUSTED_CONTENT',
      untrusted: true
    }]
  };
}

function validRetryPlanResponse() {
  return JSON.stringify({ result: JSON.stringify({
    decision: 'continue',
    summary: '형식을 복구해 다음 행동을 계획했습니다.',
    actions: [{
      id: 'list_after_schema_repair',
      title: '작업 폴더 확인',
      command: '작업 폴더 파일 목록을 보여줘',
      expectedToolName: 'filesystem.listFiles',
      arguments: { directory: '.' },
      dependencies: [],
      successSignal: '목록 반환'
    }],
    criteriaAssessment: []
  }) });
}

test('GoalExecutivePlanner repairs one invalid schema response without reusing its raw content', async () => {
  const invalidRaw = 'INVALID_RAW_MUST_NOT_ENTER_REPAIR_PROMPT';
  const prompts = [];
  let calls = 0;
  const runner = async (prompt) => {
    calls += 1;
    prompts.push(prompt);
    return calls === 1 ? invalidRaw : validRetryPlanResponse();
  };
  const planner = new GoalExecutivePlanner({
    runner,
    timeoutMs: 30_000,
    retryTimeoutMs: 10_000,
    maxTransientRetries: 1,
    runtimeReserveMs: 5_000
  });

  const plan = await planner.planNextWave(invalidResponseRetryContext());

  assert.equal(plan.decision, 'continue');
  assert.equal(calls, 2);
  assert.equal(plan.planning.attemptCount, 2);
  assert.equal(plan.planning.retryCount, 1);
  assert.equal(plan.planning.transientFailures.length, 1);
  assert.deepEqual(plan.planning.transientFailures[0], {
    type: 'invalid-response',
    code: 'A_MISSION_PLANNER_INVALID_RESPONSE',
    retryable: true,
    timeoutMs: 30_000,
    providerFailures: [],
    validationReason: 'payload-not-object'
  });
  assert.doesNotMatch(prompts[0], /형식 복구/);
  assert.match(prompts[1], /형식 복구: 직전 응답은 요구된 JSON 스키마를 충족하지 못했습니다/);
  assert.doesNotMatch(prompts[1], new RegExp(invalidRaw));
});

test('GoalExecutivePlanner pauses with resumable typed evidence after two invalid responses', async () => {
  let calls = 0;
  const planner = new GoalExecutivePlanner({
    runner: async () => {
      calls += 1;
      return calls === 1 ? 'not-json-one' : '{"decision":"continue","actions":[]}';
    },
    timeoutMs: 30_000,
    retryTimeoutMs: 10_000,
    maxTransientRetries: 1,
    runtimeReserveMs: 5_000
  });

  const plan = await planner.planNextWave(invalidResponseRetryContext());

  assert.equal(calls, 2);
  assert.equal(plan.decision, 'pause');
  assert.equal(plan.pauseReason, 'mission-planner-invalid-response');
  assert.equal(plan.planning.errorCode, 'A_MISSION_PLANNER_INVALID_RESPONSE');
  assert.equal(plan.planning.retryable, true);
  assert.equal(plan.planning.resumeSupported, true);
  assert.equal(plan.planning.attemptCount, 2);
  assert.equal(plan.planning.retryCount, 1);
  assert.equal(plan.planning.transientFailures.length, 2);
  assert.equal(plan.planning.transientFailures.every((failure) => failure.type === 'invalid-response'), true);
});

test('GoalExecutivePlanner does not exceed a one-call planner budget for invalid responses', async () => {
  let calls = 0;
  const planner = new GoalExecutivePlanner({
    runner: async () => {
      calls += 1;
      return 'not-json';
    },
    timeoutMs: 30_000,
    retryTimeoutMs: 10_000,
    maxTransientRetries: 1,
    runtimeReserveMs: 5_000
  });

  const plan = await planner.planNextWave(invalidResponseRetryContext({ plannerCalls: 1 }));

  assert.equal(calls, 1);
  assert.equal(plan.decision, 'pause');
  assert.equal(plan.planning.attemptCount, 1);
  assert.equal(plan.planning.retryCount, 0);
  assert.deepEqual(plan.planning.attemptTimeoutsMs, [30_000]);
});

test('GoalExecutivePlanner propagates abort after an invalid response without retrying', async () => {
  const controller = new AbortController();
  const abortReason = new Error('operator aborted schema repair');
  let calls = 0;
  const planner = new GoalExecutivePlanner({
    runner: async () => {
      calls += 1;
      controller.abort(abortReason);
      return 'not-json';
    },
    timeoutMs: 30_000,
    retryTimeoutMs: 10_000,
    maxTransientRetries: 1,
    runtimeReserveMs: 5_000
  });

  await assert.rejects(
    planner.planNextWave(invalidResponseRetryContext(), { signal: controller.signal }),
    (error) => error === abortReason
  );
  assert.equal(calls, 1);
});

test('transient planner exhaustion pauses within active runtime budget and resumes from persisted evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-mission-transient-planner-'));
  let runnerCalls = 0;
  const attemptTimeouts = [];
  const observedRuntimeBudgets = [];
  try {
    const runner = Object.assign(async (prompt, options) => {
      runnerCalls += 1;
      attemptTimeouts.push(options.timeoutMs);
      if (runnerCalls <= 2) {
        const error = new Error('claude-cli-timeout');
        error.code = 'ETIMEDOUT';
        error.retryable = true;
        throw error;
      }
      if (runnerCalls === 3) {
        return JSON.stringify({ result: JSON.stringify({
          decision: 'continue',
          summary: '복구 후 목록을 확인합니다.',
          actions: [{
            id: 'resume_list',
            title: '복구 목록 확인',
            command: '작업 폴더 파일 목록을 보여줘',
            expectedToolName: 'filesystem.listFiles',
            arguments: { directory: root },
            dependencies: [],
            successSignal: '목록 반환'
          }],
          criteriaAssessment: []
        }) });
      }
      const evidenceActionId = prompt.match(/"actionId":"([^"]+)"/)?.[1];
      return JSON.stringify({ result: JSON.stringify({
        decision: 'complete',
        summary: '재개 후 검증된 목록 증거로 완료합니다.',
        actions: [],
        criteriaAssessment: [{
          criterionId: 'criterion_1',
          status: 'satisfied',
          evidenceActionIds: evidenceActionId ? [evidenceActionId] : [],
          reason: '목록 조회가 G 검증을 통과했습니다.'
        }]
      }) });
    }, {
      provider: 'claude-cli',
      externalService: 'anthropic-claude-cli',
      model: 'claude-sonnet-4-6'
    });
    const planner = new GoalExecutivePlanner({
      runner,
      timeoutMs: 120_000,
      retryTimeoutMs: 45_000,
      maxTransientRetries: 1,
      runtimeReserveMs: 5_000
    });
    const planWithObservedBudget = planner.planNextWave.bind(planner);
    planner.planNextWave = (context, options) => {
      observedRuntimeBudgets.push(context.mission.remainingBudget.activeRuntimeMs);
      return planWithObservedBudget(context, options);
    };
    const runtime = createAgRuntime({
      allowedRoots: [root],
      auditRoot: join(root, 'audit'),
      cwd: () => root,
      env: {},
      missionPlanner: planner,
      workerDaemonEnabled: false
    });
    const created = runtime.missionRuntime.createMission({
      objective: '작업 폴더 파일 목록을 확인하고 그리고 조회 결과를 검증해줘.',
      successCriteria: ['파일 목록 조회가 G 검증을 통과한다.'],
      budgets: { maxActiveRuntimeMs: 100_000 },
      authorization: { grants: [MissionGrant.READ_ONLY] }
    });
    const paused = await runtime.missionRuntime.runMission(created.missionId);

    assert.equal(paused.status, MissionStatus.PAUSED);
    assert.equal(paused.stopReason, 'mission-planner-transient-failure');
    assert.equal(paused.recovery.retryable, true);
    assert.equal(paused.recovery.resumeSupported, true);
    assert.equal(paused.metrics.plannerAttempts, 2);
    assert.equal(paused.metrics.plannerRetries, 1);
    assert.equal(attemptTimeouts.length, 2);
    // File persistence and scheduling before planning can exceed one second on
    // a busy PC. Assert the actual supplied budget, not an assumed startup time.
    assert.equal(attemptTimeouts[0], Math.floor(observedRuntimeBudgets[0]) - 45_000 - 5_000);
    assert.ok(attemptTimeouts[0] >= 5_000 && attemptTimeouts[0] <= 50_000);
    assert.equal(attemptTimeouts[1], 45_000);
    assert.equal(attemptTimeouts.reduce((sum, value) => sum + value, 0) + 5_000, Math.floor(observedRuntimeBudgets[0]));

    const completed = await runtime.missionRuntime.runMission(created.missionId);
    assert.equal(completed.status, MissionStatus.PAUSED, JSON.stringify(completed));
    assert.equal(completed.stopReason, 'verification-incomplete');
    assert.equal(completed.metrics.successfulActions, 1);
    assert.equal(completed.observations.some(item => item.toolName === 'filesystem.listFiles'
      && item.outcome === 'success' && item.verification?.status === 'passed'), true);
    assert.equal(completed.metrics.plannerAttempts, 4, 'the listing criterion passes, but the separate unresolved source clauses prevent whole-goal completion');
    assert.equal(completed.observations.some(item => item.error?.reasons?.some(reason => reason.startsWith('goal:source-requirement-meaning-unresolved:'))), true);
    assert.equal(completed.metrics.plannerRetries, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('GoalExecutivePlanner bootstraps a high-confidence read-only mission without an external model call', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-mission-bootstrap-'));
  let externalCalls = 0;
  try {
    await writeFile(join(root, 'fast-proof.txt'), 'ready', 'utf8');
    const planner = new GoalExecutivePlanner({
      runner: () => {
        externalCalls += 1;
        throw new Error('external runner should not be called');
      }
    });
    const runtime = createAgRuntime({
      allowedRoots: [root],
      auditRoot: join(root, 'audit'),
      cwd: () => root,
      env: {},
      missionPlanner: planner,
      workerDaemonEnabled: false
    });
    const created = runtime.missionRuntime.createMission({
      objective: '작업 폴더에서 fast-proof.txt 파일이 존재하는지 읽기 전용으로 확인한다.',
      successCriteria: ['fast-proof.txt 파일이 검색 결과에 존재한다.', 'G 검증을 통과한다.'],
      authorization: { grants: [MissionGrant.READ_ONLY] }
    });
    const completed = await runtime.missionRuntime.runMission(created.missionId);

    assert.equal(completed.status, MissionStatus.COMPLETED, JSON.stringify(completed));
    assert.equal(externalCalls, 0);
    assert.equal(completed.metrics.plannerCalls, 1);
    assert.equal(completed.planHistory[0].planning.provider, 'local-strategy-router');
    assert.equal(completed.planHistory[0].planning.modelRoundTrips, 0);
    assert.equal(completed.planHistory[0].planning.rawObjectiveSharedWithModel, false);
    assert.equal(completed.waves[0].actions[0].actualToolName, 'filesystem.searchFiles');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('GoalExecutivePlanner does not bootstrap a compound read-only objective', () => {
  const planner = new GoalExecutivePlanner({ runner: null });
  for (const objective of [
    '최신 자료를 검색하고 요약 파일을 만들어',
    '다음 작업을 순서대로 완료해줘. 1) workspace에서 report.md를 찾아. 2) 찾은 파일을 읽고 report.zip으로 묶어.',
    '1. workspace에서 alpha.txt를 찾아\n2. 내용을 읽어 확인해'
  ]) {
    const planned = planner.planDeterministicBootstrap({
      mission: {
        objective,
        waveCount: 0,
        successCriteria: []
      },
      capabilities: [{
        toolName: 'browser.search',
        label: 'Browser Search',
        readOnly: true,
        executionStrategy: {
          rank: 1,
          score: 150,
          planningMode: 'deterministic',
          modelRoundTrips: 0
        }
      }],
      capabilitySelection: null,
      observations: []
    });

    assert.equal(planned, null, objective);
  }
});

test('Mission Runtime executes an already planned wave after planner budget reaches zero', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-mission-planner-budget-'));
  try {
    await writeFile(join(root, 'budget-proof.txt'), 'ready', 'utf8');
    const planner = new ScriptedMissionPlanner(() => continueWith([{
      id: 'budgeted_list',
      title: '파일 목록 확인',
      command: '작업 폴더 파일 목록을 보여줘',
      expectedToolName: 'filesystem.listFiles',
      dependencies: [],
      successSignal: '목록 반환'
    }]));
    const runtime = createAgRuntime({
      allowedRoots: [root],
      auditRoot: join(root, 'audit'),
      cwd: () => root,
      env: {},
      missionPlanner: planner,
      workerDaemonEnabled: false
    });
    const created = runtime.missionRuntime.createMission({
      objective: '작업 폴더 파일 목록을 확인한다.',
      budgets: { maxPlannerCalls: 1, maxWaves: 2, maxActions: 3 },
      authorization: { grants: [MissionGrant.READ_ONLY] }
    });
    const paused = await runtime.missionRuntime.runMission(created.missionId);

    assert.equal(paused.status, MissionStatus.COMPLETED);
    assert.equal(paused.completion.source, 'deterministic-evidence');
    assert.equal(paused.metrics.plannerCalls, 1);
    assert.equal(paused.metrics.successfulActions, 1);
    assert.equal(paused.waves[0].status, 'completed');
    assert.equal(paused.waves[0].actions[0].status, 'succeeded');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Mission Runtime completes an email-metric artifact before requesting another planner call', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-mission-email-metric-'));
  const outputPath = join(root, 'campaign-metric.txt');
  try {
    const planner = new ScriptedMissionPlanner(() => continueWith([{
      id: 'write_campaign_metric',
      title: '이메일 채널 지표 작성',
      command: 'campaign-metric.txt 텍스트 파일을 만들어줘',
      expectedToolName: 'filesystem.createTextFile',
      arguments: { path: outputPath, content: '이메일 클릭률 15%, 전환율 10%' },
      dependencies: [],
      successSignal: 'campaign-metric.txt 생성 및 G 검증 통과'
    }]));
    const runtime = createAgRuntime({
      allowedRoots: [root],
      auditRoot: join(root, 'audit'),
      cwd: () => root,
      env: {},
      missionPlanner: planner,
      workerDaemonEnabled: false
    });
    const objective = '이메일 클릭률 15%와 전환율 10%를 campaign-metric.txt에 작성하고 생성 파일을 확인한다.';
    const created = runtime.missionRuntime.createMission({
      objective,
      successCriteria: [{ statement: objective, verificationSpec: { version: 1, kind: 'text.equals', path: 'campaign-metric.txt',
        equals: '이메일 클릭률 15%, 전환율 10%' } }],
      budgets: { maxPlannerCalls: 1, maxWaves: 2, maxActions: 2 },
      authorization: { grants: [MissionGrant.READ_ONLY, MissionGrant.LOCAL_REVERSIBLE] }
    });
    const completed = await runtime.missionRuntime.runMission(created.missionId);

    assert.equal(completed.status, MissionStatus.COMPLETED, JSON.stringify(completed));
    assert.equal(completed.metrics.plannerCalls, 1);
    assert.equal(planner.calls, 1);
    assert.equal(completed.completion.source, 'deterministic-evidence');
    assert.equal(completed.completion.criteria[0].deterministicChecks
      .some((check) => check.checkId === 'external_commit_evidence_present'), false);
    assert.equal(await readFile(outputPath, 'utf8'), '이메일 클릭률 15%, 전환율 10%');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Mission completion guard rejects a planner claim when the named artifact is wrong', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-mission-completion-guard-'));
  try {
    const planner = new ScriptedMissionPlanner((context) => {
      const success = context.observations.find((observation) => observation.outcome === 'success');
      if (success) return completeFromLatestSuccess(context);
      return continueWith([{
        id: 'wrong_named_artifact',
        title: '다른 이름의 파일 작성',
        command: 'actual-result 메모 파일을 만들어줘. 내용은 완료',
        expectedToolName: 'filesystem.createTextFile',
        dependencies: [],
        successSignal: 'actual-result.txt 생성'
      }]);
    });
    const runtime = createAgRuntime({
      allowedRoots: [root],
      auditRoot: join(root, 'audit'),
      cwd: () => root,
      env: {},
      missionPlanner: planner,
      workerDaemonEnabled: false
    });
    const created = runtime.missionRuntime.createMission({
      objective: '정확한 이름의 결과 파일을 작성한다.',
      successCriteria: ['expected-result.txt가 생성되고 G 검증을 통과한다.'],
      authorization: { grants: [MissionGrant.READ_ONLY, MissionGrant.LOCAL_REVERSIBLE] }
    });
    const result = await runtime.missionRuntime.runMission(created.missionId);

    assert.equal(result.status, MissionStatus.BLOCKED);
    assert.equal(result.completion, null);
    assert.equal(result.observations.some((item) => item.error?.code === 'A_MISSION_COMPLETION_EVIDENCE_INSUFFICIENT'), true);
    await access(join(root, 'actual-result.txt'));
    await assert.rejects(access(join(root, 'expected-result.txt')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Mission completion guard accepts split named-file and G criteria from verified search evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-mission-search-evidence-'));
  try {
    await writeFile(join(root, 'target-proof.txt'), 'verified', 'utf8');
    const planner = new ScriptedMissionPlanner((context) => {
      if (context.observations.some((observation) => observation.outcome === 'success')) {
        return completeFromLatestSuccess(context);
      }
      return continueWith([{
        id: 'find_named_file',
        title: '대상 파일 확인',
        command: '작업 폴더에서 target-proof.txt 파일을 찾아줘',
        expectedToolName: 'filesystem.searchFiles',
        dependencies: [],
        successSignal: 'target-proof.txt 검색 결과와 G 검증 통과'
      }]);
    });
    const runtime = createAgRuntime({
      allowedRoots: [root],
      auditRoot: join(root, 'audit'),
      cwd: () => root,
      env: {},
      missionPlanner: planner,
      workerDaemonEnabled: false
    });
    const created = runtime.missionRuntime.createMission({
      objective: 'target-proof.txt 파일이 존재하는지 읽기 전용으로 확인한다.',
      successCriteria: [
        'target-proof.txt 파일의 존재가 실제 관찰 증거로 확인된다.',
        '검색 행동이 G 검증을 통과한다.'
      ],
      authorization: { grants: [MissionGrant.READ_ONLY] }
    });
    const result = await runtime.missionRuntime.runMission(created.missionId);

    assert.equal(result.status, MissionStatus.COMPLETED, JSON.stringify(result));
    assert.equal(result.waveCount, 1);
    assert.equal(planner.calls, 1);
    assert.equal(result.completion.source, 'deterministic-evidence');
    const namedCheck = result.completion.criteria[0].deterministicChecks
      .find((check) => check.checkId === 'named_artifacts_match');
    assert.equal(namedCheck.passed, true);
    assert.equal(namedCheck.evidenceMode, 'verified-observation-or-artifact');
    assert.deepEqual(namedCheck.observed, ['target-proof.txt']);
    assert.equal(result.completion.criteria[1].deterministicChecks[0].checkId, 'g_verification_passed');
    assert.equal(result.completion.criteria[1].deterministicChecks[0].passed, true);
    assert.equal(result.observations[0].data.matches[0].name, 'target-proof.txt');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Mission completion treats a file being searched and read as an input, not a second required output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-mission-summary-role-'));
  try {
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const sourcePath = join(workspace, 'meeting-notes.txt');
    const summaryPath = join(workspace, 'meeting-summary.txt');
    await writeFile(sourcePath, '회의는 10시, 본당에서 진행한다.', 'utf8');
    await writeFile(summaryPath, '본당에서 10시에 회의한다.', 'utf8');
    const objective = "'workspace/meeting-notes.txt' 파일을 찾아 내용을 읽고 핵심 사실을 요약해 'workspace/meeting-summary.txt'로 저장해";
    const runtime = createAgRuntime({ allowedRoots: [workspace], auditRoot: join(root, 'audit'),
      cwd: () => workspace, env: {}, missionPlanner: new ScriptedMissionPlanner(() => continueWith([])),
      workerDaemonEnabled: false });
    const fileEvidence = (name) => ({ name, relativePath: name, rootIndex: 0,
      outsideAllowedRoots: false, contentSha256: 'a'.repeat(64) });
    const actions = [
      { actionId: 'read-source', taskId: 'task-read', status: 'succeeded', actualToolName: 'filesystem.readText',
        arguments: { path: sourcePath } },
      { actionId: 'write-summary', taskId: 'task-write', status: 'succeeded', actualToolName: 'filesystem.createTextFile',
        arguments: { path: summaryPath } }
    ];
    const mission = { missionId: 'summary-role-regression', objective,
      waves: [{ actions }], observations: [
        { actionId: 'read-source', taskId: 'task-read', toolName: 'filesystem.readText', outcome: 'success',
          verification: { status: 'passed' }, artifacts: [fileEvidence('meeting-notes.txt')] },
        { actionId: 'write-summary', taskId: 'task-write', toolName: 'filesystem.createTextFile', outcome: 'success',
          verification: { status: 'passed' }, artifacts: [fileEvidence('meeting-summary.txt')] }
      ] };
    const result = runtime.missionRuntime.verifyCriterionEvidence(mission, {
      criterionId: 'criterion_1', statement: `${objective}. 결과 파일을 다시 확인하고 G 검증을 통과한다.`
    }, ['read-source', 'write-summary']);

    const namedArtifacts = result.checks.find((item) => item.checkId === 'named_artifacts_match');
    assert.equal(namedArtifacts.passed, true, JSON.stringify(namedArtifacts));
    assert.deepEqual(namedArtifacts.expected, ['meeting-summary.txt']);
    assert.equal(result.checks.find((item) => item.checkId === 'g_verification_passed').passed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('natural-language file summary mission searches, reads, writes, re-searches, re-reads, and matches an independent exact oracle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-mission-summary-e2e-'));
  const workspace = join(root, 'workspace');
  const sourcePath = join(workspace, 'meeting-notes.txt');
  const summaryPath = join(workspace, 'meeting-summary.txt');
  const source = [
    '설교 준비 모임은 10월 2일 오전 10시에 본당 회의실에서 진행한다.',
    '담당자는 민수이며 참석자는 6명이다.',
    '인쇄 자료 12부를 준비한다.',
    '회의 2일 전까지 교재 초안을 검토하고, 시작 15분 전에 장비를 확인한다.'
  ].join('\n');
  const expectedSummary = [
    '설교 준비 모임 요약',
    '- 일시: 10월 2일 오전 10시',
    '- 장소: 본당 회의실',
    '- 담당자: 민수',
    '- 참석자: 6명',
    '- 준비물: 인쇄 자료 12부',
    '- 사전 준비: 회의 2일 전까지 교재 초안 검토',
    '- 당일 준비: 시작 15분 전 장비 확인'
  ].join('\n');
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(sourcePath, source, 'utf8');
    const objective = "'meeting-notes.txt' 파일을 찾아 내용을 읽고 핵심 사실을 요약해 'meeting-summary.txt'로 저장한 다음, 저장된 요약 파일을 다시 찾아 읽고 확인해";
    const planner = new ScriptedMissionPlanner((context) => {
      const observations = context.observations.filter((item) => item.outcome === 'success');
      const hasSearch = (name) => observations.some((item) => item.toolName === 'filesystem.searchFiles'
        && item.data?.matches?.some((match) => match.name === name));
      const hasRead = (name) => observations.some((item) => item.toolName === 'filesystem.readText'
        && item.data?.fileEvidence?.relativePath === name);
      const hasWrite = observations.some((item) => item.toolName === 'filesystem.createTextFile'
        && item.artifacts?.some((artifact) => artifact.name === 'meeting-summary.txt'));
      const action = (id, title, command, expectedToolName, args) => continueWith([{
        id, title, command, expectedToolName, arguments: args, dependencies: [], successSignal: `${title} 실제 결과와 G 검증 통과`
      }]);
      if (!hasSearch('meeting-notes.txt')) return action('find_source', '원문 파일 찾기',
        'meeting-notes.txt 파일을 작업공간에서 찾아줘', 'filesystem.searchFiles',
        { query: 'meeting-notes.txt', scope: 'workspace', maxResults: 20 });
      if (!hasRead('meeting-notes.txt')) return action('read_source', '원문 전체 읽기',
        'meeting-notes.txt 내용을 읽어줘', 'filesystem.readText', { path: sourcePath, maxChars: 12000 });
      if (!hasWrite) return action('write_summary', '오라클 요약 저장',
        'meeting-summary.txt 텍스트 파일을 만들어줘', 'filesystem.createTextFile',
        { path: summaryPath, content: expectedSummary });
      if (!hasSearch('meeting-summary.txt')) return action('find_summary', '요약 파일 재검색',
        '작업공간에서 meeting-summary.txt 파일을 다시 찾아줘', 'filesystem.searchFiles',
        { query: 'meeting-summary.txt', scope: 'workspace', maxResults: 20 });
      if (!hasRead('meeting-summary.txt')) return action('read_summary', '요약 파일 재조회',
        'meeting-summary.txt 내용을 다시 읽어줘', 'filesystem.readText', { path: summaryPath, maxChars: 12000 });
      return {
        decision: 'complete', summary: '전체 파일 요약 흐름이 고정 오라클과 일치했습니다.', actions: [],
        criteriaAssessment: context.mission.successCriteria.map((criterion) => ({
          criterionId: criterion.criterionId, status: 'satisfied',
          evidenceActionIds: observations.map((item) => item.actionId),
          reason: '실행된 다섯 단계의 실제 파일 증거와 G 검증이 모두 존재합니다.'
        }))
      };
    });
    const runtime = createAgRuntime({ allowedRoots: [workspace], auditRoot: join(root, 'audit'),
      cwd: () => workspace, env: {}, missionPlanner: planner, workerDaemonEnabled: false });
    const created = runtime.missionRuntime.createMission({ objective,
      successCriteria: [{ statement: objective, verificationSpec: {
        version: 1, kind: 'text.equals', path: 'meeting-summary.txt', equals: expectedSummary
      } }],
      authorization: { grants: [MissionGrant.READ_ONLY, MissionGrant.LOCAL_REVERSIBLE] } });

    const result = await runtime.missionRuntime.runMission(created.missionId);
    assert.equal(result.status, MissionStatus.COMPLETED, JSON.stringify(result));
    assert.equal(result.metrics.executedActions, 5);
    assert.equal(result.metrics.successfulActions, 5);
    assert.equal(planner.calls, 5);
    assert.equal(await readFile(summaryPath, 'utf8'), expectedSummary);
    assert.deepEqual(result.waves.flatMap((wave) => wave.actions).map((item) => item.actualToolName), [
      'filesystem.searchFiles', 'filesystem.readText', 'filesystem.createTextFile',
      'filesystem.searchFiles', 'filesystem.readText'
    ]);
    assert.equal(result.completion.criteria[0].deterministicChecks
      .some((check) => check.checkId === 'typed_text_equals' && check.passed), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a failed researcher session is handed off to editor and verifier using the same Mission and G-verified artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-mission-role-handoff-e2e-'));
  const workspace = join(root, 'workspace');
  const sourcePath = join(workspace, 'source.txt');
  const reportPath = join(workspace, 'report.txt');
  const source = '공개 자료 확인 결과: 모임은 10월 4일 오전 9시에 교육관에서 진행한다.';
  const reportContent = `검증 보고서\n${source}`;
  const roleBrokers = Object.fromEntries(['researcher', 'editor', 'verifier'].map(workerRole => [workerRole, {
    db: {}, workerRole,
    bindSession: request => ({ ...request, replayed: false }),
    sendMissionMessage: async request => ({ accepted: true, request }),
    cancelMissionTurn: async request => ({ accepted: true, request }),
    async reconcileMission(missionId, assignment) {
      return { missionId, sessionId: `${workerRole}-session`, remoteStatus: workerRole === 'researcher' ? 'failed' : 'in_progress',
        outcomes: [], ...assignment, executionAuthority: false };
    }
  }]));
  let roleRegistry = new DatabaseSync(':memory:');
  const makeRolePool = () => new MissionRoleAgentSessionPool({ db: roleRegistry, roles: roleBrokers,
    authorizeRoleMessage: async () => true });
  let rolePool = makeRolePool();
  const missionStorePath = join(root, 'missions.json');
  let runtime = null;
  let planner = null;
  const makeRuntime = () => createAgRuntime({ allowedRoots: [workspace], auditRoot: join(root, 'audit'),
    cwd: () => workspace, env: {}, missionPlanner: planner, workerDaemonEnabled: false,
    missionStore: new FileMissionStore({ filePath: missionStorePath }),
    managedAgentRoleSessionPoolFactory: () => rolePool });
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(sourcePath, source, 'utf8');
    planner = new ScriptedMissionPlanner(context => {
      const observations = context.observations.filter(item => item.outcome === 'success');
      const sourceRead = observations.find(item => item.toolName === 'filesystem.readText'
        && item.data?.fileEvidence?.relativePath === 'source.txt');
      const edited = observations.some(item => item.toolName === 'filesystem.createTextFile'
        && item.artifacts?.some(artifact => artifact.name === 'report.txt'));
      const verifiedRead = observations.some(item => item.toolName === 'filesystem.readText'
        && item.data?.fileEvidence?.relativePath === 'report.txt');
      const makeAction = (id, title, command, expectedToolName, args, workerRole) => continueWith([{
        id, title, command, expectedToolName, arguments: args, dependencies: [],
        collaborationGroupId: 'local-research-report', workerRole,
        successSignal: `${title} 결과와 G 증거 확인`
      }]);
      if (!sourceRead) return makeAction('research-source', '연구자 원문 읽기',
        'source.txt 내용을 읽어줘', 'filesystem.readText', { path: sourcePath, maxChars: 12000 }, 'researcher');
      if (!edited) {
        assert.equal(sourceRead.data?.stdoutPreview, source, 'editor receives only the observed source content selected by the coordinator');
        return makeAction('editor-report', '편집자 보고서 작성',
          'report.txt 텍스트 파일을 만들어줘', 'filesystem.createTextFile', { path: reportPath, content: reportContent }, 'editor');
      }
      if (!verifiedRead) return makeAction('verifier-report', '검증자 산출물 읽기',
        'report.txt 내용을 읽어줘', 'filesystem.readText', { path: reportPath, maxChars: 12000 }, 'verifier');
      return completeFromLatestSuccess(context);
    });
    runtime = makeRuntime();
    const created = runtime.missionRuntime.createMission({
      objective: 'source.txt의 공개 자료를 연구자·편집자·검증자 역할로 처리해 report.txt에 기록하고 확인한다.',
      successCriteria: [{ statement: 'report.txt에 원문 공개 자료가 정확히 보존된다.',
        verificationSpec: { version: 1, kind: 'text.equals', path: 'report.txt', equals: reportContent } },
      { statement: 'report.txt 파일을 읽어줘.' }],
      authorization: { grants: [MissionGrant.READ_ONLY, MissionGrant.LOCAL_REVERSIBLE] }
    });
    const afterResearch = await runtime.missionRuntime.runMission(created.missionId, { maxWaves: 1 });
    assert.equal(afterResearch.status, MissionStatus.PAUSED);
    assert.equal(afterResearch.metrics.executedActions, 1);
    runtime.missionRuntime.bindManagedAgentSession(created.missionId, 'researcher-session', {
      workerRole: 'researcher', collaborationGroupId: 'local-research-report'
    });
    const workerFailure = await runtime.missionRuntime.reconcileManagedAgentSession(created.missionId, {
      workerRole: 'researcher', collaborationGroupId: 'local-research-report'
    });
    assert.equal(workerFailure.remoteStatus, 'failed');
    assert.equal(workerFailure.handoffPermitted, true);
    assert.equal(workerFailure.missionStatus, MissionStatus.PAUSED);
    assert.equal(JSON.parse(await readFile(missionStorePath, 'utf8')).missions[0].managedAgentWorkerFailures[0].handoffPermitted, true);
    runtime.workerDaemon?.stop({ reason: 'simulate-core-process-restart-after-worker-failure' });
    runtime.coreFacade.cognition?.close();
    roleRegistry.close();
    roleRegistry = new DatabaseSync(':memory:');
    rolePool = makeRolePool();
    runtime = makeRuntime();
    const restoredMission = runtime.missionRuntime.missions.get(created.missionId);
    assert.equal(restoredMission.managedAgentWorkerFailures[0].workerRole, 'researcher');
    assert.equal(restoredMission.stopReason, 'managed-agent-worker-failed');
    assert.equal(runtime.missionRuntime.plannerContext(restoredMission, Date.now())
      .managedAgentWorkerFailures[0].disposition, 'failed-handoff-allowed');
    runtime.missionRuntime.bindManagedAgentSession(created.missionId, 'researcher-session', {
      workerRole: 'researcher', collaborationGroupId: 'local-research-report'
    });
    const completed = await runtime.missionRuntime.runMission(created.missionId);
    const actions = completed.waves.flatMap(wave => wave.actions);
    assert.equal(completed.status, MissionStatus.COMPLETED, JSON.stringify(completed));
    assert.equal(completed.metrics.executedActions, 3);
    assert.equal(planner.calls, 3);
    assert.deepEqual(actions.map(action => action.workerRole), ['researcher', 'editor', 'verifier']);
    assert.deepEqual(actions.map(action => action.collaborationGroupId), Array(3).fill('local-research-report'));
    assert.deepEqual(actions.map(action => action.roleScope.allowed), [true, true, true]);
    assert.deepEqual(actions.map(action => action.actualToolName), [
      'filesystem.readText', 'filesystem.createTextFile', 'filesystem.readText'
    ]);
    assert.ok(completed.observations.filter(observation => observation.outcome === 'success')
      .every(observation => observation.evidenceId && observation.verification?.status === 'passed'));
    assert.equal(completed.observations.some(observation => observation.category === 'managed_agent_worker'
      && observation.data?.disposition === 'handoff-permitted-from-verified-artifacts'), true);
    assert.equal(await readFile(reportPath, 'utf8'), reportContent);
    assert.equal(completed.completion.criteria[0].deterministicChecks
      .some(check => check.checkId === 'typed_text_equals' && check.passed), true);
    const capturePath = process.env.JARVIS_G12_ORACLE_EVIDENCE_PATH;
    if (typeof capturePath === 'string' && capturePath.length > 0) {
      const snapshot = JSON.parse(await readFile(missionStorePath, 'utf8'));
      const durableMission = snapshot.missions.find(item => item.missionId === created.missionId);
      const actions = completed.waves.flatMap(wave => wave.actions);
      const observations = completed.observations;
      const durableActions = durableMission.waves.flatMap(wave => wave.actions);
      const durableObservations = durableMission.observations;
      const artifactBytes = await readFile(reportPath);
      await writeFile(capturePath, `${JSON.stringify({
        schemaVersion: 1,
        scenarioId: 'G12',
        result: {
          missionId: completed.missionId,
          status: completed.status,
          actions: actions.map(action => ({ actionId: action.actionId, status: action.status,
            workerRole: action.workerRole, collaborationGroupId: action.collaborationGroupId,
            actualToolName: action.actualToolName, observationId: action.observationId, roleScope: action.roleScope })),
          observations: observations.map(item => ({ observationId: item.observationId, actionId: item.actionId,
            outcome: item.outcome, verification: item.verification, evidenceId: item.evidenceId }))
        },
        durableMission: {
          missionId: durableMission?.missionId,
          status: durableMission?.status,
          stopReason: durableMission?.stopReason,
          workerFailures: durableMission?.managedAgentWorkerFailures?.map(item => ({ workerRole: item.workerRole,
            handoffPermitted: item.handoffPermitted, reason: item.reason })),
          actions: durableActions.map(action => ({ actionId: action.actionId, status: action.status,
            workerRole: action.workerRole, collaborationGroupId: action.collaborationGroupId,
            actualToolName: action.actualToolName, observationId: action.observationId })),
          observations: durableObservations.map(item => ({ observationId: item.observationId, actionId: item.actionId,
            outcome: item.outcome, verification: item.verification, evidenceId: item.evidenceId }))
        },
        workspaceFiles: await readdir(workspace),
        artifact: { relativePath: 'report.txt', byteLength: artifactBytes.length,
          base64: artifactBytes.toString('base64'), sha256: createHash('sha256').update(artifactBytes).digest('hex') }
      }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    }
    runtime.workerDaemon?.stop({ reason: 'test-finished' });
    runtime.coreFacade.cognition?.close();
  } finally {
    runtime?.workerDaemon?.stop?.({ reason: 'test-finished' });
    runtime?.coreFacade.cognition?.close?.();
    try { roleRegistry.close(); } catch {}
    await rm(root, { recursive: true, force: true });
  }
});

test('Mission stops after one unchanged rejected completion claim instead of paying for repeated planner calls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-mission-completion-stall-'));
  try {
    await writeFile(join(root, 'notes.txt'), 'notes', 'utf8');
    const planner = new ScriptedMissionPlanner((context, call) => call === 1
      ? continueWith([{
        id: 'read_notes', title: '메모 읽기', command: 'notes.txt 내용을 읽어줘',
        expectedToolName: 'filesystem.readText', arguments: { path: join(root, 'notes.txt'), maxChars: 12000 },
        dependencies: [], successSignal: '원문 전체 읽기 완료'
      }])
      : completeFromLatestSuccess(context));
    const runtime = createAgRuntime({ allowedRoots: [root], auditRoot: join(root, 'audit'),
      cwd: () => root, env: {}, missionPlanner: planner, workerDaemonEnabled: false });
    runtime.missionRuntime.validateCompletion = () => ({ valid: false, reasons: ['test-evidence-unverified'],
      criteria: [{ verificationStatus: 'failed' }], goalCoverage: { allowed: true } });
    const created = runtime.missionRuntime.createMission({ objective: 'notes.txt 파일을 읽고 결과를 확인한다.',
      successCriteria: ['notes.txt 파일을 실제로 읽고 확인한다.'],
      authorization: { grants: [MissionGrant.READ_ONLY] } });

    const result = await runtime.missionRuntime.runMission(created.missionId);
    assert.equal(result.status, MissionStatus.BLOCKED);
    assert.equal(result.stopReason, 'repeated-completion-claim-without-new-evidence');
    assert.equal(planner.calls, 3, 'one plan for the action, one rejected completion, then one identical completion to establish a stall');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Mission role scope blocks researcher writes, records editor output, and persists the role record', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-mission-role-scope-'));
  try {
    const forbiddenPath = join(root, 'researcher-must-not-write.txt');
    const blockedPlanner = new ScriptedMissionPlanner(() => continueWith([{
      id: 'researcher_write', title: '연구자 역할의 금지된 쓰기',
      command: '텍스트 파일을 작성해줘', expectedToolName: 'filesystem.createTextFile',
      arguments: { path: forbiddenPath, content: 'must not exist' }, dependencies: [],
      collaborationGroupId: 'report-work', workerRole: 'researcher',
      successSignal: '역할 제한 확인'
    }]));
    const blockedRuntime = createAgRuntime({ allowedRoots: [root], auditRoot: join(root, 'blocked-audit'),
      cwd: () => root, env: {}, missionPlanner: blockedPlanner, workerDaemonEnabled: false });
    const blockedMission = blockedRuntime.missionRuntime.createMission({ objective: '연구자 역할 쓰기 제한 검사' });
    const blocked = await blockedRuntime.missionRuntime.runMission(blockedMission.missionId);
    assert.equal(blocked.status, MissionStatus.PAUSED);
    assert.match(blocked.stopReason, /^mission-role-scope-/);
    await assert.rejects(access(forbiddenPath));
    blockedRuntime.workerDaemon?.stop({ reason: 'test-finished' });
    blockedRuntime.coreFacade.cognition?.close();

    const outputPath = join(root, 'editor-result.txt');
    const editorPlanner = new ScriptedMissionPlanner((context) => context.observations.some(item => item.outcome === 'success')
      ? completeFromLatestSuccess(context)
      : continueWith([{
        id: 'editor_write', title: '편집자 역할의 로컬 파일 작성',
        command: 'editor-result.txt 텍스트 파일을 만들어줘', expectedToolName: 'filesystem.createTextFile',
        arguments: { path: outputPath, content: 'verified local artifact' }, dependencies: [],
        collaborationGroupId: 'report-work', workerRole: 'editor',
        successSignal: '로컬 문서 생성 및 G 검증 통과'
      }]));
    const editorRuntime = createAgRuntime({ allowedRoots: [root], auditRoot: join(root, 'editor-audit'),
      cwd: () => root, env: {}, missionPlanner: editorPlanner, workerDaemonEnabled: false });
    const editorMission = editorRuntime.missionRuntime.createMission({ objective: 'editor-result.txt 파일을 만든다.',
      successCriteria: [{ statement: 'editor-result.txt 파일에 지정한 내용이 기록된다.', verificationSpec: {
        version: 1, kind: 'text.equals', path: 'editor-result.txt', equals: 'verified local artifact'
      } }],
      authorization: { grants: [MissionGrant.READ_ONLY, MissionGrant.LOCAL_REVERSIBLE] } });
    let rolePlanOptions = null;
    const accessCounts = { query: 0, preferences: 0, cognition: 0, personal: 0 };
    editorRuntime.coreFacade.memoryStore.query = () => { accessCounts.query++; return [{ text: 'private-memory-secret' }]; };
    editorRuntime.coreFacade.memoryStore.planningPreferenceContext = () => { accessCounts.preferences++; return { secret: 'private-preference-secret' }; };
    editorRuntime.coreFacade.cognition.planningContext = () => { accessCounts.cognition++; return { cognition: { secret: 'private-cognition-secret' }, planningGuardrails: [] }; };
    editorRuntime.coreFacade.personalContextProvider = () => { accessCounts.personal++; return { goals: ['private-profile-secret'] }; };
    const createTaskPlan = editorRuntime.coreFacade.taskPlanner.createPlan.bind(editorRuntime.coreFacade.taskPlanner);
    editorRuntime.coreFacade.taskPlanner.createPlan = (request, intent, options) => {
      rolePlanOptions = options;
      return createTaskPlan(request, intent, options);
    };
    const completed = await editorRuntime.missionRuntime.runMission(editorMission.missionId);
    assert.equal(completed.status, MissionStatus.COMPLETED, JSON.stringify(completed));
    const written = completed.waves[0].actions[0];
    assert.equal(written.roleScope.allowed, true);
    assert.equal(written.roleScope.policyVersion, 'mission-role-tool-scope-v1');
    assert.deepEqual({ query: accessCounts.query, preferences: accessCounts.preferences, cognition: accessCounts.cognition },
      { query: 0, preferences: 0, cognition: 0 });
    assert.equal(rolePlanOptions.personalContext, null);
    assert.equal(rolePlanOptions.planningContext, null);
    assert.deepEqual(rolePlanOptions.contextSnapshot.userPreferences, []);
    assert.equal(await readFile(outputPath, 'utf8'), 'verified local artifact');
    editorRuntime.workerDaemon?.stop({ reason: 'test-finished' });
    editorRuntime.coreFacade.cognition?.close();
    const restoredEditorRuntime = createAgRuntime({ allowedRoots: [root], auditRoot: join(root, 'editor-audit'),
      cwd: () => root, env: {}, missionPlanner: editorPlanner, workerDaemonEnabled: false });
    const persisted = restoredEditorRuntime.missionRuntime.getMission(editorMission.missionId);
    assert.equal(persisted.status, MissionStatus.COMPLETED);
    assert.equal(persisted.waves[0].actions[0].workerRole, 'editor');
    assert.equal(persisted.waves[0].actions[0].collaborationGroupId, 'report-work');
    assert.equal(persisted.waves[0].actions[0].roleScope.allowed, true);
    restoredEditorRuntime.workerDaemon?.stop({ reason: 'test-finished' });
    restoredEditorRuntime.coreFacade.cognition?.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Core Mission API requires admin auth and runs a mission through the real worker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-mission-api-'));
  try {
    await writeFile(join(root, 'visible.txt'), 'visible', 'utf8');
    const planner = new ScriptedMissionPlanner((context) => {
      if (context.observations.some((observation) => observation.outcome === 'success')) {
        return completeFromLatestSuccess(context);
      }
      return continueWith([{
        id: 'api_list',
        title: 'API 파일 목록 확인',
        command: '작업 폴더 파일 목록 보여줘',
        expectedToolName: 'filesystem.listFiles',
        dependencies: [],
        successSignal: '파일 목록 반환'
      }]);
    });
    const runtime = createAgRuntime({
      allowedRoots: [root],
      auditRoot: join(root, 'audit'),
      cwd: () => root,
      env: {},
      missionPlanner: planner,
      workerDaemonEnabled: false
    });
    await withServer(createCoreServer(runtime.coreFacade, {
      adminToken: 'mission-admin-token',
      orchestrationWorker: runtime.orchestrationWorker,
      missionRuntime: runtime.missionRuntime,
      workerDaemon: runtime.workerDaemon
    }), async (baseUrl) => {
      const unauthorized = await fetch(`${baseUrl}/missions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ objective: 'API 미션 인증 실패 확인' })
      });
      assert.equal(unauthorized.status, 401);

      const client = new CoreClient({ baseUrl, adminToken: 'mission-admin-token' });
      const created = await client.createMission({ objective: 'API로 작업 폴더를 점검한다.' });
      assert.equal(created.status, MissionStatus.CREATED);
      const completed = await client.runMission(created.missionId);
      assert.equal(completed.status, MissionStatus.COMPLETED, JSON.stringify(completed));
      assert.equal((await client.getMission(created.missionId)).completion.status, 'verified');
      assert.equal((await client.listMissions()).items.some((item) => item.missionId === created.missionId), true);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Mission gate HTTP audit identity comes from the authenticated admin token, not request JSON', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-mission-gate-identity-'));
  const runtime = createAgRuntime({ allowedRoots: [root], auditRoot: join(root, 'audit'), cwd: () => root,
    env: { JARVIS_TEST_MODE: '1' }, workerDaemonEnabled: false });
  t.after(async () => { runtime.workerDaemon?.stop({ reason: 'test-finished' }); runtime.coreFacade.cognition?.close(); await rm(root, { recursive: true, force: true }); });

  const created = runtime.missionRuntime.createMission({ objective: '검증용 외부 자료 승인 요청',
    successCriteria: ['승인 기록에 인증된 주체만 남는다.'], authorization: { grants: [MissionGrant.READ_ONLY] } });
  const mission = runtime.missionRuntime.missions.get(created.missionId);
  const gate = runtime.missionRuntime.createExternalEgressGate(mission, { childMissionId: 'fixture-child', callKey: 'fixture-call',
    providerId: 'fixture-provider', toolName: 'file_search', contentSha256: 'a'.repeat(64), dataClass: 'D2' });
  assert.equal(gate.success, true);

  const server = createCoreServer(runtime.coreFacade, { adminToken: null, adminTokenHash: null,
    adminTokens: [{ token: 'owner-token', tokenId: 'trusted-owner', role: 'owner', scopes: ['core:admin'] }],
    missionRuntime: runtime.missionRuntime });
  await withServer(server, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/missions/${encodeURIComponent(created.missionId)}/gates/${encodeURIComponent(gate.gateId)}/decision`, {
      method: 'POST', headers: { authorization: 'Bearer owner-token', 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'reject', decidedBy: 'forged-approver' })
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    const savedGate = result.gates.find(item => item.gateId === gate.gateId);
    assert.equal(savedGate.status, 'rejected');
    assert.equal(savedGate.decidedBy, 'core-admin:trusted-owner');
    assert.notEqual(savedGate.decidedBy, 'forged-approver');
  });
});

test('Mission file store retries transient Windows replacement locks without hiding hard failures', () => {
  let attempts = 0;
  const delays = [];
  replaceFileWithRetry('source.tmp', 'missions.json', {
    rename: () => {
      attempts += 1;
      if (attempts < 3) {
        const error = new Error('temporarily locked');
        error.code = 'EPERM';
        throw error;
      }
    },
    sleep: (milliseconds) => delays.push(milliseconds)
  });
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [25, 50]);

  assert.throws(() => replaceFileWithRetry('source.tmp', 'missions.json', {
    rename: () => {
      const error = new Error('invalid path');
      error.code = 'EINVAL';
      throw error;
    },
    sleep: () => assert.fail('hard failures must not be retried')
  }), { code: 'EINVAL' });
});

async function withServer(server, run) {
  const address = await listenOnFetchSafePort(server);
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}
