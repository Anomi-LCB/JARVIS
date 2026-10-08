import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { GrowthRuntime } from '../apps/growth-memory/src/growth-runtime.js';
import { SqliteMemoryStore } from '../apps/growth-memory/src/db/sqlite-store.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/agent-platform-m04-preference-revision.json', import.meta.url), 'utf8'));

test('M04 preference correction survives SQLite reopen and only the corrected scoped revision is recalled', t => {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-m04-preference-'));
  const stores = [];
  t.after(() => {
    for (const store of stores) { try { store.close(); } catch {} }
    assert.ok(resolve(root).startsWith(resolve(tmpdir())));
    rmSync(root, { recursive: true, force: true });
  });
  const open = () => {
    const store = new SqliteMemoryStore({ dbPath: join(root, 'growth.sqlite'), reviewDir: join(root, 'reviews'), backupDir: join(root, 'backups') });
    stores.push(store);
    return new GrowthRuntime({ memoryStore: store, auditRoot: root });
  };
  let runtime = open();
  const scope = { userId: 'synthetic-owner', workspaceRoot: root, conversationId: 'synthetic-conversation' };
  for (let index = 1; index <= 3; index += 1) {
    const stored = runtime.ingestor.ingest({ eventId: `m04-source-${index}`, taskId: `m04-task-${index}`,
      eventType: 'approval.edited', source: { module: 'CORE', memoryScope: scope },
      payload: { editRequest: fixture.sourceStatement },
      learningFlags: { canBeUsedForPreference: true, canBeUsedForWorkflow: true },
      trustBoundary: { userProvided: true, externalContent: false, systemGenerated: false } });
    assert.equal(stored.stored, true);
  }
  const candidate = runtime.query('회의', { scope }).find(item => item.hypothesisId && !item.preferenceId);
  assert.ok(candidate);
  const confirmed = runtime.decidePreference({ hypothesisId: candidate.hypothesisId, decision: 'confirm',
    decidedBy: 'synthetic-owner', reason: 'initial preference' });
  assert.equal(confirmed.success, true);
  assert.equal(confirmed.item.statement, fixture.originalStatement);
  const updated = runtime.updatePreference(confirmed.item.preferenceId, { patch: { statement: fixture.updatedStatement },
    decidedBy: 'synthetic-owner', reason: fixture.updateReason });
  assert.equal(updated.success, true);
  assert.equal(updated.item.revision, 2);
  const before = confirmed.item.revision;
  stores[0].close();

  runtime = open();
  const restored = runtime.confirmedPreferenceRegistry.all().find(item => item.preferenceId === confirmed.item.preferenceId);
  const recalledHints = runtime.planningPreferenceContext('회의', { scope }).confirmedPreferenceHints.map(item => item.statement);
  const unrelatedHints = runtime.planningPreferenceContext('회의', { scope: { ...scope, userId: 'other-owner' } }).confirmedPreferenceHints;
  const otherConversationHints = runtime.planningPreferenceContext('회의', { scope: { ...scope, conversationId: 'other-conversation' } }).confirmedPreferenceHints;
  assert.equal(restored.revision, 2);
  assert.equal(restored.statement, fixture.updatedStatement);
  assert.equal(recalledHints.includes(fixture.originalStatement), false);
  assert.deepEqual(recalledHints, [fixture.updatedStatement]);
  assert.deepEqual(unrelatedHints, []);
  assert.deepEqual(otherConversationHints, []);
  assert.ok(restored.history.some(item => item.action === 'update' && item.by === 'synthetic-owner'
    && item.reason === fixture.updateReason && item.patch?.statement === fixture.updatedStatement));

  const evidence = { schemaVersion: 1, scenarioId: 'M04', fixtureId: fixture.fixtureId,
    expected: { originalStatement: fixture.originalStatement, updatedStatement: fixture.updatedStatement },
    revisions: { before, after: restored.revision },
    activePreference: { preferenceId: restored.preferenceId, statement: restored.statement, status: restored.status, revision: restored.revision },
    recalledHints, unrelatedHints: unrelatedHints.map(item => item.statement),
    otherConversationHints: otherConversationHints.map(item => item.statement), history: restored.history,
    authority: { executionAuthority: false }, metrics: { externalWrites: 0, providerCalls: 0, networkRequests: 0 } };
  const evidencePath = process.env.JARVIS_M04_EVIDENCE_PATH;
  if (evidencePath) writeFileSync(resolve(evidencePath), `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
});
