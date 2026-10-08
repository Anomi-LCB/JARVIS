import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { createGoogleOperationBroker } from '../packages/core/src/personal-operations/google-operation-broker.js';
import { createGoogleBrokerHttpsServer, createGoogleBrokerHttpsTransport } from '../packages/core/src/personal-operations/google-broker-https.js';
import { IntegrationConnectorRegistry } from '../packages/core/src/personal-operations/integration-security.js';
import { GOOGLE_CONNECTOR_ID, GOOGLE_READ_SCOPES } from '../packages/core/src/personal-operations/google-vault-client.js';

const pem = name => readFileSync(new URL(`./fixtures/google-broker-tls/${name}.pem`, import.meta.url));
const input = { connectionId: 'cancel-google', expectedRevision: 'revision-one', operation: 'account' };
function latch() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(t, { phase = 'profile', deadline = 30000 } = {}) {
  const started = latch(), aborted = latch();
  let hang = true, aborts = 0, reads = 0;
  const row = { connectionId: input.connectionId, updatedAt: input.expectedRevision, connectorId: GOOGLE_CONNECTOR_ID,
    authMethod: 'oauth2', scopes: GOOGLE_READ_SCOPES, status: 'credentials-stored-unverified' };
  const broker = createGoogleOperationBroker({ registry: new IntegrationConnectorRegistry(), vault: {
    list: () => [row], withCredentials: async (id, operation) => { reads++; return operation({ clientId: 'cancel-synthetic-client',
      clientSecret: 'cancel-synthetic-secret', refreshToken: 'cancel-synthetic-refresh' }, row); }
  }, fetchImpl: async (url, options) => {
    const token = String(url).endsWith('/token');
    if (hang && (phase === 'token' ? token : !token)) {
      hang = false; started.resolve();
      return new Promise((resolve, reject) => {
        const cancel = () => { aborts++; aborted.resolve(); reject(new Error('synthetic-provider-aborted')); };
        if (options.signal.aborted) cancel(); else options.signal.addEventListener('abort', cancel, { once: true });
      });
    }
    return { ok: true, status: 200, json: async () => token ? { access_token: 'cancel-synthetic-access', expires_in: 3600 } : { emailAddress: 'synthetic@example.test' } };
  } });
  const peer = new X509Certificate(pem('core')).fingerprint256;
  const host = createGoogleBrokerHttpsServer({ broker, key: pem('server-key'), cert: pem('server'), ca: pem('ca'),
    allowedClientFingerprints: [peer], clientConnectionScopes: { [peer.replaceAll(':', '').toUpperCase()]: [row.connectionId] },
    maxConcurrent: 1, operationTimeoutMs: deadline });
  await new Promise(resolve => host.server.listen(0, '127.0.0.1', resolve));
  const transports = [];
  const transport = () => {
    const value = createGoogleBrokerHttpsTransport({ url: `https://127.0.0.1:${host.server.address().port}/v1/google/read`,
      key: pem('core-key'), cert: pem('core'), ca: pem('ca'), timeoutMs: 2000 });
    transports.push(value); return value;
  };
  t.after(async () => { transports.forEach(value => value.close()); host.server.closeAllConnections(); await new Promise(resolve => host.server.close(resolve)); });
  const bounded = async promise => {
    let timer;
    try { await Promise.race([promise, new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('SYNTHETIC_CANCEL_TIMEOUT')), 3000); })]); }
    finally { clearTimeout(timer); }
  };
  return { started: () => bounded(started.promise), aborted: () => bounded(aborted.promise), transport, host, peer,
    counters: () => ({ aborts, reads }) };
}

test('real mTLS client close aborts token refresh and releases the only broker slot for a new read', async t => {
  const f = await fixture(t, { phase: 'token' }), client = f.transport();
  const rejected = assert.rejects(client.execute(input), /A_GOOGLE_BROKER_NETWORK/u);
  await f.started(); client.close(); await rejected; await f.aborted();
  // Provider abort settles the old handler; next request proves capacity recovered.
  assert.equal(await f.transport().execute(input), 'synthetic@example.test');
  assert.deepEqual(f.counters(), { aborts: 1, reads: 2 });
});

test('whole-operation deadline aborts a stalled provider read and recovers capacity', async t => {
  const f = await fixture(t, { deadline: 200 }), client = f.transport();
  const rejected = assert.rejects(client.execute(input), /A_GOOGLE_BROKER_NETWORK/u);
  await f.started(); await rejected; await f.aborted();
  assert.equal(await client.execute(input), 'synthetic@example.test');
  assert.deepEqual(f.counters(), { aborts: 1, reads: 2 });
});

test('client certificate revocation aborts an active provider request and denies later reads before vault access', async t => {
  const f = await fixture(t), client = f.transport();
  const rejected = assert.rejects(client.execute(input), /A_GOOGLE_(?:BROKER_OPERATION_FAILED|BROKER_CLIENT_DENIED|API_NETWORK)/u);
  await f.started(); f.host.revokeClient(f.peer); await rejected; await f.aborted();
  await assert.rejects(() => client.execute(input), { message: 'A_GOOGLE_BROKER_CLIENT_DENIED' });
  assert.deepEqual(f.counters(), { aborts: 1, reads: 1 });
});
