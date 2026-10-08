import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createConfiguredCoreServiceRuntime } from '../scripts/core-service-runtime.mjs';
import { MissionGrant } from '../packages/core/src/mission/mission-runtime.js';

function deferred() {
  let resolvePromise;
  const promise = new Promise(resolve => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}
const nextTick = () => new Promise(resolve => setImmediate(resolve));
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-core-mission-shutdown-'));
  const env = { JARVIS_TEST_MODE: '1', JARVIS_TEST_AUDIT_ROOT: root,
    JARVIS_CORE_ALLOWED_ROOTS: join(root, 'workspace'), JARVIS_CORE_ADMIN_TOKEN: 'shutdown-fixture',
    JARVIS_CORE_MISSION_STORE_BACKEND: 'sqlite', JARVIS_CORE_WORKER_DAEMON_ENABLED: '0',
    JARVIS_CORE_WORKER_DAEMON_AUTOSTART: '0', JARVIS_PERSONAL_IMPORT_ENABLED: '0', JARVIS_GOOGLE_SYNC_ENABLED: '0',
    JARVIS_MISSION_EXECUTIVE: '0', JARVIS_LLM_INTENT: '0', JARVIS_LLM_PLANNER: '0', JARVIS_LLM_CONTENT: '0' };
  const runtimes = [];
  const open = async () => { const runtime = await createConfiguredCoreServiceRuntime({ env }); runtimes.push(runtime); return runtime; };
  const runtime = await open();
  t.after(async () => {
    for (const item of runtimes) await item.close();
    const target = resolve(root);
    assert.ok(target.startsWith(resolve(tmpdir()) + sep) && target.includes('jarvis-core-mission-shutdown-'));
    await rm(target, { recursive: true, force: true });
  });
  const owner = runtime.personalOwnerSession.activate({ requestedBy: 'shutdown-fixture', durationMinutes: 5 });
  const authorization = { mode: 'trusted_session', ownerSessionId: owner.session.sessionId,
    grants: [MissionGrant.READ_ONLY, MissionGrant.LOCAL_REVERSIBLE] };
  return { root, runtime, open, authorization };
}
async function workflow(f) {
  await writeFile(join(f.root, 'workspace', 'input.json'), '[{"total":42}]');
  return f.runtime.missionRuntime.createMission({
    objective: "'input.json' JSON을 '원본'으로 읽고; '원본'을 'output.json' JSON으로 저장해",
    successCriteria: [{ statement: '출력 합계는 42다.', verificationSpec: {
      version: 1, kind: 'json.value', path: 'output.json', pointer: '/0/total', equals: 42
    } }], authorization: f.authorization
  });
}

test('close stops accepting runs, signals a held planner and waits for final persistence and budget cleanup before DB close', async t => {
  const f = await setup(t), entered = deferred(), release = deferred();
  const events = [];
  let plannerSignal;
  f.runtime.missionRuntime.planner = { async planNextWave(_context, { signal }) {
    plannerSignal = signal; entered.resolve(); await release.promise;
    return { decision: 'pause', pauseReason: 'held-planner-released', actions: [] };
  } };
  const store = f.runtime.personalOperations.store;
  const closeStore = store.close.bind(store);
  store.close = () => { events.push('db-close'); return closeStore(); };
  const afterRun = f.runtime.missionRuntime.executionBudget.afterRun.bind(f.runtime.missionRuntime.executionBudget);
  f.runtime.missionRuntime.executionBudget.afterRun = mission => {
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM mission_sqlite_snapshot').get().n, 1);
    events.push('budget-finalizer'); return afterRun(mission);
  };
  const created = f.runtime.missionRuntime.createMission({ objective: '나중에 회의 자료를 대조해', successCriteria: ['확인된 자료가 저장된다.'] });
  const nextMission = f.runtime.missionRuntime.createMission({ objective: '후속 자료 확인', successCriteria: ['목록 확인'] });
  const running = f.runtime.missionRuntime.runMission(created.missionId);
  await entered.promise;
  let closed = false;
  const closing = f.runtime.close().then(() => { closed = true; });
  try {
    await nextTick();
    assert.equal(plannerSignal.aborted, true);
    assert.equal(closed, false);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM mission_sqlite_snapshot').get().n, 1);
    const rejected = await f.runtime.missionRuntime.runMission(nextMission.missionId);
    assert.equal(rejected.success, false);
    assert.equal(rejected.error.code, 'A_MISSION_RUNTIME_SHUTTING_DOWN');
  } finally { release.resolve(); }
  const result = await running;
  await closing;
  assert.equal(result.status, 'PAUSED');
  assert.equal(result.stopReason, 'core-service-runtime-shutdown');
  assert.equal(result.metrics.executedActions, 0);
  assert.deepEqual(events, ['budget-finalizer', 'db-close']);
  const reopened = await f.open();
  assert.equal(reopened.missionRuntime.getMission(created.missionId).stopReason, 'core-service-runtime-shutdown');
  assert.equal(reopened.missionRuntime.getMission(nextMission.missionId).status, 'CREATED');
});

test('close preserves an already executed local action and its delayed result without repeating it or claiming whole-mission completion', async t => {
  const f = await setup(t), entered = deferred(), release = deferred();
  const created = await workflow(f);
  const originalRun = f.runtime.orchestrationWorker.runTask.bind(f.runtime.orchestrationWorker);
  let dispatches = 0;
  f.runtime.orchestrationWorker.runTask = async (...args) => {
    dispatches++;
    const result = await originalRun(...args);
    entered.resolve(result);
    await release.promise;
    return result;
  };
  const running = f.runtime.missionRuntime.runMission(created.missionId);
  const providerResult = await entered.promise;
  assert.equal(providerResult.success, true);
  let closed = false;
  const closing = f.runtime.close().then(() => { closed = true; });
  try {
    await nextTick();
    assert.equal(closed, false);
    assert.deepEqual(JSON.parse(await readFile(join(f.root, 'workspace', 'output.json'), 'utf8')), [{ total: 42 }]);
    assert.equal(f.runtime.missionRuntime.store.getEffect instanceof Function, true);
  } finally { release.resolve(); }
  const result = await running;
  await closing;
  assert.equal(dispatches, 1);
  assert.equal(result.status, 'PAUSED');
  assert.equal(result.waves[0].actions[0].status, 'succeeded');
  assert.equal(result.metrics.executedActions, 1);
  assert.equal(result.metrics.successfulActions, 1);
  const reopened = await f.open();
  const persisted = reopened.missionRuntime.getMission(created.missionId);
  assert.equal(persisted.waves[0].actions[0].status, 'succeeded');
  assert.equal(persisted.metrics.executedActions, 1);
  assert.equal(persisted.status, 'PAUSED');
});

test('shutdown arriving during the final availability await prevents a new worker dispatch and budget debit', async t => {
  const f = await setup(t), entered = deferred(), release = deferred();
  const created = await workflow(f);
  const originalCheck = f.runtime.missionRuntime.checkActionAvailability.bind(f.runtime.missionRuntime);
  f.runtime.missionRuntime.checkActionAvailability = async (...args) => {
    const result = await originalCheck(...args);
    if (args[4] === 'dispatch') { entered.resolve(); await release.promise; }
    return result;
  };
  let dispatches = 0, budgetDebits = 0;
  const originalRun = f.runtime.orchestrationWorker.runTask.bind(f.runtime.orchestrationWorker);
  f.runtime.orchestrationWorker.runTask = (...args) => { dispatches++; return originalRun(...args); };
  const beforeAction = f.runtime.missionRuntime.executionBudget.beforeAction.bind(f.runtime.missionRuntime.executionBudget);
  f.runtime.missionRuntime.executionBudget.beforeAction = (...args) => { budgetDebits++; return beforeAction(...args); };
  const running = f.runtime.missionRuntime.runMission(created.missionId);
  await entered.promise;
  const closing = f.runtime.close();
  release.resolve();
  const result = await running;
  await closing;
  assert.equal(dispatches, 0);
  assert.equal(budgetDebits, 0);
  assert.equal(result.status, 'PAUSED');
  assert.equal(result.waves[0].actions[0].status, 'planned');
  assert.equal(result.waves[0].actions[0].attempts, 0);
  await assert.rejects(readFile(join(f.root, 'workspace', 'output.json')), { code: 'ENOENT' });
});

test('shutdown preserves an uncertain in-flight result as a recovery requirement instead of a normal pause', async t => {
  const f = await setup(t), entered = deferred(), release = deferred();
  const created = await workflow(f);
  const originalRun = f.runtime.orchestrationWorker.runTask.bind(f.runtime.orchestrationWorker);
  f.runtime.orchestrationWorker.runTask = async (...args) => {
    await originalRun(...args);
    entered.resolve();
    await release.promise;
    throw Object.assign(new Error('Synthetic response lost after local execution'), { executionUncertain: true, code: 'SYNTHETIC_RESPONSE_LOSS' });
  };
  const running = f.runtime.missionRuntime.runMission(created.missionId);
  await entered.promise;
  const closing = f.runtime.close();
  release.resolve();
  const result = await running;
  await closing;
  assert.equal(result.status, 'PAUSED');
  assert.equal(result.stopReason, 'action-recovery-required');
  assert.equal(result.waves[0].actions[0].recovery.required, true);
  assert.equal(result.waves[0].actions[0].recovery.error.code, 'A_MISSION_RECOVERY_EXECUTION_UNCERTAIN');
  assert.equal(result.metrics.successfulActions, 0);
  const reopened = await f.open();
  assert.equal(reopened.missionRuntime.getMission(created.missionId).stopReason, 'action-recovery-required');
});
