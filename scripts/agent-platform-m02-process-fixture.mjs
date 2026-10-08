import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { MissionGrant, MissionStatus } from '../packages/core/src/mission/mission-runtime.js';

const [phase, inputRoot, evidencePath, firstProcessPidText] = process.argv.slice(2);
if (!['prepare', 'resume'].includes(phase) || !inputRoot) throw new Error('usage: node scripts/agent-platform-m02-process-fixture.mjs prepare|resume <root> [evidence.json]');
const root = resolve(inputRoot), workspace = join(root, 'workspace'), auditRoot = join(root, 'audit'), missionStorePath = join(root, 'missions.json');
await mkdir(workspace, { recursive: true });
const complete = context => ({ decision: 'complete', summary: '재시작 뒤 Mission 복구 검증을 완료했습니다.', actions: [], criteriaAssessment: context.mission.successCriteria.map(criterion => ({
  criterionId: criterion.criterionId, status: 'satisfied',
  evidenceActionIds: context.observations.filter(item => item.outcome === 'success').map(item => item.actionId),
  reason: 'durable PC receipt과 G 검증 관측이 보존됐습니다.'
})) });
const planner = { async planNextWave(context) {
  if (context.observations.length) return complete(context);
  const path = join(workspace, 'first.txt');
  return { decision: 'continue', summary: '회의 준비 요약 파일 생성', actions: [{ id: 'first', title: '회의 준비 요약',
    command: '회의 준비 문서를 만들어줘. 내용은 복구 검증', expectedToolName: 'filesystem.createTextFile',
    arguments: { path, content: '복구 검증' }, dependencies: [], successSignal: 'first.txt 생성' }], criteriaAssessment: [] };
} };
const options = { allowedRoots: [workspace], auditRoot, cwd: () => workspace,
  env: { JARVIS_TEST_MODE: '1' }, missionPlanner: planner, workerDaemonEnabled: false, missionStorePath };
const runtime = createAgRuntime(options);
try {
  if (phase === 'prepare') {
    const created = runtime.missionRuntime.createMission({ objective: '회의 준비 문서를 만들고 프로세스를 재시작한 뒤 같은 결과에서 이어가줘.',
      successCriteria: ['first.txt가 생성된다.'],
      authorization: { grants: [MissionGrant.READ_ONLY, MissionGrant.LOCAL_REVERSIBLE] },
      metadata: { conversationId: 'm02-process-recovery', userId: 'local-test-owner' } });
    runtime.orchestrationWorker.verifyExecution = async () => { const error = new Error('Injected product process stop after durable PC receipt.'); error.code = 'M02_PROCESS_STOP_AFTER_RECEIPT'; throw error; };
    const result = await runtime.missionRuntime.runMission(created.missionId);
    if (result.status !== MissionStatus.PAUSED || result.metrics.executedActions !== 1) throw new Error(`prepare phase did not reach a recoverable checkpoint: ${JSON.stringify(result)}`);
    await writeFile(join(root, 'mission-id.json'), `${JSON.stringify({ missionId: created.missionId, expectedStatus: 'PAUSED' }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    console.log(JSON.stringify({ phase, pid: process.pid, missionId: created.missionId, status: result.status, executedActions: result.metrics.executedActions }));
    process.exitCode = 0;
  } else {
    if (!evidencePath) throw new Error('resume phase requires evidence path');
    const saved = JSON.parse(await readFile(join(root, 'mission-id.json'), 'utf8'));
    const before = runtime.missionRuntime.getMission(saved.missionId);
    if (before?.status !== MissionStatus.PAUSED) throw new Error(`persisted Mission was not paused before process restart: ${before?.status}`);
    let executions = 0;
    const runTask = runtime.orchestrationWorker.runTask.bind(runtime.orchestrationWorker);
    runtime.orchestrationWorker.runTask = async (...args) => { executions += 1; return runTask(...args); };
    const beforeActions = before.metrics.executedActions;
    const result = await runtime.missionRuntime.runMission(saved.missionId);
    if (result.status !== MissionStatus.COMPLETED || result.completion?.status !== 'verified' || executions !== 0) throw new Error(`resume phase did not recover without re-execution: ${JSON.stringify({ status: result.status, executions })}`);
    const bytes = await readFile(join(workspace, 'first.txt'));
    const snapshot = JSON.parse(await readFile(missionStorePath, 'utf8'));
    const durableMission = snapshot.missions.find(item => item.missionId === saved.missionId);
    const action = result.waves.flatMap(wave => wave.actions).find(item => item.actionId === result.waves[0].actions[0].actionId);
    const observation = result.observations.find(item => item.observationId === action?.observationId);
    const persistedAction = durableMission?.waves.flatMap(wave => wave.actions).find(item => item.actionId === action?.actionId);
    const persistedObservation = durableMission?.observations.find(item => item.observationId === persistedAction?.observationId);
    const capture = { schemaVersion: 1, scenarioId: 'M02', expected: { missionStatus: 'COMPLETED', completionStatus: 'verified', outputRelativePath: 'first.txt', outputText: '복구 검증' },
      processBoundary: { separateProductProcesses: true, firstProductProcessPid: Number(firstProcessPidText), secondProductProcessPid: process.pid,
        firstProcessStatus: 'PAUSED', secondProcessStatus: 'COMPLETED', processRestartBetweenPhases: true },
      result: { missionId: result.missionId, status: result.status, completionStatus: result.completion?.status,
        metrics: { executedActions: result.metrics.executedActions, executedActionsBeforeRecovery: beforeActions, recoveredActions: result.metrics.recoveredActions },
        executionCount: executions, action: action ? { actionId: action.actionId, status: action.status, taskId: action.taskId, observationId: action.observationId, recoverySource: action.recovery?.source } : null,
        observation: observation ? { observationId: observation.observationId, actionId: observation.actionId, outcome: observation.outcome, verification: observation.verification, evidenceId: observation.evidenceId } : null },
      durableMission: durableMission ? { missionId: durableMission.missionId, status: durableMission.status,
        action: persistedAction ? { actionId: persistedAction.actionId, status: persistedAction.status, taskId: persistedAction.taskId, observationId: persistedAction.observationId, recoverySource: persistedAction.recovery?.source } : null,
        observation: persistedObservation ? { observationId: persistedObservation.observationId, actionId: persistedObservation.actionId, outcome: persistedObservation.outcome, verification: persistedObservation.verification, evidenceId: persistedObservation.evidenceId } : null } : null,
      workspaceFiles: await readdir(workspace), artifact: { relativePath: 'first.txt', byteLength: bytes.length, base64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') } };
    await writeFile(evidencePath, `${JSON.stringify(capture, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    console.log(JSON.stringify({ phase, pid: process.pid, missionId: result.missionId, status: result.status, recoveredActions: result.metrics.recoveredActions, reexecutedTasks: executions, sha256: capture.artifact.sha256 }));
  }
} finally {
  runtime.workerDaemon?.stop?.({ reason: `m02-${phase}-complete` });
  runtime.coreFacade.cognition?.close?.();
}
