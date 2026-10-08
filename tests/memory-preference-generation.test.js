import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrowthRuntime } from '../apps/growth-memory/src/growth-runtime.js';
import { SqliteMemoryStore } from '../apps/growth-memory/src/db/sqlite-store.js';
import { createGrowthMemoryServer } from '../apps/growth-memory/src/main.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-preference-generation-'));
  const store = new SqliteMemoryStore({ dbPath: join(root, 'memory.sqlite'), reviewDir: join(root, 'reviews'), backupDir: join(root, 'backups') });
  const runtime = new GrowthRuntime({ memoryStore: store, auditRoot: root });
  const candidate = { hypothesisId: 'synthetic-candidate', statement: '자료를 표로 정리', confidence: 0.9, evidenceEventIds: [], appliesTo: 'research' };
  const result = runtime.confirmedPreferenceRegistry.decide({ hypothesisId: candidate.hypothesisId, preferenceCandidates: [candidate] });
  assert.equal(result.success, true);
  const backup = store.backup({ backupId: 'baseline' });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { store, runtime, backup, id: result.item.preferenceId, candidate };
}

for (const action of ['update', 'revoke']) test(`restore inside ${action} persistence rejects unchanged revision and keeps cache unpublished`, t => {
  const { store, runtime, backup, id } = fixture(t);
  const registry = runtime.confirmedPreferenceRegistry;
  const save = store.saveConfirmedPreference.bind(store);
  let once = true;
  store.saveConfirmedPreference = (preference, options) => {
    if (once) { once = false; assert.equal(store.restore({ backupPath: backup.filePath }).success, true); }
    return save(preference, options);
  };
  const payload = { expectedRevision: 1, patch: { statement: '거절돼야 하는 문구' } };
  const result = action === 'update' ? runtime.updatePreference(id, payload) : runtime.revokePreference(id, payload);
  assert.equal(result.success, false);
  assert.equal(result.error.code, 'F_MEMORY_GENERATION_CONFLICT');
  assert.equal(store.getConfirmedPreference(id).revision, 1);
  assert.equal(registry.confirmed.get(id).status, 'confirmed');
  assert.equal(registry.confirmed.get(id).statement, '자료를 표로 정리');
  const retry = action === 'update' ? runtime.updatePreference(id, payload) : runtime.revokePreference(id, payload);
  assert.equal(retry.success, true);
  assert.equal(retry.item.revision, 2);
});

test('retained pre-restore registry rejects duplicate confirmation and changes', t => {
  const { store, runtime, backup, candidate, id } = fixture(t);
  const old = runtime.confirmedPreferenceRegistry;
  assert.equal(store.restore({ backupPath: backup.filePath }).success, true);
  assert.equal(old.decide({ hypothesisId: candidate.hypothesisId, preferenceCandidates: [candidate] }).error.code, 'F_MEMORY_GENERATION_CONFLICT');
  assert.equal(old.update({ preferenceId: id, patch: {} }).error.code, 'F_MEMORY_GENERATION_CONFLICT');
  assert.equal(old.revoke({ preferenceId: id }).error.code, 'F_MEMORY_GENERATION_CONFLICT');
  assert.equal(runtime.updatePreference(id, { expectedRevision: 1, patch: { statement: '새 세대 수정' } }).success, true);
});

test('failure review commits before publishing cache and rejects restore race', t => {
  const { store, runtime, backup } = fixture(t);
  const old = runtime.failureBuilder;
  const save = store.saveFailureGuardrailReview.bind(store);
  let once = true;
  store.saveFailureGuardrailReview = (review, options) => {
    if (once) { once = false; store.restore({ backupPath: backup.filePath }); }
    return save(review, options);
  };
  assert.equal(runtime.reviewFailureGuardrail('synthetic-failure', { decision: 'disable' }).error.code, 'F_MEMORY_GENERATION_CONFLICT');
  assert.equal(old.guardrailReviews.size, 0);
  assert.equal(store.allFailureGuardrailReviews().length, 0);
  assert.equal(runtime.reviewFailureGuardrail('synthetic-failure', { decision: 'keep' }).success, true);
  assert.equal(store.allFailureGuardrailReviews().length, 1);
  store.saveFailureGuardrailReview = () => { throw new Error('synthetic write failure'); };
  assert.throws(() => runtime.reviewFailureGuardrail('unwritten-failure'), /synthetic write failure/u);
  assert.equal(runtime.failureBuilder.guardrailReviews.has('unwritten-failure'), false);
});

test('real F HTTP returns generation conflict as409 and fresh correction succeeds', async t => {
  const { store, runtime, backup, id } = fixture(t);
  const save = store.saveConfirmedPreference.bind(store);
  let once = true;
  store.saveConfirmedPreference = (item, options) => {
    if (once) { once = false; store.restore({ backupPath: backup.filePath }); }
    return save(item, options);
  };
  const server = createGrowthMemoryServer(runtime);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const call = () => fetch(`http://127.0.0.1:${server.address().port}/preferences/confirmed/${id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 1, patch: { statement: 'HTTP 수정' } })
  });
  const conflict = await call();
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, 'F_MEMORY_GENERATION_CONFLICT');
  assert.equal(store.getConfirmedPreference(id).revision, 1);
  const valid = await call(); assert.equal(valid.status, 200); assert.equal((await valid.json()).item.revision, 2);
});
