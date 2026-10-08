import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, access, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { createCoreServer } from '../packages/core/src/main.mjs';
import { MissionGrant } from '../packages/core/src/mission/mission-runtime.js';
import { MissionGoalRevisionCoordinator } from '../packages/core/src/mission/mission-goal-revision.js';
import { PersonalOperationsStore } from '../packages/core/src/personal-operations/operations-store.js';
import { SqliteMissionStore } from '../packages/core/src/mission/sqlite-mission-store.js';
import { SqliteMemoryStore } from '../apps/growth-memory/src/db/sqlite-store.js';

const deferred = () => { let resolvePromise; const promise = new Promise(resolve => { resolvePromise = resolve; }); return { promise, resolve: resolvePromise }; };
const criterion = name => ({ criterionId: `text_${name.replaceAll('.', '_')}`, statement: `${name}의 내용이 정확히 일치한다.`,
  verificationSpec: { version: 1, kind: 'text.equals', path: name, equals: name } });
const completion = context => ({ decision: 'complete', actions: [], criteriaAssessment: context.mission.successCriteria.map(item => ({
  criterionId: item.criterionId, status: 'satisfied', evidenceActionIds: context.observations.filter(obs => obs.outcome === 'success').map(obs => obs.actionId) })) });
async function fixture(t, plan = null, { sql = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-goal-revision-'));
  const operations = sql ? new PersonalOperationsStore({ dbPath: join(root, 'operations.sqlite') }) : null;
  const memoryStore = sql ? new SqliteMemoryStore({ dbPath: join(root, 'growth.sqlite'), reviewDir: join(root, 'reviews'), backupDir: join(root, 'backups') }) : null;
  const runtime = createAgRuntime({ allowedRoots: [root], auditRoot: join(root, 'audit'), cwd: () => root,
    ...(operations ? { missionStore: new SqliteMissionStore({ operationsStore: operations }), memoryStore } : {}),
    env: { JARVIS_TEST_MODE: '1', JARVIS_LLM_INTENT: '0', JARVIS_LLM_PLANNER: '0', JARVIS_LLM_CONTENT: '0', JARVIS_MISSION_EXECUTIVE: '0' },
    workerDaemonEnabled: false, missionPlanner: { async planNextWave(context) {
      if (plan) return plan(context, root);
      const named = [...context.mission.objective.matchAll(/'([^']+[.]txt)'/gu)].map(match => match[1]);
      const completedPaths = new Set(context.observations.filter(obs => obs.outcome === 'success').flatMap(obs => obs.artifacts
        .filter(item => item.rootIndex === 0 && item.relativePath).map(item => join(root, item.relativePath))));
      const remaining = named.filter(name => !completedPaths.has(join(root, name)));
      if (!remaining.length) return completion(context);
      return { decision: 'continue', actions: remaining.map((name, index) => ({ id: `write_${index}`, command: `${name} 텍스트 파일을 만들어줘`,
        expectedToolName: 'filesystem.createTextFile', arguments: { path: join(root, name), content: name },
        dependencies: index ? [`write_${index - 1}`] : [],
        requirementIds: [context.mission.goalContract.requirements.find(item => item.text.includes(`'${name}'`)).requirementId] })) };
    } } });
  t.after(async () => { runtime.workerDaemon?.stop({ reason: 'test-finished' }); runtime.pcAgent.remoteOperationStore?.close(); runtime.coreFacade.cognition?.close(); operations?.close(); memoryStore?.close();
    assert.ok(root.startsWith(resolve(tmpdir()) + sep)); await rm(root, { recursive: true, force: true }); });
  const create = (objective = "'old.txt'를 저장해", options = {}) => runtime.missionRuntime.createMission({ objective,
    successCriteria: [criterion('old.txt')], authorization: { grants: [MissionGrant.READ_ONLY, MissionGrant.LOCAL_REVERSIBLE] }, ...options });
  const revise = (id, objective, options = {}) => runtime.missionRuntime.reviseMissionGoal(id, {
    objective, expectedRevision: 1, idempotencyKey: 'revision:1', successCriteria: [criterion('new.txt')], ...options });
  return { root, runtime, missions: runtime.missionRuntime, create, revise };
}

test('a saved replacement retains raw revision history, is idempotent and rejects stale CAS or reused payload keys', async t => {
  const f = await fixture(t), initial = f.create(), raw = "  'new.txt'를 저장해  ";
  const reason = '이번 주 우선순위가 바뀌어 새 목표로 조정';
  const updated = f.revise(initial.missionId, raw, { reason });
  assert.equal(updated.status, 'applied');
  assert.equal(updated.mission.goalContract.revision, 2);
  assert.equal(updated.mission.goalContract.objective, raw);
  const internal = f.missions.missions.get(initial.missionId);
  assert.equal(internal.goalRevisionHistory[0].goalContract.objective, "'old.txt'를 저장해");
  assert.equal(internal.goalRevisionHistory[0].revisionReason, reason);
  assert.equal(internal.goalRevisionHistory[0].revisedToRevision, 2);
  assert.equal(updated.mission.goalRevisionHistory[0].revisionReason, reason);
  assert.equal(f.revise(initial.missionId, raw, { reason }).status, 'applied');
  assert.equal(internal.goalRevisionHistory.length, 1);
  assert.equal(f.revise(initial.missionId, "'other.txt'를 저장해").error.code, 'A_MISSION_GOAL_REVISION_IDEMPOTENCY_CONFLICT');
  assert.equal(f.revise(initial.missionId, raw, { idempotencyKey: 'revision:2' }).error.code, 'A_MISSION_GOAL_REVISION_CAS_CONFLICT');
  const finished = await f.missions.runMission(initial.missionId);
  assert.equal(finished.status, 'COMPLETED', JSON.stringify(finished));
  assert.equal(await readFile(join(f.root, 'new.txt'), 'utf8'), 'new.txt');
  await assert.rejects(access(join(f.root, 'old.txt')));
});

test('a revised multi-phase local goal preserves its reason and replans dependency order after SQLite persistence', async t => {
  const f = await fixture(t, null, { sql: true });
  const initialObjective = "2026-10-20까지 'phase-a.txt'를 저장해; 'phase-b.txt'를 저장해";
  const replacementObjective = "2026-10-10까지 'phase-a.txt'를 저장해; 'phase-c.txt'를 저장해";
  const initial = f.create(initialObjective, { successCriteria: [criterion('phase-a.txt'), criterion('phase-b.txt')] });
  const revisionReason = '이번 주 우선순위 변경: phase-b를 보류하고 phase-c를 먼저 진행';
  const initialDeadlines = f.missions.getMission(initial.missionId).goalContract.times
    .filter(item => item.kind === 'date' && item.status === 'parsed-date').map(item => item.date);
  const updated = f.revise(initial.missionId, replacementObjective, { reason: revisionReason,
    successCriteria: [criterion('phase-a.txt'), criterion('phase-c.txt')] });
  assert.equal(updated.status, 'applied');
  assert.equal(updated.mission.goalContract.revision, 2);
  const revisedDeadlines = updated.mission.goalContract.times.filter(item => item.kind === 'date' && item.status === 'parsed-date').map(item => item.date);
  assert.deepEqual(initialDeadlines, ['2026-10-20']);
  assert.deepEqual(revisedDeadlines, ['2026-10-10'], 'the changed deadline replaces the old target in the active revision');
  assert.equal(updated.mission.goalRevisionHistory[0].objective, initialObjective);
  assert.equal(updated.mission.goalRevisionHistory[0].revisionReason, revisionReason);
  assert.equal(updated.mission.goalRevisionHistory[0].revisedToRevision, 2);

  const finished = await f.missions.runMission(initial.missionId);
  assert.equal(finished.status, 'COMPLETED', JSON.stringify(finished));
  assert.equal(await readFile(join(f.root, 'phase-a.txt'), 'utf8'), 'phase-a.txt');
  assert.equal(finished.completion.deadlineTiming.deadlineAt,'2026-10-10T14:59:59.999Z');
  assert.equal(finished.completion.deadlineTiming.goalRevision,2);
  assert.equal(finished.completion.deadlineTiming.dateOnlyPolicy,'end-of-local-calendar-date');
  assert.equal(await readFile(join(f.root, 'phase-c.txt'), 'utf8'), 'phase-c.txt');
  await assert.rejects(access(join(f.root, 'phase-b.txt')));
  const actions = finished.waves.flatMap(wave => wave.actions);
  assert.deepEqual(actions.map(action => action.arguments.path.split(/[\\/]/u).at(-1)), ['phase-a.txt', 'phase-c.txt']);
  assert.deepEqual(actions[0].dependencies, []);
  assert.deepEqual(actions[1].dependencies, [actions[0].actionId]);
  assert.equal(finished.goalRevisionHistory[0].revisionReason, revisionReason);
  const evidencePath = process.env.JARVIS_M01_EVIDENCE_PATH;
  if (evidencePath) await writeFile(evidencePath, `${JSON.stringify({ schemaVersion: 1, scenarioId: 'M01',
    fixtureId: 'm01-long-goal-priority-revision-synthetic-v2', mission: { status: finished.status,
      goalContract: finished.goalContract, history: finished.goalRevisionHistory.map(item => ({ revision: item.revision,
        objective: item.objective, revisionReason: item.revisionReason, revisedToRevision: item.revisedToRevision })),
      actions: actions.map(item => ({ actionId: item.actionId, path: item.arguments.path.split(/[\\/]/u).at(-1),
        dependencies: item.dependencies, status: item.status })) },
    deadlineRevision: { original: initialDeadlines, active: revisedDeadlines },
    workspaceFiles: ['phase-a.txt', 'phase-c.txt'] }, null, 2)}\n`, { flag: 'wx' });
});

test('revision during a real local worker preserves the completed effect and replans only the remaining write', async t => {
  const f = await fixture(t), initial = f.create("'old.txt'를 저장해; 'pending.txt'를 저장해");
  const entered = deferred(), release = deferred(), run = f.runtime.orchestrationWorker.runTask.bind(f.runtime.orchestrationWorker);
  const writes = [];
  f.runtime.orchestrationWorker.runTask = async (taskId, options) => {
    const task = f.runtime.coreFacade.getTask(taskId); writes.push(task.plan.action.arguments.path);
    if (writes.length === 1) { entered.resolve(); await release.promise; }
    return run(taskId, options);
  };
  const active = f.missions.runMission(initial.missionId); await entered.promise;
  try {
    const response = f.revise(initial.missionId, "'old.txt'를 저장해; 'new.txt'를 저장해");
    assert.equal(response.status, 'pending');
    assert.equal(f.missions.getMission(initial.missionId).goalContract.revision, 1);
    assert.equal((await f.missions.runMission(initial.missionId)).error.code, 'A_MISSION_GOAL_REVISION_PENDING');
  } finally { release.resolve(); await active; }
  await f.missions.goalRevisions.drains.get(initial.missionId);
  const changed = f.missions.getMission(initial.missionId);
  assert.equal(changed.goalContract.revision, 2);
  assert.equal(changed.goalRevisionConflicts.length, 0);
  const finished = await f.missions.runMission(initial.missionId);
  assert.equal(finished.status, 'COMPLETED', JSON.stringify({ stopReason: finished.stopReason, errors: finished.observations, coverage: finished.goalCompletionCoverage, waves: finished.waves }));
  assert.deepEqual(writes.map(path => path.split(/[\\/]/u).at(-1)), ['old.txt', 'new.txt']);
  assert.equal(await readFile(join(f.root, 'old.txt'), 'utf8'), 'old.txt');
  assert.equal(await readFile(join(f.root, 'new.txt'), 'utf8'), 'new.txt');
  await assert.rejects(access(join(f.root, 'pending.txt')));
  assert.ok(changed.waves[0].actions.some(item => item.status === 'skipped' && item.skipReason === 'goal-revision-superseded'));
});

test('old pending and approved gates cannot authorize the replacement goal', async t => {
  const f = await fixture(t), initial = f.create(undefined, { authorization: { grants: [MissionGrant.READ_ONLY] } });
  const stopped = await f.missions.runMission(initial.missionId), gate = stopped.gates.find(item => item.status === 'pending');
  assert.ok(gate);
  const approved = f.missions.decideGate(initial.missionId, gate.gateId, { decision: 'approve' });
  assert.equal(approved.gates.find(item => item.gateId === gate.gateId).status, 'approved');
  f.revise(initial.missionId, "'new.txt'를 저장해");
  assert.equal(f.missions.decideGate(initial.missionId, gate.gateId, { decision: 'approve' }).error.code, 'A_MISSION_GOAL_REVISION_STALE_GATE');
  const next = await f.missions.runMission(initial.missionId), newGate = next.gates.find(item => item.status === 'pending');
  assert.ok(newGate); assert.notEqual(newGate.gateId, gate.gateId); assert.equal(newGate.goalRevision, 2);
  await assert.rejects(access(join(f.root, 'old.txt'))); await assert.rejects(access(join(f.root, 'new.txt')));
});

test('an ignored planner abort cannot defeat cancellation racing a pending revision', async t => {
  const entered = deferred(), release = deferred();
  const f = await fixture(t, async () => { entered.resolve(); await release.promise; return { decision: 'pause', actions: [] }; });
  const initial = f.create(), running = f.missions.runMission(initial.missionId); await entered.promise;
  assert.equal(f.revise(initial.missionId, "'new.txt'를 저장해").status, 'pending');
  f.missions.cancelMission(initial.missionId); release.resolve(); await running;
  await f.missions.goalRevisions.drains.get(initial.missionId);
  const current = f.missions.getMission(initial.missionId);
  assert.equal(current.status, 'CANCELLED'); assert.equal(current.goalContract.revision, 1);
  assert.equal(f.revise(initial.missionId, "'new.txt'를 저장해").error.code, 'A_MISSION_GOAL_REVISION_CANCELLED');
});

test('removing a completed effect keeps its bytes and exposes a conflict instead of compensation or replay', async t => {
  const f = await fixture(t), initial = f.create();
  assert.equal((await f.missions.runMission(initial.missionId)).status, 'COMPLETED');
  const changed = f.revise(initial.missionId, "'new.txt'를 저장해");
  assert.equal(changed.status, 'applied'); assert.equal(changed.mission.status, 'PAUSED');
  assert.equal(changed.revisionRequest.conflicts[0].code, 'completed-effect-before-revision');
  assert.equal((await f.missions.runMission(initial.missionId)).error.code, 'A_MISSION_GOAL_REVISION_EFFECT_CONFLICT');
  assert.equal(await readFile(join(f.root, 'old.txt'), 'utf8'), 'old.txt');
  await assert.rejects(access(join(f.root, 'new.txt')));
});

test('goal revision API requires admin and exposes applied, CAS and idempotency contracts', async t => {
  const f = await fixture(t), initial = f.create();
  const server = createCoreServer(f.runtime.coreFacade, { adminToken: 'revision-test-admin', missionRuntime: f.missions });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  t.after(() => new Promise(resolveClose => server.close(resolveClose)));
  const url = `http://127.0.0.1:${server.address().port}/missions/${encodeURIComponent(initial.missionId)}/goal-revisions`;
  const body = { objective: "'new.txt'를 저장해", expectedRevision: 1, idempotencyKey: 'api-revision', successCriteria: [criterion('new.txt')] };
  const post = auth => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: 'Bearer revision-test-admin' } : {}) }, body: JSON.stringify(body) });
  assert.equal((await post(false)).status, 401);
  const applied = await post(true); assert.equal(applied.status, 200); assert.equal((await applied.json()).status, 'applied');
  assert.equal((await post(true)).status, 200);
  body.idempotencyKey = 'api-revision-stale'; assert.equal((await post(true)).status, 409);
});

test('the HTTP API returns 202 while an old local execution is held and 200 for the same request after settlement', async t => {
  const f = await fixture(t), initial = f.create(), entered = deferred(), release = deferred();
  const run = f.runtime.orchestrationWorker.runTask.bind(f.runtime.orchestrationWorker);
  let handoffs = 0;
  f.runtime.orchestrationWorker.runTask = async (...args) => { handoffs++; entered.resolve(); await release.promise; return run(...args); };
  const server = createCoreServer(f.runtime.coreFacade, { adminToken: 'revision-test-admin', missionRuntime: f.missions });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  t.after(() => new Promise(resolveClose => server.close(resolveClose)));
  const url = `http://127.0.0.1:${server.address().port}/missions/${encodeURIComponent(initial.missionId)}/goal-revisions`;
  const body = { objective: "'old.txt'를 저장해; 'new.txt'를 저장해", expectedRevision: 1,
    idempotencyKey: 'api-pending', successCriteria: [criterion('new.txt')] };
  const post = () => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer revision-test-admin' }, body: JSON.stringify(body) });
  const active = f.missions.runMission(initial.missionId); await entered.promise;
  try {
    const pending = await post(), content = await pending.json();
    assert.equal(pending.status, 202); assert.equal(content.status, 'pending');
    assert.equal(content.mission.goalContract.revision, 1); assert.equal(handoffs, 1);
  } finally { release.resolve(); await active; await f.missions.goalRevisions.drains.get(initial.missionId); }
  const replay = await post(), content = await replay.json();
  assert.equal(replay.status, 200); assert.equal(content.status, 'applied');
  assert.equal(content.mission.goalContract.revision, 2); assert.equal(handoffs, 1);
  assert.equal(await readFile(join(f.root, 'old.txt'), 'utf8'), 'old.txt');
  await assert.rejects(access(join(f.root, 'new.txt')));
});

test('objective-only edits preserve previous criteria but require review, and empty criteria cannot become a vacuous completion', async t => {
  const f = await fixture(t), initial = f.create();
  const revised = f.revise(initial.missionId, "'new.txt'를 저장해", { successCriteria: undefined });
  assert.deepEqual(revised.mission.successCriteria, initial.successCriteria);
  assert.equal((await f.missions.runMission(initial.missionId)).error.code, 'A_MISSION_GOAL_REVISION_CRITERIA_REVIEW');
  const explicit = f.revise(initial.missionId, "'new.txt'를 저장해", { expectedRevision: 2, idempotencyKey: 'criteria-replacement', successCriteria: [] });
  assert.equal(explicit.mission.successCriteria.length, 1);
  assert.equal(explicit.mission.successCriteria[0].statement, "'new.txt'를 저장해");
});

test('an uncertain old worker outcome stays blocked across revision and cannot dispatch a replacement effect', async t => {
  const f = await fixture(t), initial = f.create(), entered = deferred(), release = deferred();
  let handoffs = 0;
  f.runtime.orchestrationWorker.runTask = async () => {
    handoffs++; entered.resolve(); await release.promise;
    throw Object.assign(new Error('synthetic uncertain receipt'), { executionUncertain: true, code: 'SYNTHETIC_RECEIPT_LOSS' });
  };
  const active = f.missions.runMission(initial.missionId); await entered.promise;
  assert.equal(f.revise(initial.missionId, "'new.txt'를 저장해").status, 'pending');
  release.resolve(); await active; await f.missions.goalRevisions.drains.get(initial.missionId);
  const current = f.missions.getMission(initial.missionId);
  assert.equal(current.goalRevisionConflicts[0].code, 'uncertain-effect-before-revision');
  assert.equal((await f.missions.runMission(initial.missionId)).error.code, 'A_MISSION_GOAL_REVISION_EFFECT_CONFLICT');
  assert.equal(handoffs, 1); await assert.rejects(access(join(f.root, 'new.txt')));
});

test('a planner that proposes an already completed retained write is blocked before another worker handoff', async t => {
  const f = await fixture(t), initial = f.create();
  await f.missions.runMission(initial.missionId);
  f.revise(initial.missionId, "'old.txt'를 저장해; 'new.txt'를 저장해");
  let handoffs = 0;
  f.runtime.orchestrationWorker.runTask = async () => { handoffs++; throw new Error('duplicate effect reached worker'); };
  f.missions.planner.planNextWave = async context => ({ decision: 'continue', actions: [{ id: 'duplicate',
    command: 'old.txt를 만들어줘', expectedToolName: 'filesystem.createTextFile', arguments: { path: join(f.root, 'old.txt'), content: 'old.txt' },
    requirementIds: [context.mission.goalContract.requirements[0].requirementId], dependencies: [] }] });
  const result = await f.missions.runMission(initial.missionId);
  assert.equal(result.status, 'PAUSED'); assert.equal(result.lastError.code, 'A_MISSION_GOAL_REVISION_EFFECT_REPLAY_BLOCKED');
  assert.equal(handoffs, 0); assert.equal(await readFile(join(f.root, 'old.txt'), 'utf8'), 'old.txt');
});

for (const phase of ['planning', 'dispatch']) {
  test(`revision arriving during the ${phase} availability await discards the old prepared action`, async t => {
    const f = await fixture(t), initial = f.create(), entered = deferred(), release = deferred();
    const assess = f.missions.checkActionAvailability.bind(f.missions); let first = true, handoffs = 0;
    f.missions.checkActionAvailability = async (...args) => {
      const result = await assess(...args);
      if (first && args[4] === phase) { first = false; entered.resolve(); await release.promise; }
      return result;
    };
    f.runtime.orchestrationWorker.runTask = async () => { handoffs++; throw new Error('old action reached worker'); };
    const running = f.missions.runMission(initial.missionId); await entered.promise;
    assert.equal(f.revise(initial.missionId, "'new.txt'를 저장해").status, 'pending');
    release.resolve(); await running; await f.missions.goalRevisions.drains.get(initial.missionId);
    assert.equal(handoffs, 0); assert.equal(f.missions.getMission(initial.missionId).goalContract.revision, 2);
    assert.deepEqual(f.missions.getMission(initial.missionId).goalRevisionConflicts, []);
  });
}

test('persisted pending requests survive JSON restart and replay their applied revision idempotently', async t => {
  const entered = deferred(), release = deferred();
  const f = await fixture(t, async () => { entered.resolve(); await release.promise; return { decision: 'pause', actions: [] }; });
  const initial = f.create(), active = f.missions.runMission(initial.missionId); await entered.promise;
  const input = { objective: "'new.txt'를 저장해", expectedRevision: 1, idempotencyKey: 'restart', successCriteria: [criterion('new.txt')],
    reason: '재시작 후에도 수정 이유를 확인하기 위한 합성 시험' };
  f.missions.reviseMissionGoal(initial.missionId, input);
  const snapshot = JSON.parse(JSON.stringify(f.missions.missions.get(initial.missionId)));
  f.missions.cancelMission(initial.missionId); release.resolve(); await active; await f.missions.goalRevisions.drains.get(initial.missionId);
  const restoredRuntime = { missions: new Map([[initial.missionId, snapshot]]), activeRuns: new Map(), clock: () => new Date(),
    coreFacade: {}, touch: () => {}, publicMission: mission => structuredClone(mission) };
  const restored = new MissionGoalRevisionCoordinator(restoredRuntime, { normalizeSuccessCriteria: value => value, normalizeConstraints: value => value });
  restored.hydrate(); await restored.drains.get(initial.missionId);
  assert.equal(snapshot.goalContract.revision, 2);
  assert.equal(restored.request(initial.missionId, input).status, 'applied');
  assert.equal(snapshot.goalRevisionHistory.length, 1); assert.equal(snapshot.goalRevisionRequests[0].state, 'applied');
  assert.equal(snapshot.goalRevisionHistory[0].revisionReason, input.reason);
  assert.equal(snapshot.goalRevisionHistory[0].revisedToRevision, 2);
});

test('a failed revision request persistence does not replace the current goal or leave a hidden pending request', async t => {
  const f = await fixture(t), initial = f.create(), original = f.missions.store.save.bind(f.missions.store);
  f.missions.store.save = () => { throw Object.assign(new Error('synthetic storage unavailable'), { code: 'SYNTHETIC_PERSIST_FAILED' }); };
  const result = f.revise(initial.missionId, "'new.txt'를 저장해");
  f.missions.store.save = original;
  assert.equal(result.error.code, 'A_MISSION_GOAL_REVISION_PERSIST_FAILED');
  assert.equal(f.missions.getMission(initial.missionId).goalContract.revision, 1);
  assert.equal(f.missions.missions.get(initial.missionId).goalRevisionRequest, undefined);
});

test('a stale model result returned after a revision request never becomes an executable old-goal wave', async t => {
  const entered = deferred(), release = deferred();
  const f = await fixture(t, async (context, root) => {
    entered.resolve(); await release.promise;
    return { decision: 'continue', actions: [{ id: 'stale', command: 'old.txt를 만들어줘', expectedToolName: 'filesystem.createTextFile',
      arguments: { path: join(root, 'old.txt'), content: 'old.txt' }, dependencies: [],
      requirementIds: [context.mission.goalContract.requirements[0].requirementId] }] };
  });
  const initial = f.create(), running = f.missions.runMission(initial.missionId); await entered.promise;
  assert.equal(f.revise(initial.missionId, "'new.txt'를 저장해").status, 'pending');
  release.resolve(); await running; await f.missions.goalRevisions.drains.get(initial.missionId);
  const current = f.missions.getMission(initial.missionId);
  assert.equal(current.goalContract.revision, 2); assert.equal(current.waves.length, 0);
  await assert.rejects(access(join(f.root, 'old.txt')));
});

test('revision at the actual SQL prepared boundary cancels only the undispatched intent and runs the replacement once', async t => {
  const f = await fixture(t, null, { sql: true }), initial = f.create(), entered = deferred(), release = deferred();
  let first = true;
  f.missions.effectCoordinator.onBoundary = async boundary => {
    if (first && boundary === 'prepared') { first = false; entered.resolve(); await release.promise; }
  };
  let calls = 0; const run = f.runtime.orchestrationWorker.runTask.bind(f.runtime.orchestrationWorker);
  f.runtime.orchestrationWorker.runTask = async (...args) => { calls++; return run(...args); };
  const active = f.missions.runMission(initial.missionId); await entered.promise;
  assert.equal(f.revise(initial.missionId, "'new.txt'를 저장해").status, 'pending');
  release.resolve(); await active; await f.missions.goalRevisions.drains.get(initial.missionId);
  const changed = f.missions.getMission(initial.missionId), oldAction = changed.waves[0].actions[0];
  assert.equal(calls, 0); assert.equal(oldAction.revisionNoHandoff, true);
  assert.equal(f.missions.store.getEffect(oldAction.effect.effectId).receipt.notDispatched, true);
  assert.deepEqual(changed.goalRevisionConflicts, []);
  const completed = await f.missions.runMission(initial.missionId);
  assert.equal(completed.status, 'COMPLETED', JSON.stringify({ reason: completed.stopReason, error: completed.lastError,
    actions: completed.waves.flatMap(wave => wave.actions).map(action => ({ recovery: action.recovery, effect: action.effect, status: action.status, taskId: action.taskId })) }));
  assert.equal(calls, 1); assert.equal(await readFile(join(f.root, 'new.txt'), 'utf8'), 'new.txt');
  await assert.rejects(access(join(f.root, 'old.txt')));
});
