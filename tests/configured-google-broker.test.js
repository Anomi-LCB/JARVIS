import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConfiguredGoogleBroker } from '../packages/core/src/personal-operations/configured-google-broker.js';
import { createConfiguredCoreServiceRuntime } from '../scripts/core-service-runtime.mjs';
import { listenOnFetchSafePort } from '../packages/shared/src/http.js';
import { GOOGLE_CONNECTOR_ID, GOOGLE_READ_SCOPES } from '../packages/core/src/personal-operations/google-vault-client.js';
import { GoogleInboxSync } from '../packages/core/src/personal-operations/google-sync.js';
import { PersonalOperationsStore } from '../packages/core/src/personal-operations/operations-store.js';
import { PersonalSourceInbox } from '../packages/core/src/personal-operations/source-inbox.js';
import { createManagedGoogleSync } from '../packages/core/src/personal-operations/google-sync-service.js';
import { setFixturePrivateAcl } from './fixtures/windows-private-acl.mjs';

function message(child, type, action) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('fixture timeout')), 10000);
    const listener = data => { if (data.type === type) finish(null, data); };
    const exited = () => finish(new Error('fixture exited'));
    function finish(error, data) { clearTimeout(timer); child.off('message', listener); child.off('exit', exited); error ? reject(error) : resolve(data); }
    child.on('message', listener); child.once('exit', exited); if (action) child.send({ action });
  });
}
async function fixture(t,{revocationPath}={}) {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-core-broker-'));
  const child = fork(new URL('./fixtures/google-broker-process.mjs', import.meta.url), revocationPath?[revocationPath]:[], {
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }, stdio: ['ignore', 'ignore', 'ignore', 'ipc']
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve)); child.disconnect(); await exited;
    }
  });
  const ready = await message(child, 'ready');
  const metadata = join(root, 'metadata.json');
  writeFileSync(metadata, JSON.stringify({ schemaVersion: 1, connectionId: 'process-google', revision: 'process-revision-one' }));
  const pem = name => fileURLToPath(new URL(`./fixtures/google-broker-tls/${name}.pem`, import.meta.url));
  const privateKey=join(root,'core-key.pem');writeFileSync(privateKey,readFileSync(pem('core-key')),{mode:0o600});
  if(process.platform==='win32'){setFixturePrivateAcl(root);setFixturePrivateAcl(privateKey);}
  const env = { PATH: process.env.PATH, TEMP: root, TMP: root, JARVIS_TEST_MODE: '1',
    JARVIS_TEST_AUDIT_ROOT: join(root, 'audit'), JARVIS_CORE_ROOT: root,
    JARVIS_CORE_HOST: '127.0.0.1', JARVIS_CORE_PORT: '0', JARVIS_CORE_ADMIN_TOKEN: 'synthetic-admin-token',
    JARVIS_CORE_ALLOWED_ROOTS: 'workspace', JARVIS_CORE_WORKER_DAEMON_ENABLED: '0',
    JARVIS_CORE_WORKER_DAEMON_AUTOSTART: '0', JARVIS_PERSONAL_IMPORT_ENABLED: '0', JARVIS_GOOGLE_SYNC_ENABLED: '0',
    JARVIS_MISSION_PROVIDER: 'xai', JARVIS_MISSION_MODEL: 'synthetic-planner', JARVIS_CORE_GOOGLE_BACKEND: 'broker',
    JARVIS_CORE_GOOGLE_BROKER_URL: `https://127.0.0.1:${ready.address.port}/v1/google/read`,
    JARVIS_CORE_GOOGLE_BROKER_TLS_KEY: privateKey, JARVIS_CORE_GOOGLE_BROKER_TLS_CERT: pem('core'),
    JARVIS_CORE_GOOGLE_BROKER_TLS_CA: pem('ca'), JARVIS_CORE_GOOGLE_BROKER_METADATA: metadata };
  return { env, root, child, metadata };
}

test('configured broker invalidates verified state on revision changes, revocation and closure', async t => {
  const f = await fixture(t), { client, controller } = createConfiguredGoogleBroker({ env: f.env, authorizePage:()=>{} });
  t.after(async () => { await controller.close(); rmSync(f.root, { recursive: true, force: true }); });
  assert.equal(controller.status().providerVerified, false);
  assert.throws(() => createConfiguredGoogleBroker({ env: {} }), /CONFIG_INCOMPLETE/u);
  await assert.rejects(() => client.page({ provider: 'gmail' }), /CONNECTION_REQUIRED/u);
  await controller.start({ profile: 'product' });
  assert.equal(controller.status().providerVerified, true);
  writeFileSync(f.metadata, JSON.stringify({ schemaVersion: 1, connectionId: 'process-google', revision: 'changed' }));
  assert.equal(controller.status().status, 'verification-required');
  await assert.rejects(() => controller.start({ profile: 'product' }), /REVISION_CONFLICT/u);
  writeFileSync(f.metadata, JSON.stringify({ schemaVersion: 1, connectionId: 'process-google', revision: 'process-revision-one' }));
  await controller.start({ profile: 'product' });
  await message(f.child, 'revoked-google', 'revoke-google');
  await assert.rejects(() => client.page({ provider: 'gmail', timeMin: '2026-10-01T00:00:00Z', timeMax: '2026-10-02T00:00:00Z' }), /CONNECTION_REQUIRED/u);
  assert.equal(controller.status().providerVerified, false);
  await controller.close(); assert.equal(controller.status().code, 'A_GOOGLE_CONNECTION_CLOSED');
});

test('real configured Core uses mTLS broker and denies local Google OAuth credential handoffs', async t => {
  const f = await fixture(t);
  await assert.rejects(() => createConfiguredCoreServiceRuntime({ env: f.env, integrationVault: {
    list: () => [{ connectorId: GOOGLE_CONNECTOR_ID }]
  } }), /LOCAL_CREDENTIALS_PRESENT/u);
  const vault = { list: () => [], save() { assert.fail('Core must not store Google credentials'); }, withCredentials() { assert.fail('Core must not retrieve Google credentials'); } };
  const runtime = await createConfiguredCoreServiceRuntime({ env: f.env, integrationVault: vault });
  t.after(async () => { await runtime.close(); rmSync(f.root, { recursive: true, force: true }); });
  const address = await listenOnFetchSafePort(runtime.server, { host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${address.port}`, headers = { authorization: 'Bearer synthetic-admin-token', 'content-type': 'application/json' };
  const request = async (path, body) => {
    const response = await fetch(base + path, { headers, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  const setup = await request('/personal-google/connect?setup=1');
  assert.equal(setup.data.credentialLocation, 'broker'); assert.equal(setup.data.providerVerified, false);
  const connected = await request('/personal-google/connect', { profile: 'product' });
  assert.equal(connected.status, 202); assert.equal(connected.data.providerVerified, true);
  assert.doesNotMatch(JSON.stringify(connected.data), /fixture@example|process-synthetic/u);
  const quota={provider:'gmail',maxPages:3,validFrom:'2020-01-01T00:00:00Z',expiresAt:'2099-01-01T00:00:00Z'};
  assert.equal((await request('/personal-google/mandate',quota)).status,409,'broker requires an explicit source query range');
  assert.equal((await request('/personal-google/mandate',{...quota,readFrom:'2026-10-01T00:00:00Z',readUntil:'2026-10-03T00:00:00Z'})).status,200);
  const inbox=(await request('/personal-inbox')).data;
  assert.equal(inbox.google.evidence[0].scopeRequired,true);
  assert.equal(inbox.google.evidence[0].readScope.connectionId,'process-google');
  assert.equal(inbox.google.evidence[0].budget.maxCalls,3);
  assert.equal((await fetch(base+'/personal-google/sync',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,401);
  assert.equal((await request('/personal-google/sync',{readFrom:'2020-01-01T00:00:00Z'})).status,409);
  const handoff = await request('/integrations/handoffs', { connectorId: GOOGLE_CONNECTOR_ID, authMethod: 'oauth2', scopes: [...GOOGLE_READ_SCOPES] });
  assert.equal(handoff.status, 409);
  assert.equal(handoff.data.error.code, 'A_INTEGRATION_EXTERNAL_CREDENTIAL_STORE_REQUIRED');
  const invalid = await request('/personal-google/connect', { clientPath: 'never-read-this-file' });
  assert.equal(invalid.status, 409);
  assert.equal((await message(f.child, 'stats', 'stats')).credentialReads, 1);
});

test('configured broker feeds existing inbox once and fails closed after certificate revocation', async t => {
  const f = await fixture(t), { client, controller } = createConfiguredGoogleBroker({ env: f.env, authorizePage:(job,context)=>sync.evidence.authorize(job,context) });
  const store = new PersonalOperationsStore({ dbPath: join(f.root, 'inbox.sqlite') });
  const inbox = new PersonalSourceInbox(store), sync = createManagedGoogleSync({ store, client, requireMandates:true });
  t.after(async () => { await sync.stop(); await controller.close(); store.close(); rmSync(f.root, { recursive: true, force: true }); });
  assert.equal((await sync.run()).status, 'degraded');
  assert.equal((await message(f.child,'stats','stats')).credentialReads,1,'only account readiness; no mailbox/calendar page without a mandate');
  for(const provider of ['gmail','google-calendar'])sync.evidence.configure({provider,maxPages:10,validFrom:'2020-01-01T00:00:00Z',expiresAt:'2099-01-01T00:00:00Z',readFrom:'2020-01-01T00:00:00Z',readUntil:'2099-01-01T00:00:00Z'});
  assert.equal((await sync.run()).status, 'ready');
  assert.equal((await sync.run()).status, 'ready');
  assert.equal(inbox.list().length, 2);
  assert.doesNotMatch(JSON.stringify(inbox.list()), /process-synthetic/u);
  await message(f.child, 'revoked-client', 'revoke-client');
  assert.equal((await sync.run()).status, 'error');
  assert.equal(controller.status().providerVerified, false);
  assert.equal(inbox.list().length, 2);
});


test('configured controller self-disconnect confirms broker-only revocation',async t=>{
 const revRoot=mkdtempSync(join(tmpdir(),'configured-self-revoke-'));
 const f=await fixture(t,{revocationPath:join(revRoot,'revocations.sqlite')});
 const {controller,client}=createConfiguredGoogleBroker({env:f.env,authorizePage:()=>{}});
 t.after(async()=>{await controller.close();});
 const store=new PersonalOperationsStore({dbPath:join(f.root,'disconnect.sqlite')});const sync=new GoogleInboxSync({inbox:new PersonalSourceInbox(store),client});
 const {createCoreServer}=await import('../packages/core/src/main.mjs');const server=createCoreServer(undefined,{googleConnection:controller,googleSync:sync,adminToken:'disconnect-admin'});const address=await listenOnFetchSafePort(server);t.after(async()=>{await new Promise(r=>server.close(r));store.close();});
 const url=`http://127.0.0.1:${address.port}/personal-google/broker-disconnect`;assert.equal((await fetch(url,{method:'POST',body:'{}'})).status,401);
 const response=await fetch(url,{method:'POST',headers:{authorization:'Bearer disconnect-admin','content-type':'application/json'},body:'{}'});assert.equal(response.status,200);const receipt=await response.json();assert.equal(sync.status().status,'collection-paused');assert.equal(receipt.brokerAccessRevoked,true);assert.equal(receipt.providerGrantRevoked,false);assert.equal(controller.status().brokerAccessRevoked,true);assert.equal(client.configured(),false);assert.equal(controller.setupStatus().brokerDisconnectSupported,true);
 const stats=await message(f.child,'stats','stats');assert.equal(stats.credentialReads,0);t.after(()=>{rmSync(f.root,{recursive:true,force:true});rmSync(revRoot,{recursive:true,force:true});});
});
