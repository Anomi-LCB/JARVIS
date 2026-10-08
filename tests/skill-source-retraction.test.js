import test from 'node:test';
import assert from 'node:assert/strict';
import { SkillDraftRegistry, GrowthRuntime } from '../apps/growth-memory/src/growth-runtime.js';
import { createGrowthMemoryServer } from '../apps/growth-memory/src/main.mjs';
import { SqliteMemoryStore } from '../apps/growth-memory/src/db/sqlite-store.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const marker = 'SYNTHETIC_RETRACTED_PROCEDURE_9281';
function approved(registry) {
  const draft = { distilledSkillId: 'draft-1', title: marker, evidenceEventIds: ['event-1'],
    suggestedSteps: [`${marker} 자료를 확인한다.`], safetyConstraints: ['requires_user_review', 'requires_policy_check'], styleHints: [], confidence: 0.8 };
  const result = registry.review({ draftId: draft.distilledSkillId, drafts: [draft], reason: marker });
  assert.equal(result.success, true);
  return { draft, entry: result.registryEntry };
}
test('retracted procedure omits all historical content and blocks every revision action and stale draft review', () => {
  let allowed = true;
  const registry = new SkillDraftRegistry({ recallAllowed: () => allowed });
  const { draft, entry } = approved(registry);
  const created = registry.createRevision({ skillId: entry.skillId, expectedActiveRevisionId: entry.activeRevisionId, suggestedSteps: [`${marker} 새 자료 확인`] });
  assert.equal(created.success, true);
  registry.evaluateRevision({ skillId: entry.skillId, revisionId: created.revision.revisionId });
  registry.reviewRevision({ skillId: entry.skillId, revisionId: created.revision.revisionId, decision: 'approve' });
  registry.promoteRevision({ skillId: entry.skillId, revisionId: created.revision.revisionId, expectedActiveRevisionId: entry.activeRevisionId });
  registry.recordUsefulness({ skillId: entry.skillId, reason: marker });
  const snapshot = registry.snapshot();
  allowed = false;
  for (const method of ['createRevision', 'evaluateRevision', 'reviewRevision', 'promoteRevision', 'rollbackRevision', 'recordUsefulness']) {
    const result = registry[method]({ skillId: entry.skillId });
    assert.equal(result.error.code, 'F_SKILL_SOURCE_RETRACTED', method);
    assert.equal(JSON.stringify(result).includes(marker), false);
  }
  assert.equal(registry.review({ draftId: draft.distilledSkillId, drafts: [draft] }).error.code, 'F_SKILL_SOURCE_RETRACTED');
  const status = registry.status([draft]);
  assert.equal(JSON.stringify(status).includes(marker), false);
  assert.equal(status.registryEntries[0].contentWithheld, true);
  assert.equal(JSON.stringify(registry.snapshot()).includes(marker), true, 'private retained snapshot is not physical erasure');
  const restored = new SkillDraftRegistry({ restoredState: snapshot, recallAllowed: () => false });
  assert.equal(JSON.stringify(restored.status([draft])).includes(marker), false);
  assert.equal(restored.rollbackRevision({ skillId: entry.skillId }).error.code, 'F_SKILL_SOURCE_RETRACTED');
});
test('durable deletion fences a pre-opened runtime and restart before lifecycle synchronization', async t => {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-skill-retraction-')), stores = [];
  const open = () => { const store = new SqliteMemoryStore({ dbPath: join(root, 'memory.sqlite'), reviewDir: join(root, 'reviews'), backupDir: join(root, 'backups') }); stores.push(store); return new GrowthRuntime({ memoryStore: store, auditRoot: root }); };
  t.after(() => { stores.forEach(s => s.close()); rmSync(root, { recursive: true, force: true }); });
  const owner = open();
  owner.ingestor.ingest({ eventId: 'event-1', taskId: 'task-1', eventType: 'task.created', source: { module: 'CORE' }, payload: { rawText: '연구 자료 확인' }, learningFlags: { canBeUsedForWorkflow: true }, trustBoundary: { userProvided: true } });
  const { entry } = approved(owner.skillDraftRegistry);
  owner.persistSkillRegistrySnapshot({ action: 'synthetic-fixture', skillId: entry.skillId });
  const observer = open();
  assert.equal(JSON.stringify(observer.skillDraftRegistry.status()).includes(marker), true);
  assert.equal(owner.decideHygiene({ targetId: 'event-1', action: 'delete' }).success, true);
  assert.equal(JSON.stringify(observer.skillDraftRegistry.status()).includes(marker), false);
  assert.equal(observer.skillDraftRegistry.createRevision({ skillId: entry.skillId }).error.code, 'F_SKILL_SOURCE_RETRACTED');
  assert.equal(JSON.stringify(open().skillRegistryStatus()).includes(marker), false);
  assert.deepEqual(observer.missionSkillGuidance('연구 자료 확인'), []);
  const server = createGrowthMemoryServer(observer);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/advanced-learning/skill-registry/${entry.skillId}/revisions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedActiveRevisionId: entry.activeRevisionId, suggestedSteps: ['다시 사용한다.'] }) });
  const result = await response.json();
  assert.equal(result.success, false); assert.equal(result.error.code, 'F_SKILL_SOURCE_RETRACTED');
  assert.equal(JSON.stringify(result).includes(marker), false);

});
