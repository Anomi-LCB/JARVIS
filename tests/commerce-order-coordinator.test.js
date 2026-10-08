import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { PersonalOperationsStore } from '../packages/core/src/personal-operations/operations-store.js';
import { CommerceOrderCoordinator } from '../packages/core/src/personal-operations/commerce-order-coordinator.js';
import { createCoreServer } from '../packages/core/src/main.mjs';
import { listenOnFetchSafePort } from '../packages/shared/src/http.js';

const order = { active: true, revision: '1', providerId: 'test', binding: { endpoint: 'isolated:test', version: '1' }, checkoutId: 'checkout',
  expiresAt: '2099-01-01T00:00:00Z', quoteEvidenceSha256: 'c'.repeat(64),
  request: { action: 'commerce.order', target: 'provider:test', currency: 'KRW', amountMinor: 100 },
  expected: { orderId: 'order', currency: 'KRW', totalMinor: 100 } };
const proof = { verified: true, checkoutId: 'checkout', orderId: 'order', currency: 'KRW', totalMinor: 100,
  receiptRef: 'receipt', evidenceSha256: 'a'.repeat(64) };
function fixture(t, patch = {}) {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-commerce-')), path = join(root, 'db.sqlite');
  const store = new PersonalOperationsStore({ dbPath: path });
  const mandate = store.createMandate({ action: 'commerce.order', target: 'provider:test', currency: 'KRW', maxAmountMinor: 100,
    validFrom: '2020-01-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z' });
  let calls = 0, lookups = 0;
  const adapter = { providerId: 'test', binding: order.binding, supportsBeforeCommit:true, complete: async ({beforeCommit}) => { assert.equal(await beforeCommit(),true); calls++; return {}; }, lookup: async () => { lookups++; return {}; } };
  const options = { adapter, authorize: () => true, resolveOrder: () => structuredClone(order), verifyReceipt: () => structuredClone(proof), ...patch };
  const c = new CommerceOrderCoordinator(store, options);
  c.budget.configure({ mandateId: mandate.id, totalMinor: 200, maxCalls: 2 });
  const stores = [store];
  t.after(() => { for (const opened of stores) opened.close(); rmSync(root, { recursive: true, force: true }); });
  return { path, store, stores, mandate, c, options, adapter, calls: () => calls, lookups: () => lookups,
    prepare: () => c.prepare({ mandateId: mandate.id, requestId: 'request', checkoutId: 'checkout' }) };
}
test('valid order verifies once; replay is lookup-only and uses the same immutable key', async t => {
  const f = fixture(t), a = await f.prepare();
  assert.equal((await f.prepare()).reservationId, a.reservationId);
  const result = await f.c.dispatch(a.reservationId);
  assert.equal(result.receiptVerified, true); assert.equal(result.fundsSettlementObserved, false);
  await assert.rejects(f.c.dispatch(a.reservationId), /NO_REDISPATCH/);
  await f.c.reconcile(a.reservationId);
  assert.equal(f.calls(), 1); assert.equal(f.lookups(), 1);
  assert.equal(f.c.budget.summary(f.mandate.id).usedOrHeldCalls, 1);
});
test('response loss retains budget; reopening reconciles after revocation without a new order', async t => {
  const f = fixture(t), a = await f.prepare(); let attempts = 0, key;
  f.adapter.complete = async input => { attempts++; key = input.idempotencyKey; throw Error('lost'); };
  await assert.rejects(f.c.dispatch(a.reservationId), /UNCERTAIN/);
  f.store.revokeMandate(f.mandate.id);
  const reopened = new PersonalOperationsStore({ dbPath: f.path });
  f.stores.push(reopened);
  const c = new CommerceOrderCoordinator(reopened, { ...f.options, adapter: { ...f.adapter,
    lookup: async input => { assert.equal(input.idempotencyKey, key); return {}; } } });
  assert.equal(c.get(a.reservationId).state, 'uncertain');
  assert.equal(c.budget.summary(f.mandate.id).usedOrHeldMinor, 100);
  await assert.rejects(c.dispatch(a.reservationId), /NO_REDISPATCH/);
  assert.equal((await c.reconcile(a.reservationId)).receiptVerified, true); assert.equal(attempts, 1);
});
test('two coordinators racing for one reservation dispatch at most once', async t => {
  const f = fixture(t), a = await f.prepare();
  const other = new PersonalOperationsStore({ dbPath: f.path }); f.stores.push(other);
  const c = new CommerceOrderCoordinator(other, f.options);
  const results = await Promise.allSettled([f.c.dispatch(a.reservationId), c.dispatch(a.reservationId)]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1); assert.equal(f.calls(), 1);
});
test('policy refusal, changed order, adapter replacement and revoked mandate cannot dispatch', async t => {
  for (const condition of ['policy', 'order', 'adapter', 'revoked']) {
    const f = fixture(t), a = await f.prepare();
    if (condition === 'policy') f.c.authorize = () => false;
    if (condition === 'order') f.c.resolveOrder = () => ({ ...order, revision: '2' });
    if (condition === 'adapter') f.adapter.binding = { endpoint: 'other' };
    if (condition === 'revoked') f.store.revokeMandate(f.mandate.id);
    await assert.rejects(f.c.dispatch(a.reservationId)); assert.equal(f.calls(), 0);
    assert.equal(f.c.get(a.reservationId).state, 'reserved');
  }
});
test('revocation while asynchronous policy is pending stops the network call', async t => {
  const f = fixture(t), a = await f.prepare();
  f.c.authorize = async () => { f.store.revokeMandate(f.mandate.id); return true; };
  await assert.rejects(f.c.dispatch(a.reservationId), /DENIED/); assert.equal(f.calls(), 0);
});
for(const condition of ['revoked','policy','order','adapter-replaced','complete-replaced','fence-removed'])test(`final commit fence blocks ${condition} after adapter preparation`,async t=>{
 const f=fixture(t),prepared=await f.prepare();let posts=0;
 f.adapter.supportsBeforeCommit=true;
 f.adapter.complete=async({beforeCommit})=>{
  if(condition==='revoked')f.store.revokeMandate(f.mandate.id);
  if(condition==='policy')f.c.authorize=()=>false;
  if(condition==='order')f.c.resolveOrder=()=>({...order,revision:'2'});
  if(condition==='adapter-replaced')f.c.adapter={...f.adapter};
  if(condition==='complete-replaced')f.adapter.complete=async()=>({});
  if(condition==='fence-removed')f.adapter.supportsBeforeCommit=false;
  if(typeof beforeCommit==='function')assert.equal(await beforeCommit(),true);
  posts++;return {};
 };
 await assert.rejects(f.c.dispatch(prepared.reservationId),/UNCERTAIN/);
 assert.equal(posts,0);assert.equal(f.c.get(prepared.reservationId).state,'uncertain');
 await assert.rejects(f.c.dispatch(prepared.reservationId),/NO_REDISPATCH/);
});
test('quote expiry during policy review stops dispatch even with an unchanged quote', async t => {
  const f = fixture(t), a = await f.prepare();
  f.c.authorize = async () => { f.store.clock = () => new Date('2100-01-01T00:00:00Z'); return true; };
  await assert.rejects(f.c.dispatch(a.reservationId), /QUOTE_EXPIRED/);
  assert.equal(f.calls(), 0); assert.equal(f.c.get(a.reservationId).state, 'reserved');
});
test('wrong receipt fields and unsigned success never settle a dispatched order', async t => {
  for (const patch of [{ verified: false }, { checkoutId: 'other' }, { orderId: 'other' }, { currency: 'USD' }, { totalMinor: 99 }, { evidenceSha256: 'bad' }]) {
    const f = fixture(t, { verifyReceipt: () => ({ ...proof, ...patch }) }), a = await f.prepare();
    await assert.rejects(f.c.dispatch(a.reservationId), /UNCERTAIN/);
    assert.equal(f.c.get(a.reservationId).receiptVerified, false);
    assert.equal(f.c.budget.summary(f.mandate.id).usedOrHeldMinor, 100);
  }
});
test('empty lookup does not release budget or retry; changed evidence cannot overwrite an existing proof', async t => {
  const f = fixture(t), a = await f.prepare();
  f.adapter.complete = async () => { throw Error('lost'); }; f.adapter.lookup = async () => null;
  await assert.rejects(f.c.dispatch(a.reservationId));
  assert.equal((await f.c.reconcile(a.reservationId)).nextAction, 'provider-reconciliation-required');
  f.adapter.lookup = async () => ({}); await f.c.reconcile(a.reservationId);
  f.c.verifyReceipt = () => ({ ...proof, evidenceSha256: 'b'.repeat(64) });
  await assert.rejects(f.c.reconcile(a.reservationId), /EVIDENCE_CONFLICT/);
  assert.equal(f.c.get(a.reservationId).evidenceSha256, 'a'.repeat(64));
});
test('accounting write followed by metadata loss is repaired by verified lookup', async t => {
  const f = fixture(t), a = await f.prepare(); await f.c.dispatch(a.reservationId);
  f.store.db.prepare('UPDATE personal_commerce_orders SET evidence_hash=NULL,verified_at=NULL WHERE reservation_id=?').run(a.reservationId);
  assert.equal(f.c.get(a.reservationId).receiptVerified, false);
  assert.equal((await f.c.reconcile(a.reservationId)).receiptVerified, true); assert.equal(f.calls(), 1);
});
test('unconfigured policy and adapter stay closed', async t => {
  const f = fixture(t), a = await f.prepare(), c = new CommerceOrderCoordinator(f.store);
  assert.equal(c.status().configured, false); await assert.rejects(c.dispatch(a.reservationId), /ADAPTER/);
  assert.equal(f.calls(), 0);
});
test('Core HTTP enforces admin scope, exact request fields and lookup-only replay', async t => {
  const f = fixture(t), server = createCoreServer(undefined, { adminToken: 'commerce-test', commerceOrderCoordinator: f.c });
  const address = await listenOnFetchSafePort(server, { host: '127.0.0.1', port: 0 });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${address.port}/commerce/orders`;
  const post = (method, input, token = 'commerce-test') => fetch(`${url}/${method}`, { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(input) });
  const input = { mandateId: f.mandate.id, requestId: 'http', checkoutId: 'checkout' };
  assert.equal((await post('prepare', input, 'bad')).status, 401);
  assert.equal((await post('prepare', { ...input, password: 'must-not-be-stored' })).status, 400);
  const a = await (await post('prepare', input)).json();
  assert.equal((await post('dispatch', { reservationId: a.reservationId })).status, 200);
  assert.equal((await post('dispatch', { reservationId: a.reservationId })).status, 409);
  assert.equal((await post('reconcile', { reservationId: a.reservationId })).status, 200);
  assert.equal(f.calls(), 1);
});
test('Core has no live order adapter by default', async t => {
  const server = createCoreServer(undefined, { adminToken: 'commerce-test' });
  const address = await listenOnFetchSafePort(server, { host: '127.0.0.1', port: 0 });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${address.port}/commerce/orders`;
  const headers = { authorization: 'Bearer commerce-test', 'content-type': 'application/json' };
  assert.equal((await (await fetch(`${url}/status`, { headers })).json()).configured, false);
  assert.equal((await fetch(`${url}/dispatch`, { method: 'POST', headers, body: '{}' })).status, 503);
});
test('expired quote or an attempt to persist credentials is rejected before dispatch', async t => {
  const f = fixture(t);
  for (const extra of [{ expiresAt: '2020-01-01T00:00:00Z' }, { token: 'secret' }, { binding: { ...order.binding, password: 'secret' } }]) {
    f.c.resolveOrder = () => ({ ...order, ...extra });
    await assert.rejects(f.prepare(), /REVIEWED_ORDER_REQUIRED/);
  }
  assert.equal(f.calls(), 0); assert.equal(f.c.budget.summary(f.mandate.id).usedOrHeldCalls, 0);
});
test('real child process death after dispatch boundary survives reopening and permits lookup only', async t => {
  const f = fixture(t), a = await f.prepare();
  const source = `import {PersonalOperationsStore} from './packages/core/src/personal-operations/operations-store.js';
    import {CommerceOrderCoordinator} from './packages/core/src/personal-operations/commerce-order-coordinator.js';
    const store=new PersonalOperationsStore({dbPath:process.argv[1]});
    const order=${JSON.stringify(order)};
    const c=new CommerceOrderCoordinator(store,{resolveOrder:()=>order,authorize:()=>true,
      adapter:{providerId:'test',binding:order.binding,supportsBeforeCommit:true,lookup:async()=>null,complete:async({beforeCommit})=>{await beforeCommit();process.stdout.write('DISPATCHED\\n');await new Promise(()=>{});}}});
    setInterval(()=>{},1000);await c.dispatch(process.argv[2]);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, f.path, a.reservationId], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', x => { stderr += x; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(Error('child boundary timeout')); }, 10000);
    child.once('error', e => { clearTimeout(timer); reject(e); });
    child.once('exit', () => { clearTimeout(timer); reject(Error(stderr)); });
    child.stdout.once('data', x => { clearTimeout(timer); assert.match(x.toString(), /DISPATCHED/); resolve(); });
  });
  await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
  assert.equal(f.c.get(a.reservationId).state, 'in_flight');
  await assert.rejects(f.c.dispatch(a.reservationId), /NO_REDISPATCH/);
  assert.equal((await f.c.reconcile(a.reservationId)).receiptVerified, true); assert.equal(f.calls(), 0);
});
