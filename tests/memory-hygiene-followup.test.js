import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrowthRuntime } from '../apps/growth-memory/src/growth-runtime.js';
import { SqliteMemoryStore } from '../apps/growth-memory/src/db/sqlite-store.js';
import { createGrowthMemoryServer } from '../apps/growth-memory/src/main.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-hygiene-followup-'));
  const store = new SqliteMemoryStore({ dbPath: join(root, 'memory.sqlite'), reviewDir: join(root, 'reviews'), backupDir: join(root, 'backups') });
  const runtime = new GrowthRuntime({ memoryStore: store, auditRoot: root });
  for (let i = 0; i < 2; i++) runtime.ingest({ eventId: `event-${i}`, taskId: `task-${i}`, eventType: 'task.created',
    source: { module: 'CORE', memoryScope: { userId: 'synthetic-owner', workspaceRoot: root, conversationId: null } },
    payload: { rawText: '합성 자료' }, learningFlags: { canBeUsedForWorkflow: true }, trustBoundary: { userProvided: true } });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { store, runtime };
}

test('report SQL failure after deletion returns applied receipt and report retry separately', t => {
  const { store, runtime } = fixture(t), save = store.saveReview.bind(store);
  store.saveReview = () => { throw new Error('SYNTHETIC_PRIVATE_REPORT_FAILURE'); };
  const result = runtime.decideHygiene({ targetId: 'event-0', action: 'delete' });
  assert.equal(result.success, true);
  assert.equal(result.applied, true);
  assert.equal(result.persisted, true);
  assert.equal(result.followUps.report.status, 'requires_retry');
  assert.equal(result.hygiene, null);
  assert.equal(JSON.stringify(result).includes('SYNTHETIC_PRIVATE_REPORT_FAILURE'), false);
  assert.equal(store.hasSourceRetraction('event-0'), true);
  assert.equal(store.allEvents()[0].learningFlags.doNotRemember, true);
  store.saveReview = save;
  assert.equal(runtime.hygieneFollowUp().followUps.report.status, 'completed');
  assert.equal(store.allHygieneDecisions().length, 1, 'refresh report without resubmitting deletion');
});

test('withheld report is explicitly unavailable and not reported as completed', t => {
  const { runtime } = fixture(t);
  runtime.latestReview = () => ({ success: false, contentWithheld: true, error: { code: 'F_MEMORY_SOURCE_CHANGED' } });
  const result = runtime.decideHygiene({ targetId: 'event-0', action: 'delete' });
  assert.equal(result.applied, true);
  assert.equal(result.followUps.report.status, 'requires_retry');
  assert.equal(result.followUps.report.error.code, 'F_MEMORY_SOURCE_CHANGED');
});

test('projection and audit failures do not erase committed decision or leak raw errors', t => {
  const { store, runtime } = fixture(t);
  runtime.synchronizeSourceRetractions = () => { throw new Error('SYNTHETIC_PRIVATE_PROJECTION'); };
  runtime.auditLog.write = () => { throw new Error('SYNTHETIC_PRIVATE_AUDIT'); };
  const result = runtime.decideHygiene({ targetId: 'event-0', action: 'delete' });
  assert.equal(result.applied, true);
  assert.equal(result.followUps.sourceProjection.status, 'requires_retry');
  assert.equal(result.followUps.audit.status, 'requires_retry');
  assert.equal(store.allHygieneDecisions().length, 1);
  assert.equal(JSON.stringify(result).includes('SYNTHETIC_PRIVATE_'), false);
});

test('batch generates one aggregate report and preserves per-item applied receipts on report failure', t => {
  const { store, runtime } = fixture(t);
  let reports = 0;
  runtime.latestReview = () => { reports++; throw new Error('synthetic report failure'); };
  const result = runtime.decideHygieneBatch({ decisions: [
    { targetId: 'event-0', action: 'delete' }, { targetId: 'event-1', action: 'delete' }, { targetId: 'bad', action: 'invalid' }
  ] });
  assert.equal(reports, 1);
  assert.equal(result.success, false);
  assert.equal(result.appliedCount, 2);
  assert.equal(result.failedCount, 1);
  assert.equal(store.allHygieneDecisions().length, 2);
  assert.equal(result.results.filter(item => item.applied && item.persisted).length, 2);
  assert.equal(result.followUps.report.status, 'requires_retry');
});

test('actual F HTTP returns a committed deletion with report warning rather than generic500', async t => {
  const { store, runtime } = fixture(t);
  const save = store.saveReview.bind(store);
  store.saveReview = () => { throw new Error('synthetic report unavailable'); };
  const server = createGrowthMemoryServer(runtime);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/memory/hygiene/decisions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targetId: 'event-0', action: 'delete' })
  });
  assert.equal(response.status, 200);
  const receipt = await response.json();
  assert.equal(receipt.applied, true);
  assert.equal(receipt.persisted, true);
  assert.equal(receipt.followUps.report.status, 'requires_retry');
  assert.equal(store.allHygieneDecisions().length, 1);
  store.saveReview = save;
  const refresh = await fetch(`http://127.0.0.1:${server.address().port}/memory/hygiene/follow-up`);
  assert.equal(refresh.status, 200);
  assert.equal((await refresh.json()).followUps.report.status, 'completed');
  assert.equal(store.allHygieneDecisions().length, 1);
});
