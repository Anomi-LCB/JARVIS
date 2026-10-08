import test from 'node:test';
import assert from 'node:assert/strict';
import { IntegrationConnectorRegistry } from '../packages/core/src/personal-operations/integration-security.js';
import { createGoogleVaultReadClient, registerGoogleWorkspaceConnector, GOOGLE_CONNECTOR_ID, GOOGLE_READ_SCOPES } from '../packages/core/src/personal-operations/google-vault-client.js';

function fixture({ scopes = GOOGLE_READ_SCOPES, status = 'credentials-stored-unverified', duplicate = false } = {}) {
  const record = { connectionId: 'google-one', connectorId: GOOGLE_CONNECTOR_ID, authMethod: 'oauth2', scopes: [...scopes], status, updatedAt: '2026-09-28T00:00:00.000Z' };
  if (duplicate) record.connectionId = 'google-two';
  const connections = [record, ...(duplicate ? [{ ...record, connectionId: 'google-two' }] : [])];
  const verification = [];
  const calls = [];
  const vault = {
    list: () => connections.map(item => ({ ...item, scopes: [...item.scopes] })),
    withCredentials: async (id, operation) => {
      const item = connections.find(connection => connection.connectionId === id);
      return operation({ clientId: 'client-id', clientSecret: 'client-secret', refreshToken: 'refresh-token' }, {
        connectorId: item.connectorId, connectionId: id, scopes: [...item.scopes], authMethod: item.authMethod, updatedAt: item.updatedAt
      });
    },
    recordProviderVerification: (id, result) => { verification.push({ id, ...result }); return null; }
  };
  const client = createGoogleVaultReadClient({
    registry: new IntegrationConnectorRegistry(), vault,
    clock: () => new Date('2026-09-28T00:00:00.000Z'),
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (String(url) === 'https://oauth2.googleapis.com/token') return response(200, { access_token: 'access-token', expires_in: 3600 });
      if (String(url) === 'https://gmail.googleapis.com/gmail/v1/users/me/profile') return response(200, { emailAddress: 'research@example.test' });
      return response(404, {});
    }
  });
  return { client, vault, calls, verification };
}

test('Google reader accepts only one correctly scoped vault connection and verifies provider before connected status', async () => {
  const f = fixture();
  assert.equal(f.client.configured(), true);
  assert.deepEqual(await f.client.verifyConnection(), { verified: true, checkedAt: '2026-09-28T00:00:00.000Z' });
  assert.deepEqual(f.verification, [{ id: 'google-one', status: 'verified', providerVerified: true, checkedAt: '2026-09-28T00:00:00.000Z', modelCount: 0 }]);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].options.headers.authorization, 'Bearer access-token');
  assert.doesNotMatch(JSON.stringify(f.client), /client-secret|refresh-token/u);
});

test('Google reader fails closed for absent, ambiguous, expired, revoked, or insufficient-scope connections', async () => {
  for (const options of [{ scopes: [] }, { duplicate: true }, { status: 'expired' }, { status: 'revoked' }, { status: 'reauth-required' }]) {
    const f = fixture(options);
    assert.equal(f.client.configured(), false);
    await assert.rejects(() => f.client.account(), { message: 'A_GOOGLE_CONNECTION_REQUIRED' });
    assert.equal(f.calls.length, 0);
  }
});

test('Google reconnect guidance contains only its minimal registered read scopes and no revocation overclaim', () => {
  const f = fixture();
  assert.deepEqual(f.client.connectionRequirements(), { connectorId: GOOGLE_CONNECTOR_ID,
    requiredScopes: [...GOOGLE_READ_SCOPES], remoteGrantRevocationConfirmed: false });
});

test('Google connector scopes and OAuth credential fields stay least-privilege', () => {
  const registry = new IntegrationConnectorRegistry();
  registerGoogleWorkspaceConnector(registry);
  const connector = registry.get(GOOGLE_CONNECTOR_ID);
  assert.deepEqual(connector.scopes, [...GOOGLE_READ_SCOPES]);
  assert.deepEqual(connector.credentialFields, ['clientId', 'clientSecret', 'refreshToken']);
  assert.deepEqual(connector.capabilities.map(item => item.riskTier), ['read', 'read']);
});

function response(status, body) { return { ok: status >= 200 && status < 300, status, json: async () => body }; }
