import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrowthRuntime } from '../apps/growth-memory/src/growth-runtime.js';
import { SqliteMemoryStore } from '../apps/growth-memory/src/db/sqlite-store.js';
const settled = () => new Promise(resolve => setImmediate(resolve));
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-async-retraction-'));
  const store = new SqliteMemoryStore({ dbPath: join(root, 'memory.sqlite'), reviewDir: join(root, 'reviews'), backupDir: join(root, 'backups') });
  const runtime = new GrowthRuntime({ memoryStore: store, auditRoot: root });
  runtime.ingest({ eventId: 'source', taskId: 'task', eventType: 'task.created', source: { module: 'CORE', memoryScope: {
    userId: 'synthetic-owner', workspaceRoot: root, conversationId: null
  } }, payload: { rawText: '합성 자료' }, learningFlags: { canBeUsedForWorkflow: true }, trustBoundary: { userProvided: true } });
  store.saveHygieneDecision({ decisionId: 'delete', targetType: 'memory_event', targetId: 'source', action: 'delete', decidedAt: '2026-10-03T00:00:00Z' });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { store, runtime, root };
}

test('pending asynchronous withdrawal is invoked once across overlapping synchronization and acknowledged only after completion', async t => {
  const { runtime } = fixture(t); let calls = 0, resolve;
  const first = runtime.setSourceRetractionHandler(() => { calls++; return new Promise(r => { resolve = r; }); });
  assert.equal(first.deliveries[0].propagated, false);
  for (let i = 0; i < 4; i++) assert.equal(runtime.synchronizeSourceRetractions().deliveries[0].propagated, false);
  assert.equal(calls, 1); assert.equal(runtime.deliveredSourceRetractions.size, 0);
  resolve({ revoked: true }); await settled();
  assert.equal(runtime.deliveredSourceRetractions.size, 1);
  assert.equal(runtime.synchronizeSourceRetractions().deliveries.length, 0);
  assert.equal(calls, 1);
});

test('rejected async withdrawal remains retryable without unhandled rejection or duplicate in-flight attempt', async t => {
  const { runtime } = fixture(t); let calls = 0;
  runtime.setSourceRetractionHandler(() => { calls++; return calls === 1 ? Promise.reject(new Error('PRIVATE_SYNTHETIC_REJECTION')) : Promise.resolve({ revoked: true }); });
  await settled();
  assert.equal(runtime.deliveredSourceRetractions.size, 0);
  runtime.synchronizeSourceRetractions(); await settled();
  assert.equal(calls, 2); assert.equal(runtime.deliveredSourceRetractions.size, 1);
  runtime.synchronizeSourceRetractions(); assert.equal(calls, 2);
});

test('unconfirmed async result does not consume withdrawal and success on next attempt is retained', async t => {
  const { runtime } = fixture(t); let calls = 0;
  runtime.setSourceRetractionHandler(() => Promise.resolve({ revoked: ++calls > 1 }));
  await settled(); assert.equal(runtime.deliveredSourceRetractions.size, 0);
  runtime.synchronizeSourceRetractions(); await settled(); assert.equal(runtime.deliveredSourceRetractions.size, 1);
});

test('completion from replaced handler cannot acknowledge a newer handler pending attempt', async t => {
  const { runtime } = fixture(t); let oldResolve, newResolve;
  runtime.setSourceRetractionHandler(() => new Promise(r => { oldResolve = r; }));
  runtime.setSourceRetractionHandler(() => new Promise(r => { newResolve = r; }));
  oldResolve({ revoked: true }); await settled();
  assert.equal(runtime.deliveredSourceRetractions.size, 0); assert.equal(runtime.inFlightSourceRetractions.size, 1);
  newResolve({ revoked: true }); await settled(); assert.equal(runtime.deliveredSourceRetractions.size, 1);
});

test('runtime restore invalidates old asynchronous acknowledgment and requires delivery in rebuilt context', async t => {
  const { runtime, store } = fixture(t); const backup = store.backup({ backupId: 'baseline' });
  const resolvers = [];
  runtime.setSourceRetractionHandler(() => new Promise(resolve => { resolvers.push(resolve); }));
  assert.equal(runtime.restoreStorage({ backupPath: backup.filePath }).success, true);
  assert.equal(resolvers.length, 2);
  resolvers[0]({ revoked: true }); await settled(); assert.equal(runtime.deliveredSourceRetractions.size, 0);
  resolvers[1]({ revoked: true }); await settled(); assert.equal(runtime.deliveredSourceRetractions.size, 1);
});

test('reentrant handler synchronization does not dispatch the same withdrawal again', t => {
  const { runtime } = fixture(t); let calls = 0;
  runtime.setSourceRetractionHandler(() => { calls++; const nested = runtime.synchronizeSourceRetractions(); assert.equal(nested.deliveries[0].reason, 'source-retraction-projection-pending'); return { revoked: true }; });
  assert.equal(calls, 1); assert.equal(runtime.deliveredSourceRetractions.size, 1);
});

test('external store restore before promise completion cannot acknowledge stale generation', async t => {
  const { runtime, store } = fixture(t);
  const backup = store.backup({ backupId: 'direct-restore' });
  let resolve;
  runtime.setSourceRetractionHandler(() => new Promise(r => { resolve = r; }));
  assert.equal(store.restore({ backupPath: backup.filePath }).success, true);
  resolve({ revoked: true }); await settled();
  assert.equal(runtime.deliveredSourceRetractions.size, 0);
});
