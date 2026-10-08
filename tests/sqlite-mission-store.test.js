import {SqliteMemoryStore} from '../apps/growth-memory/src/db/sqlite-store.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { PersonalOperationsStore } from '../packages/core/src/personal-operations/operations-store.js';
import { PersonalMandateBudget } from '../packages/core/src/personal-operations/mandate-budget.js';
import { SqliteMissionStore } from '../packages/core/src/mission/sqlite-mission-store.js';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { MissionGrant } from '../packages/core/src/mission/mission-runtime.js';

const START = Date.parse('2026-09-27T00:00:00Z');
const missions = [{ missionId: 'mission-1', status: 'READY', objective: '합성 입력 집계' }];
const legacyMissions = [{ ...missions[0], status: 'CREATED', missionVersion: 'a-autonomous-mission-v1', successCriteria: [], constraints: [], waves: [], gates: [], observations: [], planHistory: [], budgets: {}, authorization: {}, metadata: {}, failureSignatures: {}, metrics: {}, createdAt: new Date(START).toISOString(), updatedAt: new Date(START).toISOString() }];
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-sqlite-mission-')), dbPath = join(root, 'operations.sqlite');
  let now = START;
  const connections = [], children = new Set();
  const open = () => {
    const operations = new PersonalOperationsStore({ dbPath, clock: () => new Date(now) });
    connections.push(operations);
    return new SqliteMissionStore({ operationsStore: operations });
  };
  const store = open();
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
      }
    }
    for (const connection of connections) { try { connection.close(); } catch {} }
    const target = resolve(root), parent = resolve(tmpdir()) + sep;
    assert.ok(target.startsWith(parent) && target.includes('jarvis-sqlite-mission-'));
    rmSync(target, { recursive: true, force: true });
  });
  return { root, dbPath, store, open, children, connections, now: value => { now = value; } };
}
function makeEffect(patch = {}) {
  return { effectId: 'effect-1', operationId: 'operation-1', missionId: 'mission-1', request: { action: 'synthetic.write', target: 'fixture:1' }, providerIdempotencyKey: 'provider-operation-1', ...patch };
}
test('Core fence inside an owned transaction retains expiry across rollback and clock reversal',t=>{
 const f=fixture(t),lease=f.store.acquireCoreAuthority({ownerId:'synthetic-core',expectedToken:0,ttlMs:100});
 f.store.db.exec('BEGIN IMMEDIATE');
 assert.doesNotThrow(()=>f.store.assertCoreAuthority(lease));
 assert.throws(()=>f.store.assertCoreAuthority({...lease,token:lease.token+1}),/FENCE/u);
 f.now(START+101);
 assert.throws(()=>f.store.assertCoreAuthority(lease),/LEASE|FENCE/u);
 f.store.db.exec('ROLLBACK');
 f.now(START);
 assert.throws(()=>f.store.assertCoreAuthority(lease),/LEASE|FENCE/u);
});
function configureBudget(f) {
  const operations = f.store.operationsStore, budget = new PersonalMandateBudget(operations);
  const mandate = operations.createMandate({ action: 'synthetic.write', target: 'fixture:1', validFrom: '2020-01-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z', currency: 'KRW', maxAmountMinor: 100 });
  budget.configure({ mandateId: mandate.id, totalMinor: 100, maxCalls: 5 });
  return { budget, mandateId: mandate.id, spec: { mandateId: mandate.id, requestId: 'effect:operation-1', request: { action: 'synthetic.write', target: 'fixture:1', currency: 'KRW', amountMinor: 30 } } };
}
async function child(f, mode, owner = 'child', effectId = 'effect-1') {
  const process = fork(new URL('./fixtures/sqlite-mission-worker.mjs', import.meta.url), [f.dbPath, mode, String(START), owner, effectId, join(f.root, 'synthetic-provider.jsonl')], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
  f.children.add(process);
  let stderr = '';
  process.stderr.on('data', data => { stderr += data; });
  const next = () => new Promise((resolveMessage, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`child timeout: ${stderr}`)); }, 10_000);
    const onMessage = message => { cleanup(); message.type === 'error' ? reject(new Error(message.message)) : resolveMessage(message); };
    const onExit = code => { cleanup(); reject(new Error(`child exited ${code}: ${stderr}`)); };
    const cleanup = () => { clearTimeout(timer); process.off('message', onMessage); process.off('exit', onExit); };
    process.once('message', onMessage); process.once('exit', onExit);
  });
  assert.equal((await next()).type, 'ready');
  return { process, next, run() { const result = next(); process.send('run'); return result; }, async kill() { const exited = once(process, 'exit'); assert.equal(process.kill('SIGKILL'), true); await exited; f.children.delete(process); } };
}

test('compatible load/save uses the existing operations DB and rejects stale snapshot writers', t => {
  const f = fixture(t), other = f.open();
  assert.deepEqual(f.store.load(), []);
  assert.deepEqual(other.load(), []);
  const saved = f.store.save(missions);
  assert.equal(saved.revision, 1);
  assert.throws(() => other.save([{ ...missions[0], status: 'STALE' }]), { code: 'A_MISSION_STORE_REVISION_CONFLICT' });
  assert.deepEqual(other.load(), missions);
  assert.equal(other.save(missions).revision, 2);
  assert.equal(other.metadata().sharedPersonalOperationsConnection, true);
  assert.equal(other.db, other.operationsStore.db);
});

test('legacy import preserves exact source bytes, checks schema, and is hash-idempotent across reopen', t => {
  const f = fixture(t), path = join(f.root, 'legacy.json');
  const bytes = `${JSON.stringify({ storeVersion: 'a-mission-store-v1', missions: legacyMissions })}\n`;
  writeFileSync(path, bytes);
  assert.equal(f.store.importLegacySnapshot(path).imported, true);
  assert.equal(f.open().importLegacySnapshot(path).replayed, true);
  assert.equal(readFileSync(path, 'utf8'), bytes);
  writeFileSync(path, JSON.stringify({ storeVersion: 'a-mission-store-v1', missions: [{ ...legacyMissions[0], missionId: 'different' }] }));
  assert.throws(() => f.store.importLegacySnapshot(path), { code: 'A_MISSION_IMPORT_TARGET_NOT_EMPTY' });
  writeFileSync(path, '{broken');
  assert.throws(() => f.store.importLegacySnapshot(path), { code: 'A_MISSION_STORE_CORRUPT' });
  writeFileSync(path, JSON.stringify({ storeVersion: 'future', missions: [] }));
  assert.throws(() => f.store.importLegacySnapshot(path), { code: 'A_MISSION_STORE_VERSION_UNSUPPORTED' });
});

test('legacy root and nested Mission schema damage is rejected without changing bytes or SQL state', t => {
  const f = fixture(t), path = join(f.root, 'damaged.json');
  const invalid = [{ missionId: 'x' }, { ...legacyMissions[0], status: 'MADE_UP' }, { ...legacyMissions[0], waves: [{}] }, { ...legacyMissions[0], metrics: null }, { ...legacyMissions[0], observations: 'broken' }];
  for (const mission of invalid) {
    const bytes = JSON.stringify({ storeVersion: 'a-mission-store-v1', missions: [mission] });
    writeFileSync(path, bytes);
    assert.throws(() => f.store.importLegacySnapshot(path), { code: 'A_MISSION_IMPORT_SCHEMA_INVALID' });
    assert.equal(readFileSync(path, 'utf8'), bytes);
    assert.equal(f.store.metadata().revision, 0);
    assert.deepEqual(f.store.load(), []);
  }
});

test('actual runtime writes CSV, verifies typed content through G and reloads the persisted completed Mission', async t => {
  const f = fixture(t), input = join(f.root, 'inputs');
  mkdirSync(input);
  writeFileSync(join(input, 'a.csv'), 'region,amount\nnorth,10\nnorth,20\nsouth,5\n');
  const env = { JARVIS_TEST_MODE: '1', JARVIS_MISSION_EXECUTIVE: '0', JARVIS_LLM_INTENT: '0', JARVIS_LLM_PLANNER: '0', JARVIS_LLM_CONTENT: '0' };
  const memoryStore=new SqliteMemoryStore({dbPath:join(f.root,'growth.sqlite'),reviewDir:join(f.root,'reviews'),backupDir:join(f.root,'backups')});
  f.connections.push(memoryStore);
  const options = { memoryStore, allowedRoots: [f.root], auditRoot: join(f.root, 'audit'), cwd: () => f.root, env, taskEnv: env, workerDaemonEnabled: false, bridgeRealExecution: true };
  const runtime = createAgRuntime({ ...options, missionStore: f.store });
  const owner = runtime.personalOwnerSession.activate({ durationMinutes: 15, requestedBy: 'sqlite-storage-integration' });
  let result;
  try {
    const created = runtime.missionRuntime.createMission({
      objective: "'inputs/a.csv' CSV를 'A'로 읽고; 'A'를 'region'별로 'amount' 합계 'total'을 계산해 '요약'으로 만들고; '요약'을 'outputs/summary.csv' CSV로 저장해.",
      successCriteria: [{ criterionId: 'sum', statement: 'CSV 지역별 합계의 전체 행과 열이 일치한다.', verificationSpec: { version: 1, kind: 'csv.rows', path: 'outputs/summary.csv', equals: [{ region: 'north', total: 30 }, { region: 'south', total: 5 }], numericColumns: ['total'], order: 'unordered' } }],
      authorization: { mode: 'trusted_session', grants: [MissionGrant.READ_ONLY, MissionGrant.LOCAL_REVERSIBLE], ownerSessionId: owner.session.sessionId }
    });
    result = await runtime.missionRuntime.runMission(created.missionId);
    assert.equal(result.status, 'COMPLETED');
    assert.equal(result.verificationStatus, 'passed');
    assert.ok(result.completion.criteria[0].deterministicChecks.some(check => check.checkId === 'typed_csv_rows' && check.passed));
    assert.match(readFileSync(join(f.root, 'outputs/summary.csv'), 'utf8'), /region,total/);
  } finally { await runtime.close?.(); }
  const reopened = createAgRuntime({ ...options, missionStore: f.open() });
  try {
    const loaded = reopened.missionRuntime.getMission(result.missionId);
    assert.equal(loaded.status, 'COMPLETED');
    assert.equal(loaded.verificationStatus, 'passed');
    assert.equal(loaded.metrics.executedActions, 1);
    assert.equal((await reopened.missionRuntime.runMission(result.missionId)).metrics.executedActions, 1);
    // Snapshot integration is real; runtime dispatch is not yet wired to the new effect outbox.
    assert.equal(f.store.pendingEffects().length, 0);
  } finally { await reopened.close?.(); }
});

test('snapshot, effect, mandate revision, budget reservation and dispatch outbox commit atomically', t => {
  const f = fixture(t), budget = configureBudget(f), effect = makeEffect({ budget: budget.spec });
  f.store.save(missions, { effects: [effect] });
  const stored = f.store.getEffect(effect.effectId);
  assert.equal(stored.operation_id, effect.operationId);
  assert.match(stored.request_sha256, /^[a-f0-9]{64}$/);
  assert.match(stored.mandate_revision, /^[a-f0-9]{64}$/);
  assert.equal(stored.provider_idempotency_key, effect.providerIdempotencyKey);
  assert.equal(budget.budget.get(stored.budget_reservation_id).state, 'reserved');
  assert.equal(budget.budget.summary(budget.mandateId).usedOrHeldMinor, 30);
  assert.equal(f.store.pendingEffects().length, 1);
  f.store.save(missions, { effects: [effect] });
  assert.equal(f.store.pendingEffects().length, 1);
  assert.equal(budget.budget.summary(budget.mandateId).usedOrHeldCalls, 1);
  const revision = f.store.metadata().revision;
  assert.throws(() => f.store.save([{ ...missions[0], status: 'MUST_ROLL_BACK' }], { effects: [makeEffect({ request: { changed: true } })] }), { code: 'A_DURABLE_EFFECT_CONFLICT' });
  assert.equal(f.store.metadata().revision, revision);
  assert.deepEqual(f.store.load(), missions);
});

test('a later invalid effect rolls back the earlier reservation and entire snapshot', t => {
  const f = fixture(t), budget = configureBudget(f);
  assert.throws(() => f.store.save(missions, { effects: [makeEffect({ budget: budget.spec }), makeEffect({ effectId: 'effect-2', operationId: 'operation-2', missionId: 'missing' })] }), { code: 'A_DURABLE_EFFECT_MISSION_MISSING' });
  assert.equal(f.store.metadata().revision, 0);
  assert.equal(f.store.pendingEffects().length, 0);
  assert.equal(budget.budget.summary(budget.mandateId).usedOrHeldCalls, 0);
});

test('revoked mandate prevents a reserved effect from being claimed', t => {
  const f = fixture(t), budget = configureBudget(f);
  f.store.save(missions, { effects: [makeEffect({ budget: budget.spec })] });
  f.store.operationsStore.revokeMandate(budget.mandateId);
  assert.throws(() => f.store.claimEffect({ effectId: 'effect-1', ownerId: 'worker' }), { code: 'A_DURABLE_MANDATE_CHANGED' });
  assert.equal(f.store.getEffect('effect-1').state, 'prepared');
  assert.equal(budget.budget.get(f.store.getEffect('effect-1').budget_reservation_id).state, 'reserved');
});

test('response loss holds budget, blocks redispatch, and needs operation-bound reconciliation', t => {
  const f = fixture(t), budget = configureBudget(f);
  f.store.save(missions, { effects: [makeEffect({ budget: budget.spec })] });
  const claim = f.store.claimEffect({ effectId: 'effect-1', ownerId: 'worker' });
  f.store.markUncertain({ effectId: 'effect-1', lease: claim.lease });
  assert.equal(f.store.claimEffect({ effectId: 'effect-1', ownerId: 'retry' }), null);
  assert.equal(f.store.pendingEffects().length, 0);
  assert.equal(budget.budget.summary(budget.mandateId).usedOrHeldMinor, 30);
  assert.throws(() => f.store.reconcileEffect({ effectId: 'effect-1', receipt: { receiptRef: 'provider:1' } }), { code: 'A_DURABLE_RECONCILIATION_REQUIRED' });
  const effect = f.store.getEffect('effect-1');
  const reconciliation = { effectId: 'effect-1', reconciliation: { operationId: effect.operation_id, requestSha256: effect.request_sha256, evidenceRef: 'synthetic:provider-read:1' }, receipt: { receiptRef: 'provider:1' }, actualMinor: 20 };
  f.store.reconcileEffect(reconciliation);
  assert.equal(f.store.reconcileEffect(reconciliation).replayed, true);
  assert.equal(f.store.getEffect('effect-1').state, 'succeeded');
  assert.equal(budget.budget.summary(budget.mandateId).usedOrHeldMinor, 20);
  assert.equal(f.store.pendingFollowups().length, 1);
});

test('receipt, settlement and followup roll back together on settlement failure', t => {
  const f = fixture(t), budget = configureBudget(f);
  f.store.save(missions, { effects: [makeEffect({ budget: budget.spec })] });
  const claim = f.store.claimEffect({ effectId: 'effect-1', ownerId: 'worker' });
  const input = { effectId: 'effect-1', lease: claim.lease, receipt: { receiptRef: 'provider:1' }, actualMinor: 31 };
  assert.throws(() => f.store.completeEffect(input), /EXCEEDS_RESERVATION/);
  assert.equal(f.store.getEffect('effect-1').state, 'in_flight');
  assert.equal(f.store.pendingFollowups().length, 0);
  const completed = f.store.completeEffect({ ...input, actualMinor: 20 });
  assert.equal(completed.independentVerification, false);
  assert.equal(f.store.completeEffect({ ...input, actualMinor: 20 }).replayed, true);
  assert.throws(() => f.store.completeEffect({ ...input, actualMinor: 19 }), { code: 'A_DURABLE_RECEIPT_CONFLICT' });
  assert.equal(f.store.pendingFollowups().length, 1);
  assert.equal(f.store.acknowledgeFollowup(completed.eventId).externalDispatch, false);
  assert.equal(f.store.acknowledgeFollowup(completed.eventId).replayed, true);
});

test('fencing rejects an expired owner and backward clock jumps cannot revive its lease', t => {
  const f = fixture(t);
  const first = f.store.acquireLease({ resourceKey: 'test-resource', ownerId: 'old', ttlMs: 100 });
  assert.equal(f.store.acquireLease({ resourceKey: 'test-resource', ownerId: 'new' }), null);
  f.now(START + 101);
  const second = f.store.acquireLease({ resourceKey: 'test-resource', ownerId: 'new' });
  assert.equal(second.token, first.token + 1);
  f.now(START - 1000);
  assert.throws(() => f.store.heartbeatLease(first), { code: 'A_DURABLE_STALE_FENCE' });
  assert.throws(() => f.store.releaseLease(first), { code: 'A_DURABLE_STALE_FENCE' });
  assert.ok(f.store.heartbeatLease(second).expiresMs >= START + 101);
});

test('an expired heartbeat remains expired after rollback of both its transaction and the wall clock', t => {
  const f = fixture(t);
  const lease = f.store.acquireLease({ resourceKey: 'clock', ownerId: 'worker', ttlMs: 100 });
  f.now(START + 101);
  assert.throws(() => f.store.heartbeatLease(lease), { code: 'A_DURABLE_STALE_FENCE' });
  f.now(START - 1000);
  assert.throws(() => f.open().heartbeatLease(lease), { code: 'A_DURABLE_STALE_FENCE' });
});

test('completion can atomically persist its Mission snapshot and never overwrite a newer revision', t => {
  const f = fixture(t);
  f.store.save(missions, { effects: [makeEffect()] });
  const claim = f.store.claimEffect({ effectId: 'effect-1', ownerId: 'worker' });
  const input = { effectId: 'effect-1', lease: claim.lease, receipt: { receiptRef: 'provider:1' }, snapshot: { missions: [{ ...missions[0], status: 'WAITING_VERIFICATION' }], expectedRevision: 0 } };
  assert.throws(() => f.store.completeEffect(input), { code: 'A_MISSION_STORE_REVISION_CONFLICT' });
  assert.equal(f.store.getEffect('effect-1').state, 'in_flight');
  assert.equal(f.store.pendingFollowups().length, 0);
  const completed = f.store.completeEffect({ ...input, snapshot: { ...input.snapshot, expectedRevision: 1 } });
  assert.equal(completed.snapshot.revision, 2);
  assert.equal(f.store.metadata().loadedRevision, 2);
  assert.equal(f.open().load()[0].status, 'WAITING_VERIFICATION');
  assert.equal(f.store.getEffect('effect-1').state, 'succeeded');
});

test('an expired effect is uncertain, cannot be completed by the old worker, and blocks the same resource', t => {
  const f = fixture(t);
  f.store.save(missions, { effects: [makeEffect({ resourceKey: 'shared' }), makeEffect({ effectId: 'effect-2', operationId: 'operation-2', resourceKey: 'shared' })] });
  const claim = f.store.claimEffect({ effectId: 'effect-1', ownerId: 'old', ttlMs: 100 });
  f.now(START + 101);
  assert.deepEqual(f.store.recoverExpiredEffects(), { uncertainEffectIds: ['effect-1'], replayedEffects: 0 });
  assert.equal(f.store.claimEffect({ effectId: 'effect-2', ownerId: 'new' }), null);
  assert.throws(() => f.store.completeEffect({ effectId: 'effect-1', lease: claim.lease, receipt: { receiptRef: 'late' } }), { code: 'A_DURABLE_STALE_FENCE' });
});

test('actual child process kill preserves committed snapshot and rolls back an open SQL transaction', async t => {
  const f = fixture(t);
  const committed = await child(f, 'save');
  assert.equal((await committed.run()).type, 'committed');
  await committed.kill();
  assert.equal(f.open().load()[0].status, 'RUNNING');
  const uncommitted = await child(f, 'uncommitted');
  assert.equal((await uncommitted.run()).type, 'uncommitted');
  await uncommitted.kill();
  const reopened = f.open();
  assert.equal(reopened.load()[0].status, 'RUNNING');
  assert.equal(reopened.metadata().revision, 1);
});

test('two actual worker processes race for one effect and only one gets a dispatch claim', async t => {
  const f = fixture(t);
  f.store.save(missions, { effects: [makeEffect()] });
  const workers = await Promise.all([child(f, 'claim', 'worker-a'), child(f, 'claim', 'worker-b')]);
  try {
    const results = await Promise.all(workers.map(worker => worker.run()));
    assert.equal(results.filter(result => result.claim).length, 1);
    assert.equal(f.open().getEffect('effect-1').state, 'in_flight');
  } finally { await Promise.all(workers.map(worker => worker.kill())); }
});

test('kill after a synthetic provider dispatch becomes uncertain without a second dispatch', async t => {
  const f = fixture(t), budget = configureBudget(f);
  f.store.save(missions, { effects: [makeEffect({ budget: budget.spec })] });
  const worker = await child(f, 'dispatch');
  assert.equal((await worker.run()).type, 'dispatched');
  await worker.kill();
  f.now(START + 101);
  const reopened = f.open();
  assert.deepEqual(reopened.recoverExpiredEffects().uncertainEffectIds, ['effect-1']);
  assert.equal(reopened.claimEffect({ effectId: 'effect-1', ownerId: 'restarted' }), null);
  assert.equal(readFileSync(join(f.root, 'synthetic-provider.jsonl'), 'utf8').trim().split('\n').length, 1);
  assert.equal(budget.budget.get(reopened.getEffect('effect-1').budget_reservation_id).state, 'uncertain');
});

test('kill after receipt commit leaves memory followup retryable without repeating the synthetic provider', async t => {
  const f = fixture(t), budget = configureBudget(f);
  f.store.save(missions, { effects: [makeEffect({ budget: budget.spec })] });
  const worker = await child(f, 'receipt');
  assert.equal((await worker.run()).type, 'receipt-committed');
  await worker.kill();
  const reopened = f.open();
  assert.equal(reopened.getEffect('effect-1').state, 'succeeded');
  assert.equal(reopened.pendingEffects().length, 0);
  assert.equal(reopened.pendingFollowups().length, 1);
  // Simulated F outage leaves the durable event unacknowledged, not a new B dispatch.
  const event = reopened.pendingFollowups()[0];
  assert.throws(() => { throw new Error('synthetic F unavailable'); });
  assert.equal(f.open().pendingFollowups()[0].event_id, event.event_id);
  reopened.acknowledgeFollowup(event.event_id);
  assert.equal(reopened.claimEffect({ effectId: 'effect-1', ownerId: 'restarted' }), null);
  assert.equal(readFileSync(join(f.root, 'synthetic-provider.jsonl'), 'utf8').trim().split('\n').length, 1);
  assert.equal(budget.budget.summary(budget.mandateId).usedOrHeldMinor, 20);
});
