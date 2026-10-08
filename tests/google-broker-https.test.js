import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpsRequest } from 'node:https';
import { createGoogleBrokerHttpsTransport, createGoogleBrokerHttpsServer } from '../packages/core/src/personal-operations/google-broker-https.js';
import { createGoogleBrokerReadClient } from '../packages/core/src/personal-operations/google-operation-broker.js';
import { GoogleInboxSync } from '../packages/core/src/personal-operations/google-sync.js';
import { PersonalOperationsStore } from '../packages/core/src/personal-operations/operations-store.js';
import { PersonalSourceInbox } from '../packages/core/src/personal-operations/source-inbox.js';
import { runConfiguredGoogleCredentialBroker } from '../scripts/google-credential-broker.mjs';
import { fileURLToPath } from 'node:url';

const pem = name => readFileSync(new URL(`./fixtures/google-broker-tls/${name}.pem`, import.meta.url));
const input = { connectionId: 'process-google', expectedRevision: 'process-revision-one', operation: 'account' };
function message(child, type, action) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('test child message timeout')), 10000);
    const onExit = () => finish(new Error('test child exited'));
    const onMessage = value => { if (value.type === type) finish(null, value); };
    function finish(error, value) { clearTimeout(timer); child.off('exit', onExit); child.off('message', onMessage); error ? reject(error) : resolve(value); }
    child.on('message', onMessage); child.once('exit', onExit);
    if (action) child.send({ action });
  });
}
async function fixture(t, { revocationPath } = {}) {
  const child = fork(new URL('./fixtures/google-broker-process.mjs', import.meta.url), revocationPath ? [revocationPath] : [], {
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }, stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  let logs = ''; child.stdout.on('data', bytes => { logs += bytes; }); child.stderr.on('data', bytes => { logs += bytes; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.disconnect(); await exited;
    }
    assert.doesNotMatch(logs, /process-synthetic-(?:secret|refresh|access)/u);
  });
  const ready = await message(child, 'ready');
  const url = `https://127.0.0.1:${ready.address.port}/v1/google/read`;
  const transport = createGoogleBrokerHttpsTransport({ url, key: pem('core-key'), cert: pem('core'), ca: pem('ca') });
  t.after(() => transport.close());
  return { child, ready, url, transport };
}

test('separate broker process authenticates Core and feeds existing SQLite sync without Google secrets', async t => {
  const f = await fixture(t); assert.notEqual(f.ready.pid, process.pid);
  const client = createGoogleBrokerReadClient({ connectionMetadata: () => f.ready.metadata, execute: f.transport.execute });
  const root = mkdtempSync(join(tmpdir(), 'jarvis-google-mtls-'));
  const store = new PersonalOperationsStore({ dbPath: join(root, 'test.sqlite') });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const inbox = new PersonalSourceInbox(store);
  const sync = new GoogleInboxSync({ inbox, client, clock: () => new Date('2026-10-02T00:00:00Z') });
  assert.equal((await sync.run()).status, 'ready');
  assert.equal((await sync.run()).status, 'ready');
  assert.equal(inbox.list().length, 2);
  assert.doesNotMatch(JSON.stringify({ rows: inbox.list(), metadata: f.ready.metadata }), /process-synthetic-/u);
  const stats = await message(f.child, 'stats', 'stats'); assert.equal(stats.credentialReads, 6);
});

test('missing client certificate and a CA-valid but unlisted client never access broker credentials', async t => {
  const f = await fixture(t);
  await assert.rejects(() => new Promise((resolve, reject) => {
    const req = httpsRequest(f.url, { method: 'POST', ca: pem('ca'), minVersion: 'TLSv1.3' }, resolve);
    req.on('error', reject); req.end('{}');
  }));
  const other = createGoogleBrokerHttpsTransport({ url: f.url, key: pem('other-key'), cert: pem('other'), ca: pem('ca') });
  t.after(() => other.close());
  await assert.rejects(() => other.execute(input), { message: 'A_GOOGLE_BROKER_CLIENT_DENIED' });
  assert.equal((await message(f.child, 'stats', 'stats')).credentialReads, 0);
});

test('Core refuses a broker whose server certificate is not trusted', async t => {
  const f = await fixture(t);
  const untrusted = createGoogleBrokerHttpsTransport({ url: f.url, key: pem('core-key'), cert: pem('core'), ca: pem('other') });
  t.after(() => untrusted.close());
  await assert.rejects(() => untrusted.execute(input), { message: 'A_GOOGLE_BROKER_NETWORK' });
  assert.equal((await message(f.child, 'stats', 'stats')).credentialReads, 0);
});

test('client certificate revocation applies to an already open keepalive connection', async t => {
  const f = await fixture(t);
  assert.equal(await f.transport.execute(input), 'fixture@example.test');
  await message(f.child, 'revoked-client', 'revoke-client');
  await assert.rejects(() => f.transport.execute(input), { message: 'A_GOOGLE_BROKER_CLIENT_DENIED' });
  assert.equal((await message(f.child, 'stats', 'stats')).credentialReads, 1);
});

test('Google connection revocation and invalid operations cross the process boundary as safe failures', async t => {
  const f = await fixture(t);
  await assert.rejects(() => f.transport.execute({ ...input, operation: 'send' }), { message: 'A_GOOGLE_BROKER_REQUEST_INVALID' });
  await assert.rejects(() => f.transport.execute({ ...input, connectionId: 'another-users-account' }), { message: 'A_GOOGLE_BROKER_CLIENT_DENIED' });
  assert.equal((await message(f.child, 'stats', 'stats')).credentialReads, 0);
  await message(f.child, 'revoked-google', 'revoke-google');
  await assert.rejects(() => f.transport.execute(input), { message: 'A_GOOGLE_BROKER_CONNECTION_REQUIRED' });
  assert.equal((await message(f.child, 'stats', 'stats')).providerCalls, 0);
});

test('bounded page restrictions survive the actual mTLS process boundary before secret access',async t=>{
 const f=await fixture(t),page={...input,operation:'page',job:{provider:'google-calendar',timeMin:'2026-10-01T00:00:00Z',timeMax:'2026-10-02T00:00:00Z'}};
 for(const job of [
   {...page.job,syncToken:'synthetic-sync-token'},
   {...page.job,startHistoryId:'12345'},
   {...page.job,timeMin:'2026-10-01T00:00:00.123Z'},
   {...page.job,timeMax:'2027-10-01T00:00:00Z'}
 ])await assert.rejects(f.transport.execute({...page,job}),{message:'A_GOOGLE_BROKER_REQUEST_INVALID'});
 const denied=await message(f.child,'stats','stats');assert.equal(denied.credentialReads,0);assert.equal(denied.providerCalls,0);
 assert.equal((await f.transport.execute(page)).items[0].id,'event-one');
 assert.ok((await message(f.child,'stats','stats')).providerCalls>0);
});

test('plaintext, insecure config and oversized requests have no fallback path', async t => {
  const f = await fixture(t);
  assert.throws(() => createGoogleBrokerHttpsTransport({ url: f.url.replace('https:', 'http:'), key: pem('core-key'), cert: pem('core'), ca: pem('ca') }), /TLS_CONFIG_INVALID/u);
  assert.throws(() => createGoogleBrokerHttpsServer({ broker: { execute() {} }, key: pem('server-key'), cert: pem('server'), ca: pem('ca'), allowedClientFingerprints: [] }), /TLS_CONFIG_INVALID/u);
  await assert.rejects(() => f.transport.execute({ ...input, excess: 'x'.repeat(8192) }), /REQUEST_TOO_LARGE/u);
  assert.equal((await message(f.child, 'stats', 'stats')).providerCalls, 0);
});

test('production startup never auto-loads a real vault and rejects test certificates or missing Linux secret store', async () => {
  await assert.rejects(() => runConfiguredGoogleCredentialBroker({ env: {} }), {
    message: process.platform === 'win32' ? 'A_GOOGLE_BROKER_CONFIG_INCOMPLETE' : 'A_GOOGLE_BROKER_LINUX_SECRET_STORE_REQUIRED'
  });
  const path = name => fileURLToPath(new URL(`./fixtures/google-broker-tls/${name}.pem`, import.meta.url));
  await assert.rejects(() => runConfiguredGoogleCredentialBroker({ env: {
    JARVIS_BROKER_GOOGLE_VAULT: 'must-not-read-this-vault', JARVIS_BROKER_TLS_KEY: path('server-key'),
    JARVIS_BROKER_TLS_CERT: path('server'), JARVIS_BROKER_TLS_CA: path('ca'),
    JARVIS_BROKER_CLIENT_FINGERPRINT: 'F'.repeat(64), JARVIS_BROKER_GOOGLE_CONNECTION_ID: 'test-google', JARVIS_BROKER_PORT: '19567'
    , JARVIS_BROKER_REVOCATIONS: 'must-not-create-this-database'
  } }), { message: process.platform === 'win32' ? 'A_GOOGLE_BROKER_TEST_CERT_DENIED' : 'A_GOOGLE_BROKER_LINUX_SECRET_STORE_REQUIRED' });
});

test('committed client revocation survives a real broker process restart', async t => {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-broker-revocation-'));
  const revocationPath = join(root, 'revocations.sqlite');
  const first = await fixture(t, { revocationPath });
  assert.equal(await first.transport.execute(input), 'fixture@example.test');
  await message(first.child, 'revoked-client', 'revoke-client');
  const exited = new Promise(resolveExit => first.child.once('exit', resolveExit)); first.child.disconnect(); await exited;
  const restarted = await fixture(t, { revocationPath });
  await assert.rejects(() => restarted.transport.execute(input), { message: 'A_GOOGLE_BROKER_CLIENT_DENIED' });
  assert.equal((await message(restarted.child, 'stats', 'stats')).credentialReads, 0);
  // Register after process cleanup hooks; Windows cannot delete an open SQLite file.
  t.after(() => rmSync(root, { recursive: true, force: true }));
});
