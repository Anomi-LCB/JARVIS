import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import test from 'node:test';
import { PersonalOperationsStore } from '../packages/core/src/personal-operations/operations-store.js';
import { SqliteMissionStore } from '../packages/core/src/mission/sqlite-mission-store.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-local-effect-')), children = new Set();
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { const ended = once(child, 'exit'); child.kill('SIGKILL'); await ended; }
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep) && root.includes('jarvis-local-effect-'));
    rmSync(root, { recursive: true, force: true });
  });
  const calls = () => existsSync(join(root, 'adapter-calls.jsonl')) ? readFileSync(join(root, 'adapter-calls.jsonl'), 'utf8').trim().split('\n').length : 0;
  const verifications = () => existsSync(join(root, 'g-verifications.jsonl')) ? readFileSync(join(root, 'g-verifications.jsonl'), 'utf8').trim().split('\n').length : 0;
  return { root, children, calls, verifications };
}
const details = response => JSON.stringify({ status: response.result?.status, stopReason: response.result?.stopReason,
  error: response.result?.lastError, observations: response.result?.observations?.map(item => ({ outcome: item.outcome, error: item.error })),
  recovery: response.result?.waves?.[0]?.actions?.[0]?.recovery, effect: response.effect?.state });

for(const mode of ['cognition-failure-kill-graph','cognition-f-store-failure-graph','cognition-work-memory-throw-graph','cognition-work-memory-false-graph','cognition-failure-kill-second-graph','cognition-f-store-failure-second-graph'])
test(`dependent graph repairs ${mode} before executing the next action once`,async t=>{
 const f=fixture(t),initial=await launch(f,mode);
 const late=mode.includes('-second-');
 assert.equal((await initial.run()).boundary,mode);assert.equal(f.calls(),late?2:1);await initial.kill();
 assert.equal(readFileSync(join(f.root,'workspace','first.txt'),'utf8'),'durable graph first');
 assert.equal(existsSync(join(f.root,'workspace','second.txt')),late);
 const repaired=await(await launch(f,'cognition-resume-graph')).run();
 assert.equal(repaired.result.status,'COMPLETED',details(repaired));assert.equal(f.calls(),2);assert.equal(repaired.cognitionEpisodes,2);assert.equal(repaired.pendingFollowups,0);
 assert.equal(readFileSync(join(f.root,'workspace','second.txt'),'utf8'),'durable graph second');
 const repeated=await(await launch(f,'cognition-resume-graph')).run();assert.equal(repeated.result.status,'COMPLETED',details(repeated));assert.equal(f.calls(),2);assert.equal(repeated.cognitionEpisodes,2);
 t.diagnostic(JSON.stringify({mode,graphActions:2,actualAdapterCalls:f.calls(),cognitionEpisodes:repeated.cognitionEpisodes,pendingFollowups:repeated.pendingFollowups,duplicateB:false}));
});

test('authority revoked after claim or inside adapter shadow cannot produce a local file effect', async t => {
  for (const mode of ['revoke-quota-claimed', 'revoke-quota-inside-adapter', 'revoke-owner-claimed', 'revoke-owner-inside-adapter',
    'revoke-connection-claimed', 'revoke-connection-inside-adapter']) {
    const f = fixture(t), child = await launch(f, mode), result = await child.run();
    assert.equal(result.revocationBoundary, mode.endsWith('-claimed') ? 'claimed' : 'adapter-shadow',
      `${mode}: the actual revocation stimulus must reach its boundary`);
    assert.notEqual(result.result.status, 'COMPLETED', `${mode}: ${details(result)}`);
    assert.equal(f.calls(), 0, `${mode}: adapter must not publish a file`);
    assert.equal(existsSync(join(f.root, 'workspace/result.txt')), false, mode);
    assert.notEqual(result.effect.state, 'succeeded', mode);
  }
});

test('Core authority expiry fences an actual file action after claim and inside adapter shadow',async t=>{
  for(const mode of ['core-authority-claimed','core-authority-inside-adapter']) {
    const f=fixture(t),child=await launch(f,mode),result=await child.run();
    assert.equal(result.revocationBoundary,mode.endsWith('-claimed')?'claimed':'adapter-shadow');
    assert.notEqual(result.result.status,'COMPLETED',details(result));
    assert.equal(f.calls(),0);assert.equal(existsSync(join(f.root,'workspace/result.txt')),false);
    assert.notEqual(result.effect.state,'succeeded');
  }
});

test('a current Core authority completes one real local E/B/G file action',async t=>{
  const f=fixture(t),child=await launch(f,'core-authority-normal'),result=await child.run();
  assert.equal(result.result.status,'COMPLETED',details(result));assert.equal(f.calls(),1);
  assert.equal(result.effect.state,'succeeded');
});
async function launch(f, mode, time = '2026-09-27T00:00:00Z') {
  const child = fork(new URL('./fixtures/local-mission-effect-child.mjs', import.meta.url), [f.root, mode, time],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  f.children.add(child);
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const next = (allowError = false) => new Promise((resolveMessage, reject) => {
    const cleanup = () => { clearTimeout(timer); child.off('message', onMessage); child.off('exit', onExit); };
    const onMessage = message => { cleanup(); message.type === 'error' && !allowError ? reject(new Error(`${message.message}\n${message.stack}`)) : resolveMessage(message); };
    const onExit = code => { cleanup(); reject(new Error(`child exited ${code}: ${stderr}`)); };
    const timer = setTimeout(() => { cleanup(); reject(new Error(`child timed out: ${stderr}`)); }, 20_000);
    child.once('message', onMessage); child.once('exit', onExit);
  });
  assert.equal((await next()).type, 'ready');
  return { child, async run() { const reply = next(); child.send('run'); return reply; },
    async resumeBoundary() { const reply = next(true); child.send('continue'); return reply; },
    async kill() { const ended = once(child, 'exit'); child.kill('SIGKILL'); await ended; f.children.delete(child); } };
}

test('real Mission/E/B/G local file action records intent, receipt and independently verified completion', async t => {
  const f = fixture(t), child = await launch(f, 'normal'), result = await child.run();
  assert.equal(result.enabled, true);
  assert.equal(result.result.status, 'COMPLETED', details(result));
  assert.equal(result.effect.state, 'succeeded');
  assert.equal(result.pendingFollowups, 0);
  assert.equal(f.calls(), 1);
  assert.equal(f.verifications(), 1);
  assert.equal(result.workMemoryCount, 1);
  const dispatched = JSON.parse(readFileSync(join(f.root, 'adapter-calls.jsonl'), 'utf8').trim());
  assert.equal(dispatched.idempotencyKey, result.effect.operation_id);
  assert.equal(dispatched.idempotencyKey, result.effect.provider_idempotency_key);
  assert.equal(readFileSync(join(f.root, 'workspace/result.txt'), 'utf8'), 'actual durable local effect');
});

test('actual Core/E/B/G provider adapter runs outside SQLite transaction and permits an independent writer', async t => {
  const f=fixture(t),child=await launch(f,'transaction-observation'),result=await child.run();
  assert.equal(result.result.status,'COMPLETED',details(result));assert.equal(f.calls(),1);
  const observations=readFileSync(join(f.root,'transaction-observation.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(observations,[{phase:'before-actual-B',transactionOpen:false,independentWriterCommitted:true},{phase:'after-actual-B',transactionOpen:false}]);
  assert.equal(result.effect.state,'succeeded');assert.equal(result.pendingFollowups,0);
  t.diagnostic(JSON.stringify({actualCoreEBG:true,transactionObservations:observations,actualLocalAdapterCalls:f.calls()}));
});

test('an unresolved filename retains the existing failure and is never claimed as a durable connected effect', async t => {
  const baseline = fixture(t), durable = fixture(t);
  const oldResult = await (await launch(baseline, 'implicit-path-file')).run();
  const newResult = await (await launch(durable, 'implicit-path')).run();
  assert.equal(oldResult.result.status, 'BLOCKED'); assert.equal(newResult.result.status, oldResult.result.status);
  assert.equal(newResult.result.observations[0].error.code, oldResult.result.observations[0].error.code);
  assert.equal(newResult.effect, null); assert.equal(oldResult.effect, null);
  assert.equal(durable.calls(), 0); assert.equal(baseline.calls(), 0);
});

for (const mode of ['prepared', 'file-effect', 'b-receipt', 'receipt-persisted', 'after-G']) {
  test(`actual process kill at ${mode} resumes without duplicating the file effect`, async t => {
    const f = fixture(t), child = await launch(f, mode);
    const stopped = await child.run(); assert.equal(stopped.type, 'boundary', details(stopped)); assert.equal(stopped.boundary, mode);
    await child.kill();
    assert.equal(f.calls(), mode === 'prepared' ? 0 : 1);
    const restarted = await launch(f, 'resume', '2026-09-27T00:02:00Z');
    const result = await restarted.run();
    assert.equal(result.result.status, mode === 'file-effect' ? 'PAUSED' : 'COMPLETED', details(result));
    assert.equal(result.effect.state, mode === 'file-effect' ? 'uncertain' : 'succeeded');
    assert.equal(f.calls(), 1);
    assert.equal(result.pendingFollowups, 0);
    assert.equal(f.verifications(), mode === 'file-effect' ? 0 : mode === 'after-G' ? 2 : 1);
    assert.equal(result.workMemoryCount, mode === 'file-effect' ? 0 : 1);
    if (mode === 'file-effect') {
      const second = await launch(f, 'resume', '2026-09-27T00:03:00Z'), again = await second.run();
      assert.equal(again.result.status, 'PAUSED'); assert.equal(f.calls(), 1);
    } else {
      const count = f.verifications(), memoryCount = result.workMemoryCount;
      const again = await (await launch(f, 'resume')).run();
      assert.equal(again.result.status, 'COMPLETED'); assert.equal(f.calls(), 1);
      assert.equal(f.verifications(), count); assert.equal(again.workMemoryCount, memoryCount); assert.equal(again.pendingFollowups, 0);
    }
    t.diagnostic(JSON.stringify({ scenario: mode, actualChildKill: true, actualAdapterCalls: f.calls(),
      status: result.result.status, effectState: result.effect.state, gChecks: f.verifications(), workMemoryCount: result.workMemoryCount,
      pendingFollowups: result.pendingFollowups, fixtureTrust: result.fixtureTrust, externalCalls: 0 }));
  });
}

test('changed output after a durable receipt stays pending and is never overwritten on recovery', async t => {
  const f = fixture(t), child = await launch(f, 'receipt-persisted');
  await child.run(); await child.kill();
  writeFileSync(join(f.root, 'workspace/result.txt'), 'user changed this file');
  const restarted = await launch(f, 'resume', '2026-09-27T00:02:00Z'), result = await restarted.run();
  assert.equal(result.result.status, 'PAUSED'); assert.equal(result.pendingFollowups, 1);
  assert.equal(f.calls(), 1); assert.equal(readFileSync(join(f.root, 'workspace/result.txt'), 'utf8'), 'user changed this file');
});

test('B checks the fence after asynchronous shadow and refuses an expired claim before any file effect', async t => {
  const f = fixture(t), child = await launch(f, 'expire-before-effect'), result = await child.run();
  assert.equal(result.result.status, 'PAUSED', details(result));
  assert.equal(result.effect.state, 'uncertain'); assert.equal(f.calls(), 0); assert.equal(f.verifications(), 0);
});

test('a lease expiring inside the file adapter is rechecked before mkdir or write', async t => {
  const f = fixture(t), child = await launch(f, 'expire-inside-adapter'), result = await child.run();
  assert.equal(result.result.status, 'PAUSED', details(result)); assert.equal(result.effect.state, 'uncertain');
  assert.equal(f.calls(), 0); assert.equal(existsSync(join(f.root, 'workspace/result.txt')), false);
});

test('two actual Core processes cannot redispatch an unresolved effect and an old claimant is fenced before B', async t => {
  const f = fixture(t), old = await launch(f, 'claimed');
  assert.equal((await old.run()).boundary, 'claimed');
  const newer = await launch(f, 'resume'), result = await newer.run();
  assert.equal(result.result.status, 'PAUSED', details(result)); assert.equal(result.effect.state, 'uncertain'); assert.equal(f.calls(), 0);
  const oldResult = await old.resumeBoundary();
  assert.ok(oldResult.type === 'error' || oldResult.result.status !== 'COMPLETED');
  assert.equal(f.calls(), 0, 'the delayed old owner must fail its fence before adapter.execute');
  t.diagnostic(JSON.stringify({ scenario: 'two-core-fence-before-B', processes: 2, actualAdapterCalls: 0,
    newStatus: result.result.status, oldResult: oldResult.type, externalCalls: 0 }));
});

test('SQL prepared failure cannot release an in-flight or uncertain effect', t => {
  const f = fixture(t), operations = new PersonalOperationsStore({ dbPath: join(f.root, 'operations.sqlite') });
  const store = new SqliteMissionStore({ operationsStore: operations });
  store.save([{ missionId: 'm' }], { effects: [{ effectId: 'e', operationId: 'o', missionId: 'm', request: { synthetic: true } }] });
  const claim = store.claimEffect({ effectId: 'e', ownerId: 'owner' });
  assert.throws(() => store.failUndispatchedEffect({ effectId: 'e' }), { code: 'A_DURABLE_EFFECT_ALREADY_DISPATCHED' });
  store.markUncertain({ effectId: 'e', lease: claim.lease });
  assert.throws(() => store.failUndispatchedEffect({ effectId: 'e' }), { code: 'A_DURABLE_EFFECT_ALREADY_DISPATCHED' });
  operations.close();
});

for (const mode of ['f-store-failure', 'work-memory-throw', 'work-memory-false']) {
  test(`a durable ${mode} keeps the followup pending until a fresh Core persists both memories without B replay`, async t => {
    const f = fixture(t), failed = await (await launch(f, mode)).run();
    assert.equal(failed.result.status, 'PAUSED', details(failed));
    assert.equal(failed.pendingFollowups, 1);
    assert.equal(failed.workMemoryCount, 0);
    assert.equal(failed.growthMemoryCount, mode === 'f-store-failure' ? 0 : 1);
    assert.equal(f.calls(), 1);
    const recovered = await (await launch(f, 'resume')).run();
    assert.equal(recovered.result.status, 'COMPLETED', details(recovered));
    assert.equal(recovered.growthMemoryCount, 1); assert.equal(recovered.workMemoryCount, 1);
    assert.equal(recovered.pendingFollowups, 0); assert.equal(f.calls(), 1);
    const final = await (await launch(f, 'resume')).run();
    assert.equal(final.growthMemoryCount, 1); assert.equal(final.workMemoryCount, 1); assert.equal(f.calls(), 1);
    t.diagnostic(JSON.stringify({ scenario: mode, firstStatus: failed.result.status, firstPending: failed.pendingFollowups,
      finalStatus: final.result.status, finalPending: final.pendingFollowups, growthMemoryCount: final.growthMemoryCount,
      workMemoryCount: final.workMemoryCount, actualAdapterCalls: f.calls(), externalCalls: 0 }));
  });
}

for (const mode of ['resume-f-store-failure', 'resume-work-memory-false']) {
  test(`recovery ${mode} cannot ACK a receipt before its memory append succeeds`, async t => {
    const f = fixture(t), initial = await launch(f, 'receipt-persisted'); await initial.run(); await initial.kill();
    const failed = await (await launch(f, mode)).run();
    assert.equal(failed.result.status, 'PAUSED', details(failed)); assert.equal(failed.pendingFollowups, 1);
    const recovered = await (await launch(f, 'resume')).run();
    assert.equal(recovered.result.status, 'COMPLETED', details(recovered));
    assert.equal(recovered.growthMemoryCount, 1); assert.equal(recovered.workMemoryCount, 1);
    assert.equal(recovered.pendingFollowups, 0); assert.equal(f.calls(), 1);
  });
}

test('two actual Windows Cores bind case aliases of one not-yet-created file to the same resource lease', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t), first = await launch(f, 'case-alias-first'); assert.equal((await first.run()).boundary, 'claimed');
  const second = await (await launch(f, 'case-alias-second')).run();
  assert.notEqual(second.result.status, 'COMPLETED', details(second)); assert.equal(f.calls(), 0);
  const operations = new PersonalOperationsStore({ dbPath: join(f.root, 'operations.sqlite') });
  const rows = operations.db.prepare('SELECT resource_key,state,mission_id,operation_id FROM mission_effects ORDER BY created_at').all();
  operations.close();
  assert.equal(rows.length, 2, JSON.stringify(rows)); assert.equal(new Set(rows.map(row => row.resource_key)).size, 1);
  assert.equal(rows.filter(row => row.state === 'in_flight').length, 1);
  const original = await first.resumeBoundary();
  assert.ok(original.type === 'error' || original.result.status !== 'COMPLETED', 'a stale snapshot owner cannot overwrite the newer Mission snapshot');
  assert.equal(f.calls(), 1);
  assert.equal(readFileSync(join(f.root, 'workspace/result.txt'), 'utf8'), 'actual durable local effect');
  t.diagnostic(JSON.stringify({ scenario: 'windows-case-alias-two-cores', actualAdapterCalls: 1, resourceIdentities: 1, effects: 2, externalCalls: 0 }));
});

test('cognition append failure followed by actual Core termination recovers the episode without a second B call',async t=>{
 const f=fixture(t),initial=await launch(f,'cognition-failure-kill');
 const stopped=await initial.run();assert.equal(stopped.boundary,'cognition-failure-kill');assert.equal(f.calls(),1);await initial.kill();
 const resumed=await(await launch(f,'cognition-resume')).run();
 assert.equal(resumed.result.status,'COMPLETED',details(resumed));assert.equal(f.calls(),1);assert.equal(resumed.cognitionEpisodes,1);
});

test('cognition recovery rejects cloned and mutated G objects, then stores one scoped episode',async t=>{
 const f=fixture(t),initial=await launch(f,'cognition-failure-kill');await initial.run();await initial.kill();
 const result=await(await launch(f,'cognition-resume-proofs')).run();assert.deepEqual(result.cognitiveProofChecks,{cloneRejected:true,mutationRejected:true});
 assert.equal(result.cognitionEpisodes,1);assert.equal(result.result.status,'COMPLETED');assert.equal(f.calls(),1);
 const again=await(await launch(f,'cognition-resume')).run();assert.equal(again.cognitionEpisodes,1);assert.equal(f.calls(),1);
});
test('repeated cognition storage failure retains the durable followup without repeating B',async t=>{
 const f=fixture(t),initial=await launch(f,'cognition-failure-kill');await initial.run();await initial.kill();
 const failed=await(await launch(f,'cognition-resume-still-failing')).run();assert.equal(failed.result.status,'PAUSED');assert.equal(failed.pendingFollowups,1);assert.equal(failed.cognitionEpisodes,0);assert.equal(f.calls(),1);
 const result=await(await launch(f,'cognition-resume')).run();assert.equal(result.result.status,'COMPLETED');assert.equal(result.cognitionEpisodes,1);assert.equal(result.pendingFollowups,0);assert.equal(f.calls(),1);
});
test('source retraction excludes cognition replay and changed artifact blocks new cognition proof',async t=>{
 for(const mode of ['retracted','changed']){
  const f=fixture(t),initial=await launch(f,'cognition-failure-kill');await initial.run();await initial.kill();
  if(mode==='changed')writeFileSync(join(f.root,'workspace/result.txt'),'changed after execution');
  const result=await(await launch(f,mode==='retracted'?'cognition-resume-retracted':'cognition-resume')).run();
  assert.equal(result.cognitionEpisodes,0);assert.equal(f.calls(),1);
  assert.equal(result.result.status,mode==='retracted'?'COMPLETED':'PAUSED');
 }
});

test('kill immediately after cognition write failure before Mission pause restores memory only',async t=>{
 const f=fixture(t),initial=await launch(f,'cognition-failure-observe-kill');
 assert.equal((await initial.run()).boundary,'cognition-write-failed');await initial.kill();assert.equal(f.calls(),1);
 const result=await(await launch(f,'cognition-resume')).run();assert.equal(result.result.status,'COMPLETED',details(result));assert.equal(result.cognitionEpisodes,1);assert.equal(result.pendingFollowups,0);assert.equal(f.calls(),1);
});

test('cognition replay cannot substitute a different approved plan for the durable intent',async t=>{
 const f=fixture(t),initial=await launch(f,'cognition-failure-kill');await initial.run();await initial.kill();
 const result=await(await launch(f,'cognition-resume-plan-mismatch')).run();assert.equal(result.result.status,'PAUSED');assert.equal(result.cognitionEpisodes,0);assert.equal(result.pendingFollowups,1);assert.equal(f.calls(),1);
});

for(const boundary of ['outcome','goal'])test(`cognition ${boundary} write failure and Core termination restore one joined result without B replay`,async t=>{
 const f=fixture(t),mode='cognition-failure-kill-'+boundary,initial=await launch(f,mode);
 assert.equal((await initial.run()).boundary,mode);await initial.kill();
 const result=await(await launch(f,'cognition-resume')).run();assert.equal(result.result.status,'COMPLETED',details(result));assert.equal(result.cognitionEpisodes,1);assert.equal(result.pendingFollowups,0);assert.equal(f.calls(),1);
});
