import test from 'node:test';
import { listenOnFetchSafePort } from '../packages/shared/src/http.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrowthRuntime } from '../apps/growth-memory/src/growth-runtime.js';
import { SqliteMemoryStore } from '../apps/growth-memory/src/db/sqlite-store.js';
import { createGrowthMemoryServer } from '../apps/growth-memory/src/main.mjs';

const marker = '합성삭제고유내용_741';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-retraction-fence-')), stores = [];
  const scope = { userId: 'synthetic-owner', workspaceRoot: root, conversationId: 'synthetic-session' };
  const open = () => { const store = new SqliteMemoryStore({ dbPath: join(root, 'memory.sqlite'), reviewDir: join(root, 'reviews'), backupDir: join(root, 'backups') }); stores.push(store); return { store, runtime: new GrowthRuntime({ memoryStore: store, auditRoot: root }) }; };
  const f = open();
  t.after(() => { stores.forEach(store => store.close()); rmSync(root, { recursive: true, force: true }); });
  for (let i = 1; i <= 3; i++) f.runtime.ingestor.ingest({ eventId: `synthetic-event-${i}`, taskId: `synthetic-task-${i}`, eventType: 'approval.edited', source: { module: 'CORE', memoryScope: scope }, payload: { editRequest: '회의자료를 표로 정리해줘' }, learningFlags: { canBeUsedForPreference: true, canBeUsedForWorkflow: true }, trustBoundary: { userProvided: true, externalContent: false, systemGenerated: false } });
  const candidate = f.runtime.query('회의자료', { scope }).find(item => item.hypothesisId && !item.preferenceId);
  const confirmed = f.runtime.decidePreference({ hypothesisId: candidate.hypothesisId }); assert.equal(confirmed.success, true);
  const corrected = f.runtime.updatePreference(confirmed.item.preferenceId, { expectedRevision: 1, patch: { statement: `회의자료 ${marker}` }, reason: `합성 정정 이유 ${marker}` }); assert.equal(corrected.success, true);
  return { ...f, open, id: confirmed.item.preferenceId, scope };
}

test('deleted source cannot be reactivated and inactive history/revoke responses omit derived content', t => {
  const f = fixture(t);
  assert.ok(JSON.stringify(f.runtime.latestReview()).includes(marker));
  assert.equal(f.runtime.decideHygiene({ targetId: 'synthetic-event-1', action: 'delete' }).success, true);
  const registry = f.runtime.confirmedPreferenceRegistry;
  const projected = registry.all({ includeInactive: true }).find(item => item.preferenceId === f.id);
  assert.equal(projected.contentWithheld, true); assert.equal(JSON.stringify(projected).includes(marker), false);
  assert.ok(projected.history.some(item => item.by === 'source-retraction'));
  const staleRestore = f.runtime.updatePreference(f.id, { expectedRevision: projected.revision, patch: { status: 'confirmed' } });
  assert.equal(staleRestore.error.code, 'F_MEMORY_SOURCE_RETRACTED');
  const revoked = f.runtime.revokePreference(f.id, { expectedRevision: projected.revision });
  assert.equal(revoked.success, true); assert.equal(JSON.stringify(revoked).includes(marker), false);
  assert.equal(registry.all().length, 0);
  assert.equal(f.runtime.query(marker, { scope: f.scope }).length, 0);
  assert.equal(JSON.stringify(f.runtime.latestReview()).includes(marker), false);
  assert.ok(JSON.stringify(f.store.getConfirmedPreference(f.id)).includes(marker));
  const reopened = f.open();
  assert.equal(reopened.runtime.confirmedPreferenceRegistry.all().length, 0);
  assert.equal(JSON.stringify(reopened.runtime.confirmedPreferenceRegistry.all({ includeInactive: true })).includes(marker), false);
});

test('durable source decision fences recall even when derived lifecycle persistence conflicts', t => {
  const f = fixture(t), save = f.store.saveConfirmedPreference.bind(f.store);
  const observer = f.open();
  assert.equal(observer.runtime.confirmedPreferenceRegistry.all().length, 1);
  f.store.saveConfirmedPreference = () => { throw Object.assign(new Error('synthetic-conflict'), { code: 'F_MEMORY_REVISION_CONFLICT', currentRevision: 2 }); };
  const deleted = f.runtime.decideHygiene({ targetId: 'synthetic-event-1', action: 'delete' }); assert.equal(deleted.success, true);
  assert.equal(f.store.getConfirmedPreference(f.id).status, 'confirmed');
  assert.equal(f.runtime.confirmedPreferenceRegistry.all().length, 0);
  assert.equal(JSON.stringify(f.runtime.confirmedPreferenceRegistry.all({ includeInactive: true })).includes(marker), false);
  assert.equal(observer.runtime.confirmedPreferenceRegistry.all().length, 0);
  observer.runtime.query('회의자료', { scope: f.scope });
  assert.equal(observer.runtime.ingestor.events.get('synthetic-event-1').learningFlags.doNotRemember, true);
  f.store.saveConfirmedPreference = save;
  const reopened = f.open();
  assert.equal(reopened.runtime.confirmedPreferenceRegistry.all().length, 0);
  reopened.runtime.synchronizeSourceRetractions();
  assert.equal(reopened.store.getConfirmedPreference(f.id).status, 'source_review_required');
});

test('actual F HTTP cannot restore a retracted preference or reveal it in active listings', async t => {
  const f = fixture(t); f.runtime.decideHygiene({ targetId: 'synthetic-event-1', action: 'delete' });
  const server = createGrowthMemoryServer(f.runtime);
  await listenOnFetchSafePort(server,{host:'127.0.0.1',port:0});
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const revision = f.store.getConfirmedPreference(f.id).revision;
  const response = await fetch(`${base}/preferences/confirmed/${f.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: revision, patch: { status: 'confirmed' } }) });
  assert.equal(response.status, 409); assert.equal((await response.json()).error.code, 'F_MEMORY_SOURCE_RETRACTED');
  const listed = await (await fetch(`${base}/preferences/confirmed`)).json(); assert.deepEqual(listed.items, []);
  assert.equal(JSON.stringify(listed).includes(marker), false);
});
