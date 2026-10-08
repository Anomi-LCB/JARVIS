import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import test from 'node:test';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { SqliteMemoryStore } from '../apps/growth-memory/src/db/sqlite-store.js';
import { PersonalOperationsStore } from '../packages/core/src/personal-operations/operations-store.js';
import { SqliteMissionStore } from '../packages/core/src/mission/sqlite-mission-store.js';
import { MissionGrant } from '../packages/core/src/mission/mission-runtime.js';
import { getRecoveredMemoryScopeProof, recoverMissionAction } from '../packages/core/src/mission/mission-action-recovery.js';
import { createRecoveredMemoryScopeAuthority, RECOVERED_MEMORY_SCOPE_TTL_MS } from '../packages/core/src/mission/recovered-memory-scope.js';

const env = { JARVIS_TEST_MODE: '1', JARVIS_LLM_INTENT: '0', JARVIS_LLM_PLANNER: '0', JARVIS_LLM_CONTENT: '0' };
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-recovered-scope-')), workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const scope = { userId: 'synthetic-owner', workspaceRoot: workspace, conversationId: 'synthetic-conversation' };
  const opened = [];
  let adapterCalls = 0, now = Date.now();
  const clock = () => new Date(now++);
  function open({ failMemory = false } = {}) {
    const operations = new PersonalOperationsStore({ dbPath: join(root, 'operations.sqlite'), clock });
    const store = new SqliteMissionStore({ operationsStore: operations, clock });
    const memoryStore = new SqliteMemoryStore({ dbPath: join(root, 'growth.sqlite'), reviewDir: join(root, 'reviews'), backupDir: join(root, 'backups'), clock });
    const runtime = createAgRuntime({ allowedRoots: [workspace], cwd: () => workspace, auditRoot: join(root, 'audit'),
      memoryStore, missionStore: store, cognitionStorePath: join(root, 'cognition.sqlite'), env, taskEnv: env, clock,
      trustSigningSecret: 'synthetic-recovery-scope-fixture-not-a-credential', workerDaemonEnabled: false,
      missionPlanner: { async planNextWave(context) {
        if (context.observations.some(item => item.outcome === 'success')) return { decision: 'complete', actions: [],
          criteriaAssessment: context.mission.successCriteria.map(item => ({ criterionId: item.criterionId, status: 'satisfied',
            evidenceActionIds: context.observations.filter(item => item.outcome === 'success').map(item => item.actionId) })) };
        return { decision: 'continue', actions: [{ id: 'write', command: 'result 텍스트 파일을 만들어줘', expectedToolName: 'filesystem.createTextFile',
          arguments: { path: join(workspace, context.mission.objective.match(/'([^']+)'/)[1]), content: 'verified synthetic recovery output' }, dependencies: [],
          requirementIds: [context.mission.goalContract.requirements[0].requirementId] }] };
      } } });
    const adapter = runtime.pcAgent.registry.get('filesystem.createTextFile'), execute = adapter.execute.bind(adapter);
    adapter.execute = async (...args) => { adapterCalls++; return execute(...args); };
    if (failMemory) {
      const save = memoryStore.saveEvent.bind(memoryStore);
      memoryStore.saveEvent = event => {
        if (event.eventType === 'execution.completed') throw Object.assign(new Error('synthetic F store unavailable'), { code: 'TEST_MEMORY_UNAVAILABLE' });
        return save(event);
      };
    }
    let closed = false;
    const value = { ...runtime, operations, store, close() { if (closed) return; closed = true; operations.close(); memoryStore.close(); runtime.coreFacade.cognition.close(); } };
    opened.push(value); return value;
  }
  async function prepare(runtime, count = 1) {
    const missions = [];
    for (let i = 1; i <= count; i++) {
      const filename = `result-${i}.txt`;
      const created = runtime.missionRuntime.createMission({ objective: `'${filename}'를 저장해`,
        metadata: { userId: scope.userId, conversationId: scope.conversationId, filename },
        successCriteria: [{ criterionId: 'text', statement: '저장한 파일의 실제 내용이 일치한다.',
          verificationSpec: { version: 1, kind: 'text.equals', path: filename, equals: 'verified synthetic recovery output' } }],
        authorization: { grants: [MissionGrant.READ_ONLY, MissionGrant.LOCAL_REVERSIBLE] } });
      const result = await runtime.missionRuntime.runMission(created.missionId);
      assert.equal(result.status, 'PAUSED', JSON.stringify(result));
      assert.ok(['post-effect-memory-pending', 'action-recovery-required'].includes(result.stopReason));
      assert.equal(result.waves[0].actions[0].recovery.error?.causeCode ?? result.waves[0].actions[0].recovery.learning?.reason, 'TEST_MEMORY_UNAVAILABLE');
      missions.push(result);
    }
    return missions;
  }
  t.after(() => { opened.forEach(value => value.close()); assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); rmSync(root, { recursive: true, force: true }); });
  return { root, workspace, scope, open, prepare, calls: () => adapterCalls, advance: ms => { now += ms; } };
}

async function recoveryFixture(t) {
  const f = fixture(t), first = f.open({ failMemory: true }), [mission] = await f.prepare(first);
  first.close();
  const runtime = f.open(), action = runtime.missionRuntime.getMission(mission.missionId).waves[0].actions[0];
  const effect = () => runtime.store.getEffect(action.effect.effectId);
  const recover = durableEffect => recoverMissionAction({ missionId: mission.missionId, action, allowedRoots: [f.workspace],
    coreFacade: runtime.coreFacade, worker: runtime.orchestrationWorker, pcAgent: runtime.pcAgent, durableEffect: durableEffect ?? effect() });
  const task = () => ({ taskId: action.taskId, request: structuredClone(effect().intent.request.taskRequest) });
  const ingest = (recovered, inputTask = task(), execution = recovered.execution, proof = getRecoveredMemoryScopeProof(recovered)) =>
    runtime.orchestrationWorker.ingestAndVerifyLearning(inputTask, execution, { recoveredScopeProof: proof }).ingest;
  const completed = () => runtime.growthRuntime.ingestor.store.allEvents().filter(event => event.eventType === 'execution.completed');
  return { ...f, runtime, action, effect, recover, task, ingest, completed };
}

test('actual Core recreation recovers three missing F events and scoped recall without replaying B', async t => {
  const f = fixture(t), first = f.open({ failMemory: true }), missions = await f.prepare(first, 3);
  assert.equal(first.growthRuntime.ingestor.store.allEvents().filter(event => event.eventType === 'execution.completed').length, 0);
  first.close();
  const resumed = f.open();
  const workScope = resumed.coreFacade.workReferenceScope({ userId: f.scope.userId, metadata: { conversationId: f.scope.conversationId } });
  const forgedWorkScope = { ...workScope, userId: 'injected-owner', conversationId: 'injected-conversation', workspaceId: join(f.root, 'injected-workspace') };
  for (const mission of missions) {
    assert.equal(resumed.coreFacade.getTask(mission.waves[0].actions[0].taskId), undefined);
    const savedMission = resumed.missionRuntime.missions.get(mission.missionId);
    savedMission.metadata.userId = forgedWorkScope.userId;
    savedMission.metadata.conversationId = forgedWorkScope.conversationId;
    savedMission.metadata.workReferenceScope = forgedWorkScope;
    const result = await resumed.missionRuntime.runMission(mission.missionId);
    assert.equal(result.status, 'COMPLETED', JSON.stringify({ recovery: result.waves[0]?.actions[0]?.recovery,
      audit: readFileSync(join(f.root, 'audit/memory-audit.jsonl'), 'utf8').split('\n').slice(-8) }));
  }
  const events = resumed.growthRuntime.ingestor.store.allEvents().filter(event => event.eventType === 'execution.completed');
  assert.equal(events.length, 3);
  for (const event of events) assert.deepEqual(event.source.memoryScope, f.scope);
  assert.equal(resumed.coreFacade.workMemory.recentOutputs(20, { scope: workScope }).length, 3);
  assert.deepEqual(resumed.coreFacade.workMemory.recentOutputs(20, { scope: forgedWorkScope }), []);
  resumed.close();
  const recalled = f.open();
  assert.equal(recalled.coreFacade.workMemory.recentOutputs(20, { scope: workScope }).length, 3);
  assert.deepEqual(recalled.coreFacade.workMemory.recentOutputs(20, { scope: forgedWorkScope }), []);
  const result = recalled.growthRuntime.query('result', { scope: f.scope });
  assert.equal(result.filter(item => item.memoryType === 'execution_observation').length, 3, JSON.stringify(result));
  assert.deepEqual(result.flatMap(item => item.evidenceEventIds).sort(), events.map(event => event.eventId).sort());
  assert.ok(result.every(item => item.provenance.memoryKind === 'execution_observation' && item.currentArtifactVerified === false && item.executionAuthority === false));
  for (const scope of [{ ...f.scope, userId: 'different-owner' }, { ...f.scope, workspaceRoot: join(f.root, 'different-workspace') }, { ...f.scope, conversationId: 'different-conversation' }]) {
    assert.deepEqual(recalled.growthRuntime.query('result', { scope }), []);
  }
  assert.equal(f.calls(), 3);
  for (let i = 1; i <= 3; i++) assert.equal(readFileSync(join(f.workspace, `result-${i}.txt`), 'utf8'), 'verified synthetic recovery output');
});

for (const field of ['userId', 'conversationId', 'workspaceRoot']) {
  test(`recovered event cannot change its original ${field}`, async t => {
    const f = await recoveryFixture(t), recovered = await f.recover();
    assert.equal(recovered.status, 'recovered');
    const task = f.task(), originalRoot = f.runtime.coreFacade.workspaceRoot;
    if (field === 'userId') task.request.userId = 'injected-owner';
    if (field === 'conversationId') task.request.metadata.conversationId = 'injected-conversation';
    if (field === 'workspaceRoot') f.runtime.coreFacade.workspaceRoot = join(f.root, 'injected-workspace');
    const rejected = f.ingest(recovered, task);
    f.runtime.coreFacade.workspaceRoot = originalRoot;
    assert.equal(rejected.success, false); assert.equal(rejected.error.reason, 'proof-scope-mismatch');
    assert.equal(f.completed().length, 0);
    assert.equal(f.ingest(recovered).stored, true, 'a rejected mutation must not prevent the authentic bound event from persisting');
    assert.deepEqual(f.completed()[0].source.memoryScope, f.scope); assert.equal(f.calls(), 1);
  });
}

test('plain, cloned and independently minted recovery objects cannot inject a scoped memory', async t => {
  const f = await recoveryFixture(t), recovered = await f.recover();
  const clone = structuredClone(recovered), authority = createRecoveredMemoryScopeAuthority();
  assert.equal(authority.bind(clone, { request: f.effect().intent.request, requestSha256: f.effect().request_sha256,
    workspaceRoot: f.workspace }), true);
  for (const fake of [{ status: 'recovered' }, clone, null]) {
    assert.equal(getRecoveredMemoryScopeProof(fake), null);
    const result = f.ingest(recovered, f.task(), recovered.execution, fake);
    assert.equal(result.success, false); assert.equal(result.error.reason, 'unrecognized-proof');
  }
  assert.equal(f.completed().length, 0); assert.equal(f.ingest(recovered).stored, true); assert.equal(f.calls(), 1);
});

test('scope proof binds event contents, task and the original G result', async t => {
  const f = await recoveryFixture(t), recovered = await f.recover();
  const injected = structuredClone(recovered.execution);
  injected.memoryEvent.payload.outputPaths = [join(f.workspace, 'never-created.txt')];
  assert.equal(f.ingest(recovered, f.task(), injected).error.reason, 'proof-event-mismatch');
  const otherTask = f.task(); otherTask.taskId = 'injected-task';
  injected.memoryEvent.taskId = otherTask.taskId;
  assert.equal(f.ingest(recovered, otherTask, injected).error.reason, 'proof-task-mismatch');
  const status = recovered.verification.status; recovered.verification.status = 'failed';
  assert.equal(f.ingest(recovered).error.reason, 'proof-result-mismatch'); recovered.verification.status = status;
  assert.equal(f.completed().length, 0); assert.equal(f.ingest(recovered).stored, true);
});

test('scope proof expires, rejects backward clocks and is single use; fresh re-verification deduplicates same-scope retry', async t => {
  const f = await recoveryFixture(t), expired = await f.recover();
  f.advance(RECOVERED_MEMORY_SCOPE_TTL_MS + 1);
  assert.equal(f.ingest(expired).error.reason, 'proof-expired');
  const backward = await f.recover(); f.advance(-1000);
  assert.equal(f.ingest(backward).error.reason, 'proof-expired'); f.advance(1001);
  const valid = await f.recover();
  assert.equal(f.ingest(valid).stored, true);
  assert.equal(f.ingest(valid).error.reason, 'proof-consumed');
  const retry = await f.recover(), duplicate = f.ingest(retry);
  assert.equal(duplicate.success, true); assert.equal(duplicate.stored, false); assert.equal(duplicate.reason, 'duplicate-event');
  assert.equal(f.completed().length, 1); assert.equal(f.calls(), 1);
});

test('mutating stored request scope cannot pass the original SQL intent hash', async t => {
  const f = await recoveryFixture(t), original = f.effect();
  for (const field of ['userId', 'conversationId', 'allowedRootsSha256']) {
    const mutated = structuredClone(original);
    if (field === 'userId') mutated.intent.request.taskRequest.userId = 'injected-owner';
    if (field === 'conversationId') mutated.intent.request.taskRequest.metadata.conversationId = 'injected-conversation';
    if (field === 'allowedRootsSha256') mutated.intent.request.allowedRootsSha256 = 'injected-workspace';
    f.runtime.operations.db.prepare('UPDATE mission_effects SET intent_json=? WHERE effect_id=?').run(JSON.stringify(mutated.intent), original.effect_id);
    const result = await f.recover();
    assert.equal(result.status, 'blocked'); assert.equal(result.error.code, 'A_MISSION_RECOVERY_RECEIPT_DISPATCH_MISMATCH');
    assert.equal(getRecoveredMemoryScopeProof(result), null); assert.equal(f.completed().length, 0);
  }
  f.runtime.operations.db.prepare('UPDATE mission_effects SET intent_json=? WHERE effect_id=?').run(JSON.stringify(original.intent), original.effect_id);
  assert.equal(f.ingest(await f.recover()).stored, true); assert.equal(f.calls(), 1);
});

test('source revocation survives recovery replay and Core recreation without widening recall', async t => {
  const f = await recoveryFixture(t), recovered = await f.recover();
  assert.equal(f.ingest(recovered).stored, true);
  const eventId = f.completed()[0].eventId;
  assert.equal(f.runtime.growthRuntime.query('result', { scope: f.scope }).length, 1);
  assert.equal(f.runtime.growthRuntime.decideHygiene({ targetType: 'memory_event', targetId: eventId, action: 'delete', decidedBy: 'synthetic-owner' }).success, true);
  assert.equal(f.ingest(await f.recover()).reason, 'duplicate-event');
  assert.equal(f.completed()[0].learningFlags.doNotRemember, true);
  f.runtime.close();
  const reopened = f.open();
  assert.deepEqual(reopened.growthRuntime.query('result', { scope: f.scope }), []);
  const revoked = reopened.growthRuntime.ingestor.store.allEvents().find(event => event.eventId === eventId);
  assert.equal(revoked.learningFlags.doNotRemember, true); assert.deepEqual(revoked.source.memoryScope, f.scope);
  assert.equal(f.calls(), 1);
});

test('unknown task events stay unscoped and legacy administrative query cannot expose raw outcomes', t => {
  const f = fixture(t), runtime = f.open();
  runtime.growthRuntime.ingestor.ingest({ eventId: 'untrusted-memory', taskId: 'unknown-task', eventType: 'execution.completed',
    source: { memoryScope: f.scope }, payload: { outputPaths: [join(f.workspace, 'forged-result.txt')] } });
  assert.equal(runtime.growthRuntime.ingestor.events.get('untrusted-memory').source.memoryScope, undefined);
  assert.deepEqual(runtime.growthRuntime.query('result', { scope: f.scope }), []);
  assert.deepEqual(runtime.growthRuntime.query('result'), []);
  assert.equal(f.calls(), 0);
});

test('do-not-remember before the missing F append prevents later recovery from resurrecting the task', async t => {
  const f = fixture(t), first = f.open({ failMemory: true }), [mission] = await f.prepare(first);
  const taskId = mission.waves[0].actions[0].taskId;
  const feedback = first.growthRuntime.recordFeedback({ taskId, feedbackType: 'do_not_remember', text: '이 작업은 기억하지 마.' });
  assert.equal(feedback.sourceRetraction.scopeKnown, true);
  first.close();
  const resumed = f.open(), completed = await resumed.missionRuntime.runMission(mission.missionId);
  assert.equal(completed.status, 'COMPLETED');
  const event = resumed.growthRuntime.ingestor.store.allEvents().find(item => item.taskId === taskId && item.eventType === 'execution.completed');
  assert.equal(event.learningFlags.doNotRemember, true);
  assert.equal(event.payload.outputPaths, undefined, 'the late append stores only a retraction tombstone');
  assert.deepEqual(resumed.growthRuntime.query('result', { scope: f.scope }), []);
  assert.equal(f.calls(), 1);
});
