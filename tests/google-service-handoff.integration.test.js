import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfiguredCoreServiceRuntime } from '../scripts/core-service-runtime.mjs';
import { listenOnFetchSafePort } from '../packages/shared/src/http.js';
import { IntegrationCredentialVault } from '../packages/core/src/personal-operations/integration-security.js';
import { GOOGLE_CONNECTOR_ID, GOOGLE_READ_SCOPES } from '../packages/core/src/personal-operations/google-vault-client.js';

test('Core completes a one-use Google OAuth handoff into its vault, probes it, and reports no execution grant', async t => {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-google-service-handoff-'));
  let runtime;
  t.after(async () => { if (runtime) await runtime.close(); rmSync(root, { recursive: true, force: true }); });
  const vault = new IntegrationCredentialVault({
    path: join(root, 'vault.dpapi.json'), platform: 'win32',
    protect: value => Buffer.from(`test-seal:${value}`).toString('base64'),
    unprotect: value => Buffer.from(value, 'base64').toString('utf8').replace(/^test-seal:/u, ''),
    harden: () => {}
  });
  const network = [];
  const fetchImpl = async (url, options) => {
    const target = String(url);
    network.push({ target, method: options?.method });
    if (target === 'https://oauth2.googleapis.com/token') return new Response(JSON.stringify({ access_token: 'synthetic-access-token', expires_in: 3600 }), { status: 200 });
    if (target === 'https://gmail.googleapis.com/gmail/v1/users/me/profile') return new Response(JSON.stringify({ emailAddress: 'account@example.test' }), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  const env = {
    PATH: process.env.PATH, TEMP: root, TMP: root, JARVIS_TEST_MODE: '1',
    JARVIS_TEST_AUDIT_ROOT: join(root, 'audit'), JARVIS_CORE_ROOT: root,
    JARVIS_CORE_HOST: '127.0.0.1', JARVIS_CORE_PORT: '0', JARVIS_CORE_ADMIN_TOKEN: 'synthetic-admin-token',
    JARVIS_CORE_ALLOWED_ROOTS: 'workspace', JARVIS_CORE_WORKER_DAEMON_ENABLED: '0',
    JARVIS_CORE_WORKER_DAEMON_AUTOSTART: '0', JARVIS_PERSONAL_IMPORT_ENABLED: '0',
    JARVIS_GOOGLE_SYNC_ENABLED: '0', JARVIS_MISSION_PROVIDER: 'xai', JARVIS_MISSION_MODEL: 'synthetic-planner'
  };
  runtime = await createConfiguredCoreServiceRuntime({ env, integrationVault: vault, modelProviderFetch: fetchImpl });
  const address = await listenOnFetchSafePort(runtime.server, { host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${address.port}`;
  const admin = { authorization: 'Bearer synthetic-admin-token', 'content-type': 'application/json' };
  const issuedResponse = await fetch(`${base}/integrations/handoffs`, { method: 'POST', headers: admin, body: JSON.stringify({
    connectorId: GOOGLE_CONNECTOR_ID, authMethod: 'oauth2', scopes: [...GOOGLE_READ_SCOPES]
  }) });
  assert.equal(issuedResponse.status, 201);
  const issued = await issuedResponse.json();
  const completion = await fetch(`${base}/integrations/handoffs/${issued.handoffId}/complete`, {
    method: 'POST', headers: { authorization: `Bearer ${issued.ticket}`, 'content-type': 'application/json' },
    body: JSON.stringify({ providerAccountId: 'account@example.test', label: 'Google account', credentials: {
      clientId: 'client.apps.googleusercontent.com', clientSecret: 'synthetic-client-secret', refreshToken: 'synthetic-refresh-token'
    } })
  });
  assert.equal(completion.status, 202);
  const result = await completion.json();
  assert.deepEqual(result.activation, { status: 'verified', providerVerified: true, checkedAt: result.activation.checkedAt });
  assert.equal(result.connection.verificationState, 'unverified', 'write response remains the original safe, non-secret storage receipt');
  assert.deepEqual(result.connection.grants, []);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-(?:client|refresh|access)-token/u);
  assert.equal(vault.list()[0].verificationState, 'provider-verified');
  assert.deepEqual(vault.list()[0].grants, []);
  assert.deepEqual(network.map(item => item.target), [
    'https://oauth2.googleapis.com/token', 'https://gmail.googleapis.com/gmail/v1/users/me/profile'
  ]);
  const inbox = await fetch(`${base}/personal-inbox`, { headers: { authorization: 'Bearer synthetic-admin-token' } });
  assert.equal(inbox.status, 200);
  const payload = await inbox.json();
  assert.equal(payload.connection.status, 'connected');
  assert.equal(payload.google.configured, true);
  assert.doesNotMatch(JSON.stringify(payload), /synthetic-(?:client|refresh|access)-token|account@example\.test/u);
  const replay = await fetch(`${base}/integrations/handoffs/${issued.handoffId}/complete`, {
    method: 'POST', headers: { authorization: `Bearer ${issued.ticket}`, 'content-type': 'application/json' },
    body: JSON.stringify({ providerAccountId: 'account@example.test', credentials: { clientId: 'x', clientSecret: 'y', refreshToken: 'z' } })
  });
  assert.equal(replay.status, 404);
});
