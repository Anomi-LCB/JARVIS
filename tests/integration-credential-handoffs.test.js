import test from 'node:test';
import assert from 'node:assert/strict';
import { IntegrationCredentialHandoffs } from '../packages/core/src/personal-operations/integration-credential-handoffs.js';
import { IntegrationConnectorRegistry } from '../packages/core/src/personal-operations/integration-security.js';

function createFixture({ clock = () => new Date('2026-09-28T03:00:00.000Z'), save = input => ({ connectionId: 'stored-1', ...input }) } = {}) {
  const registry = new IntegrationConnectorRegistry();
  registry.register({
    id: 'mail-test', displayName: 'Mail test', authMethods: ['oauth2'], scopes: ['mail.read'],
    capabilities: [{ id: 'mail.read', riskTier: 'read', scopes: ['mail.read'] }]
  });
  const writes = [];
  const vault = { save: input => { writes.push(input); return save(input); } };
  return { writes, registry, vault, handoffs: new IntegrationCredentialHandoffs({ registry, vault, clock }) };
}

test('one-use credential handoff is connector/scope-bound and never stores or returns raw ticket in status', () => {
  const f = createFixture();
  const issued = f.handoffs.issue({ connectorId: 'mail-test', authMethod: 'oauth2', scopes: ['mail.read'] });
  assert.equal(issued.providerVerified, false);
  assert.equal(issued.executionAuthorized, false);
  assert.equal(f.handoffs.status().storesPlaintextTickets, false);
  assert.equal(JSON.stringify(f.handoffs.status()).includes(issued.ticket), false);

  const result = f.handoffs.complete(issued.handoffId, issued.ticket, {
    providerAccountId: 'user@example.test', credentials: { refreshToken: 'fake-refresh-secret' }, label: 'Test account'
  });
  assert.equal(result.providerVerified, false);
  assert.equal(result.executionAuthorized, false);
  assert.equal(f.writes[0].connectorId, 'mail-test');
  assert.deepEqual(f.writes[0].scopes, ['mail.read']);
  assert.deepEqual(f.writes[0].grants, []);
  assert.equal(JSON.stringify(result).includes('fake-refresh-secret'), false);
  assert.throws(() => f.handoffs.complete(issued.handoffId, issued.ticket, {
    providerAccountId: 'user@example.test', credentials: { refreshToken: 'replay' }
  }), error => error.code === 'A_INTEGRATION_HANDOFF_NOT_FOUND');
});

test('handoff keeps only a bounded credential-free outcome receipt for response-loss reconciliation', () => {
  const f = createFixture();
  const issued = f.handoffs.issue({ connectorId: 'mail-test', authMethod: 'oauth2', scopes: ['mail.read'] });
  assert.equal(f.handoffs.getOutcome(issued.handoffId), null);
  f.handoffs.complete(issued.handoffId, issued.ticket, {
    providerAccountId: 'sensitive@example.test', credentials: { refreshToken: 'secret-refresh' }
  });
  assert.deepEqual(f.handoffs.getOutcome(issued.handoffId), { status: 'credentials-stored-unverified' });
  assert.deepEqual(f.handoffs.recordOutcome(issued.handoffId, 'provider-verified'), { status: 'provider-verified' });
  assert.deepEqual(f.handoffs.getOutcome(issued.handoffId), { status: 'provider-verified' });
  assert.equal(JSON.stringify(f.handoffs.getOutcome(issued.handoffId)).includes('sensitive@example.test'), false);
  assert.equal(JSON.stringify(f.handoffs.getOutcome(issued.handoffId)).includes('secret-refresh'), false);
  assert.equal(f.handoffs.recordOutcome('unrecognized-id', 'provider-verified'), null);
  assert.equal(f.handoffs.recordOutcome(issued.handoffId, 'arbitrary-status'), null);
});

test('outcome receipts expire with their one-use ticket lifetime', () => {
  let now = Date.parse('2026-09-28T03:00:00.000Z');
  const f = createFixture({ clock: () => new Date(now) });
  const issued = f.handoffs.issue({ connectorId: 'mail-test', authMethod: 'oauth2', scopes: ['mail.read'], ttlMs: 6000 });
  f.handoffs.complete(issued.handoffId, issued.ticket, {
    providerAccountId: 'user@example.test', credentials: { refreshToken: 'fixture' }
  });
  now += 6000;
  assert.equal(f.handoffs.getOutcome(issued.handoffId), null);
});

test('handoff fails closed for wrong ticket, connector, auth method, and out-of-registry scope', () => {
  const f = createFixture();
  assert.throws(() => f.handoffs.issue({ connectorId: 'unregistered', authMethod: 'oauth2', scopes: [] }), error => error.code === 'A_INTEGRATION_CONNECTOR_UNAVAILABLE');
  assert.throws(() => f.handoffs.issue({ connectorId: 'mail-test', authMethod: 'api-key', scopes: [] }), error => error.code === 'A_INTEGRATION_HANDOFF_METHOD_INVALID');
  assert.throws(() => f.handoffs.issue({ connectorId: 'mail-test', authMethod: 'oauth2', scopes: ['mail.send'] }), error => error.code === 'A_INTEGRATION_HANDOFF_SCOPE_INVALID');
  const issued = f.handoffs.issue({ connectorId: 'mail-test', authMethod: 'oauth2', scopes: ['mail.read'] });
  assert.throws(() => f.handoffs.complete(issued.handoffId, 'wrong-ticket', {
    providerAccountId: 'user@example.test', credentials: { refreshToken: 'fake' }
  }), error => error.code === 'A_INTEGRATION_HANDOFF_TICKET_INVALID');
  assert.equal(f.writes.length, 0);
});

test('handoff expires and can be cancelled before use', () => {
  let now = Date.parse('2026-09-28T03:00:00.000Z');
  const clock = () => new Date(now);
  const f = createFixture({ clock });
  const expired = f.handoffs.issue({ connectorId: 'mail-test', authMethod: 'oauth2', scopes: ['mail.read'] });
  now += 120_000;
  assert.throws(() => f.handoffs.complete(expired.handoffId, expired.ticket, {
    providerAccountId: 'user@example.test', credentials: { refreshToken: 'fake' }
  }), error => error.code === 'A_INTEGRATION_HANDOFF_EXPIRED');

  const cancelled = f.handoffs.issue({ connectorId: 'mail-test', authMethod: 'oauth2', scopes: ['mail.read'] });
  assert.deepEqual(f.handoffs.cancel(cancelled.handoffId), { cancelled: true });
  assert.throws(() => f.handoffs.complete(cancelled.handoffId, cancelled.ticket, {
    providerAccountId: 'user@example.test', credentials: { refreshToken: 'fake' }
  }), error => error.code === 'A_INTEGRATION_HANDOFF_NOT_FOUND');

});

test('Google-length OAuth consent has a bounded six-minute ticket while invalid lifetimes fail closed', () => {
  let now = Date.parse('2026-09-28T03:00:00.000Z');
  const f = createFixture({ clock: () => new Date(now) });
  const issued = f.handoffs.issue({ connectorId: 'mail-test', authMethod: 'oauth2', scopes: ['mail.read'], ttlMs: 360_000 });
  assert.equal(Date.parse(issued.expiresAt) - now, 360_000);
  now += 300_000;
  const result = f.handoffs.complete(issued.handoffId, issued.ticket, {
    providerAccountId: 'user@example.test', credentials: { refreshToken: 'delayed-consent-fixture' }
  });
  assert.equal(result.providerVerified, false);
  assert.throws(() => f.handoffs.issue({ connectorId: 'mail-test', authMethod: 'oauth2', scopes: ['mail.read'], ttlMs: 600_000 }),
    { code: 'A_INTEGRATION_HANDOFF_TTL_INVALID' });
  assert.throws(() => f.handoffs.issue({ connectorId: 'mail-test', authMethod: 'oauth2', scopes: ['mail.read'], ttlMs: 500 }),
    { code: 'A_INTEGRATION_HANDOFF_TTL_INVALID' });
});

test('handoff refuses completion after its trusted connector declaration disappears', () => {
  const definition = { id: 'mail-test', authMethods: ['oauth2'], scopes: ['mail.read'] };
  let registered = definition;
  const registry = { get: id => id === 'mail-test' ? registered : null, describe: id => id === 'mail-test' && registered ? { id } : null };
  const writes = [];
  const handoffs = new IntegrationCredentialHandoffs({ registry, vault: { save: input => { writes.push(input); return {}; } } });
  const issued = handoffs.issue({ connectorId: 'mail-test', authMethod: 'oauth2', scopes: ['mail.read'] });
  registered = null;
  assert.throws(() => handoffs.complete(issued.handoffId, issued.ticket, {
    providerAccountId: 'user@example.test', credentials: { refreshToken: 'fake' }
  }), error => error.code === 'A_INTEGRATION_CONNECTOR_CHANGED');
  assert.equal(writes.length, 0);
});

test('API-key connectors can store one secret through a scope-bound, one-use handoff without granting execution', () => {
  const registry = new IntegrationConnectorRegistry();
  registry.register({ id: 'model-test', displayName: 'Model test', authMethods: ['api-key'], scopes: ['model.plan'],
    capabilities: [{ id: 'plan', riskTier: 'read', scopes: ['model.plan'] }] });
  const persisted = [];
  const handoffs = new IntegrationCredentialHandoffs({ registry, vault: { save: input => { persisted.push(input); return { connectionId: 'c-1', ...input }; } } });
  const issued = handoffs.issue({ connectorId: 'model-test', authMethod: 'api-key', scopes: ['model.plan'] });
  assert.equal(issued.executionAuthorized, false);
  assert.equal(issued.providerVerified, false);
  const result = handoffs.complete(issued.handoffId, issued.ticket, {
    providerAccountId: 'primary', label: 'Primary planning key', credentials: { apiKey: 'fixture-secret' }
  });
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.providerVerified, false);
  assert.deepEqual(persisted[0].scopes, ['model.plan']);
  assert.deepEqual(persisted[0].grants, []);
  assert.equal(JSON.stringify(result).includes('fixture-secret'), false);
  assert.throws(() => handoffs.complete(issued.handoffId, issued.ticket, {
    providerAccountId: 'primary', credentials: { apiKey: 'replay-secret' }
  }), { code: 'A_INTEGRATION_HANDOFF_NOT_FOUND' });
});

test('API-key handoff cannot widen a connector scope or use an unregistered method', () => {
  const f = createFixture();
  assert.throws(() => f.handoffs.issue({ connectorId: 'mail-test', authMethod: 'api-key', scopes: ['mail.read'] }),
    { code: 'A_INTEGRATION_HANDOFF_METHOD_INVALID' });
  const registry = new IntegrationConnectorRegistry();
  registry.register({ id: 'model-test', displayName: 'Model test', authMethods: ['api-key'], scopes: ['model.plan'], capabilities: [] });
  const handoffs = new IntegrationCredentialHandoffs({ registry, vault: f.vault });
  assert.throws(() => handoffs.issue({ connectorId: 'model-test', authMethod: 'api-key', scopes: ['model.write'] }),
    { code: 'A_INTEGRATION_HANDOFF_SCOPE_INVALID' });
});

test('connector credential schemas reject malformed required-field declarations', () => {
  const registry = new IntegrationConnectorRegistry();
  const base = { id: 'schema-test', authMethods: ['api-key'], scopes: ['model.plan'], capabilities: [] };
  const invalidSchema = error => error.message === 'A_INTEGRATION_CREDENTIAL_SCHEMA_INVALID';
  assert.throws(() => registry.register({ ...base, requiredCredentialFields: ['apiKey'] }), invalidSchema);
  assert.throws(() => registry.register({ ...base, credentialFields: ['unknownSecret'] }), invalidSchema);
  assert.throws(() => registry.register({ ...base, credentialFields: ['apiKey'], requiredCredentialFields: ['refreshToken'] }), invalidSchema);
});
