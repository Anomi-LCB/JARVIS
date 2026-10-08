import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { MemoryEventIngestor } from '../apps/growth-memory/src/growth-runtime.js';
import { SqliteMemoryStore } from '../apps/growth-memory/src/db/sqlite-store.js';

const event = () => ({ eventId: 'synthetic-persistence-event', taskId: 'synthetic-task', eventType: 'approval.edited',
  source: { module: 'CORE' }, payload: { editRequest: '합성 회의자료를 표로 정리해줘' },
  learningFlags: { canBeUsedForPreference: true, canBeUsedForWorkflow: true },
  trustBoundary: { userProvided: true, externalContent: false, systemGenerated: false } });

function fixture(t, auditLog = null) {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-ingest-durability-'));
  const store = new SqliteMemoryStore({ dbPath: join(root, 'growth.sqlite'), reviewDir: join(root, 'reviews'), backupDir: join(root, 'backups') });
  t.after(() => {
    store.close();
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep) && root.includes('jarvis-ingest-durability-'));
    rmSync(root, { recursive: true, force: true });
  });
  return { store, ingestor: new MemoryEventIngestor({ store, auditLog }) };
}

test('failed SQLite save does not publish phantom memory and same-runtime retry persists once', t => {
  const { store, ingestor } = fixture(t), save = store.saveEvent.bind(store);
  store.saveEvent = () => { throw Object.assign(new Error('synthetic disk failure'), { code: 'SYNTHETIC_STORAGE_FAILURE' }); };
  assert.throws(() => ingestor.ingest(event()), { code: 'SYNTHETIC_STORAGE_FAILURE' });
  assert.equal(store.allEvents().length, 0);
  assert.equal(ingestor.all().length, 0);
  assert.equal(ingestor.learningQueue.length, 0);
  store.saveEvent = save;
  assert.equal(ingestor.ingest(event()).stored, true);
  assert.equal(store.allEvents().length, 1);
  assert.equal(ingestor.all().length, 1);
  assert.equal(ingestor.learningQueue.length, 1);
  assert.equal(ingestor.ingest(event()).reason, 'duplicate-event');
  assert.equal(store.allEvents().length, 1);
  assert.equal(new MemoryEventIngestor({ store }).learningQueue.length, 1);
});

test('an explicit false persistence result cannot be reported as stored', t => {
  const { store, ingestor } = fixture(t), save = store.saveEvent.bind(store);
  store.saveEvent = () => false;
  assert.throws(() => ingestor.ingest(event()), { code: 'F_MEMORY_EVENT_NOT_PERSISTED' });
  assert.equal(ingestor.all().length, 0);
  assert.equal(ingestor.learningQueue.length, 0);
  store.saveEvent = save;
  assert.equal(ingestor.ingest(event()).stored, true);
  assert.equal(store.allEvents().length, 1);
});

test('audit failure after committed memory preserves the learning queue across retry and reopen', t => {
  let fail = true;
  const { store, ingestor } = fixture(t, { write(type) {
    if (type === 'memory.event.stored' && fail) throw new Error('synthetic audit failure');
  } });
  assert.throws(() => ingestor.ingest(event()), /synthetic audit failure/u);
  assert.equal(store.allEvents().length, 1);
  assert.equal(ingestor.all().length, 1);
  assert.equal(ingestor.learningQueue.length, 1);
  fail = false;
  assert.equal(ingestor.ingest(event()).reason, 'duplicate-event');
  assert.equal(ingestor.learningQueue.length, 1);
  assert.equal(new MemoryEventIngestor({ store }).learningQueue.length, 1);
});

test('explicit in-memory use retains duplicate suppression without a persistence store', () => {
  const ingestor = new MemoryEventIngestor();
  assert.equal(ingestor.ingest(event()).stored, true);
  assert.equal(ingestor.ingest(event()).reason, 'duplicate-event');
  assert.equal(ingestor.all().length, 1);
  assert.equal(ingestor.learningQueue.length, 1);
});
