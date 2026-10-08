import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RemoteOperationStore } from '../apps/pc-agent/src/remote-operation-store.js';
import { inspectPublicationContract } from '../apps/pc-agent/src/remote-operation-store.js';

const descriptor = (operationId, keys) => ({ operationId, taskId: operationId,
  fingerprint: 'a'.repeat(64), authorizationHash: 'b'.repeat(64), resourceKey: keys[0], resourceKeys: keys });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-multi-resource-'));
  const stores = [], children = [];
  t.after(async () => { for (const child of children) if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit'); child.kill(); await exited;
  } for (const store of stores) { try { store.close(); } catch {} } await rm(root, { recursive: true, force: true }); });
  const path = join(root, 'operations.sqlite');
  const open = () => { const store = new RemoteOperationStore({ path }); stores.push(store); return store; };
  return { root, path, open, children };
}

test('multi-resource claim collides with single-file claim on any shared target and rolls back all claims', async t => {
  const f = await fixture(t), store = f.open();
  const first = descriptor('first', ['file-b', 'file-a']);
  const prepared = store.prepare(first); store.claim(first, prepared.ticket, prepared.generation);
  for (const [id, keys] of [['single', ['file-a']], ['overlap', ['file-c', 'file-b']]]) {
    const next = descriptor(id, keys), ticket = store.prepare(next);
    assert.throws(() => store.claim(next, ticket.ticket, ticket.generation), error => error.code === 'B_OPERATION_RESOURCE_UNRESOLVED');
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM remote_operation_claims WHERE operation_id=?').get(id).n, 0);
  }
  assert.throws(() => store.prepare({ ...first, resourceKeys: ['file-b', 'file-c'] }), error => error.code === 'B_OPERATION_RESOURCE_CHANGED');
  store.complete(first, { syntheticReceipt: true });
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM remote_operation_claims').get().n, 0);
  const next = descriptor('single', ['file-a']), ticket = store.prepare(next);
  store.claim(next, ticket.ticket, ticket.generation);
});

test('restart keeps every unresolved resource claimed instead of reclaiming a timed-out operation', async t => {
  const f = await fixture(t), store = f.open(), first = descriptor('first', ['file-a', 'file-b']);
  const ticket = store.prepare(first); const fence = store.claim(first, ticket.ticket, ticket.generation);
  const restarted = f.open();
  assert.equal(restarted.row('first').state, 'uncertain');
  assert.throws(() => store.assertFence(fence), error => error.code === 'B_OPERATION_STALE_FENCE');
  const second = descriptor('second', ['file-b']), other = restarted.prepare(second);
  assert.throws(() => restarted.claim(second, other.ticket, other.generation), error => error.code === 'B_OPERATION_RESOURCE_UNRESOLVED');
});

test('legacy single-key rows are migrated into the same unresolved resource claims', async t => {
  const f = await fixture(t), store = f.open(), first = descriptor('legacy', ['file-a']);
  const ticket = store.prepare(first); store.claim(first, ticket.ticket, ticket.generation);
  store.db.prepare('UPDATE remote_operations SET resource_keys_json=NULL').run();
  store.db.prepare('DELETE FROM remote_operation_claims').run();
  const migrated = f.open();
  assert.equal(migrated.db.prepare('SELECT operation_id FROM remote_operation_claims WHERE resource_key=?').get('file-a').operation_id, 'legacy');
});

test('frozen publication intent rejects replacement, old fences and mismatched observation without releasing claims', async t => {
  const f = await fixture(t), store = f.open(), first = descriptor('contract', ['file-a', 'file-b']);
  const ticket = store.prepare(first), claim = store.claim(first, ticket.ticket, ticket.generation);
  const intent = { version: 'workflow-publication-journal-v1', phase: 'prepared', taskId: first.taskId,
    publicationOperationId: first.operationId, files: [{ path: 'synthetic-a', afterSha256: 'd'.repeat(64) }] };
  const digest = store.recordPublicationIntent(first, claim, intent);
  assert.equal(store.recordPublicationIntent(first, claim, intent), digest);
  assert.throws(() => store.recordPublicationIntent(first, claim, { ...intent, files: [] }), error => error.code === 'B_PUBLICATION_CONTRACT_CHANGED');
  const observed = inspectPublicationContract(f.path, { operationId: first.operationId, taskId: first.taskId, intentSha256: digest });
  assert.equal(observed.status, 'bound');
  for (const patch of [{ taskId: 'other' }, { intentSha256: 'c'.repeat(64) }]) {
    assert.equal(inspectPublicationContract(f.path, { operationId: first.operationId, taskId: first.taskId, intentSha256: digest, ...patch }).status, 'conflict');
  }
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM remote_operation_claims').get().n, 2);
  store.uncertain(first.operationId);
  assert.throws(() => store.recordPublicationIntent(first, claim, intent), error => error.code === 'B_OPERATION_STALE_FENCE');
  assert.equal(store.row(first.operationId).state, 'uncertain');
  const renewed = store.resumePublicationClaim({ ...first, authorizationHash: 'c'.repeat(64) }, intent);
  assert.equal(renewed.generation, claim.generation + 1);
  assert.throws(() => store.assertFence(claim), error => error.code === 'B_OPERATION_STALE_FENCE');
  assert.throws(() => store.complete({ ...first, publicationGeneration: claim.generation }, { staleReceipt: true }), error => error.code === 'B_OPERATION_STALE_FENCE');
  store.assertFence(renewed);
  assert.throws(() => store.resumePublicationClaim(first, intent), error => error.code === 'B_PUBLICATION_RESUME_REJECTED');
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM remote_operation_claims').get().n, 2);
});

test('two real child processes cannot claim the same targets in reverse order', { timeout: 20000 }, async t => {
  const f = await fixture(t), file = join(f.root, 'child.mjs');
  const url = new URL('../apps/pc-agent/src/remote-operation-store.js', import.meta.url).href;
  await writeFile(file, `import { RemoteOperationStore } from ${JSON.stringify(url)};
    const store = new RemoteOperationStore({ path: process.argv[2] });
    process.send('ready'); process.on('message', descriptor => {
      try { const ticket = store.prepare(descriptor); store.claim(descriptor, ticket.ticket, ticket.generation);
        process.send({ state:'claimed', owner:descriptor.operationId }); }
      catch(error) { process.send({ state:'blocked', code:error.code, owner:descriptor.operationId }); }
    });`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|COMSPEC|USERPROFILE|APPDATA|LOCALAPPDATA)$/i.test(key)));
  const a = fork(file, [f.path], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }); f.children.push(a);
  await once(a, 'message');
  const b = fork(file, [f.path], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }); f.children.push(b);
  await once(b, 'message');
  const replies = [once(a, 'message'), once(b, 'message')];
  a.send(descriptor('a', ['file-a', 'file-b'])); b.send(descriptor('b', ['file-b', 'file-a']));
  const results = (await Promise.all(replies)).map(([result]) => result);
  assert.equal(results.filter(result => result.state === 'claimed').length, 1);
  assert.equal(results.find(result => result.state === 'blocked').code, 'B_OPERATION_RESOURCE_UNRESOLVED');
  const store = f.open(), rows = store.db.prepare('SELECT * FROM remote_operation_claims ORDER BY resource_key').all();
  assert.equal(rows.length, 2); assert.equal(new Set(rows.map(row => row.operation_id)).size, 1);
});

test('partial overlap across real processes blocks the loser and fences a predecessor after recovery', { timeout: 20000 }, async t => {
  const f = await fixture(t), file = join(f.root, 'overlap-child.mjs'), output = join(f.root, 'effects.txt');
  const url = new URL('../apps/pc-agent/src/remote-operation-store.js', import.meta.url).href;
  await writeFile(file, `import { RemoteOperationStore } from ${JSON.stringify(url)};
    import { appendFileSync } from 'node:fs';
    const store = new RemoteOperationStore({ path: process.argv[2] });
    let claim, descriptor;
    process.send({state:'ready',pid:process.pid});
    process.on('message', message => {
      try {
        if (message.kind === 'claim') {
          descriptor=message.descriptor;
          const ticket=store.prepare(descriptor); claim=store.claim(descriptor,ticket.ticket,ticket.generation);
          process.send({state:'claimed',owner:descriptor.operationId});
        } else if (message.kind === 'effect') {
          store.assertFence(claim);
          appendFileSync(process.argv[3],descriptor.operationId+'\\n');
          process.send({state:'effect'});
        }
      } catch(error) { process.send({state:'blocked',code:error.code}); }
    });`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|COMSPEC|USERPROFILE|APPDATA|LOCALAPPDATA)$/i.test(key)));
  const start = async () => {
    const child = fork(file, [f.path, output], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    f.children.push(child); const [ready] = await once(child, 'message');
    assert.equal(ready.state, 'ready'); assert.notEqual(ready.pid, process.pid); return child;
  };
  const a = await start(), b = await start();
  const replies = [once(a, 'message'), once(b, 'message')];
  // Different primary resources; only the secondary target overlaps.
  a.send({ kind: 'claim', descriptor: descriptor('partial-a', ['private-a', 'shared']) });
  b.send({ kind: 'claim', descriptor: descriptor('partial-b', ['private-b', 'shared']) });
  const results = (await Promise.all(replies)).map(([result]) => result);
  assert.equal(results.filter(result => result.state === 'claimed').length, 1);
  assert.equal(results.find(result => result.state === 'blocked').code, 'B_OPERATION_RESOURCE_UNRESOLVED');
  const winner = results[0].state === 'claimed' ? a : b;
  const winnerId = results.find(result => result.state === 'claimed').owner;
  const invoke = async () => { const reply = once(winner, 'message'); winner.send({ kind: 'effect' }); return (await reply)[0]; };
  assert.equal((await invoke()).state, 'effect');
  assert.equal(await readFile(output, 'utf8'), `${winnerId}\n`);
  // Opening a replacement B recovers the still-unresolved journal; the old process stays alive.
  const recovered = f.open();
  assert.equal(recovered.row(winnerId).state, 'uncertain');
  const stale = await invoke();
  assert.equal(stale.code, 'B_OPERATION_STALE_FENCE');
  assert.equal(await readFile(output, 'utf8'), `${winnerId}\n`);
  const rows = recovered.db.prepare('SELECT * FROM remote_operation_claims ORDER BY resource_key').all();
  assert.equal(rows.length, 2); assert.ok(rows.every(row => row.operation_id === winnerId));
  const unrelated = descriptor('unrelated', ['private-unrelated']), ticket = recovered.prepare(unrelated);
  recovered.assertFence(recovered.claim(unrelated, ticket.ticket, ticket.generation));
});
