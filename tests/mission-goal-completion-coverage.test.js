import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { MissionGrant } from '../packages/core/src/mission/mission-runtime.js';

for (const objective of ["'source.txt'를 읽어; 'draft.txt'를 저장해; 'draft.txt'를 보내", 'source.txt를 읽고 draft.txt로 저장해 보내라']) {
test(`a narrow passing file criterion cannot complete omitted requirements: ${objective}`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-goal-completion-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  const runtime = createAgRuntime({ allowedRoots: [root], cwd: () => root, env: {}, auditRoot: join(root, 'audit'), workerDaemonEnabled: false,
    missionPlanner: { async planNextWave(context) {
      if (calls++ === 0) return { decision: 'continue', actions: [{ id: 'save', title: '파일 저장', command: '결과 파일을 저장해',
        expectedToolName: 'filesystem.createTextFile', arguments: { path: join(root, 'draft.txt'), content: 'only saved' },
        requirementIds: [context.mission.goalContract.requirements[1]?.requirementId ?? context.mission.goalContract.requirements[0].requirementId], dependencies: [] }], criteriaAssessment: [] };
      return { decision: 'complete', actions: [], criteriaAssessment: context.mission.successCriteria.map(criterion => ({
        criterionId: criterion.criterionId, status: 'satisfied', evidenceActionIds: [context.observations[0].actionId]
      })) };
    } } });
  const created = runtime.missionRuntime.createMission({ objective,
    successCriteria: [{ statement: 'draft.txt가 존재하고 내용은 only saved', verificationSpec: { version: 1, kind: 'text.equals', path: 'draft.txt', equals: 'only saved' } }],
    authorization: { grants: [MissionGrant.READ_ONLY, MissionGrant.LOCAL_REVERSIBLE] } });
  assert.equal(created.success, true);
  const result = await runtime.missionRuntime.runMission(created.missionId);
  assert.equal(await readFile(join(root, 'draft.txt'), 'utf8'), 'only saved');
  assert.equal(result.metrics.successfulActions, 1);
  assert.notEqual(result.status, 'COMPLETED', 'saving one output does not execute the independent read or send clauses');
  assert.ok(runtime.missionRuntime.missions.get(created.missionId).goalCompletionCoverage.reasons.some(reason => reason.code.startsWith('source-requirement-')));
});
}

test('real local read and save plus an isolated email receipt complete the exact three source requirements', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-goal-completion-positive-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'source.txt'), 'source data');
  const content = 'checked draft', hash = createHash('sha256').update(content).digest('hex');
  let calls = 0, simulatedEmailCalls = 0;
  const runtime = createAgRuntime({ allowedRoots: [root], cwd: () => root, env: {}, auditRoot: join(root, 'audit'), workerDaemonEnabled: false,
    missionPlanner: { async planNextWave(context) {
      const step = calls++, requirements = context.mission.goalContract.requirements;
      const tools = ['filesystem.readText', 'filesystem.createTextFile', 'email.send'];
      if (step < 3) return { decision: 'continue', actions: [{ id: `step-${step}`, title: `정확한 단계 ${step}`, command: '요청한 단계를 실행해',
        expectedToolName: tools[step], arguments: step === 0 ? { path: join(root, 'source.txt') } : step === 1 ? { path: join(root, 'draft.txt'), content }
          : { recipientMode: 'self', to: '', subject: 'isolated fixture', body: 'isolated fixture', attachments: [{
            attachmentRef: { rootIndex: 0, relativePath: 'draft.txt' }, attachmentSha256: hash }] },
        requirementIds: [requirements[step].requirementId], dependencies: [] }], criteriaAssessment: [] };
      return { decision: 'complete', actions: [], criteriaAssessment: context.mission.successCriteria.map(criterion => ({
        criterionId: criterion.criterionId, status: 'satisfied', evidenceActionIds: context.observations.map(item => item.actionId).filter(Boolean)
      })) };
    } } });
  const worker = runtime.orchestrationWorker.runTask.bind(runtime.orchestrationWorker);
  // Only local read/write adapters run. Email is intercepted before any provider
  // call, with synthetic E and receipt evidence explicitly confined to this test.
  runtime.missionRuntime.capabilityAvailabilityGuard.assess = async () => ({ required: false });
  runtime.missionRuntime.actionAuthorized = (mission, action) => {
    action.authorizationRevision = mission.authorizationRevision ?? 1;
    action.authorizationCheckRevision = mission.authorizationRevision ?? 1;
    return true;
  };
  runtime.orchestrationWorker.runTask = async (...args) => {
    const task = runtime.coreFacade.getTask(args[0]);
    if (task.plan.action.toolName !== 'email.send') return worker(...args);
    simulatedEmailCalls += 1;
    task.status = 'COMPLETED';
    return { success: true, execution: { status: 'COMPLETED', evidence: { evidenceId: 'isolated-email-receipt' },
      executionResult: { verification: { passed: true, providerAccepted: true, recipientMatched: true } } },
      executionVerification: { status: 'passed', verificationId: 'isolated-email-g', checks: [] } };
  };
  const created = runtime.missionRuntime.createMission({ objective: "'source.txt'를 읽어; 'draft.txt'를 저장해; 'draft.txt'를 내 구글 이메일로 보내",
    successCriteria: [{ statement: '초안 내용', verificationSpec: { version: 1, kind: 'text.equals', path: 'draft.txt', equals: content } }],
    authorization: { grants: [MissionGrant.READ_ONLY, MissionGrant.LOCAL_REVERSIBLE] } });
  const result = await runtime.missionRuntime.runMission(created.missionId);
  assert.equal(result.status, 'COMPLETED', JSON.stringify({ stopReason: result.stopReason, observations: result.observations, waves: result.waves }));
  assert.equal(result.metrics.successfulActions, 3);
  assert.equal(simulatedEmailCalls, 1);
  assert.equal(await readFile(join(root, 'draft.txt'), 'utf8'), content);
  assert.equal(result.completion.goalCoverage.allowed, true);
  assert.equal(result.completion.goalCoverage.coveredRequirementIds.length, 3);
});
