import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersonalOperationsStore } from '../packages/core/src/personal-operations/operations-store.js';
import { SqliteMissionStore } from '../packages/core/src/mission/sqlite-mission-store.js';

async function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-event-race-')), children = [];
  const operations = new PersonalOperationsStore({ dbPath: join(root, 'isolated.sqlite'), clock: () => new Date(1790899200000) });
  const store = new SqliteMissionStore({ operationsStore: operations });
  store.save([{ missionId: 'm', status: 'PAUSED' }], { effects: ['a', 'b'].map(effectId => ({ effectId,
    operationId: `op-${effectId}`, missionId: 'm', resourceKey: 'same-reviewed-resource', request: { synthetic: true, effectId } })) });
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGKILL'); await done; }
    operations.close(); rmSync(root, { recursive: true, force: true });
  });
  const next = child => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('worker IPC timeout')); }, 10000);
    const cleanup = () => { clearTimeout(timer); child.off('message', message); child.off('exit', exit); };
    const message = value => { cleanup(); resolve(value); }, exit = code => { cleanup(); reject(new Error(`worker exited ${code}`)); };
    child.once('message', message); child.once('exit', exit);
  });
  const launch = async () => {
    const child = fork(new URL('./fixtures/effect-event-worker.mjs', import.meta.url), [join(root, 'isolated.sqlite')], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    children.push(child); assert.equal((await next(child)).type, 'ready');
    return { child, send: async message => { const reply = next(child); child.send(message); return reply; } };
  };
  return { store, a: await launch(), b: await launch() };
}

test('real SQL workers fence a losing claimant and expired owner through clock rollback and duplicate events', async t => {
  const f = await setup(t);
  assert.notEqual(f.a.child.pid, f.b.child.pid);
  const results = await Promise.all([f.a.send({ kind: 'claim', effectId: 'a' }), f.b.send({ kind: 'claim', effectId: 'a' })]);
  assert.equal(results.filter(value => value.result?.lease).length, 1);
  const winner = results[0].result ? f.a : f.b, loser = winner === f.a ? f.b : f.a;
  assert.equal((await loser.send({ kind: 'claim', effectId: 'b' })).result, null, 'same resource is not available to another effect');
  assert.equal((await winner.send({ kind: 'dispatch', effectId: 'a' })).result.allowed, true);
  await winner.send({ kind: 'clock', time: 1790899201001 });
  assert.equal((await winner.send({ kind: 'dispatch', effectId: 'a' })).code, 'A_DURABLE_STALE_FENCE');
  await winner.send({ kind: 'clock', time: 1790899199000 });
  assert.equal((await winner.send({ kind: 'dispatch', effectId: 'a' })).code, 'A_DURABLE_STALE_FENCE');
  assert.equal((await loser.send({ kind: 'recover' })).result.uncertainEffectIds[0], 'a');
  for (let count = 0; count < 2; count++) {
    assert.equal((await winner.send({ kind: 'complete', effectId: 'a', receipt: { receiptRef: 'late' } })).type, 'rejected');
    assert.equal((await loser.send({ kind: 'claim', effectId: 'a' })).result, null);
    assert.equal((await loser.send({ kind: 'claim', effectId: 'b' })).result, null);
  }
  assert.equal(f.store.getEffect('a').state, 'uncertain'); assert.equal(f.store.pendingFollowups().length, 0);
  t.diagnostic(JSON.stringify({ workers: 2, clockRollbackAfterRejectedTransaction: true, unresolvedEffectsRedispatched: 0, lateReceiptsRejected: 2 }));
});

test('reverse-order SQL followups and late duplicate receipts never overwrite a newer snapshot or settle twice', async t => {
  const f = await setup(t), receiptA = { receiptRef: 'a-actual-observation' }, receiptB = { receiptRef: 'b-actual-observation' };
  assert.ok((await f.a.send({ kind: 'claim', effectId: 'a' })).result.lease);
  assert.equal((await f.a.send({ kind: 'complete', effectId: 'a', receipt: receiptA })).result.effect.state, 'succeeded');
  assert.ok((await f.b.send({ kind: 'claim', effectId: 'b' })).result.lease);
  assert.equal((await f.b.send({ kind: 'complete', effectId: 'b', receipt: receiptB })).result.effect.state, 'succeeded');
  assert.equal((await f.a.send({ kind: 'complete', effectId: 'a', receipt: receiptA })).result.replayed, true);
  assert.equal((await f.a.send({ kind: 'complete', effectId: 'a', receipt: { receiptRef: 'conflicting' } })).code, 'A_DURABLE_RECEIPT_CONFLICT');
  assert.equal((await f.a.send({ kind: 'uncertain', effectId: 'a' })).type, 'rejected');
  const initialRevision = f.store.metadata().revision;
  const snapshot = status => ({ missions: [{ missionId: 'm', status }], expectedRevision: initialRevision });
  assert.equal((await f.b.send({ kind: 'ack', eventId: 'effect-result:b', options: { snapshot: snapshot('COMPLETED') } })).result.acknowledged, true);
  const stale = await f.a.send({ kind: 'ack', eventId: 'effect-result:a', options: { snapshot: snapshot('RUNNING') } });
  assert.equal(stale.type, 'rejected'); assert.match(stale.code, /REVISION/u);
  assert.equal(f.store.load()[0].status, 'COMPLETED');
  assert.equal(f.store.pendingFollowups().length, 1, 'failed CAS does not drop the older event');
  assert.equal((await f.a.send({ kind: 'ack', eventId: 'effect-result:a' })).result.acknowledged, true);
  assert.equal((await f.a.send({ kind: 'ack', eventId: 'effect-result:a' })).result.replayed, true);
  assert.equal(f.store.pendingFollowups().length, 0); assert.equal(f.store.load()[0].status, 'COMPLETED');
  t.diagnostic(JSON.stringify({ workers: 2, reverseOrderAcknowledgements: true, staleSnapshotRejected: true, duplicateCompletionEvents: 0, currentStatus: 'COMPLETED' }));
});
