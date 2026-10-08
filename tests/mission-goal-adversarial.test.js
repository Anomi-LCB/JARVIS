import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { buildMissionPlanningPrompt } from '../packages/core/src/mission/mission-planner.js';
import { captureMissionGoalContract } from '../packages/core/src/mission/mission-goal-contract.js';
import { assessMissionRequirementCoverage } from '../packages/core/src/mission/mission-requirement-coverage.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-goal-adversarial-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { JARVIS_TEST_MODE: '1', JARVIS_MISSION_EXECUTIVE: '0', JARVIS_LLM_INTENT: '0', JARVIS_LLM_PLANNER: '0', JARVIS_LLM_CONTENT: '0' };
  return createAgRuntime({ allowedRoots: [root], auditRoot: join(root, 'audit'), env, taskEnv: env, workerDaemonEnabled: false });
}
function context(runtime, created) {
  assert.equal(created.success, true, JSON.stringify(created.error));
  return runtime.missionRuntime.plannerContext(runtime.missionRuntime.missions.get(created.missionId), Date.now());
}
function prompt(ctx, overrides = {}) {
  return buildMissionPlanningPrompt({ ...ctx, today: '2026-09-27', externalEgress: true,
    dataClassifier: { classify(value) { return { dataClass: /SYNTH_PRIVATE_/u.test(String(value)) ? 'D4' : 'D0' }; } }, ...overrides });
}

test('raw UTF-16 spans preserve leading whitespace, astral symbols and the final prohibition after 4000 characters', async t => {
  const runtime = await fixture(t);
  const objective = ` \t'🙂자료'를 읽어; '${'가'.repeat(4800)}'를 저장해; 최종사본은 보내지 마  `;
  const finalStart = objective.indexOf('최종사본');
  const created = runtime.missionRuntime.createMission({ objective, successCriteria: [{ criterionId: 'tail',
    statement: '말미 전송 금지', requirementId: '원본-외부별칭', sourceSpan: { start: finalStart, end: objective.length - 2 } }] });
  assert.equal(created.success, true);
  assert.equal(created.goalContract.objective, objective);
  assert.equal(created.goalContract.requirements.length, 3);
  assert.equal(created.goalContract.requirements.at(-1).text, '최종사본은 보내지 마');
  for (const requirement of created.goalContract.requirements) {
    assert.equal(objective.slice(requirement.sourceSpan.start, requirement.sourceSpan.end), requirement.text);
  }
  assert.equal(created.goalContract.criterionBindings[0].status, 'bound');
  assert.equal(created.goalContract.criterionBindings[0].requirementId, created.goalContract.requirements.at(-1).requirementId);
  assert.equal(created.successCriteria[0].requirementId, '원본-외부별칭');
});

test('malformed lexical input keeps the entire original unresolved instead of a valid prefix contract', () => {
  for (const objective of ["자료를 읽어; '닫히지 않은 원문; 마지막은 보내지 마", '자료를 읽어;; 마지막은 보내지 마',
    `자료를 읽어; ${Array.from({ length: 65 }, (_, i) => `자료${i}를 읽어`).join('; ')}; 마지막은 보내지 마`]) {
    const goal = captureMissionGoalContract({ objective, missionId: '한국어-미션', createdAt: '2026-09-27T00:00:00Z', successCriteria: [] });
    assert.equal(goal.requirements.length, 1);
    assert.equal(goal.requirements[0].text, objective);
    assert.equal(goal.requirements[0].interpretation.status, 'unresolved');
    assert.equal(goal.executionAuthorized, false);
    assert.equal(goal.semanticCoverage, 'unverified');
  }
});

test('malformed constraints reject the whole request and preserve no valid prefix mission', async t => {
  const runtime = await fixture(t);
  for (const constraints of [
    ['첫 파일은 삭제하지 마', { statement: 17 }, '마지막 파일도 보내지 마'],
    [{ constraintId: 'constraint_2', statement: '보내지 마' }, '지우지 마'],
    [{ constraintId: '금지', statement: '보내지 마' }]
  ]) {
    const created = runtime.missionRuntime.createMission({ objective: '자료를 읽어', constraints });
    assert.equal(created.success, false);
    assert.equal(created.error.code, 'A_MISSION_CONSTRAINT_INVALID');
  }
  assert.equal(runtime.missionRuntime.missions.size, 0);
});

test('supplied criterion IDs are preserved exactly or explicitly rejected, never silently rewritten into aliases', async t => {
  const runtime = await fixture(t);
  for (const criterionId of ['검증-첫째', 'criterion_검증', 'criterion with space', 'criterion!one']) {
    const created = runtime.missionRuntime.createMission({ objective: '자료를 읽어', successCriteria: [{ criterionId, statement: '파일 목록 확인' }] });
    if (created.success === false) assert.equal(created.error.code, 'A_MISSION_CRITERION_INVALID');
    else assert.equal(created.successCriteria[0].criterionId, criterionId, 'explicit identifier silently changed');
  }
});

test('one supplied requirement alias cannot silently bind two different source requirements', async t => {
  const runtime = await fixture(t), objective = '자료를 읽어; 초안을 저장해';
  const second = objective.indexOf('초안');
  const created = runtime.missionRuntime.createMission({ objective, successCriteria: [
    { criterionId: 'read', statement: '자료 읽기', requirementId: '외부-별칭', sourceSpan: { start: 0, end: objective.indexOf(';') } },
    { criterionId: 'save', statement: '초안 저장', requirementId: '외부-별칭', sourceSpan: { start: second, end: objective.length } }
  ] });
  if (created.success === false) return;
  const bound = created.goalContract.criterionBindings.filter(item => item.status === 'bound');
  assert.ok(new Set(bound.map(item => item.requirementId)).size <= 1,
    'same supplied requirement alias was accepted for different source requirements');
});

test('external projection redacts typed verifier paths, pointers and nested expected values; local contract stays intact', async t => {
  const runtime = await fixture(t);
  const secrets = ['SYNTH_PRIVATE_PATH_610', 'SYNTH_PRIVATE_POINTER_611', 'SYNTH_PRIVATE_VALUE_612'];
  const created = runtime.missionRuntime.createMission({ objective: '자료를 읽어', successCriteria: [{ criterionId: 'typed', statement: '검사',
    verificationSpec: { version: 1, kind: 'json.value', path: `${secrets[0]}.json`, pointer: `/${secrets[1]}`,
      equals: { nested: [{ value: secrets[2] }] } } }] });
  const ctx = context(runtime, created), external = prompt(ctx), local = prompt(ctx, { externalEgress: false });
  for (const secret of secrets) {
    assert.equal(external.includes(secret), false, `typed criterion data leaked: ${secret}`);
    assert.equal(local.includes(secret), true);
  }
});

test('private criterion/requirement/constraint identifiers cannot escape via structural fields or redaction field paths', async t => {
  const runtime = await fixture(t), secrets = ['SYNTH_PRIVATE_CRITERION_621', 'SYNTH_PRIVATE_REQUIREMENT_622', 'SYNTH_PRIVATE_CONSTRAINT_623'];
  const created = runtime.missionRuntime.createMission({ objective: '자료를 읽어',
    successCriteria: [{ criterionId: secrets[0], requirementId: secrets[1], statement: `${secrets[0]} 검사` }],
    constraints: [{ constraintId: secrets[2], statement: `${secrets[2]}를 보내지 마`, hard: true }] });
  const external = prompt(context(runtime, created));
  for (const secret of secrets) assert.equal(external.includes(secret), false, `identifier leaked: ${secret}`);
});

test('unknown classifier shape fails closed for new goal and constraint prompt surfaces', async t => {
  const runtime = await fixture(t), secret = 'SYNTH_PRIVATE_CLASSIFIER_631';
  const created = runtime.missionRuntime.createMission({ objective: `'${secret}'를 읽어`, constraints: [`${secret}를 전송하지 마`] });
  const ctx = context(runtime, created);
  for (const value of [{}, [], { dataClass: 'not-a-class' }, Promise.resolve({ dataClass: 'D4' })]) {
    assert.equal(prompt(ctx, { dataClassifier: { classify() { return value; } } }).includes(secret), false);
  }
});

test('closed constraint projection drops unrecognized metadata while preserving the actual prohibition', async t => {
  const runtime = await fixture(t), secret = 'SYNTH_PRIVATE_METADATA_641';
  const created = runtime.missionRuntime.createMission({ objective: '자료를 읽어', constraints: [{ constraintId: 'c1',
    statement: '원본은 삭제하지 마', hard: true, extra: { credentials: secret } }] });
  assert.deepEqual(created.constraints, [{ constraintId: 'c1', statement: '원본은 삭제하지 마', hard: true }]);
  assert.equal(prompt(context(runtime, created), { externalEgress: false }).includes(secret), false);
});

function coverageFixture(objective = "'source.txt'를 읽어; 'draft.txt'를 저장해; 'draft.txt'를 내 메일로 보내") {
  const workspaceRoot = resolve('synthetic-coverage-workspace');
  const sha = value => createHash('sha256').update(value).digest('hex');
  const artifact = name => ({ rootIndex: 0, relativePath: name, name, pathHash: sha(resolve(workspaceRoot, name)),
    contentSha256: 'a'.repeat(64), outsideAllowedRoots: false });
  const goalContract = captureMissionGoalContract({ objective, missionId: 'adversarial-coverage', createdAt: '2026-09-27T00:00:00Z' });
  const tools = ['filesystem.readText', 'filesystem.createTextFile', 'email.send'];
  const actions = goalContract.requirements.map((requirement, index) => ({ actionId: `synthetic-action-${index}`,
    taskId: `synthetic-task-${index}`, expectedToolName: tools[index], actualToolName: tools[index],
    requirementIds: [requirement.requirementId], constraintRequirementIds: [], dependencies: index ? [`synthetic-action-${index - 1}`] : [],
    arguments: index === 0 ? { path: 'source.txt' } : index === 1 ? { path: 'draft.txt' }
      : { recipientMode: 'self', attachments: [{ attachmentRef: { rootIndex: 0, relativePath: 'draft.txt' }, attachmentSha256: 'a'.repeat(64) }] },
    status: index === 2 ? 'planned' : 'succeeded', ...(index < 2 ? { observationId: `synthetic-observation-${index}` } : {}) }));
  for (const action of actions) action.operation = { dispatch: { taskId: action.taskId, toolName: action.actualToolName, arguments: structuredClone(action.arguments) } };
  const observations = actions.slice(0, 2).map((action, index) => ({ observationId: action.observationId, actionId: action.actionId,
    taskId: action.taskId, toolName: action.actualToolName, outcome: 'success', evidenceId: `synthetic-evidence-${action.actionId}`,
    verification: { status: 'passed', verificationId: `synthetic-g-${action.actionId}` },
    ...(index === 0 ? { data: { fileEvidence: artifact('source.txt') } } : { artifacts: [artifact('draft.txt')] }) }));
  const wave = { actions }, mission = { objective, goalContract, waves: [wave], observations, constraints: [], workspaceRoot };
  const assess = () => assessMissionRequirementCoverage({ mission, wave, action: actions.at(-1), phase: 'dispatch',
    allowedRoots: [workspaceRoot], dispatchArguments: actions.at(-1).operation.dispatch.arguments,
    profile: { externalTransfer: true, externalNetwork: true, readOnly: false, executionClass: 'external_commit' } });
  return { mission, wave, actions, assess };
}

test('an unknown compound predecessor cannot be discharged by a successful read before a recognized external send', () => {
  const f = coverageFixture('자료를 읽고 요약해서 법적 정확성을 검토해; 초안을 저장해; 초안을 보내');
  const result = f.assess();
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.some(item => item.code === 'requirement-meaning-unresolved'));
});

test('source file identity remains bound across read, save, send and actual dispatch checkpoints', () => {
  const positive = coverageFixture();
  assert.ok(positive.mission.goalContract.requirements.every(item => item.interpretation.status === 'recognized'));
  assert.equal(positive.assess().allowed, true, JSON.stringify(positive.assess()));
  for (const [name, change] of [
    ['wrong-read-file', f => { f.actions[0].arguments.path = f.actions[0].operation.dispatch.arguments.path = 'other.txt'; }],
    ['wrong-output-file', f => { f.actions[1].arguments.path = f.actions[1].operation.dispatch.arguments.path = 'other.txt'; }],
    ['wrong-send-attachment', f => { f.actions[2].arguments.attachments[0].attachmentRef.relativePath = 'other.txt';
      f.actions[2].operation.dispatch.arguments.attachments[0].attachmentRef.relativePath = 'other.txt'; }],
    ['actual-read-checkpoint-differs', f => { f.actions[0].operation = { dispatch: { toolName: 'filesystem.readText', arguments: { path: 'other.txt' } } }; }],
    ['actual-email-checkpoint-differs', f => { f.actions[2].operation = { dispatch: { toolName: 'email.send', arguments: {
      attachments: [{ attachmentRef: { rootIndex: 0, relativePath: 'other.txt' }, attachmentSha256: 'a'.repeat(64) }] } } }; }]
  ]) {
    const f = coverageFixture(); change(f);
    assert.equal(f.assess().allowed, false, `requirement source target was replaced: ${name}`);
  }
});
