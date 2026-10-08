import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrowthRuntime } from '../apps/growth-memory/src/growth-runtime.js';
import { SqliteMemoryStore } from '../apps/growth-memory/src/db/sqlite-store.js';

const marker = 'PRIVATE_SYNTHETIC_REVIEW_SOURCE_853';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-review-source-race-'));
  const options = { dbPath: join(root, 'memory.sqlite'), reviewDir: join(root, 'reviews'), backupDir: join(root, 'backups') };
  const store = new SqliteMemoryStore(options);
  const runtime = new GrowthRuntime({ memoryStore: store, auditRoot: root });
  const scope = { userId: 'synthetic-owner', workspaceRoot: root, conversationId: null };
  for (let i = 0; i < 3; i++) runtime.ingest({ eventId: `event-${i}`, taskId: `task-${i}`, eventType: 'approval.edited',
    source: { module: 'CORE', memoryScope: scope }, payload: { editRequest: '회의자료를 표로 정리해줘' },
    learningFlags: { canBeUsedForPreference: true }, trustBoundary: { userProvided: true } });
  const candidate = runtime.query('회의자료', { scope }).find(item => item.hypothesisId);
  const confirmation = runtime.decidePreference({ hypothesisId: candidate.hypothesisId });
  assert.equal(confirmation.success, true);
  assert.equal(runtime.updatePreference(confirmation.item.preferenceId, { expectedRevision: 1, patch: { statement: marker } }).success, true);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, options, store, runtime };
}
const deletion = { decisionId: 'source-withdrawal', targetType: 'memory_event', targetId: 'event-0', action: 'delete', decidedAt: '2026-10-03T00:00:00Z' };

test('same-generation withdrawal before report SQL write withholds stale content and next request rebuilds', t => {
  const { store, runtime, root } = fixture(t);
  const save = store.saveReview.bind(store);
  let once = true, rejectedPath;
  store.saveReview = (review, options) => {
    if (once) {
      once = false;
      assert.equal(JSON.stringify(review).includes(marker), true);
      rejectedPath = join(root, 'reviews', `${review.reviewId}.json`);
      store.saveHygieneDecision(deletion);
    }
    return save(review, options);
  };
  const result = runtime.latestReview();
  assert.equal(result.success, false);
  assert.equal(result.error.code, 'F_MEMORY_SOURCE_CHANGED');
  assert.equal(result.contentWithheld, true);
  assert.equal(JSON.stringify(result).includes(marker), false);
  assert.equal(existsSync(rejectedPath), false);
  assert.equal(store.latestReview(), null);
  assert.equal(store.restoreGeneration(), 0);
  const rebuilt = runtime.latestReview();
  assert.equal(rebuilt.contentWithheld, undefined);
  assert.equal(JSON.stringify(rebuilt).includes(marker), false);
  assert.equal(JSON.stringify(store.latestReview()).includes(marker), false);
});

test('independent SQLite writer changes source digest without generation change and stale direct save is rejected', t => {
  const { store, options, root } = fixture(t);
  const digest = store.sourceRetractionDigest();
  const peer = new SqliteMemoryStore(options);
  try { peer.saveHygieneDecision(deletion); } finally { peer.close(); }
  assert.throws(() => store.saveReview({ reviewId: 'stale-direct', generatedAt: '2026-10-03T00:00:00Z', period: 'daily', text: marker },
    { expectedGeneration: 0, expectedSourceRetractionDigest: digest }), { code: 'F_MEMORY_SOURCE_CHANGED' });
  assert.equal(existsSync(join(root, 'reviews', 'stale-direct.json')), false);
  assert.equal(store.latestReview(), null);
});

test('unchanged source digest permits a current report and records the exact checked digest', t => {
  const { store } = fixture(t);
  const digest = store.sourceRetractionDigest();
  const report = store.saveReview({ reviewId: 'current', generatedAt: '2026-10-03T00:00:00Z', period: 'daily' },
    { expectedGeneration: 0, expectedSourceRetractionDigest: digest });
  assert.equal(report.sourceRetractionDigest, digest);
  assert.equal(store.latestReview().sourceRetractionDigest, digest);
  assert.equal(existsSync(report.filePath), true);
});
