import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrowthRuntime } from '../apps/growth-memory/src/growth-runtime.js';
import { SqliteMemoryStore } from '../apps/growth-memory/src/db/sqlite-store.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-derived-generation-'));
  const store = new SqliteMemoryStore({ dbPath: join(root, 'memory.sqlite'),
    reviewDir: join(root, 'reviews'), backupDir: join(root, 'backups') });
  const runtime = new GrowthRuntime({ memoryStore: store, auditRoot: root });
  const backup = store.backup({ backupId: 'empty' });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, store, runtime, backup };
}

test('stale derived writes cannot repopulate restored rows or create a report file', t => {
  const { root, store, backup } = fixture(t);
  const generation = store.restoreGeneration();
  assert.equal(store.restore({ backupPath: backup.filePath }).success, true);
  const options = { expectedGeneration: generation };
  assert.throws(() => store.saveReview({ reviewId: 'stale', generatedAt: '2026-10-03T00:00:00Z', period: 'daily' }, options),
    { code: 'F_MEMORY_GENERATION_CONFLICT' });
  assert.equal(existsSync(join(root, 'reviews', 'stale.json')), false);
  assert.equal(store.latestReview(), null);
  assert.throws(() => store.saveTrendSnapshot({ trendType: 'genome', snapshotId: 'stale', snapshot: { value: 'old' } }, options),
    { code: 'F_MEMORY_GENERATION_CONFLICT' });
  assert.equal(store.allTrendSnapshots().length, 0);
});

test('runtime report raced at SQL write withholds content and refreshes on next request', t => {
  const { store, runtime, backup } = fixture(t);
  const save = store.saveReview.bind(store);
  let once = true;
  store.saveReview = (review, options) => {
    if (once) { once = false; assert.equal(store.restore({ backupPath: backup.filePath }).success, true); }
    return save(review, options);
  };
  const result = runtime.latestReview();
  assert.equal(result.success, false);
  assert.equal(result.contentWithheld, true);
  assert.equal(result.error.code, 'F_MEMORY_GENERATION_CONFLICT');
  assert.equal(store.latestReview(), null);
  assert.equal(runtime.latestReview().contentWithheld, undefined);
  assert.ok(store.latestReview());
  assert.equal(runtime.memoryGeneration, store.restoreGeneration());
});

test('runtime trend raced immediately before persistence prevents stale snapshot and report', t => {
  const { store, runtime, backup } = fixture(t);
  const save = store.saveTrendSnapshot.bind(store);
  let once = true;
  store.saveTrendSnapshot = (snapshot, options) => {
    if (once) { once = false; assert.equal(store.restore({ backupPath: backup.filePath }).success, true); }
    return save(snapshot, options);
  };
  assert.equal(runtime.latestReview().error.code, 'F_MEMORY_GENERATION_CONFLICT');
  assert.equal(store.allTrendSnapshots().length, 0);
  assert.equal(store.latestReview(), null);
  assert.equal(runtime.latestReview().contentWithheld, undefined);
  assert.ok(store.allTrendSnapshots().length > 0);
});

test('current-generation derived writes persist and invalid generation is rejected', t => {
  const { store } = fixture(t);
  const options = { expectedGeneration: store.restoreGeneration() };
  const review = store.saveReview({ reviewId: 'current', generatedAt: '2026-10-03T00:00:00Z', period: 'daily' }, options);
  assert.ok(existsSync(review.filePath));
  assert.equal(store.latestReview().reviewId, 'current');
  assert.equal(store.saveTrendSnapshot({ trendType: 'genome', snapshotId: 'current', snapshot: { value: 'new' } }, options).success, true);
  assert.throws(() => store.saveReview({ reviewId: 'bad' }, { expectedGeneration: -1 }), { code: 'F_MEMORY_GENERATION_INVALID' });
  assert.equal(store.allTrendSnapshots().length, 1);
});
