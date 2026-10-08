import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrowthRuntime } from '../apps/growth-memory/src/growth-runtime.js';
import { SqliteMemoryStore } from '../apps/growth-memory/src/db/sqlite-store.js';
import { CoreFacade } from '../packages/core/src/core-facade.js';
import { createCoreServer } from '../packages/core/src/main.mjs';
import { createPreferenceManagementPanel } from '../src/ui/preference-management.js';

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-observed-generation-'));
  const store = new SqliteMemoryStore({ dbPath: join(root, 'memory.sqlite'), reviewDir: join(root, 'reviews'), backupDir: join(root, 'backups') });
  const growth = new GrowthRuntime({ memoryStore: store, auditRoot: root });
  const seed = growth.confirmedPreferenceRegistry.decide({ hypothesisId: 'synthetic-candidate', preferenceCandidates: [{ hypothesisId: 'synthetic-candidate', statement: '백업 당시 문구', confidence: 0.9, evidenceEventIds: [], appliesTo: 'research' }] });
  const id = seed.item.preferenceId;
  const backup = store.backup({ backupId: 'baseline' });
  store.saveConfirmedPreference({ ...seed.item, statement: '조회 당시 문구' });
  const server = createCoreServer(new CoreFacade({ memoryStore: growth, workspaceRoot: root }), { adminToken: 'synthetic-admin' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(root, { recursive: true, force: true }); });
  const call = (suffix = '', method = 'GET', body) => fetch(`http://127.0.0.1:${server.address().port}/memory/preferences${suffix}`, {
    method, headers: { authorization: 'Bearer synthetic-admin', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {})
  });
  return { store, growth, backup, id, call };
}

for (const action of ['update', 'revoke']) test(`Core rejects pre-request restore with same revision for ${action} and fresh observation succeeds`, async t => {
  const f = await fixture(t);
  const observed = await (await f.call()).json();
  assert.equal(observed.items[0].revision, 1);
  assert.equal(observed.items[0].statement, '조회 당시 문구');
  assert.equal(observed.memoryGeneration, 0);
  assert.equal(f.store.restore({ backupPath: f.backup.filePath }).success, true);
  const body = { expectedRevision: 1, expectedGeneration: observed.memoryGeneration,
    ...(action === 'update' ? { statement: '오래된 화면의 문구' } : {}) };
  const suffix = `/${f.id}${action === 'revoke' ? '/revoke' : ''}`;
  const method = action === 'update' ? 'PATCH' : 'POST';
  const failed = await f.call(suffix, method, body);
  assert.equal(failed.status, 409);
  assert.equal((await failed.json()).error.code, 'F_MEMORY_GENERATION_CONFLICT');
  assert.equal(f.store.getConfirmedPreference(f.id).revision, 1);
  assert.equal(f.store.getConfirmedPreference(f.id).statement, '백업 당시 문구');
  const fresh = await (await f.call()).json();
  assert.equal(fresh.memoryGeneration, 1);
  assert.equal((await f.call(suffix, method, { ...body, expectedGeneration: fresh.memoryGeneration })).status, 200);
});

test('Core requires a valid observed generation instead of silently using current state', async t => {
  const f = await fixture(t);
  for (const value of [undefined, null, -1, '0', 0.5]) {
    const body = { expectedRevision: 1, statement: '미저장', ...(value === undefined ? {} : { expectedGeneration: value }) };
    assert.equal((await f.call(`/${f.id}`, 'PATCH', body)).status, 400);
  }
  assert.equal(f.store.getConfirmedPreference(f.id).revision, 1);
});

test('list does not attach a new generation to values gathered before restore', async t => {
  const f = await fixture(t);
  const all = f.growth.confirmedPreferenceRegistry.all.bind(f.growth.confirmedPreferenceRegistry);
  f.growth.confirmedPreferenceRegistry.all = options => {
    const items = all(options);
    f.store.restore({ backupPath: f.backup.filePath });
    return items;
  };
  const response = await f.call();
  assert.equal(response.status, 409);
  const result = await response.json();
  assert.equal(result.items, undefined);
  assert.equal(result.error.code, 'F_MEMORY_GENERATION_CONFLICT');
});

test('panel retains observed generation across refresh and never auto-resubmits a conflicting draft', async () => {
  let generation = 0, submitted = [];
  const panel = createPreferenceManagementPanel({ canManage: () => true, request: async (path, options) => {
    if (!options) return { memoryGeneration: generation, items: [{ preferenceId: 'p', revision: 1, status: 'confirmed', statement: '자료 형식' }] };
    submitted.push(options.body);
    throw { code: 'F_MEMORY_GENERATION_CONFLICT' };
  } });
  await panel.refresh(); panel.edit('p'); generation = 1;
  await panel.mutate('p', 'save');
  assert.equal(submitted[0].expectedGeneration, 0);
  assert.match(panel.render(), /기억이 복구되어 저장하지 않았습니다/);
  await panel.mutate('p', 'save'); assert.equal(submitted.length, 1);
  const invalid = createPreferenceManagementPanel({ canManage: () => true, request: async () => ({ items: [{ preferenceId: 'p', revision: 1, status: 'confirmed' }] }) });
  await invalid.refresh(); invalid.edit('p'); await invalid.mutate('p', 'save');
  assert.match(invalid.render(), /기억을 불러오지 못했습니다/);
});
