import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, cpSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Agent, request } from 'node:https';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { OpenBaoGoogleVault } from '../packages/core/src/personal-operations/openbao-google-vault.js';
import { createGoogleOperationBroker } from '../packages/core/src/personal-operations/google-operation-broker.js';
import { IntegrationConnectorRegistry } from '../packages/core/src/personal-operations/integration-security.js';
import { GOOGLE_CONNECTOR_ID, GOOGLE_READ_SCOPES } from '../packages/core/src/personal-operations/google-vault-client.js';

// Real OpenBao, synthetic Google data only. Never loads environment credentials or captures init keys to disk.
const image = 'openbao/openbao@sha256:a36ea8c27f0dcff5757664ad080425f96d3b6b2f33db3e76c4e2d3112fb17005';
const root = mkdtempSync(join(tmpdir(), 'jarvis-openbao-audit-'));
const artifactPath = resolve(process.argv[2] ?? 'artifacts/openbao-live-20261002.json');
if (!artifactPath.startsWith(resolve('artifacts') + sep)) throw new Error('Audit evidence must be inside artifacts');
const container = `jarvis-openbao-audit-${randomUUID().slice(0, 8)}`;
const rows = [], startedAt = new Date().toISOString();
const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let base, adminToken, unsealKey, readerToken, vault, restartEndpointChanged = false;
const agent = new Agent({ ca: readFileSync(new URL('../tests/fixtures/google-broker-tls/ca.pem', import.meta.url)), minVersion: 'TLSv1.3', rejectUnauthorized: true });
function api(path, { method = 'GET', body, token = adminToken } = {}) {
  return new Promise((resolveRequest, reject) => {
    const req = request(new URL(path, base), { method, agent, signal: AbortSignal.timeout(5000),
      headers: { ...(token ? { 'X-Vault-Token': token } : {}), ...(body ? { 'content-type': 'application/json' } : {}) } }, res => {
      const chunks = []; res.on('data', bytes => chunks.push(bytes)); res.on('error', reject);
      res.on('end', () => { let data = null; try { data = JSON.parse(Buffer.concat(chunks).toString()); } catch {} resolveRequest({ status: res.statusCode, data }); });
    });
    req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
}
async function ready() {
  let last;
  for (let i = 0; i < 60; i++) {
    try { last = await api('/v1/sys/health', { token: null }); if ([200, 501, 503].includes(last.status)) return last; } catch {}
    await new Promise(resolveWait => setTimeout(resolveWait, 250));
  }
  throw new Error('AUDIT_OPENBAO_START_TIMEOUT');
}
async function step(id, operation) {
  const start = performance.now();
  try { await operation(); rows.push({ id, status: 'passed', elapsedMs: performance.now() - start }); }
  catch (error) { rows.push({ id, status: 'failed', code: /^A_GOOGLE_[A-Z_]+$/u.test(error?.message ?? '') ? error.message : 'AUDIT_ASSERTION_OR_RUNTIME_FAILURE',
    errorCode: error?.code ?? null, actual: ['number', 'boolean'].includes(typeof error?.actual) ? error.actual : null,
    expected: ['number', 'boolean'].includes(typeof error?.expected) ? error.expected : null }); throw error; }
}
const record = { schemaVersion: 1, connectionId: 'fixture-google', connectorId: GOOGLE_CONNECTOR_ID,
  authMethod: 'oauth2', scopes: [...GOOGLE_READ_SCOPES], status: 'active',
  credentials: { clientId: 'audit-synthetic-client', clientSecret: 'audit-synthetic-secret', refreshToken: 'audit-synthetic-refresh' } };
let providerCalls = 0;
const fetchImpl = async url => {
  providerCalls++;
  const body = String(url).endsWith('/token') ? { access_token: 'audit-synthetic-access', expires_in: 3600 } : { emailAddress: 'fixture@example.test' };
  return { ok: true, status: 200, json: async () => body };
};
function createVault(version = 1) {
  return new OpenBaoGoogleVault({ url: base, ca: readFileSync(join(root, 'ca.pem')), token: () => readerToken,
    connections: [{ connectionId: 'fixture-google', version }] });
}
try {
  mkdirSync(join(root, 'data'));
  for (const name of ['ca', 'server', 'server-key']) writeFileSync(join(root, `${name}.pem`), readFileSync(new URL(`../tests/fixtures/google-broker-tls/${name}.pem`, import.meta.url)));
  writeFileSync(join(root, 'bao.hcl'), 'disable_mlock = true\nui = false\nstorage "pebbledb" { path = "/fixture/data" }\nlistener "tcp" { address = "0.0.0.0:8200" tls_cert_file = "/fixture/server.pem" tls_key_file = "/fixture/server-key.pem" tls_min_version = "tls13" }\n');
  docker(['run', '-d', '--name', container, '--user', '1000:1000', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '--memory=256m', '--memory-swap=256m', '--pids-limit=64', '--tmpfs', '/tmp:rw,nosuid,nodev,size=32m',
    '--mount', `type=bind,source=${root},target=/fixture`, '-p', '127.0.0.1::8200', '--entrypoint', 'bao', image, 'server', '-config=/fixture/bao.hcl']);
  const port = docker(['port', container, '8200/tcp']).split(':').at(-1); base = `https://127.0.0.1:${port}/`;
  await step('initialize-non-dev-tls-store', async () => {
    assert.equal((await ready()).status, 501);
    const init = await api('/v1/sys/init', { method: 'POST', token: null, body: { secret_shares: 1, secret_threshold: 1 } });
    assert.equal(init.status, 200); adminToken = init.data.root_token; unsealKey = init.data.keys_base64[0];
    assert.equal((await api('/v1/sys/unseal', { method: 'POST', token: null, body: { key: unsealKey } })).data.sealed, false);
    assert.equal((await api('/v1/sys/mounts/jarvis', { method: 'POST', body: { type: 'kv', options: { version: '2' } } })).status, 204);
    assert.equal((await api('/v1/jarvis/data/fixture-google', { method: 'POST', body: { data: record, options: { cas: 0 } } })).status, 200);
    assert.equal((await api('/v1/sys/policies/acl/jarvis-reader', { method: 'PUT', body: {
      policy: 'path "jarvis/data/fixture-google" { capabilities = ["read"] }'
    } })).status, 204);
    const created = await api('/v1/auth/token/create', { method: 'POST', body: { policies: ['jarvis-reader'], no_default_policy: true, ttl: '10m' } });
    assert.equal(created.status, 200); readerToken = created.data.auth.client_token;
    vault = createVault();
  });
  await step('broker-provider-contract-reads-real-store', async () => {
    const broker = createGoogleOperationBroker({ registry: new IntegrationConnectorRegistry(), vault, fetchImpl });
    assert.equal(await broker.execute({ connectionId: 'fixture-google', expectedRevision: 'openbao-kv-v2:1', operation: 'account' }), 'fixture@example.test');
    assert.equal(providerCalls, 2);
    assert.doesNotMatch(JSON.stringify(vault.list()), /audit-synthetic-/u);
  });
  await step('reader-cannot-write-or-read-other-secrets', async () => {
    assert.equal((await api('/v1/jarvis/data/fixture-google', { method: 'POST', token: readerToken, body: { data: {} } })).status, 403);
    assert.equal((await api('/v1/jarvis/data/other-account', { token: readerToken })).status, 403);
  });
  await step('restart-seals-store-and-preserves-connection-after-unseal', async () => {
    docker(['restart', container]);
    const previous = base;
    base = `https://127.0.0.1:${docker(['port', container, '8200/tcp']).split(':').at(-1)}/`;
    restartEndpointChanged = previous !== base;
    assert.equal((await ready()).status, 503);
    vault.close(); vault = createVault();
    await assert.rejects(() => vault.withCredentials('fixture-google', () => true), /SECRET_STORE_UNAVAILABLE/u);
    assert.equal((await api('/v1/sys/unseal', { method: 'POST', token: null, body: { key: unsealKey } })).data.sealed, false);
    assert.equal(await vault.withCredentials('fixture-google', () => 'read-after-restart'), 'read-after-restart');
  });
  await step('rotation-rejects-old-revision-and-accepts-explicit-new-revision', async () => {
    assert.equal((await api('/v1/jarvis/data/fixture-google', { method: 'POST', body: { data: record, options: { cas: 1 } } })).status, 200);
    await assert.rejects(() => vault.withCredentials('fixture-google', () => true), /REVISION_CONFLICT/u);
    vault.close(); vault = createVault(2);
    assert.equal(await vault.withCredentials('fixture-google', () => true), true);
  });
  await step('token-revocation-during-operation-suppresses-result', async () => {
    await assert.rejects(() => vault.withCredentials('fixture-google', async () => {
      assert.equal((await api('/v1/auth/token/revoke', { method: 'POST', body: { token: readerToken } })).status, 204);
      return 'must-not-be-delivered';
    }), /SECRET_STORE_AUTH_DENIED/u);
    const recreated = await api('/v1/auth/token/create', { method: 'POST', body: { policies: ['jarvis-reader'], no_default_policy: true, ttl: '10m' } });
    readerToken = recreated.data.auth.client_token;
  });
  await step('offline-backup-restore-preserves-current-version-and-reader-policy', async () => {
    vault.close(); docker(['stop', container]);
    cpSync(join(root, 'data'), join(root, 'backup'), { recursive: true, errorOnExist: true, force: false });
    renameSync(join(root, 'data'), join(root, 'pre-restore'));
    cpSync(join(root, 'backup'), join(root, 'data'), { recursive: true, errorOnExist: true, force: false });
    docker(['start', container]);
    base = `https://127.0.0.1:${docker(['port', container, '8200/tcp']).split(':').at(-1)}/`;
    assert.equal((await ready()).status, 503);
    assert.equal((await api('/v1/sys/unseal', { method: 'POST', token: null, body: { key: unsealKey } })).data.sealed, false);
    vault = createVault(2);
    assert.equal(await vault.withCredentials('fixture-google', () => 'restored'), 'restored');
    assert.equal((await api('/v1/jarvis/data/other-account', { token: readerToken })).status, 403);
  });
  await step('actual-linux-node-adapter-reads-restored-openbao-without-vault-admin-access', async () => {
    const bundle = resolve('artifacts/cloud-validation-20261002-broker-storage');
    const code = `import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { OpenBaoGoogleVault } from '/validation/packages/core/src/personal-operations/openbao-google-vault.js';
const vault = new OpenBaoGoogleVault({ url: 'https://127.0.0.1:8200/', ca: readFileSync('/test-ca.pem'), token: () => ${JSON.stringify(readerToken)}, connections: [{ connectionId: 'fixture-google', version: 2 }] });
try { assert.equal(process.platform, 'linux'); assert.equal(await vault.withCredentials('fixture-google', credentials => Boolean(credentials.refreshToken)), true); console.log(JSON.stringify({ passed: true, platform: process.platform, adminAccessProvided: false })); } finally { vault.close(); }
`;
    const output = execFileSync('docker', ['run', '--rm', '-i', '--network', `container:${container}`, '--user', '1000:1000',
      '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--memory=256m', '--memory-swap=256m', '--pids-limit=64',
      '--mount', `type=bind,source=${bundle},target=/validation,readonly`, '--mount', `type=bind,source=${join(root, 'ca.pem')},target=/test-ca.pem,readonly`,
      '--entrypoint', 'node', 'node@sha256:81a8fcfa2aa85bc07d22d9ddff227d0a52cfc3b08e571a21b16efc9153842106', '--input-type=module'],
      { input: code, encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] });
    assert.deepEqual(JSON.parse(output.trim()), { passed: true, platform: 'linux', adminAccessProvided: false });
  });
  await step('destroy-latest-version-denies-credential-read', async () => {
    assert.equal((await api('/v1/jarvis/destroy/fixture-google', { method: 'POST', body: { versions: [2] } })).status, 204);
    await assert.rejects(() => vault.withCredentials('fixture-google', () => true), /CONNECTION_REQUIRED/u);
    // All versions and metadata, including the older retained revision, require separate removal.
    assert.equal((await api('/v1/jarvis/metadata/fixture-google', { method: 'DELETE' })).status, 204);
  });
} catch { process.exitCode = 1; }
finally {
  vault?.close(); agent.destroy();
  let cleanup = false;
  try { docker(['rm', '-f', container]); cleanup = true; } catch {}
  const dataFiles = [];
  const scan = dir => { for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name); if (entry.isDirectory()) scan(path); else if (entry.isFile()) dataFiles.push(path);
  } };
  scan(join(root, 'data'));
  const plaintextObserved = dataFiles.some(path => readFileSync(path).includes(Buffer.from('audit-synthetic-refresh')));
  const report = { version: 'openbao-live-credential-audit-v1', startedAt, observedAt: new Date().toISOString(), image,
    phases: rows, counts: { passed: rows.filter(row => row.status === 'passed').length, failed: rows.filter(row => row.status === 'failed').length },
    syntheticGoogleCredentials: true, realOpenBaoProcess: true, devMode: false, productionActivated: false,
    providerCalls, restartEndpointChanged, rawSyntheticRefreshObservedInDataFiles: plaintextObserved, scannedDataFileCount: dataFiles.length, containerRemoved: cleanup,
    limitations: ['Single test unseal share; not production custody', 'Synthetic Google response; no OAuth account', 'Filesystem byte scan is not independent cryptographic proof', 'Offline backup only; high availability and deployment account isolation not tested'] };
  writeFileSync(artifactPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ ...report, phases: rows.map(({ id, status }) => ({ id, status })) }, null, 2));
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep) || !root.includes('jarvis-openbao-audit-')) throw new Error('Unsafe audit cleanup path');
  rmSync(root, { recursive: true, force: true });
}
