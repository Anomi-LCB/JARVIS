import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { GoalExecutivePlanner } from '../packages/core/src/mission/mission-planner.js';
import { MissionGrant, MissionStatus } from '../packages/core/src/mission/mission-runtime.js';

const context = {
  mission: {
    objective: '자료를 확인하고 결과 파일을 작성한다.',
    successCriteria: [{ criterionId: 'criterion_1', statement: '결과가 검증된다.' }],
    constraints: [],
    remainingBudget: { plannerCalls: 2, activeRuntimeMs: 60_000 }
  },
  capabilities: [{ toolName: 'filesystem.listFiles' }, { toolName: 'filesystem.createTextFile' }],
  observations: []
};

function action(id = 'read', overrides = {}) {
  return {
    id, command: '작업 폴더 파일 목록을 보여줘', expectedToolName: 'filesystem.listFiles',
    arguments: { directory: '.' }, dependencies: [], ...overrides
  };
}

const malformedCases = [
  ['unregistered tool after valid prefix', [action(), action('unknown', { expectedToolName: 'pc.omnipotent' })]],
  ['invalid prerequisite before valid write', [action('read', { expectedToolName: 'pc.omnipotent' }), action('write', { dependencies: ['read'], expectedToolName: 'filesystem.createTextFile' })]],
  ['missing command after valid prefix', [action(), action('empty', { command: '' })]],
  ['null action after valid prefix', [action(), null]],
  ['duplicate action IDs', [action(), action()]],
  ['ambiguous duplicate referenced by a later action', [action(), action(), action('write', { dependencies: ['read'] })]],
  ['missing action ID', [action(undefined, { id: undefined })]],
  ['rewritten action ID', [action('read invalid')]],
  ['unknown dependency', [action('read', { dependencies: ['missing'] })]],
  ['self dependency', [action('read', { dependencies: ['read'] })]],
  ['invalid dependency entry', [action('read', { dependencies: [null] })]],
  ['non-array dependency list', [action('read', { dependencies: 'missing' })]],
  ['more dependency references than accepted', [action('read'), action('write', { dependencies: Array.from({ length: 9 }, () => 'read') })]],
  ['cyclic dependencies', [action('a', { dependencies: ['b'] }), action('b', { dependencies: ['a'] })]],
  ['command exceeding accepted bound', [action('read', { command: 'x'.repeat(1201) })]],
  ['more actions than allowed in one wave', Array.from({ length: 5 }, (_, index) => action(`a${index}`))]
];

for (const [name, actions] of malformedCases) {
  test(`Planner rejects the whole wave for ${name}`, () => {
    const planner = new GoalExecutivePlanner();
    assert.equal(planner.sanitizePlan({ decision: 'continue', actions }, context), null);
  });
}

for (const decision of ['complete', 'ask_user', 'blocked']) {
  test(`Planner rejects ${decision} responses with contradictory executable actions`, () => {
    assert.equal(new GoalExecutivePlanner().sanitizePlan({ decision, actions: [action()] }, context), null);
  });
  test(`Planner rejects ${decision} responses with a non-array actions field`, () => {
    assert.equal(new GoalExecutivePlanner().sanitizePlan({ decision, actions: {} }, context), null);
  });
  test(`Planner accepts ${decision} responses with an explicit empty action list`, () => {
    const result = new GoalExecutivePlanner().sanitizePlan({ decision, actions: [] }, context);
    assert.equal(result.decision, decision);
    assert.deepEqual(result.actions, []);
  });
}

test('Planner preserves a valid graph with forward and duplicate dependency references', () => {
  const planner = new GoalExecutivePlanner();
  const actions = [
    action('파일_읽기', { dependencies: ['목록', '목록'] }),
    action('목록')
  ];
  const before = structuredClone(actions);
  const result = planner.sanitizePlan({ decision: 'continue', actions }, context);
  assert.deepEqual(result.actions.map(({ id, dependencies }) => ({ id, dependencies })), [
    { id: '파일_읽기', dependencies: ['목록'] }, { id: '목록', dependencies: [] }
  ]);
  assert.deepEqual(actions, before, 'input response must stay unchanged');
});

test('Planner exposes only a bounded validation reason for rejected model output', () => {
  const diagnostics = {};
  const secretLikeContent = { decision: 'continue', actions: [
    action('bad-tool', { command: 'private-request-fragment', expectedToolName: 'pc.omnipotent' })
  ] };
  assert.equal(new GoalExecutivePlanner().sanitizePlan(secretLikeContent, context, diagnostics), null);
  assert.equal(diagnostics.reason, 'action-graph-invalid');
  assert.doesNotMatch(JSON.stringify(diagnostics), /private-request-fragment|pc\.omnipotent/);
});

test('Planner automatically repairs a rejected partial response before returning executable actions', async () => {
  const prompts = [];
  const planner = new GoalExecutivePlanner({ runner: async (prompt) => {
    prompts.push(prompt);
    return JSON.stringify({ decision: 'continue', actions: prompts.length === 1
      ? [action(), action('unsupported', { expectedToolName: 'pc.omnipotent' })]
      : [action('repaired')] });
  } });
  const result = await planner.planNextWave(context);
  assert.equal(prompts.length, 2);
  assert.equal(result.decision, 'continue');
  assert.deepEqual(result.actions.map(({ id }) => id), ['repaired']);
  assert.equal(result.planning.transientFailures[0].code, 'A_MISSION_PLANNER_INVALID_RESPONSE');
  assert.equal(result.planning.transientFailures[0].validationReason, 'action-graph-invalid');
  assert.match(prompts[1], /형식 복구/);
});

test('Core binds the private Mission tool hint before parsing negated command text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-trusted-mission-route-'));
  let runtime;
  try {
    runtime = createAgRuntime({ allowedRoots: [root], auditRoot: join(root, 'audit'), cwd: () => root,
      env: {}, workerDaemonEnabled: false });
    const task = runtime.coreFacade.createMissionActionTask('현재 작업 폴더의 파일 이름만 나열해줘. 파일은 수정하지 마.', {
      expectedToolName: 'filesystem.listFiles',
      source: 'trigger', sourceModule: 'A_CORE', deviceId: 'mission_executive', inputMode: 'text'
    });
    assert.deepEqual(task.plan.trustedMissionRoute, { selected: true, preparedArgumentsProvided: false,
      argumentMode: 'bounded-local-read-default', reason: 'registered-tool-bound' });
    assert.equal(task.plan.route.skill.toolName, 'filesystem.listFiles');
    assert.equal(task.plan.action.toolName, 'filesystem.listFiles');
    assert.equal(task.plan.action.arguments.directory, root);
  } finally {
    runtime?.workerDaemon?.stop?.();
    runtime?.coreFacade?.cognition?.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test('Mission Runtime pauses without executing the valid write prefix of an invalid plan', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-planner-integrity-'));
  const workspace = join(root, 'workspace');
  let runnerCalls = 0;
  try {
    await mkdir(workspace);
    const outputPath = join(workspace, 'must-not-exist.txt');
    const planner = new GoalExecutivePlanner({ runner: async () => {
      runnerCalls += 1;
      return JSON.stringify({ decision: 'continue', actions: [
        action('valid_prefix', {
          command: 'must-not-exist.txt 텍스트 파일을 만들어줘',
          expectedToolName: 'filesystem.createTextFile',
          arguments: { path: outputPath, content: 'A rejected plan must never write this.' }
        }),
        action('unsupported', { expectedToolName: 'pc.omnipotent', dependencies: ['valid_prefix'] })
      ] });
    } });
    const runtime = createAgRuntime({
      allowedRoots: [workspace], auditRoot: join(root, 'audit'), cwd: () => workspace,
      env: {}, missionPlanner: planner, workerDaemonEnabled: false
    });
    const mission = runtime.missionRuntime.createMission({
      objective: '자료를 읽은 뒤 결과를 작성하고 다른 도구로 검토한다.',
      successCriteria: ['결과 파일 생성', '다른 도구의 검토'],
      authorization: { grants: [MissionGrant.READ_ONLY, MissionGrant.LOCAL_REVERSIBLE] }
    });
    const result = await runtime.missionRuntime.runMission(mission.missionId);
    const outputExists = await access(outputPath).then(() => true, () => false);
    t.diagnostic(JSON.stringify({ status: result.status, stopReason: result.stopReason,
      runnerCalls, successfulActions: result.metrics.successfulActions, waveCount: result.waves.length, outputExists }));
    assert.equal(result.status, MissionStatus.PAUSED);
    assert.equal(result.stopReason, 'mission-planner-invalid-response');
    assert.equal(result.recovery.resumeSupported, true);
    assert.equal(runnerCalls, 2);
    assert.equal(result.metrics.successfulActions, 0);
    assert.equal(result.waves.length, 0, 'no partial wave may reach the executor');
    await assert.rejects(access(outputPath), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('trusted Mission tool selection survives a negated mention of a different capability', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-mission-negated-route-'));
  const workspace = join(root, 'workspace');
  let runtime;
  try {
    await mkdir(workspace);
    await writeFile(join(workspace, 'route-marker.txt'), 'synthetic', 'utf8');
    const planner = new GoalExecutivePlanner({ runner: async () => JSON.stringify({
      decision: 'continue', summary: '목록 조회', actions: [action('list_files', {
        command: '현재 작업 폴더의 파일 이름만 나열해줘. 파일은 수정하지 마.',
        expectedToolName: 'filesystem.listFiles', arguments: { directory: workspace }
      })], criteriaAssessment: []
    }) });
    runtime = createAgRuntime({ allowedRoots: [workspace], auditRoot: join(root, 'audit'), cwd: () => workspace,
      env: {}, missionPlanner: planner, workerDaemonEnabled: false });
    const mission = runtime.missionRuntime.createMission({
      objective: '현재 작업 폴더의 파일 이름만 나열해줘. 파일은 수정하지 마.',
      successCriteria: ['파일 목록 조회'],
      authorization: { grants: [MissionGrant.READ_ONLY] },
      budgets: { maxActions: 1, maxWaves: 1 }
    });
    const result = await runtime.missionRuntime.runMission(mission.missionId, { maxWaves: 1 });
    const actions = result.waves.flatMap(wave => wave.actions);
    const task = actions[0]?.taskId ? runtime.coreFacade.getTask(actions[0].taskId) : null;
    assert.deepEqual(task?.plan?.trustedMissionRoute, { selected: true, preparedArgumentsProvided: false,
      argumentMode: 'bounded-local-read-default', reason: 'registered-tool-bound' });
    assert.equal(actions[0]?.expectedToolName, 'filesystem.listFiles');
    assert.equal(actions[0]?.actualToolName, 'filesystem.listFiles');
    assert.equal(result.metrics.routeMismatches, 0);
    assert.equal(result.observations.some(item => item.toolName === 'filesystem.listFiles' && item.outcome === 'success'), true);
    assert.equal(result.observations.some(item => item.toolName === 'document.edit' && item.outcome === 'success'), false);
  } finally {
    runtime?.workerDaemon?.stop?.();
    runtime?.coreFacade?.cognition?.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

for (const limit of ['action-budget', 'wave-limit', 'fits']) {
  test(`Mission Runtime preserves a forward prerequisite when constrained by ${limit}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'jarvis-planner-budget-integrity-'));
    const workspace = join(root, 'workspace');
    try {
      await mkdir(workspace);
      const outputPath = join(workspace, 'must-await-read.txt');
      const payload = { decision: 'continue', actions: [
        action('write', {
          command: 'must-await-read.txt 텍스트 파일을 만들어줘',
          expectedToolName: 'filesystem.createTextFile',
          arguments: { path: outputPath, content: 'The prerequisite must finish before writing.' },
          dependencies: ['read']
        }), action('read', { arguments: { directory: workspace } })
      ] };
      const planner = new GoalExecutivePlanner({ runner: async () => JSON.stringify(payload) });
      assert.equal(planner.sanitizePlan(payload, context).actions.length, 2, 'input graph itself is valid');
      const runtime = createAgRuntime({
        allowedRoots: [workspace], auditRoot: join(root, 'audit'), cwd: () => workspace,
        env: {}, missionPlanner: planner, workerDaemonEnabled: false,
        missionMaxActionsPerWave: limit === 'wave-limit' ? 1 : 4
      });
      const mission = runtime.missionRuntime.createMission({
        objective: '자료를 검토하고 결과 초안을 생성한 뒤 실행 관계를 검증한다.',
        successCriteria: ['자료 검토', '결과 파일 생성'],
        budgets: { maxActions: limit === 'action-budget' ? 1 : 4 },
        authorization: { grants: [MissionGrant.READ_ONLY, MissionGrant.LOCAL_REVERSIBLE] }
      });
      const result = await runtime.missionRuntime.runMission(mission.missionId, { maxWaves: 1 });
      const outputExists = await access(outputPath).then(() => true, () => false);
      t.diagnostic(JSON.stringify({ limit, status: result.status, stopReason: result.stopReason,
        successfulActions: result.metrics.successfulActions, waveCount: result.waves.length, outputExists }));
      if (limit === 'fits') {
        assert.equal(result.metrics.successfulActions, 2);
        assert.equal(result.waves.length, 1);
        assert.equal(outputExists, true);
        const [write, read] = result.waves[0].actions;
        assert.deepEqual(write.dependencies, [read.actionId]);
        assert.equal(read.status, 'succeeded');
        assert.equal(write.status, 'succeeded');
        return;
      }
      assert.equal(result.status, MissionStatus.PAUSED);
      assert.equal(result.stopReason, limit === 'action-budget'
        ? 'mission-wave-action-budget-insufficient' : 'mission-wave-size-exceeded');
      assert.equal(result.recovery.resumeSupported, true);
      assert.equal(result.metrics.successfulActions, 0);
      assert.equal(result.waves.length, 0);
      assert.equal(outputExists, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
