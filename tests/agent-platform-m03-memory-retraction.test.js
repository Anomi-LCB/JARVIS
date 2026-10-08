import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { GrowthRuntime } from '../apps/growth-memory/src/growth-runtime.js';
import { SqliteMemoryStore } from '../apps/growth-memory/src/db/sqlite-store.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/agent-platform-m03-memory-retraction.json', import.meta.url), 'utf8'));

test('M03 deleted source retracts derived personal guidance after SQLite reopen', t => {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-m03-memory-'));
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
    const stored = runtime.ingestor.ingest({ eventId: `m03-source-${index}`, taskId: `m03-task-${index}`,
      eventType: 'approval.edited', source: { module: 'CORE', memoryScope: scope },
      payload: { editRequest: fixture.sourceStatement },
      learningFlags: { canBeUsedForPreference: true, canBeUsedForWorkflow: true },
      trustBoundary: { userProvided: true, externalContent: false, systemGenerated: false } });
    assert.equal(stored.stored, true);
  }
  const candidate = runtime.query(fixture.query, { scope }).find(item => item.hypothesisId && !item.preferenceId);
  assert.ok(candidate);
  const confirmed = runtime.decidePreference({ hypothesisId: candidate.hypothesisId, decision: 'confirm',
    decidedBy: 'synthetic-owner', reason: fixture.decisionReason });
  assert.equal(confirmed.success, true);
  assert.ok(runtime.planningPreferenceContext(fixture.query, { scope }).confirmedPreferenceHints.some(item => item.preferenceId === confirmed.item.preferenceId));

  const deletion = runtime.decideHygiene({ targetType: 'memory_event', targetId: fixture.deleteEventId, action: 'delete', decidedBy: 'synthetic-owner' });
  assert.equal(deletion.success, true);
  assert.equal(runtime.planningPreferenceContext(fixture.query, { scope }).confirmedPreferenceHints.length, 0);
  stores[0].close();

  runtime = open();
  const hintsAfterReopen = runtime.planningPreferenceContext(fixture.query, { scope }).confirmedPreferenceHints;
  const historical = runtime.confirmedPreferenceRegistry.all({ includeInactive: true }).find(item => item.preferenceId === confirmed.item.preferenceId);
  const event = runtime.ingestor.events.get(fixture.deleteEventId);
  assert.equal(hintsAfterReopen.length, 0);
  assert.equal(historical.status, 'source_review_required');
  assert.ok(historical.history.some(item => item.by === 'source-retraction'));
  assert.equal(event.learningFlags.doNotRemember, true);
  const unrelatedHints = runtime.planningPreferenceContext(fixture.query,
    { scope: { ...scope, userId: 'other-owner' } }).confirmedPreferenceHints;

  const evidence = { schemaVersion: 1, scenarioId: 'M03', fixtureId: fixture.fixtureId,
    expected: { deletedPreferenceId: confirmed.item.preferenceId, decisionReason: fixture.decisionReason, query: fixture.query },
    beforeDeleteHintIds: [confirmed.item.preferenceId], afterDeleteHintIds: [], afterReopenHintIds: hintsAfterReopen.map(item => item.preferenceId),
    derivedMemory: { status: historical.status, reasonPreserved: historical.reason === fixture.decisionReason,
      sourceRetractionRecorded: historical.history.some(item => item.by === 'source-retraction'),
      doNotRemember: event.learningFlags.doNotRemember },
    unrelatedHintIds: unrelatedHints.map(item => item.preferenceId),
    metrics: { externalWrites: 0, providerCalls: 0, networkRequests: 0, executionAuthority: false,
      physicalDeletion: false, rawSourceErasure: false } };
  const evidencePath = process.env.JARVIS_M03_EVIDENCE_PATH;
  if (evidencePath) writeFileSync(resolve(evidencePath), `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
});
