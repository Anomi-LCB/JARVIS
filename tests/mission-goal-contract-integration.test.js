import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { buildMissionPlanningPrompt } from '../packages/core/src/mission/mission-planner.js';
import { MissionGrant } from '../packages/core/src/mission/mission-runtime.js';

async function fixture(t, planner = { async planNextWave() { return { decision: 'blocked', blockedReason: 'fixture', actions: [], criteriaAssessment: [] }; } }) {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-goal-integration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { allowedRoots: [root], auditRoot: join(root, 'audit'), cwd: () => root, env: {},
    missionStorePath: join(root, 'missions.json'), missionPlanner: planner, workerDaemonEnabled: false };
  return { root, options, runtime: createAgRuntime(options) };
}

test('Mission preserves raw source spans and criterion aliases across persisted reopen and the real planner handoff', async t => {
  let received;
  const planner = { async planNextWave(context) { received = context; return { decision: 'blocked', blockedReason: 'fixture', actions: [], criteriaAssessment: [] }; } };
  const { runtime, options } = await fixture(t, planner);
  const objective = "  '📚원문'을 읽어; 초안을 요약해; 원본은 삭제하지 마  ";
  const created = runtime.missionRuntime.createMission({ objective,
    successCriteria: [{ criterionId: 'c-original', requirementId: 'req_external_alias', sourceSpan: { start: 2, end: 12 }, statement: '원문 확인' }] });
  assert.equal(created.success, true);
  assert.equal(created.goalContract.objective, objective);
  assert.equal(created.goalContract.requirements.length, 3);
  assert.equal(created.successCriteria[0].requirementId, 'req_external_alias');
  for (const requirement of created.goalContract.requirements) {
    assert.equal(objective.slice(requirement.sourceSpan.start, requirement.sourceSpan.end), requirement.text);
  }
  const restored = createAgRuntime(options).missionRuntime;
  assert.deepEqual(restored.getMission(created.missionId).goalContract, created.goalContract);
  await restored.runMission(created.missionId);
  assert.deepEqual(received.mission.goalContract, created.goalContract);
  received.mission.goalContract.requirements[0].text = 'planner mutation';
  assert.notEqual(restored.getMission(created.missionId).goalContract.requirements[0].text, 'planner mutation');
  assert.equal(restored.getMission(created.missionId).goalContract.executionAuthorized, false);
});

test('long objective retains the final prohibition instead of silently truncating at 4000 characters', async t => {
  const { runtime } = await fixture(t);
  const objective = `자료 ${'가'.repeat(5000)}를 읽어; 원본은 삭제하지 마`;
  const created = runtime.missionRuntime.createMission({ objective });
  assert.equal(created.objective, objective);
  assert.equal(created.goalContract.objective, objective);
  assert.equal(created.goalContract.requirements.at(-1).text, '원본은 삭제하지 마');
  const tooLong = runtime.missionRuntime.createMission({ objective: '가'.repeat(32769) });
  assert.equal(tooLong.error.code, 'A_MISSION_OBJECTIVE_INVALID');
  assert.equal(runtime.missionRuntime.missions.size, 1);
});

test('malformed quote retains one unresolved original request, never a misleading partial contract', async t => {
  const { runtime } = await fixture(t);
  const objective = "'원문을 읽어; 민감한 사본은 보내지 마";
  const created = runtime.missionRuntime.createMission({ objective });
  assert.equal(created.goalContract.interpretationIssue, 'A_GOAL_QUOTE_INVALID');
  assert.equal(created.goalContract.requirements.length, 1);
  assert.equal(created.goalContract.requirements[0].text, objective);
  assert.equal(created.goalContract.requirements[0].interpretation.status, 'unresolved');
  assert.equal(created.goalContract.semanticCoverage, 'unverified');
  assert.equal(created.goalContract.executionAuthorized, false);
});

test('planner prompt includes source requirement mapping with no new external text egress path', async t => {
  const { runtime } = await fixture(t);
  const secret = 'PRIVATE_GOAL_7518';
  const created = runtime.missionRuntime.createMission({ objective: `'${secret}'를 읽어; 원본은 삭제하지 마`,
    constraints: [{ constraintId: 'private-constraint', statement: `${secret}를 전송하지 마`, hard: true }] });
  const context = runtime.missionRuntime.plannerContext(runtime.missionRuntime.missions.get(created.missionId), Date.now());
  const local = buildMissionPlanningPrompt({ ...context, today: '2026-09-27', externalEgress: false });
  assert.ok(local.includes(secret));
  assert.ok(local.includes(created.goalContract.requirements[0].requirementId));
  const external = buildMissionPlanningPrompt({ ...context, today: '2026-09-27', externalEgress: true,
    dataClassifier: { classify(value) { return { dataClass: value.includes(secret) ? 'D4' : 'D0' }; } } });
  assert.equal(external.includes(secret), false);
  assert.ok(external.includes('원문 요구사항 계약:'));
  const unavailable = buildMissionPlanningPrompt({ ...context, today: '2026-09-27', externalEgress: true });
  assert.equal(unavailable.includes(secret), false);
  assert.ok(unavailable.includes('CLASSIFICATION_UNAVAILABLE'));
});

test('extra or overlong constraints fail before creating a mission instead of silently removing prohibitions', async t => {
  const { runtime } = await fixture(t);
  const objective = '자료를 읽어';
  const invalid = [Array.from({ length: 31 }, (_, i) => `자료 ${i}는 삭제하지 마`),
    [`${'가'.repeat(1000)} 삭제 금지`], [null], [''], [{ statement: '전송 금지', hard: 'false' }],
    [{ constraintId: 'same', statement: '전송 금지' }, { constraintId: 'same', statement: '삭제 금지' }]];
  for (const constraints of invalid) {
    assert.equal(runtime.missionRuntime.createMission({ objective, constraints }).error.code, 'A_MISSION_CONSTRAINT_INVALID');
  }
  assert.equal(runtime.missionRuntime.missions.size, 0);
  const constraint = { constraintId: 'original', statement: '  원본은 삭제하지 마  ', hard: true };
  const created = runtime.missionRuntime.createMission({ objective, constraints: [constraint] });
  assert.deepEqual(created.constraints, [constraint]);
});

test('legacy mission remains without a reconstructed or verified GoalContract', async t => {
  const { runtime, options } = await fixture(t);
  const created = runtime.missionRuntime.createMission({ objective: '목록을 읽어' });
  delete runtime.missionRuntime.missions.get(created.missionId).goalContract;
  runtime.missionRuntime.persist('legacy-fixture');
  const restored = createAgRuntime(options).missionRuntime.getMission(created.missionId);
  assert.equal(restored.goalContract, null);
  assert.equal(restored.verificationStatus, 'pending');
});

const localBlockedIntentCases = [
  { objective: "'report.txt'를 저장하지 마", filename: 'report.txt' },
  { objective: "'report.txt'를 저장하지 마; 'report.txt'를 저장해", filename: 'report.txt' },
  { objective: "'report.txt'를 제외하고 'summary.txt'를 저장해", filename: 'summary.txt' },
  { objective: "'report.txt'를 저장해; 아니, 'report.txt'는 저장하지 마", filename: 'report.txt' }
];
for (const { objective, filename } of localBlockedIntentCases) {
  test(`local file creation pauses for a prohibited, excluded, contradictory or corrected goal: ${objective}`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'jarvis-goal-local-prohibition-'));
    const target = join(root, filename);
    let workerCalls = 0;
    const missionPlanner = { async planNextWave(context) {
      const positiveSave = context.mission.goalContract.requirements.find(item => item.interpretation.action === 'save'
        && item.interpretation.polarity === 'required');
      return { decision: 'continue', actions: [{ id: 'guarded-save', title: '시험용 파일 저장', command: '시험 파일을 저장해',
        expectedToolName: 'filesystem.createTextFile', arguments: { path: target, content: 'should not overwrite' },
        ...(positiveSave ? { requirementIds: [positiveSave.requirementId] } : {}), dependencies: [] }], criteriaAssessment: [] };
    } };
    const runtime = createAgRuntime({ allowedRoots: [root], auditRoot: join(root, 'audit'), cwd: () => root, env: {},
      missionStorePath: join(root, 'missions.json'), missionPlanner, workerDaemonEnabled: false });
    t.after(async () => { await runtime.close?.(); await rm(root, { recursive: true, force: true }); });
    const worker = runtime.orchestrationWorker.runTask.bind(runtime.orchestrationWorker);
    runtime.orchestrationWorker.runTask = async (...args) => { workerCalls += 1; return worker(...args); };
    const created = runtime.missionRuntime.createMission({ objective,
      authorization: { grants: [MissionGrant.READ_ONLY, MissionGrant.LOCAL_REVERSIBLE] } });
    const result = await runtime.missionRuntime.runMission(created.missionId);
    assert.notEqual(result.status, 'COMPLETED');
    assert.equal(workerCalls, 0, 'the prohibited local operation must be blocked before worker handoff');
    await assert.rejects(readFile(target));
    const mission = runtime.missionRuntime.missions.get(created.missionId);
    const action = mission.waves.flatMap(wave => wave.actions).find(item => item.expectedToolName === 'filesystem.createTextFile');
    assert.equal(action.actualToolName, 'filesystem.createTextFile');
    assert.ok(action.requirementCoverage?.reasons?.some(reason =>
      ['conflicting-goal-requirements', 'external-action-conflicts-with-prohibition', 'constraint-interpretation-unresolved', 'requirement-meaning-unresolved'].includes(reason.code)),
    JSON.stringify({ goal: mission.goalContract, status: mission.status, stopReason: mission.stopReason, action }));
  });
}

test('compound list plus edit prohibition allows the requested read but blocks a model-proposed edit before dispatch', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-goal-read-prohibition-'));
  const target = join(root, 'existing.txt');
  await writeFile(target, 'keep this content', 'utf8');
  let workerCalls = 0;
  const missionPlanner = { async planNextWave() {
    return { decision: 'continue', actions: [{ id: 'unexpected-edit', title: '파일 편집', command: '파일 내용을 편집해',
      expectedToolName: 'document.edit', arguments: { path: target, edits: [{ find: 'keep', replace: 'changed' }] }, dependencies: [] }],
      criteriaAssessment: [] };
  } };
  const runtime = createAgRuntime({ allowedRoots: [root], auditRoot: join(root, 'audit'), cwd: () => root, env: {},
    missionStorePath: join(root, 'missions.json'), missionPlanner, workerDaemonEnabled: false });
  t.after(async () => { await runtime.close?.(); await rm(root, { recursive: true, force: true }); });
  const worker = runtime.orchestrationWorker.runTask.bind(runtime.orchestrationWorker);
  runtime.orchestrationWorker.runTask = async (...args) => { workerCalls += 1; return worker(...args); };
  const objective = '현재 작업 폴더의 파일 이름 목록을 보여줘. 파일은 수정하지 마.';
  const created = runtime.missionRuntime.createMission({ objective,
    authorization: { grants: [MissionGrant.READ_ONLY, MissionGrant.LOCAL_REVERSIBLE] } });
  const result = await runtime.missionRuntime.runMission(created.missionId);
  const mission = runtime.missionRuntime.missions.get(created.missionId);
  assert.notEqual(result.status, 'COMPLETED');
  assert.equal(workerCalls, 0, 'the prohibited edit must be stopped before worker handoff');
  assert.equal(await readFile(target, 'utf8'), 'keep this content');
  assert.equal(mission.goalContract.requirements.length, 2);
  assert.equal(mission.goalContract.requirements[0].interpretation.action, 'list');
  assert.equal(mission.goalContract.requirements[1].interpretation.polarity, 'prohibited');
  const action = mission.waves.flatMap(wave => wave.actions).find(item => item.expectedToolName === 'document.edit');
  assert.equal(action?.requirementCoverage?.allowed, false);
  assert.ok(action?.requirementCoverage?.reasons?.some(reason => reason.code === 'external-action-conflicts-with-prohibition'),
    JSON.stringify({ status: mission.status, stopReason: mission.stopReason, action }));
});
