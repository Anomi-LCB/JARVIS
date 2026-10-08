import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { PersonalOperationsStore } from '../packages/core/src/personal-operations/operations-store.js';
import { SqliteMissionStore } from '../packages/core/src/mission/sqlite-mission-store.js';
import { SqliteMemoryStore } from '../apps/growth-memory/src/db/sqlite-store.js';
import { SqliteDurableRoutineStore } from '../packages/core/src/runtime/durable-routine-store.js';
import { DurableRoutineScheduler } from '../packages/core/src/runtime/durable-routine-scheduler.js';

for (const lateOutcome of ['completed', 'exception']) {
  test(`actual SQL Mission/E/B/G/F routine recovers without redispatch, then rejects stale ${lateOutcome}`, { timeout: 20000 }, async t => {
    const root = mkdtempSync(join(tmpdir(), 'jarvis-routine-mission-recovery-'));
    const workspace = join(root, 'workspace'); mkdirSync(workspace);
    const content = '격리 예약 복구: 실제 파일 내용 확인';
    const clock = () => new Date();
    const connections = [], memories = [], runtimes = [];
    const operations = () => {
      const store = new PersonalOperationsStore({ dbPath: join(root, 'operations.sqlite'), clock }); connections.push(store); return store;
    };
    let plannerCalls = 0, fileCalls = 0;
    const build = ops => {
      const memoryStore = new SqliteMemoryStore({ dbPath: join(root, 'memory.sqlite'), reviewDir: join(root, 'reviews'), backupDir: join(root, 'backups'), clock }); memories.push(memoryStore);
      const runtime = createAgRuntime({ allowedRoots: [workspace], auditRoot: join(root, 'audit'), cwd: () => workspace, clock,
        memoryStore, missionStore: new SqliteMissionStore({ operationsStore: ops }), workerDaemonEnabled: false,
        trustSigningSecret: 'synthetic-routine-test-key-not-production',
        env: { JARVIS_TEST_MODE: '1', JARVIS_LLM_INTENT: '0', JARVIS_LLM_PLANNER: '0', JARVIS_LLM_CONTENT: '0' },
        missionPlanner: { async planNextWave(context) {
          plannerCalls++;
          const successes = context.observations.filter(o => o.outcome === 'success');
          if (successes.length) return { decision: 'complete', actions: [], criteriaAssessment: context.mission.successCriteria.map(c => ({ criterionId: c.criterionId, status: 'satisfied', evidenceActionIds: successes.map(o => o.actionId) })) };
          return { decision: 'continue', actions: [{ id: 'write', command: '복구 시험 텍스트 파일을 만들어줘', expectedToolName: 'filesystem.createTextFile',
            arguments: { path: join(workspace, 'result.txt'), content }, dependencies: [], requirementIds: [context.mission.goalContract.requirements[0].requirementId] }] };
        } } });
      const adapter = runtime.pcAgent.registry.get('filesystem.createTextFile'), execute = adapter.execute.bind(adapter);
      adapter.execute = async (...args) => { fileCalls++; return execute(...args); };
      runtimes.push(runtime); return runtime;
    };
    t.after(async () => {
      for (const runtime of runtimes) await runtime.missionRuntime.requestShutdown({ reason: 'isolated-test-cleanup' });
      memories.forEach(s => s.close()); connections.forEach(s => s.close()); rmSync(root, { recursive: true, force: true });
    });
    const ops = operations(), runtime = build(ops);
    const firstStore = new SqliteDurableRoutineStore({ operationsStore: ops });
    const secondStore = new SqliteDurableRoutineStore({ operationsStore: operations() });
    let releaseOld, reached;
    const waiting = new Promise(resolve => { releaseOld = resolve; });
    const arrived = new Promise(resolve => { reached = resolve; });
    const originalRun = runtime.missionRuntime.runMission.bind(runtime.missionRuntime);
    const firstNotices = [], secondNotices = [];
    const first = new DurableRoutineScheduler({ store: firstStore, ownerId: 'old', clock, onNotification: n => firstNotices.push(n),
      missionRuntime: { createMission: request => runtime.missionRuntime.createMission(request), async runMission(id) {
        const result = await originalRun(id); reached(result); await waiting;
        if (lateOutcome === 'exception') throw new Error('isolated lost response');
        return result;
      } } });
    first.schedule({ routineId: 'actual-recovery', scheduledAt: clock().toISOString(), missionRequest: {
      objective: 'result.txt를 저장해', successCriteria: [{ criterionId: 'text', statement: '실제 파일의 내용이 일치한다.',
        verificationSpec: { version: 1, kind: 'text.equals', path: 'result.txt', equals: content } }],
      authorization: { mode: 'supervised', grants: ['read_only', 'local_reversible'] }
    } });
    const ticking = first.tick();
    t.after(() => releaseOld());
    const result = await arrived;
    assert.equal(result.status, 'COMPLETED', JSON.stringify(result));
    assert.equal(fileCalls, 1); assert.equal(readFileSync(join(workspace, 'result.txt'), 'utf8'), content);
    const action = result.waves[0].actions[0];
    assert.equal(runtime.missionRuntime.store.getEffect(action.effect.effectId).state, 'succeeded');
    assert.equal(runtime.missionRuntime.store.pendingFollowups().length, 0);
    const beforePlans = plannerCalls;
    const second = new DurableRoutineScheduler({ store: secondStore, ownerId: 'new', clock, missionRuntime: runtime.missionRuntime, onNotification: n => secondNotices.push(n) });
    try {
      await second.startupReconcile();
      assert.equal(secondStore.get('actual-recovery').status, 'completed', JSON.stringify(secondStore.get('actual-recovery')));
      assert.equal(secondStore.get('actual-recovery').missionId, result.missionId);
      assert.equal(secondNotices.length, 1);
    } finally { releaseOld(); await ticking; }
    assert.equal(firstNotices.length, 0); assert.equal(fileCalls, 1); assert.equal(plannerCalls, beforePlans);
    assert.equal(runtime.missionRuntime.listMissions().items.length, 1);
    await runtime.missionRuntime.requestShutdown({ reason: 'isolated-restart' });
    const restarted = build(operations());
    const restartedStore = new SqliteDurableRoutineStore({ operationsStore: operations() });
    const recovered = new DurableRoutineScheduler({ store: restartedStore, ownerId: 'after-restart', clock, missionRuntime: restarted.missionRuntime });
    assert.equal((await recovered.startupReconcile()).recoveredDispatches, 0);
    await recovered.tick();
    assert.equal(restartedStore.get('actual-recovery').status, 'completed');
    assert.equal(fileCalls, 1); assert.equal(plannerCalls, beforePlans);
    assert.equal(restarted.missionRuntime.listMissions().items.length, 1);
    assert.equal(readFileSync(join(workspace, 'result.txt'), 'utf8'), content);
    const memoryEvents = restarted.growthRuntime.ingestor.store.allEvents().filter(e => e.taskId === action.taskId && e.eventType === 'execution.completed');
    const workEntries = restarted.coreFacade.workMemory.load().filter(e => e.taskId === action.taskId);
    assert.equal(memoryEvents.length, 1);
    assert.equal(workEntries.length, 1);
    // A genuinely different request must remain a conflict; recovery must not weaken hashes.
    const conflictNotices = [];
    const conflict = new DurableRoutineScheduler({ store: restartedStore, ownerId: 'conflict-check', clock, missionRuntime: restarted.missionRuntime, onNotification: n => conflictNotices.push(n) });
    conflict.schedule({ routineId: 'changed-request', scheduledAt: clock().toISOString(), missionRequest: { objective: 'result.txt를 저장해' } });
    const reserved = restarted.missionRuntime.createMission({ objective: '다른 원문 요청을 보존해', idempotencyKey: 'routine:changed-request' });
    assert.ok(reserved.missionId);
    await conflict.tick();
    assert.equal(restartedStore.get('changed-request').status, 'failed');
    assert.equal(restartedStore.get('changed-request').notification.code, 'A_MISSION_IDEMPOTENCY_CONFLICT');
    assert.equal(conflictNotices.length, 1);
    assert.equal(conflictNotices[0].kind, 'routine-failed');
    assert.equal(fileCalls, 1);
    if (process.env.JARVIS_ROUTINE_RECOVERY_EVIDENCE_PREFIX) {
      const bytes = readFileSync(join(workspace, 'result.txt'));
      writeFileSync(`${process.env.JARVIS_ROUTINE_RECOVERY_EVIDENCE_PREFIX}-${lateOutcome}.json`, JSON.stringify({
        observedAt: new Date().toISOString(), lateOutcome, missionId: result.missionId, missionStatus: result.status,
        routineAfterRestart: restartedStore.get('actual-recovery'), effect: restarted.missionRuntime.store.getEffect(action.effect.effectId),
        adapterCalls: fileCalls, plannerCalls, plannerCallsBeforeRecovery: beforePlans, staleNotifications: firstNotices.length,
        acceptedNotifications: secondNotices.length, growthMemoryEvents: memoryEvents.length, workMemoryEntries: workEntries.length,
        conflict: { status: restartedStore.get('changed-request').status, code: restartedStore.get('changed-request').notification.code, notifications: conflictNotices.length },
        artifact: { relativePath: 'result.txt', byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), text: bytes.toString('utf8') },
        scope: 'isolated-local-SQL-Mission-E-B-G-F; fixture-planner; response-loss-in-one-process; no-provider-or-cloud'
      }, null, 2), { flag: 'wx' });
    }
  });
}
