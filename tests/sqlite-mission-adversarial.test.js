import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { PersonalOperationsStore } from '../packages/core/src/personal-operations/operations-store.js';
import { PersonalMandateBudget } from '../packages/core/src/personal-operations/mandate-budget.js';
import { SqliteMissionStore } from '../packages/core/src/mission/sqlite-mission-store.js';

const START = Date.parse('2026-09-27T00:00:00Z');
const snapshot = [{ missionId: 'review-mission', status: 'RUNNING', objective: '격리 시험 결과를 기록해' }];

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-sqlite-adversarial-'));
  const connections = [];
  let now = START;
  const open = () => {
    const operationsStore = new PersonalOperationsStore({ dbPath: join(root, 'test.sqlite'), clock: () => new Date(now) });
    connections.push(operationsStore);
    return new SqliteMissionStore({ operationsStore });
  };
  const store = open();
  t.after(() => {
    for (const connection of connections) connection.close();
    const target = resolve(root);
    assert.ok(target.startsWith(resolve(tmpdir()) + sep) && target.includes('jarvis-sqlite-adversarial-'));
    rmSync(target, { recursive: true, force: true });
  });
  return { store, open, setTime(value) { now = value; } };
}

function effect(patch = {}) {
  return { effectId: 'review-effect', operationId: 'review-operation', missionId: 'review-mission',
    resourceKey: 'synthetic-resource', request: { action: 'synthetic.record', target: 'fixture:only' }, ...patch };
}

function budget(f, { expiresAt = '2099-01-01T00:00:00Z' } = {}) {
  const store = f.store.operationsStore;
  const mandate = store.createMandate({ action: 'synthetic.record', target: 'fixture:only',
    validFrom: '2020-01-01T00:00:00Z', expiresAt, currency: 'KRW', maxAmountMinor: 100 });
  const accounting = new PersonalMandateBudget(store);
  accounting.configure({ mandateId: mandate.id, totalMinor: 100, maxCalls: 10 });
  return { mandateId: mandate.id, accounting, spec: { mandateId: mandate.id, requestId: 'review-budget-request',
    request: { action: 'synthetic.record', target: 'fixture:only', currency: 'KRW', amountMinor: 40 } } };
}

test('an observed expired lease stays expired even when the expiry check failed and the wall clock moved backwards', t => {
  const f = fixture(t);
  const lease = f.store.acquireLease({ resourceKey: 'clock', ownerId: 'old-worker', ttlMs: 100 });
  f.setTime(START + 101);
  assert.throws(() => f.store.heartbeatLease(lease), { code: 'A_DURABLE_STALE_FENCE' });
  f.setTime(START + 50);
  const restarted = f.open();
  assert.throws(() => restarted.heartbeatLease(lease), { code: 'A_DURABLE_STALE_FENCE' });
});

test('a backwards wall clock cannot make a mandate eligible after durable time has passed its expiry', t => {
  const f = fixture(t), b = budget(f, { expiresAt: new Date(START + 100).toISOString() });
  f.store.save(snapshot, { effects: [effect({ budget: b.spec })] });
  f.setTime(START + 101);
  f.store.acquireLease({ resourceKey: 'unrelated-clock-observation', ownerId: 'observer' });
  f.setTime(START + 50);
  assert.throws(() => f.store.claimEffect({ effectId: 'review-effect', ownerId: 'late-worker' }), /MANDATE|EXPIRED|TIME/u);
  assert.equal(f.store.getEffect('review-effect').state, 'prepared');
  assert.equal(b.accounting.summary(b.mandateId).usedOrHeldMinor, 40);
});

test('a missing actual charge remains unknown and must not release a monetary reservation as zero', t => {
  const f = fixture(t), b = budget(f);
  f.store.save(snapshot, { effects: [effect({ budget: b.spec })] });
  const claim = f.store.claimEffect({ effectId: 'review-effect', ownerId: 'worker' });
  assert.throws(() => f.store.completeEffect({ effectId: 'review-effect', lease: claim.lease,
    receipt: { receiptRef: 'synthetic-receipt:charge-not-specified' } }), /AMOUNT|ACTUAL|COST/u);
  assert.equal(f.store.getEffect('review-effect').state, 'in_flight');
  assert.equal(b.accounting.summary(b.mandateId).usedOrHeldMinor, 40);
  assert.equal(f.store.pendingFollowups().length, 0);
  const result = f.store.completeEffect({ effectId: 'review-effect', lease: claim.lease,
    receipt: { receiptRef: 'synthetic-receipt:explicitly-free' }, actualMinor: 0 });
  assert.equal(result.effect.state, 'succeeded');
  assert.equal(b.accounting.summary(b.mandateId).usedOrHeldMinor, 0);
});

test('failure after budget settlement rolls back receipt, amount, lease release and both outboxes atomically', t => {
  const f = fixture(t), b = budget(f);
  f.store.save(snapshot, { effects: [effect({ budget: b.spec })] });
  const claim = f.store.claimEffect({ effectId: 'review-effect', ownerId: 'worker' });
  const before = f.store.getEffect('review-effect');
  f.store.db.exec("CREATE TRIGGER reject_review_followup BEFORE INSERT ON mission_followup_outbox BEGIN SELECT RAISE(ABORT,'INJECTED_FOLLOWUP_STORAGE_FAILURE'); END");
  const completion = { effectId: 'review-effect', lease: claim.lease, receipt: { receiptRef: 'synthetic-receipt:1' }, actualMinor: 25 };
  assert.throws(() => f.store.completeEffect(completion), /INJECTED_FOLLOWUP_STORAGE_FAILURE/u);
  const after = f.store.getEffect('review-effect');
  assert.equal(after.state, 'in_flight');
  assert.equal(after.receipt, null);
  assert.equal(after.updated_at, before.updated_at);
  assert.equal(b.accounting.get(after.budget_reservation_id).state, 'in_flight');
  assert.equal(b.accounting.get(after.budget_reservation_id).actual_minor, null);
  assert.equal(b.accounting.summary(b.mandateId).usedOrHeldMinor, 40);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM mission_dispatch_outbox').get().n, 1);
  assert.equal(f.store.pendingFollowups().length, 0);
  assert.equal(f.store.db.prepare('SELECT owner_id FROM mission_resource_leases WHERE resource_key=?').get('synthetic-resource').owner_id, 'worker');
  f.store.db.exec('DROP TRIGGER reject_review_followup');
  assert.equal(f.store.completeEffect(completion).effect.state, 'succeeded');
  assert.equal(f.store.completeEffect(completion).replayed, true);
  assert.equal(b.accounting.summary(b.mandateId).usedOrHeldMinor, 25);
  assert.equal(b.accounting.summary(b.mandateId).usedOrHeldCalls, 1);
  assert.equal(f.store.pendingFollowups().length, 1);
});

test('an uncertain resource stays blocked across reopen while an independent effect can progress', t => {
  const f = fixture(t);
  f.store.save(snapshot, { effects: [effect(), effect({ effectId: 'same-resource', operationId: 'operation-2' }),
    effect({ effectId: 'independent', operationId: 'operation-3', resourceKey: 'independent-resource' })] });
  const claim = f.store.claimEffect({ effectId: 'review-effect', ownerId: 'first', ttlMs: 100 });
  f.store.markUncertain({ effectId: 'review-effect', lease: claim.lease });
  const restarted = f.open();
  assert.equal(restarted.claimEffect({ effectId: 'review-effect', ownerId: 'retry' }), null);
  assert.equal(restarted.claimEffect({ effectId: 'same-resource', ownerId: 'retry' }), null);
  const independent = restarted.claimEffect({ effectId: 'independent', ownerId: 'different' });
  assert.equal(independent.effect.state, 'in_flight');
  assert.equal(independent.executionAuthority, false);
  assert.throws(() => restarted.reconcileEffect({ effectId: 'review-effect', reconciliation: {
    operationId: 'operation-2', requestSha256: restarted.getEffect('review-effect').request_sha256, evidenceRef: 'wrong-operation-read'
  }, receipt: { receiptRef: 'wrong-receipt' } }), { code: 'A_DURABLE_RECONCILIATION_REQUIRED' });
  assert.equal(restarted.getEffect('review-effect').state, 'uncertain');
});

test('snapshot persistence neither deletes unrelated personal records nor upgrades a revoked mandate', t => {
  const f = fixture(t), b = budget(f), ops = f.store.operationsStore;
  const goal = ops.createGoal({ title: '합성 장기 목표 보존' });
  const commitment = ops.createCommitment({ goalId: goal.id, title: '합성 약속 보존', dueAt: '2026-10-01T00:00:00Z', sourceRef: 'fixture:source' });
  ops.revokeMandate(b.mandateId);
  f.store.save(snapshot);
  f.store.save([{ ...snapshot[0], status: 'COMPLETED' }]);
  const restarted = f.open();
  assert.equal(restarted.db.prepare('SELECT title FROM personal_goals WHERE id=?').get(goal.id).title, '합성 장기 목표 보존');
  assert.equal(restarted.db.prepare('SELECT state FROM personal_commitments WHERE id=?').get(commitment.id).state, 'open');
  assert.equal(restarted.db.prepare('SELECT revoked FROM personal_mandates WHERE id=?').get(b.mandateId).revoked, 1);
  assert.equal(restarted.metadata().executionAuthority, false);
});

test('a budget reservation cannot be bound to an effect declaring a different action, target, currency or charge', t => {
  const f = fixture(t), b = budget(f);
  for (const patch of [{ action: 'different.action' }, { target: 'fixture:different' }, { currency: 'USD' }, { amountMinor: 41 }]) {
    assert.throws(() => f.store.save(snapshot, { effects: [effect({ budget: b.spec,
      request: { action: 'synthetic.record', target: 'fixture:only', ...patch } })] }), /BUDGET.*(?:BIND|REQUEST|MISMATCH)|(?:REQUEST|INTENT).*MISMATCH/u);
    assert.equal(f.store.metadata().revision, 0);
    assert.equal(f.store.pendingEffects().length, 0);
    assert.equal(b.accounting.summary(b.mandateId).usedOrHeldMinor, 0);
    assert.equal(b.accounting.summary(b.mandateId).usedOrHeldCalls, 0);
  }
});

test('reconciliation replay cannot double-charge or silently change its prior receipt', t => {
  const f = fixture(t), b = budget(f);
  f.store.save(snapshot, { effects: [effect({ budget: b.spec })] });
  const claim = f.store.claimEffect({ effectId: 'review-effect', ownerId: 'worker' });
  f.store.markUncertain({ effectId: 'review-effect', lease: claim.lease });
  const prior = f.store.getEffect('review-effect');
  const completion = { effectId: 'review-effect', reconciliation: { operationId: prior.operation_id,
    requestSha256: prior.request_sha256, evidenceRef: 'synthetic:provider-lookup' },
    receipt: { receiptRef: 'synthetic:confirmed-1' }, actualMinor: 29 };
  assert.equal(f.store.reconcileEffect(completion).effect.state, 'succeeded');
  assert.equal(f.open().reconcileEffect(completion).replayed, true);
  assert.equal(b.accounting.summary(b.mandateId).usedOrHeldMinor, 29);
  assert.equal(b.accounting.summary(b.mandateId).usedOrHeldCalls, 1);
  assert.equal(f.store.pendingFollowups().length, 1);
  assert.throws(() => f.store.reconcileEffect({ ...completion, actualMinor: 28 }), /CONFLICT/u);
});
