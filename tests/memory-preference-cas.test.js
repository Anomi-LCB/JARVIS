import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfirmedPreferenceRegistry } from '../apps/growth-memory/src/growth-runtime.js';
import { SqliteMemoryStore } from '../apps/growth-memory/src/db/sqlite-store.js';
import { createGrowthMemoryServer, createGrowthMemoryOpenApiSpec } from '../apps/growth-memory/src/main.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-memory-cas-')), stores = [];
  const open = () => { const store = new SqliteMemoryStore({ dbPath: join(root, 'memory.sqlite'), reviewDir: join(root, 'reviews'), backupDir: join(root, 'backups') }); stores.push(store); return { store, registry: new ConfirmedPreferenceRegistry({ store }) }; };
  const a = open(), b = open();
  const seed = a.registry.decide({ hypothesisId: 'synthetic-candidate', preferenceCandidates: [{ hypothesisId: 'synthetic-candidate', statement: '자료를 표로 정리', confidence: 0.9, evidenceEventIds: ['synthetic-source'], appliesTo: 'synthetic-research' }] });
  assert.equal(seed.success, true);
  t.after(() => { stores.forEach(store => store.close()); rmSync(root, { recursive: true, force: true }); });
  return { a, b, id: seed.item.preferenceId, root };
}

test('two SQLite connections reject stale correction/revocation and recall the durable new version', t => {
  const { a, b, id } = fixture(t);
  assert.equal(a.registry.update({ preferenceId: id, expectedRevision: 1, patch: { statement: '수정된 자료 형식' } }).success, true);
  assert.deepEqual(b.registry.update({ preferenceId: id, expectedRevision: 1, patch: { statement: '오래된 화면 수정' } }), { success: false, error: { code: 'F_MEMORY_REVISION_CONFLICT', currentRevision: 2 } });
  assert.equal(b.registry.all()[0].statement, '수정된 자료 형식');
  assert.equal(b.registry.revoke({ preferenceId: id, expectedRevision: 1 }).error.code, 'F_MEMORY_REVISION_CONFLICT');
  assert.equal(b.registry.revoke({ preferenceId: id, expectedRevision: 2 }).item.revision, 3);
  assert.equal(a.registry.all().length, 0);
  assert.equal(a.registry.all({ includeInactive: true })[0].status, 'revoked');
});

test('durable CAS rejects a competing commit between snapshot and write without publishing failed cache data', t => {
  const { a, b, id } = fixture(t);
  const save = a.store.saveConfirmedPreference.bind(a.store);
  a.store.saveConfirmedPreference = (next, options) => {
    assert.equal(b.registry.update({ preferenceId: id, expectedRevision: 1, patch: { statement: '경합 승자의 값' } }).success, true);
    return save(next, options);
  };
  const failed = a.registry.update({ preferenceId: id, expectedRevision: 1, patch: { statement: '거부돼야 하는 값' } });
  assert.equal(failed.error.code, 'F_MEMORY_REVISION_CONFLICT');
  assert.equal(a.registry.confirmed.get(id).statement, '자료를 표로 정리');
  assert.equal(a.registry.all()[0].statement, '경합 승자의 값');
  assert.equal(b.store.getConfirmedPreference(id).revision, 2);
});

test('SQLite write failure leaves preference cache and persistent version unchanged', t => {
  const { a, id } = fixture(t);
  a.store.saveConfirmedPreference = () => { throw new Error('synthetic-write-failure'); };
  assert.throws(() => a.registry.update({ preferenceId: id, expectedRevision: 1, patch: { statement: '저장 실패 값' } }), /synthetic-write-failure/u);
  assert.equal(a.registry.confirmed.get(id).statement, '자료를 표로 정리');
  assert.equal(a.store.getConfirmedPreference(id).revision, 1);
});

test('actual F HTTP correction/revocation routes distinguish version conflict from valid update', async t => {
  const { a, id } = fixture(t);
  const server = createGrowthMemoryServer({
    updatePreference: (preferenceId, payload) => a.registry.update({ preferenceId, ...payload }),
    revokePreference: (preferenceId, payload) => a.registry.revoke({ preferenceId, ...payload })
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const call = (suffix, payload, method = 'PATCH') => fetch(`http://127.0.0.1:${server.address().port}/preferences/confirmed/${id}${suffix}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const valid = await call('', { expectedRevision: 1, patch: { statement: 'HTTP 새 값' } }); assert.equal(valid.status, 200); assert.equal((await valid.json()).item.revision, 2);
  const stale = await call('', { expectedRevision: 1, patch: { statement: 'HTTP 오래된 값' } }); assert.equal(stale.status, 409); assert.equal((await stale.json()).error.currentRevision, 2);
  const invalid = await call('', { expectedRevision: -1 }); assert.equal(invalid.status, 400);
  for (const expectedRevision of [null, '2', 2.5]) assert.equal((await call('', { expectedRevision })).status, 400);
  const revoked = await call('/revoke', { expectedRevision: 1 }, 'POST'); assert.equal(revoked.status, 409);
  assert.equal(a.store.getConfirmedPreference(id).statement, 'HTTP 새 값');
  const spec = createGrowthMemoryOpenApiSpec();
  assert.equal(spec.paths['/preferences/confirmed/{preferenceId}'].patch.requestBody.content['application/json'].schema.properties.expectedRevision.minimum, 1);
  assert.ok(spec.paths['/preferences/confirmed/{preferenceId}/revoke'].post.responses[409]);
});
