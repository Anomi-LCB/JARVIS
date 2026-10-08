import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { MissionRuntime, MissionGrant, MissionStatus } from '../packages/core/src/mission/mission-runtime.js';
import { MemoryMissionStore } from '../packages/core/src/mission/mission-store.js';

const complete = (context) => ({
  decision: 'complete', summary: '실제 파일과 G 검증 완료', actions: [],
  criteriaAssessment: context.mission.successCriteria.map((criterion) => ({
    criterionId: criterion.criterionId, status: 'satisfied',
    evidenceActionIds: context.observations.filter((item) => item.outcome === 'success').map((item) => item.actionId),
    reason: '파일 생성 후 검증된 실행 기록이 존재합니다.'
  }))
});

async function fixture(t, { twoActions = false, interruptReceipt = false, interruptAfterFirst = false, interruptVerification = false, durableStore = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-action-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const firstPath = join(workspace, 'first.txt');
  const secondPath = join(workspace, 'second.txt');
  const planner = { async planNextWave(context) {
    if (context.observations.length) return complete(context);
    const actions = [{ id: 'first', title: '첫 파일', command: 'first 메모 파일을 만들어줘. 내용은 복구 검증',
      expectedToolName: 'filesystem.createTextFile', arguments: { path: firstPath, content: '복구 검증' }, dependencies: [], successSignal: 'first.txt 생성' }];
    if (twoActions) actions.push({ id: 'second', title: '두 번째 파일', command: 'second 메모 파일을 만들어줘. 내용은 후속 작업',
      expectedToolName: 'filesystem.createTextFile', arguments: { path: secondPath, content: '후속 작업' }, dependencies: ['first'], successSignal: 'second.txt 생성' });
    return { decision: 'continue', summary: '격리된 파일 생성', actions, criteriaAssessment: [] };
  } };
  const options = { allowedRoots: [workspace], auditRoot: join(root, 'audit'), cwd: () => workspace,
    env: { JARVIS_TEST_MODE: '1' }, missionPlanner: planner, workerDaemonEnabled: false,
    ...(durableStore ? { missionStorePath: join(root, 'missions.json') } : {}) };
  const runtime = createAgRuntime(options);
  let checkpoint;
  const save = runtime.missionRuntime.store.save.bind(runtime.missionRuntime.store);
  runtime.missionRuntime.store.save = (missions, metadata) => {
    if (!checkpoint && metadata.reason.startsWith('mission-action-running:')) checkpoint = structuredClone(missions);
    return save(missions, metadata);
  };
  if (interruptReceipt) {
    const record = runtime.pcAgent.packetJournal.recordResult.bind(runtime.pcAgent.packetJournal);
    runtime.pcAgent.packetJournal.recordResult = (packet, result, opts) => {
      if (!opts?.dryRun && result.executionResult?.status === 'success') {
        const error = new Error('Injected process termination after file publication, before durable receipt.');
        error.code = 'TEST_RECEIPT_CRASH';
        throw error;
      }
      return record(packet, result, opts);
    };
  }
  if (interruptAfterFirst) {
    const execute = runtime.missionRuntime.executePreparedAction.bind(runtime.missionRuntime);
    runtime.missionRuntime.executePreparedAction = async (...args) => {
      await execute(...args);
      throw new Error('Injected termination before the dependent action is prepared.');
    };
  }
  if (interruptVerification) runtime.orchestrationWorker.verifyExecution = async () => {
    const error = new Error('Injected termination after durable PC receipt, before Core completion.');
    error.code = 'TEST_G_CRASH';
    throw error;
  };
  const created = runtime.missionRuntime.createMission({ objective: twoActions ? 'first.txt와 second.txt 파일을 생성해줘.' : 'first.txt 파일을 생성해줘.',
    successCriteria: twoActions ? ['first.txt와 second.txt가 생성된다.'] : ['first.txt가 생성된다.'],
    authorization: { grants: [MissionGrant.READ_ONLY, MissionGrant.LOCAL_REVERSIBLE] },
    metadata: { conversationId: 'recovery-conversation', userId: 'recovery-owner' } });
  const completed = await runtime.missionRuntime.runMission(created.missionId);
  assert.ok(checkpoint, JSON.stringify(completed));
  if (!interruptReceipt && !interruptAfterFirst && !interruptVerification) assert.equal(completed.status, MissionStatus.COMPLETED, JSON.stringify(completed));
  const store = new MemoryMissionStore();
  store.save(checkpoint);
  return { runtime, options, checkpoint, store, created, completed, firstPath, secondPath, workspace, save };
}

function restoreExisting(f, overrides = {}) {
  return new MissionRuntime({ coreFacade: f.runtime.coreFacade, orchestrationWorker: f.runtime.orchestrationWorker,
    pcAgent: f.runtime.pcAgent, planner: f.options.missionPlanner, store: f.store,
    allowedRoots: [f.workspace], ...overrides });
}

function executionSpy(worker) {
  let calls = 0;
  const original = worker.runTask.bind(worker);
  worker.runTask = async (...args) => { calls++; return await original(...args); };
  return () => calls;
}

test('an interrupted action restores a completed Core task after fresh G verification without a second execution', async (t) => {
  const f = await fixture(t);
  const before = await stat(f.firstPath);
  const undoCount = f.runtime.pcAgent.undoJournal.history().length;
  const memoryCount = f.runtime.coreFacade.workMemory.load().length;
  const executions = executionSpy(f.runtime.orchestrationWorker);
  let verifications = 0;
  const verify = f.runtime.orchestrationWorker.verifyExecution.bind(f.runtime.orchestrationWorker);
  f.runtime.orchestrationWorker.verifyExecution = async (...args) => { verifications++; return await verify(...args); };
  const mission = restoreExisting(f);
  const result = await mission.runMission(f.created.missionId);
  assert.equal(result.status, MissionStatus.COMPLETED, JSON.stringify(result));
  assert.equal(result.waves[0].actions[0].recovery.source, 'core-completed-task');
  assert.equal(result.metrics.recoveredActions, 1);
  assert.equal(verifications, 1);
  assert.equal(executions(), 0);
  assert.equal((await stat(f.firstPath)).mtimeMs, before.mtimeMs);
  assert.equal(f.runtime.pcAgent.undoJournal.history().length, undoCount);
  assert.equal(f.runtime.coreFacade.workMemory.load().length, memoryCount);
  assert.equal(result.waves[0].actions[0].recovery.memory.status, 'already-recorded');
});

test('a different A/B runtime recovers a durable PC receipt with empty Core tasks and unchanged files and undo history', async (t) => {
  const f = await fixture(t);
  const before = await stat(f.firstPath);
  const bytes = await readFile(f.firstPath);
  const undoCount = f.runtime.pcAgent.undoJournal.history().length;
  f.save(f.checkpoint, { reason: 'test-crash-checkpoint' });
  const fresh = createAgRuntime(f.options);
  const action = f.checkpoint[0].waves[0].actions[0];
  assert.equal(fresh.coreFacade.getTask(action.taskId), undefined);
  const executions = executionSpy(fresh.orchestrationWorker);
  let packets = 0;
  fresh.pcAgent.receiveExecutionPacket = async () => { packets++; throw new Error('Recovery must not execute a packet.'); };
  const result = await fresh.missionRuntime.runMission(f.created.missionId);
  assert.equal(result.status, MissionStatus.COMPLETED, JSON.stringify(result));
  assert.equal(result.waves[0].actions[0].taskId, action.taskId);
  assert.equal(result.waves[0].actions[0].operation.operationId, action.operation.operationId);
  assert.equal(result.waves[0].actions[0].recovery.source, 'pc-task-receipt');
  assert.equal(executions(), 0);
  assert.equal(packets, 0);
  assert.deepEqual(await readFile(f.firstPath), bytes);
  assert.equal((await stat(f.firstPath)).mtimeMs, before.mtimeMs);
  assert.equal(fresh.pcAgent.undoJournal.history().length, undoCount);
});

test('an artifact changed after completion is paused, stays paused on resume, and is never overwritten', async (t) => {
  const f = await fixture(t);
  await writeFile(f.firstPath, '사용자가 수정한 최신 내용');
  const executions = executionSpy(f.runtime.orchestrationWorker);
  const mission = restoreExisting(f);
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await mission.runMission(f.created.missionId);
    assert.equal(result.status, MissionStatus.PAUSED);
    assert.equal(result.stopReason, 'action-recovery-required');
    assert.equal(result.waves[0].actions[0].recovery.error.code, 'A_MISSION_RECOVERY_ARTIFACT_CHANGED');
    assert.equal(result.observations.some((item) => item.outcome === 'success'), false);
  }
  assert.equal(executions(), 0);
  assert.equal(await readFile(f.firstPath, 'utf8'), '사용자가 수정한 최신 내용');
});

test('a publication before durable receipt remains uncertain after restart and is not executed twice', async (t) => {
  const f = await fixture(t, { interruptReceipt: true });
  assert.equal(await readFile(f.firstPath, 'utf8'), '복구 검증');
  assert.ok(f.runtime.pcAgent.packetJournal.records.some((record) => record.recordType === 'packet_received' && record.dryRun === false));
  assert.equal(f.runtime.pcAgent.packetJournal.records.some((record) => record.recordType === 'packet_result' && record.dryRun === false), false);
  const before = await stat(f.firstPath);
  f.save(f.checkpoint, { reason: 'test-crash-checkpoint' });
  const fresh = createAgRuntime(f.options);
  const executions = executionSpy(fresh.orchestrationWorker);
  const result = await fresh.missionRuntime.runMission(f.created.missionId);
  assert.equal(result.status, MissionStatus.PAUSED, JSON.stringify(result));
  assert.equal(result.waves[0].actions[0].recovery.error.code, 'A_MISSION_RECOVERY_EXECUTION_UNCERTAIN');
  assert.equal(executions(), 0);
  assert.equal((await stat(f.firstPath)).mtimeMs, before.mtimeMs);
  assert.equal(f.completed.status, MissionStatus.PAUSED);
  assert.equal(f.completed.metrics.failedActions, 0);
});

test('missing receipt, changed action identity, changed roots and failed G never bypass recovery', async (t) => {
  const f = await fixture(t);
  for (const kind of ['missing', 'identity', 'roots', 'verification', 'wrong-task', 'external']) {
    const snapshot = structuredClone(f.checkpoint);
    const action = snapshot[0].waves[0].actions[0];
    if (kind === 'identity') action.arguments.content = '다른 명령';
    if (kind === 'external') action.operation.dispatch.profile.externalTransfer = true;
    const store = new MemoryMissionStore(); store.save(snapshot);
    let executions = 0;
    const worker = { pcAgent: f.runtime.pcAgent, runTask: async () => { executions++; },
      verifyExecution: kind === 'verification' ? async () => ({ verificationId: 'failed-g', status: 'failed', checks: [] })
        : f.runtime.orchestrationWorker.verifyExecution.bind(f.runtime.orchestrationWorker) };
    const coreFacade = kind === 'missing' || kind === 'wrong-task' ? { getTask: () => undefined } : f.runtime.coreFacade;
    if (kind === 'missing') worker.pcAgent = { taskResult: async () => ({ error: { code: 'B_TASK_NOT_FOUND' } }) };
    if (kind === 'wrong-task') {
      const receipt = structuredClone(f.runtime.pcAgent.taskResult(action.taskId));
      receipt.executionResult.taskId = 'another-task';
      worker.pcAgent = { taskResult: async () => receipt };
    }
    const mission = restoreExisting(f, { store, coreFacade, orchestrationWorker: worker,
      allowedRoots: kind === 'roots' ? [f.workspace, join(f.workspace, 'other')] : [f.workspace] });
    const result = await mission.runMission(f.created.missionId);
    assert.equal(result.status, MissionStatus.PAUSED, `${kind}: ${JSON.stringify(result)}`);
    assert.equal(executions, 0, kind);
    assert.equal(result.observations.some((item) => item.outcome === 'success'), false, kind);
  }
});

test('a prepared action proven not dispatched keeps its operation identity and follows normal execution and authorization', async (t) => {
  const f = await fixture(t);
  // Capture a real prepared task for a new output, before executePreparedAction
  // creates the durable dispatch checkpoint.
  const mission = f.runtime.missionRuntime;
  const created = mission.createMission({ objective: '미실행 미션', successCriteria: ['never-dispatched.txt 파일이 생성된다.'], authorization: { grants: [MissionGrant.READ_ONLY, MissionGrant.LOCAL_REVERSIBLE] } });
  const live = mission.missions.get(created.missionId);
  const output = join(f.workspace, 'never-dispatched.txt');
  const wave = mission.createWave(live, { actions: [{ id: 'unrun', command: 'never-dispatched 메모 파일을 만들어줘',
    expectedToolName: 'filesystem.createTextFile', arguments: { path: output, content: '한 번 실행' }, dependencies: [] }] });
  await mission.prepareAction(live, wave, wave.actions[0]);
  live.status = MissionStatus.RUNNING;
  const operationId = wave.actions[0].operation.operationId;
  const store = new MemoryMissionStore(); store.save([live]);
  const fresh = createAgRuntime({ ...f.options, missionStore: store });
  const executions = executionSpy(fresh.orchestrationWorker);
  const result = await fresh.missionRuntime.runMission(created.missionId);
  assert.equal(result.status, MissionStatus.COMPLETED, JSON.stringify(result));
  assert.equal(executions(), 1);
  assert.equal(result.waves[0].actions[0].operation.operationId, operationId);
  assert.equal(await readFile(output, 'utf8'), '한 번 실행');
});

test('restart recovers the completed prerequisite and executes only its never-dispatched dependent action', async (t) => {
  const f = await fixture(t, { twoActions: true, interruptAfterFirst: true });
  const before = await stat(f.firstPath);
  await assert.rejects(stat(f.secondPath), { code: 'ENOENT' });
  f.save(f.checkpoint, { reason: 'test-crash-checkpoint' });
  const fresh = createAgRuntime(f.options);
  const executions = executionSpy(fresh.orchestrationWorker);
  const result = await fresh.missionRuntime.runMission(f.created.missionId);
  assert.equal(result.status, MissionStatus.COMPLETED, JSON.stringify(result));
  assert.equal(executions(), 1);
  assert.equal(result.metrics.recoveredActions, 1);
  assert.equal(result.metrics.executedActions, 2);
  assert.equal(result.waves[0].actions[0].attempts, 1);
  assert.equal(result.waves[0].actions[1].attempts, 1);
  assert.equal((await stat(f.firstPath)).mtimeMs, before.mtimeMs);
  assert.equal(await readFile(f.secondPath, 'utf8'), '후속 작업');
  assert.equal(fresh.pcAgent.undoJournal.history().length, 2);
});

test('an expired owner session cannot authorize a never-dispatched action during recovery', async (t) => {
  const f = await fixture(t);
  const snapshot = structuredClone(f.checkpoint);
  const mission = snapshot[0];
  mission.authorization.mode = 'trusted_session';
  mission.authorization.ownerSessionId = 'expired-session';
  mission.waves[0].actions[0].attempts = 0;
  mission.waves[0].actions[0].status = 'ready';
  mission.waves[0].actions[0].operation.dispatch = null;
  const store = new MemoryMissionStore(); store.save(snapshot);
  const fresh = createAgRuntime({ ...f.options, missionStore: store });
  const executions = executionSpy(fresh.orchestrationWorker);
  const result = await fresh.missionRuntime.runMission(f.created.missionId);
  assert.equal(result.status, MissionStatus.WAITING_APPROVAL, JSON.stringify(result));
  assert.equal(result.pendingGates.length, 1);
  assert.equal(executions(), 0);
});

test('a receipt recovered before Core completion restores scoped work memory once and keeps follow-up file references usable', async (t) => {
  const f = await fixture(t, { interruptVerification: true });
  assert.equal(f.completed.status, MissionStatus.PAUSED);
  assert.equal(f.runtime.coreFacade.workMemory.load().length, 0);
  // The actual PAUSED snapshot is sufficient; no synthetic task or success is
  // inserted. A new runtime reads the durable PC receipt and performs G itself.
  const fresh = createAgRuntime(f.options);
  const executions = executionSpy(fresh.orchestrationWorker);
  const result = await fresh.missionRuntime.runMission(f.created.missionId);
  assert.equal(result.status, MissionStatus.COMPLETED, JSON.stringify(result));
  assert.equal(executions(), 0);
  assert.equal(result.metrics.executedActions, 1);
  assert.equal(result.metrics.successfulActions, 1);
  assert.equal(result.waves[0].actions[0].recovery.memory.status, 'recorded');
  const memory = fresh.coreFacade.workMemory;
  const entries = memory.load();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].scope.conversationId, 'recovery-conversation');
  assert.equal(entries[0].scope.userId, 'recovery-owner');
  assert.equal(entries[0].operationId, result.waves[0].actions[0].operation.operationId);
  assert.equal(entries[0].artifacts[0].version, 1);
  const scope = f.checkpoint[0].metadata.workReferenceScope;
  const reference = memory.resolveArtifactReference('그 파일 읽어줘', { scope });
  assert.equal(reference.status, 'resolved');
  assert.equal(reference.path, f.firstPath);
  assert.equal(memory.resolveArtifactReference('그 파일 읽어줘', { scope: { ...scope, conversationId: 'other' } }).status, 'not_found');
  f.save(f.checkpoint, { reason: 'test-repeat-recovery-checkpoint' });
  const again = createAgRuntime(f.options);
  const repeated = await again.missionRuntime.runMission(f.created.missionId);
  assert.equal(repeated.status, MissionStatus.COMPLETED);
  assert.equal(again.coreFacade.workMemory.load().length, 1);
  assert.equal(again.coreFacade.workMemory.load()[0].artifacts[0].version, 1);
});

test('a fresh runtime recovers an interrupted mission from FileMissionStore without repeating its completed action', async (t) => {
  const f = await fixture(t, { interruptVerification: true, durableStore: true });
  assert.equal(f.completed.status, MissionStatus.PAUSED);
  const artifactPath = f.firstPath;
  const artifactBytes = await readFile(artifactPath);
  const snapshot = JSON.parse(await readFile(f.options.missionStorePath, 'utf8'));
  const savedMission = snapshot.missions.find(item => item.missionId === f.created.missionId);
  assert.equal(savedMission.status, MissionStatus.PAUSED);
  assert.equal(savedMission.waves[0].actions[0].status, 'planned');
  assert.equal(savedMission.waves[0].actions[0].recovery.required, true);

  const fresh = createAgRuntime(f.options);
  assert.equal(fresh.missionRuntime.store.metadata().filePath, f.options.missionStorePath);
  const beforeActions = fresh.missionRuntime.getMission(f.created.missionId).metrics.executedActions;
  const executions = executionSpy(fresh.orchestrationWorker);
  const result = await fresh.missionRuntime.runMission(f.created.missionId);
  assert.equal(result.status, MissionStatus.COMPLETED, JSON.stringify(result));
  assert.equal(result.completion.status, 'verified');
  assert.equal(result.metrics.executedActions, beforeActions);
  assert.equal(result.metrics.recoveredActions, 1);
  assert.equal(executions(), 0);
  assert.deepEqual(await readFile(artifactPath), artifactBytes);
  assert.equal(result.waves[0].actions[0].recovery.source, 'pc-task-receipt');

  const capturePath = process.env.JARVIS_M02_ORACLE_EVIDENCE_PATH;
  if (typeof capturePath === 'string' && capturePath.length > 0) {
    const savedSnapshot = JSON.parse(await readFile(f.options.missionStorePath, 'utf8'));
    const persistedMission = savedSnapshot.missions.find(item => item.missionId === f.created.missionId);
    const action = result.waves.flatMap(wave => wave.actions).find(item => item.actionId === result.waves[0].actions[0].actionId);
    const observation = result.observations.find(item => item.observationId === action?.observationId);
    const persistedAction = persistedMission?.waves.flatMap(wave => wave.actions)
      .find(item => item.actionId === action?.actionId);
    const persistedObservation = persistedMission?.observations.find(item => item.observationId === persistedAction?.observationId);
    await writeFile(capturePath, `${JSON.stringify({
      schemaVersion: 1,
      scenarioId: 'M02',
      expected: { missionStatus: 'COMPLETED', completionStatus: 'verified', outputRelativePath: 'first.txt', outputText: '복구 검증' },
      result: {
        missionId: result.missionId,
        status: result.status,
        completionStatus: result.completion?.status,
        metrics: { executedActions: result.metrics.executedActions, executedActionsBeforeRecovery: beforeActions,
          recoveredActions: result.metrics.recoveredActions },
        executionCount: executions(),
        action: action ? { actionId: action.actionId, status: action.status, taskId: action.taskId,
          observationId: action.observationId, recoverySource: action.recovery?.source } : null,
        observation: observation ? { observationId: observation.observationId, actionId: observation.actionId,
          outcome: observation.outcome, verification: observation.verification, evidenceId: observation.evidenceId } : null
      },
      durableMission: persistedMission ? {
        missionId: persistedMission.missionId,
        status: persistedMission.status,
        action: persistedAction ? { actionId: persistedAction.actionId, status: persistedAction.status,
          taskId: persistedAction.taskId, observationId: persistedAction.observationId,
          recoverySource: persistedAction.recovery?.source } : null,
        observation: persistedObservation ? { observationId: persistedObservation.observationId,
          actionId: persistedObservation.actionId, outcome: persistedObservation.outcome,
          verification: persistedObservation.verification, evidenceId: persistedObservation.evidenceId } : null
      } : null,
      workspaceFiles: await readdir(f.workspace),
      artifact: { relativePath: 'first.txt', byteLength: artifactBytes.length,
        base64: artifactBytes.toString('base64'),
        sha256: createHash('sha256').update(artifactBytes).digest('hex') }
    }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  }
});

test('retargeting a workspace junction cannot reuse a receipt even when the replacement artifact has identical bytes', async (t) => {
  const f = await fixture(t);
  const original = `${f.workspace}-original`;
  const replacement = `${f.workspace}-replacement`;
  await mkdir(replacement);
  await writeFile(join(replacement, 'first.txt'), await readFile(f.firstPath));
  await rename(f.workspace, original);
  await symlink(replacement, f.workspace, process.platform === 'win32' ? 'junction' : 'dir');
  const executions = executionSpy(f.runtime.orchestrationWorker);
  const result = await restoreExisting(f).runMission(f.created.missionId);
  assert.equal(result.status, MissionStatus.PAUSED);
  assert.equal(result.waves[0].actions[0].recovery.error.code, 'A_MISSION_RECOVERY_ROOTS_CHANGED');
  assert.equal(executions(), 0);
});

test('mission detail and list DTOs expose only the remembered file binding needed by the UI', async (t) => {
  const f = await fixture(t);
  const runtime = f.runtime.missionRuntime;
  const created = runtime.createMission({ objective: '그 파일 읽어줘', metadata: {
    conversationId: 'recovery-conversation', userId: 'recovery-owner', privateNote: 'private-metadata-value'
  } });
  const internal = runtime.missions.get(created.missionId);
  assert.equal(internal.metadata.workReference.path, f.firstPath);
  assert.equal(internal.metadata.workReferenceOriginalText, '그 파일 읽어줘');
  const { artifactId, path, sha256, size, version } = internal.metadata.workReference;
  const expected = { workReference: { artifactId, path, sha256, size, version } };
  // Extra private fields must remain private even if a future producer adds them
  // to the stored binding. The DTO is an explicit whitelist, not a metadata clone.
  internal.metadata.workReference.privateReceipt = 'private-binding-value';
  for (const dto of [created, runtime.getMission(created.missionId), runtime.publicMission(internal, { detail: false })]) {
    assert.deepEqual(dto.metadata, expected);
    assert.equal(JSON.stringify(dto).includes('private-metadata-value'), false);
    assert.equal(JSON.stringify(dto).includes('private-binding-value'), false);
    assert.equal(Object.hasOwn(dto.metadata, 'userId'), false);
    assert.equal(Object.hasOwn(dto.metadata, 'workReferenceOriginalText'), false);
    assert.equal(Object.hasOwn(dto.metadata, 'workReferenceScope'), false);
  }
  created.metadata.workReference.path = 'changed-public-copy';
  assert.equal(internal.metadata.workReference.path, f.firstPath);
  internal.metadata.workReference.sha256 = 'invalid';
  assert.equal(Object.hasOwn(runtime.getMission(created.missionId), 'metadata'), false);
  assert.equal(Object.hasOwn(f.created, 'metadata'), false);
});
