import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrowthRuntime } from '../apps/growth-memory/src/growth-runtime.js';
import { SqliteMemoryStore } from '../apps/growth-memory/src/db/sqlite-store.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-hygiene-atomic-'));
  const store = new SqliteMemoryStore({ dbPath: join(root, 'memory.sqlite'), reviewDir: join(root, 'reviews'), backupDir: join(root, 'backups') });
  const runtime = new GrowthRuntime({ memoryStore: store, auditRoot: root });
  const event = { eventId: 'synthetic-event', taskId: 'synthetic-task', eventType: 'task.created',
    source: { module: 'CORE', memoryScope: { userId: 'synthetic-owner', workspaceRoot: root, conversationId: null } },
    payload: { rawText: '합성 자료 정리' }, learningFlags: { canBeUsedForWorkflow: true }, trustBoundary: { userProvided: true } };
  assert.equal(runtime.ingest(event).stored, true);
  const backup = store.backup({ backupId: 'baseline' });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { store, runtime, backup };
}

for (const action of ['delete', 'redact', 'defer', 'keep']) test(`${action} event-update failure rolls back decision and leaves runtime memory unchanged`, t => {
  const { store, runtime } = fixture(t);
  const original = structuredClone(runtime.ingestor.events.get('synthetic-event'));
  const queue = JSON.stringify(runtime.ingestor.learningQueue);
  store.updateEvent = () => { throw new Error('SYNTHETIC_PRIVATE_WRITE_FAILURE'); };
  const result = runtime.decideHygiene({ targetId: 'synthetic-event', action });
  assert.equal(result.success, false);
  assert.equal(result.error.code, 'F_HYGIENE_PERSISTENCE_FAILED');
  assert.equal(JSON.stringify(result).includes('SYNTHETIC_PRIVATE_WRITE_FAILURE'), false);
  assert.equal(store.allHygieneDecisions().length, 0);
  assert.equal(runtime.hygieneManager.decisions.has('synthetic-event'), false);
  assert.deepEqual(runtime.ingestor.events.get('synthetic-event'), original);
  assert.equal(JSON.stringify(runtime.ingestor.learningQueue), queue);
  assert.deepEqual(store.allEvents()[0].payload, original.payload);
});

test('restore immediately before atomic write rejects stale decision and next attempt commits both', t => {
  const { store, runtime, backup } = fixture(t);
  const apply = store.applyHygieneDecision.bind(store);
  let once = true;
  store.applyHygieneDecision = (decision, event, options) => {
    if (once) { once = false; store.restore({ backupPath: backup.filePath }); }
    return apply(decision, event, options);
  };
  assert.equal(runtime.decideHygiene({ targetId: 'synthetic-event', action: 'delete' }).error.code, 'F_MEMORY_GENERATION_CONFLICT');
  assert.equal(store.hasSourceRetraction('synthetic-event'), false);
  assert.equal(runtime.ingestor.events.get('synthetic-event').learningFlags.doNotRemember, false);
  assert.equal(runtime.decideHygiene({ targetId: 'synthetic-event', action: 'delete' }).success, true);
  assert.equal(store.hasSourceRetraction('synthetic-event'), true);
  assert.equal(store.allEvents()[0].learningFlags.doNotRemember, true);
  assert.equal(runtime.ingestor.learningQueue.some(item => item.eventId === 'synthetic-event'), false);
});

test('successful batch metadata is included in first atomic write; failures remain separate', t => {
  const { store, runtime } = fixture(t);
  const result = runtime.decideHygieneBatch({ decisions: [
    { targetId: 'synthetic-event', action: 'delete' }, { targetId: 'bad', action: 'invalid' }
  ] });
  assert.equal(result.success, false);
  assert.equal(result.appliedCount, 1);
  assert.equal(result.failedCount, 1);
  const decision = store.allHygieneDecisions()[0];
  assert.equal(decision.batchId, result.batchId);
  assert.equal(decision.batchIndex, 0);
  assert.equal(store.allEvents()[0].payload.hygieneDecision.batchId, result.batchId);
});

test('same-generation competing withdrawal blocks keep without overwriting minimized event', t => {
  const { store, runtime } = fixture(t);
  const apply = store.applyHygieneDecision.bind(store);
  store.applyHygieneDecision = (decision, event, options) => {
    store.saveHygieneDecision({ decisionId: 'competing-delete', targetType: 'memory_event', targetId: 'synthetic-event', action: 'delete', decidedAt: '2026-10-03T00:00:00Z' });
    return apply(decision, event, options);
  };
  assert.equal(runtime.decideHygiene({ targetId: 'synthetic-event', action: 'keep' }).error.code, 'F_MEMORY_SOURCE_RETRACTED');
  assert.equal(store.allHygieneDecisions().length, 1);
  assert.equal(runtime.hygieneManager.decisions.has('synthetic-event'), false);
});

test('decision failure prevents event mutation and missing event cannot leave an orphan decision', t => {
  const { store, runtime } = fixture(t);
  store.saveHygieneDecision = () => { throw new Error('synthetic decision failure'); };
  assert.equal(runtime.decideHygiene({ targetId: 'synthetic-event', action: 'delete' }).success, false);
  assert.equal(store.allEvents()[0].learningFlags.doNotRemember, false);
  assert.equal(runtime.ingestor.events.get('synthetic-event').learningFlags.doNotRemember, false);
  assert.throws(() => store.applyHygieneDecision({ targetId: 'missing', targetType: 'memory_event', action: 'delete' }, { eventId: 'missing' }, { expectedGeneration: 0 }), { code: 'F_MEMORY_EVENT_NOT_FOUND' });
  assert.equal(store.allHygieneDecisions().length, 0);
});

test('failure after actual event SQL update rolls both rows back and does not publish cache', t => {
  const { store, runtime } = fixture(t);
  const update = store.updateEvent.bind(store);
  store.updateEvent = (event, options) => {
    update(event, options);
    assert.equal(store.allEvents()[0].learningFlags.doNotRemember, true);
    throw new Error('synthetic post-update failure');
  };
  assert.equal(runtime.decideHygiene({ targetId: 'synthetic-event', action: 'delete' }).success, false);
  assert.equal(store.allEvents()[0].learningFlags.doNotRemember, false);
  assert.equal(store.allHygieneDecisions().length, 0);
  assert.equal(runtime.ingestor.events.get('synthetic-event').learningFlags.doNotRemember, false);
});

test('redaction cannot downgrade an already committed deletion in the same generation', t => {
  const { store, runtime } = fixture(t);
  assert.equal(runtime.decideHygiene({ targetId: 'synthetic-event', action: 'delete' }).success, true);
  const before = store.allEvents()[0];
  const result = runtime.decideHygiene({ targetId: 'synthetic-event', action: 'redact' });
  assert.equal(result.error.code, 'F_MEMORY_SOURCE_RETRACTED');
  assert.deepEqual(store.allEvents()[0], before);
  assert.equal(store.allHygieneDecisions().length, 1);
});
