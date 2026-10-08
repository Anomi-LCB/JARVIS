import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersonalOperationsStore } from '../packages/core/src/personal-operations/operations-store.js';
import { MemoryDurableRoutineStore, SqliteDurableRoutineStore } from '../packages/core/src/runtime/durable-routine-store.js';
import { DurableRoutineScheduler } from '../packages/core/src/runtime/durable-routine-scheduler.js';

const instant = '2026-10-03T00:00:00.000Z';
for (const storage of ['memory', 'sqlite']) {
  for (const recoveryOwner of ['new', 'old']) {
  for (const response of ['completed', 'exception', 'not-created', 'create-exception']) {
    test(`${storage}: stale ${response} cannot overwrite recovery by ${recoveryOwner} owner or emit a completion`, async t => {
      const root = mkdtempSync(join(tmpdir(), 'jarvis-stale-routine-'));
      const connections = [];
      const open = () => {
        const operationsStore = new PersonalOperationsStore({ dbPath: join(root, 'test.sqlite'), clock: () => new Date(instant) });
        connections.push(operationsStore);
        return new SqliteDurableRoutineStore({ operationsStore });
      };
      const store = storage === 'sqlite' ? open() : new MemoryDurableRoutineStore();
      const other = storage === 'sqlite' ? open() : store;
      t.after(() => { connections.forEach(c => c.close()); rmSync(root, { recursive: true, force: true }); });
      let resolveRun, rejectRun, started;
      const entered = new Promise(resolve => { started = resolve; });
      const run = new Promise((resolve, reject) => { resolveRun = resolve; rejectRun = reject; });
      // Synchronous creation outcomes do not await runMission, so avoid an unused rejection.
      run.catch(() => {});
      const notices = [];
      const transfer = () => assert.ok(other.claimRecovery('stale-test', { expectedOwnerId: 'old', ownerId: recoveryOwner, nowIso: instant }));
      const scheduler = new DurableRoutineScheduler({ store, ownerId: 'old', clock: () => new Date(instant), onNotification: n => notices.push(n),
        missionRuntime: {
          createMission() {
            if (response === 'not-created' || response === 'create-exception') {
              transfer();
              if (response === 'create-exception') throw new Error('isolated creation failure');
              return { code: 'A_MISSION_IDEMPOTENCY_CONFLICT' };
            }
            return { missionId: 'isolated-mission' };
          },
          runMission() { started(); return run; }
        } });
      scheduler.schedule({ routineId: 'stale-test', scheduledAt: instant, missionRequest: { objective: '합성 예약의 복구 소유권을 검사해.' } });
      const ticking = scheduler.tick();
      if (response === 'completed' || response === 'exception') {
        await entered; transfer();
        if (response === 'completed') resolveRun({ status: 'COMPLETED' });
        else rejectRun(new Error('isolated old worker failure'));
      }
      await ticking;
      const current = storage === 'sqlite' ? open().get('stale-test') : store.get('stale-test');
      assert.equal(current.status, 'dispatching');
      assert.equal(current.ownerId, recoveryOwner);
      assert.equal(current.attempts, 2);
      assert.equal(current.notification, null);
      assert.equal(notices.length, 0);
      assert.equal(scheduler.status().dispatched, 0);
    });
  }
  }
}

for (const response of ['exception', 'not-created', 'create-exception']) {
  test(`current dispatch still records ${response} and notifies once`, async () => {
    const store = new MemoryDurableRoutineStore(), notices = [];
    const scheduler = new DurableRoutineScheduler({ store, ownerId: 'current', clock: () => new Date(instant), onNotification: n => notices.push(n),
      missionRuntime: {
        createMission() {
          if (response === 'create-exception') throw new Error('isolated creation failure');
          return response === 'not-created' ? { code: 'A_ROUTINE_MISSION_CREATE_FAILED' } : { missionId: 'isolated-mission' };
        },
        async runMission() { throw new Error('isolated current worker failure'); }
      } });
    scheduler.schedule({ routineId: 'current-test', scheduledAt: instant, missionRequest: { objective: '합성 실행 실패를 기록해.' } });
    await scheduler.tick();
    assert.equal(store.get('current-test').status, response === 'not-created' ? 'blocked' : 'failed');
    assert.equal(notices.length, 1);
  });
}
