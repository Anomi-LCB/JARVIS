import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreWorkerDaemon } from '../packages/core/src/runtime/core-worker-daemon.js';
import { GrowthRuntime } from '../apps/growth-memory/src/growth-runtime.js';
import { SqliteMemoryStore } from '../apps/growth-memory/src/db/sqlite-store.js';

function worker(growthRuntime) {
  return {
    growthRuntime,
    queueStatus: () => ({ total: 0, persistence: { enabled: true }, leases: {
      activeLeaseCount: 0, persistence: { enabled: true }
    } }),
    drain: async () => ({ processed: 0 })
  };
}

function fixture(t, count = 1) {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-core-memory-replay-'));
  const store = new SqliteMemoryStore({ dbPath: join(root, 'memory.sqlite'),
    reviewDir: join(root, 'reviews'), backupDir: join(root, 'backups') });
  const growth = new GrowthRuntime({ memoryStore: store, auditRoot: root });
  const backup = store.backup({ backupId: 'empty' });
  const save = store.saveEvent.bind(store);
  store.saveEvent = (event, options) => {
    store.restore({ backupPath: backup.filePath });
    return save(event, options);
  };
  // Prevent opportunistic replay while deliberately creating a retained batch.
  growth.pendingDrainInProgress = true;
  for (let i = 0; i < count; i++) {
    const result = growth.ingest({ eventId: `queued-${i}`, taskId: `task-${i}`,
      eventType: 'task.created', source: { module: 'CORE', memoryScope: {
        userId: 'synthetic-owner', workspaceRoot: root, conversationId: null
      } }, payload: { rawText: '합성 자료 정리' },
      learningFlags: { canBeUsedForWorkflow: true }, trustBoundary: { userProvided: true } });
    assert.equal(result.queued, true);
  }
  growth.pendingDrainInProgress = false;
  store.saveEvent = save;
  const reopened = new GrowthRuntime({ memoryStore: store, auditRoot: root });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { store, growth: reopened };
}

test('Core timer replays persisted memory while task queue is idle, without F server', async t => {
  const { store, growth } = fixture(t);
  const daemon = new CoreWorkerDaemon({ worker: worker(growth), intervalMs: 20 });
  t.after(() => daemon.stop());
  daemon.start();
  const deadline = Date.now() + 2000;
  while (!store.hasEvent('queued-0') && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(store.hasEvent('queued-0'), true);
  assert.equal(store.pendingMemoryStatus().pendingCount, 0);
  assert.equal(daemon.status().processedTotal, 0);
  assert.equal(daemon.lastMemoryReplay.stored, 1);
  assert.equal(JSON.stringify(daemon.status()).includes('queued-0'), false);
  await daemon.tick();
  assert.equal(daemon.lastMemoryReplay.stored, 0);
  assert.equal(store.allEvents().length, 1);
  daemon.stop();
});

test('Core bounds each replay batch and warns while pending work remains', async t => {
  const { store, growth } = fixture(t, 11);
  const daemon = new CoreWorkerDaemon({ worker: worker(growth) });
  const first = await daemon.tick();
  assert.equal(first.success, true);
  assert.equal(first.status, 'degraded');
  assert.equal(daemon.lastMemoryReplay.stored, 10);
  assert.equal(store.pendingMemoryStatus().pendingCount, 1);
  assert.equal((await daemon.tick()).status, 'healthy');
  assert.equal(store.allEvents().length, 11);
});

test('failed pending items stay queued, visible, and recover on the next Core tick', async t => {
  const { store, growth } = fixture(t);
  const save = store.saveEvent.bind(store);
  store.saveEvent = () => { throw new Error('SYNTHETIC_PRIVATE_FAILURE'); };
  const daemon = new CoreWorkerDaemon({ worker: worker(growth) });
  const first = await daemon.tick();
  assert.equal(first.success, true);
  assert.equal(first.status, 'degraded');
  assert.equal(daemon.lastMemoryReplay.failed, 1);
  assert.equal(store.hasEvent('queued-0'), false);
  assert.equal(store.pendingMemoryStatus().pendingCount, 1);
  store.saveEvent = save;
  assert.equal((await daemon.tick()).status, 'healthy');
  assert.equal(store.hasEvent('queued-0'), true);
});

test('replay exceptions do not block Core tasks or leak provider messages', async () => {
  let drained = 0;
  const w = worker({ drainPendingMemory() { throw new Error('PRIVATE_TOKEN_EXAMPLE'); } });
  w.drain = async () => { drained++; return { processed: 1 }; };
  const daemon = new CoreWorkerDaemon({ worker: w });
  const result = await daemon.tick();
  assert.equal(drained, 1);
  assert.equal(result.success, true);
  assert.equal(result.status, 'degraded');
  assert.equal(daemon.lastMemoryReplay.success, false);
  assert.equal(daemon.lastMemoryReplay.pendingCount, null);
  assert.equal(JSON.stringify(result).includes('PRIVATE_TOKEN_EXAMPLE'), false);
});

test('overlapping Core ticks skip replay and legacy workers need no memory adapter', async () => {
  let release, calls = 0;
  const daemon = new CoreWorkerDaemon({ worker: worker({
    drainPendingMemory: () => { calls++; return new Promise(resolve => { release = resolve; }); }
  }) });
  const running = daemon.tick();
  assert.equal((await daemon.tick()).status, 'skipped');
  assert.equal(calls, 1);
  release({ success: true, stored: 0, suppressed: 0, failed: 0, pendingCount: 0,
    rawText: 'PRIVATE_OMITTED' });
  assert.equal((await running).status, 'healthy');
  assert.equal(JSON.stringify(daemon.status()).includes('PRIVATE_OMITTED'), false);
  assert.equal((await new CoreWorkerDaemon({ worker: worker(null) }).tick()).status, 'healthy');
});
