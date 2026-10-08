import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { createCoreServer } from '../packages/core/src/main.mjs';
import { CoreClient } from '../packages/core/src/client/core-client.js';
import { IntegrationConnectorRegistry } from '../packages/core/src/personal-operations/integration-security.js';
import { IntegrationCredentialHandoffs } from '../packages/core/src/personal-operations/integration-credential-handoffs.js';
import { CoreAdminScope } from '../packages/core/src/security/core-admin-auth.js';
import { listenOnFetchSafePort } from '../packages/shared/src/http.js';

test('HTTP credential handoff uses a scoped one-use ticket without the Core admin bearer', async t => {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-integration-handoff-http-'));
  const runtime = createAgRuntime({ allowedRoots: [root], auditRoot: join(root, 'audit'), env: { JARVIS_TEST_MODE: '1', JARVIS_MISSION_PLANNER: 'rule' } });
  const registry = new IntegrationConnectorRegistry();
  registry.register({ id: 'mail-test', displayName: 'Mail test', authMethods: ['oauth2'], scopes: ['mail.read'], capabilities: [] });
  registry.register({ id: 'model-test', displayName: 'Model test', authMethods: ['api-key'], scopes: ['model.plan'],
    credentialFields: ['apiKey'], requiredCredentialFields: ['apiKey'],
    capabilities: [{ id: 'plan', riskTier: 'read', scopes: ['model.plan'] }] });
  const persisted = [];
  const modelProviderChecks = [];
  let verifyHandoffs = false;
  const vault = {
    save(input) { persisted.push(input); return { connectionId: 'connection-1', connectorId: input.connectorId, scopes: [...input.scopes], status: 'credentials-stored-unverified', verificationState: 'unverified' }; },
    list() { return persisted.map(({ providerAccountId, credentials, ...item }) => ({ connectionId: 'connection-1', connectorId: item.connectorId, status: 'credentials-stored-unverified' })); },
    status() { return { state: persisted.length ? 'present-not-probed' : 'empty', verificationState: 'not-probed' }; },
    remove() { return { removed: false, remoteGrantRevoked: false }; }
  };
  const credentialHandoffs = new IntegrationCredentialHandoffs({ registry, vault });
  const server = createCoreServer(runtime.coreFacade, {
    adminToken: null,
    adminTokens: [
      { token: 'integration-handoff-admin', tokenId: 'test-admin', scopes: [CoreAdminScope.ADMIN] },
      { token: 'integration-handoff-broker', tokenId: 'test-broker', scopes: [CoreAdminScope.MANAGE_INTEGRATION_HANDOFFS] },
      { token: 'integration-handoff-reader', tokenId: 'test-reader', scopes: [CoreAdminScope.READ_DIAGNOSTICS] }
    ],
    integrationRegistry: registry,
    integrationVault: vault,
    integrationHandoffs: credentialHandoffs,
    onIntegrationHandoffCompleted: async () => verifyHandoffs
      ? { status: 'verified', providerVerified: true }
      : { status: 'stored', providerVerified: false },
    managedAgentCredentialAccess: { status: () => ({ 'provider.verify': false, 'session.create': false, 'session.read': false, 'session.message': false,
      'session.tool-result': false, 'session.cancel': false }) },
    modelProviderVerifier: { async verify(input) {
      modelProviderChecks.push(input);
      return { provider: input.provider, providerVerified: true, status: 'verified', checkedAt: '2026-09-28T00:00:00.000Z',
        modelCount: 2, ...(input.modelId ? { modelId: input.modelId, requestedModelAvailable: true } : {}), executionAuthorized: false };
    } }
  });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    runtime.coreFacade.cognition?.close?.();
    rmSync(root, { recursive: true, force: true });
  });
  const address = await listenOnFetchSafePort(server, { host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${address.port}`;
  const admin = { authorization: 'Bearer integration-handoff-admin', 'content-type': 'application/json' };
  const client = new CoreClient({ baseUrl: base, integrationHandoffToken: 'integration-handoff-broker' });

  const extendedTicket = await fetch(`${base}/integrations/handoffs`, { method: 'POST',
    headers: { authorization: 'Bearer integration-handoff-broker', 'content-type': 'application/json' },
    body: JSON.stringify({ connectorId: 'mail-test', authMethod: 'oauth2', scopes: ['mail.read'], ttlMs: 360_000 }) });
  assert.equal(extendedTicket.status, 201);
  const extendedTicketBody = await extendedTicket.json();
  assert.ok(Date.parse(extendedTicketBody.expiresAt) - Date.now() > 350_000);
  assert.ok(Date.parse(extendedTicketBody.expiresAt) - Date.now() <= 360_000);
  assert.equal((await fetch(`${base}/integrations/handoffs/${extendedTicketBody.handoffId}`, {
    method: 'DELETE', headers: { authorization: 'Bearer integration-handoff-broker' }
  })).status, 200);

  const directOAuth = await fetch(`${base}/integrations`, { method: 'POST', headers: admin, body: JSON.stringify({ connectorId: 'mail-test', providerAccountId: 'user@example.test', authMethod: 'oauth2', scopes: ['mail.read'], credentials: { refreshToken: 'raw' } }) });
  assert.equal(directOAuth.status, 409);
  assert.deepEqual(await directOAuth.json(), { error: { code: 'A_INTEGRATION_HANDOFF_REQUIRED' } });

  const directModelCredential = extra => fetch(`${base}/integrations`, { method: 'POST', headers: admin,
    body: JSON.stringify({ connectorId: 'model-test', providerAccountId: 'primary', authMethod: 'api-key',
      scopes: ['model.plan'], credentials: extra }) });
  const directExtraSecret = await directModelCredential({ apiKey: 'expected-key', refreshToken: 'unexpected-token' });
  assert.equal(directExtraSecret.status, 409);
  assert.deepEqual(await directExtraSecret.json(), { error: { code: 'A_INTEGRATION_CREDENTIAL_FIELDS_INVALID' } });
  const directMissingKey = await directModelCredential({ refreshToken: 'unexpected-token' });
  assert.equal(directMissingKey.status, 409);
  assert.equal(persisted.length, 0, 'invalid direct API-key writes never reach the vault');

  const issued = await client.createIntegrationCredentialHandoff({ connectorId: 'mail-test', authMethod: 'oauth2', scopes: ['mail.read'] });
  assert.ok(issued.ticket);
  assert.equal(issued.providerVerified, false);
  assert.equal(issued.executionAuthorized, false);
  const brokerCannotReadAdminDiagnostics = await fetch(`${base}/admin/diagnostics`, { headers: { authorization: 'Bearer integration-handoff-broker' } });
  assert.equal(brokerCannotReadAdminDiagnostics.status, 403);
  const completionUrl = `${base}/integrations/handoffs/${issued.handoffId}/complete`;
  const payload = { providerAccountId: 'user@example.test', credentials: { refreshToken: 'one-use-secret' } };
  assert.equal((await fetch(completionUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })).status, 401);
  const extraAuthority = await fetch(completionUrl, { method: 'POST', headers: { authorization: `Bearer ${issued.ticket}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...payload, scopes: ['mail.send'] }) });
  assert.equal(extraAuthority.status, 400);

  const completion = await client.completeIntegrationCredentialHandoff(issued.handoffId, issued.ticket, payload);
  assert.equal(completion.providerVerified, false);
  assert.equal(completion.executionAuthorized, false);
  assert.equal(JSON.stringify(completion).includes('one-use-secret'), false);
  assert.deepEqual(credentialHandoffs.getOutcome(issued.handoffId), { status: 'credentials-stored-unverified' });
  assert.deepEqual(persisted[0].grants, []);
  assert.deepEqual(persisted[0].scopes, ['mail.read']);
  assert.equal((await fetch(completionUrl, { method: 'POST', headers: { authorization: `Bearer ${issued.ticket}`, 'content-type': 'application/json' }, body: JSON.stringify(payload) })).status, 404);
  verifyHandoffs = true;
  const verifiedHandoff = await client.createIntegrationCredentialHandoff({ connectorId: 'mail-test', authMethod: 'oauth2', scopes: ['mail.read'] });
  const verifiedCompletion = await client.completeIntegrationCredentialHandoff(verifiedHandoff.handoffId, verifiedHandoff.ticket, payload);
  assert.deepEqual(credentialHandoffs.getOutcome(verifiedHandoff.handoffId), { status: 'provider-verified' });
  assert.equal(verifiedCompletion.activation.providerVerified, true);
  const readiness = await (await fetch(`${base}/integrations`, { headers: admin })).json();
  assert.deepEqual(readiness.managedAgentCredentials, { 'provider.verify': false, 'session.create': false, 'session.read': false, 'session.message': false,
    'session.tool-result': false, 'session.cancel': false });
  assert.equal(JSON.stringify(readiness).includes('one-use-secret'), false);
  assert.equal(JSON.stringify(readiness).includes('user@example.test'), false);

  const cancellable = await client.createIntegrationCredentialHandoff({ connectorId: 'mail-test', authMethod: 'oauth2', scopes: ['mail.read'] });
  const cancel = await client.cancelIntegrationCredentialHandoff(cancellable.handoffId);
  assert.deepEqual(cancel, { cancelled: true });
  const modelKeyHandoff = await client.createIntegrationCredentialHandoff({ connectorId: 'model-test', authMethod: 'api-key', scopes: ['model.plan'] });
  const modelKeyResult = await client.completeIntegrationCredentialHandoff(modelKeyHandoff.handoffId, modelKeyHandoff.ticket, {
    providerAccountId: 'primary', label: 'Primary planning key', credentials: { apiKey: 'provider-key-fixture' }
  });
  assert.equal(modelKeyResult.providerVerified, false);
  assert.equal(modelKeyResult.executionAuthorized, false);
  assert.equal(JSON.stringify(modelKeyResult).includes('provider-key-fixture'), false);
  assert.deepEqual(persisted.at(-1).scopes, ['model.plan']);
  assert.deepEqual(persisted.at(-1).grants, []);
  const modelAdminCannotCreateHandoffWithoutBrokerScope = await fetch(`${base}/integrations/handoffs`, {
    method: 'POST', headers: { authorization: 'Bearer integration-handoff-reader', 'content-type': 'application/json' },
    body: JSON.stringify({ connectorId: 'model-test', authMethod: 'api-key', scopes: ['model.plan'] })
  });
  assert.equal(modelAdminCannotCreateHandoffWithoutBrokerScope.status, 403);
  const verifyWithoutBrokerScope = await fetch(`${base}/integrations/model-providers/xai/verify`, {
    method: 'POST', headers: { authorization: 'Bearer integration-handoff-reader', 'content-type': 'application/json' }, body: JSON.stringify({ modelId: 'xai-plan' })
  });
  assert.equal(verifyWithoutBrokerScope.status, 403);
  const verifyModelProvider = await fetch(`${base}/integrations/model-providers/xai/verify`, {
    method: 'POST', headers: { authorization: 'Bearer integration-handoff-broker', 'content-type': 'application/json' }, body: JSON.stringify({ modelId: 'xai-plan' })
  });
  assert.equal(verifyModelProvider.status, 200);
  const verification = await verifyModelProvider.json();
  assert.equal(verification.providerVerified, true);
  assert.equal(verification.executionAuthorized, false);
  assert.deepEqual(modelProviderChecks, [{ provider: 'xai', modelId: 'xai-plan' }]);
  const invalidVerificationBody = await fetch(`${base}/integrations/model-providers/xai/verify`, {
    method: 'POST', headers: admin, body: JSON.stringify({ scopes: ['mail.send'] })
  });
  assert.equal(invalidVerificationBody.status, 400);
  const openApi = await (await fetch(`${base}/openapi.json`)).json();
  assert.equal(openApi.paths['/integrations/handoffs'].post.operationId, 'createIntegrationCredentialHandoff');
  assert.equal(openApi.paths['/integrations/handoffs/{handoffId}/complete'].post.operationId, 'completeIntegrationCredentialHandoff');
  assert.equal(openApi.paths['/integrations/handoffs'].post.requestBody.content['application/json'].schema.properties.ttlMs.maximum, 360000);
  assert.equal(openApi.paths['/integrations/model-providers/{provider}/verify'].post.operationId, 'verifyModelProviderCredentials');
});
