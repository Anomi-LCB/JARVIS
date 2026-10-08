import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IntegrationConnectorRegistry, IntegrationCredentialVault } from '../packages/core/src/personal-operations/integration-security.js';
import { createVaultModelCredentialAccess, createVaultOpenAiAgentsCredentialAccess, registerOpenAiAgentsConnector } from '../packages/core/src/mission/model-provider-vault.js';
import { describeModelProviders, createModelPlanningRunner } from '../packages/core/src/mission/model-provider.js';
import { IntegrationCredentialHandoffs } from '../packages/core/src/personal-operations/integration-credential-handoffs.js';

function makeVault() {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-model-provider-vault-'));
  const path = join(directory, 'credentials.dpapi.json');
  const protect = text => Buffer.from(`sealed:${text}`).toString('base64');
  const unprotect = envelope => {
    const text = Buffer.from(envelope, 'base64').toString('utf8');
    if (!text.startsWith('sealed:')) throw new Error('invalid fixture');
    return text.slice(7);
  };
  const vault = new IntegrationCredentialVault({ path, platform: 'win32', protect, unprotect, harden: () => {} });
  return { directory, vault };
}

test('vault provider access is scoped, unique and returns a key only inside a vault callback', async () => {
  const { directory, vault } = makeVault();
  try {
    const registry = new IntegrationConnectorRegistry();
    const access = createVaultModelCredentialAccess({ registry, vault });
    const connection = vault.save({ connectorId: 'jarvis-model-meta', providerAccountId: 'primary', authMethod: 'api-key',
      scopes: ['model.plan'], credentials: { apiKey: 'private-meta-fixture' } });
    assert.equal(access.isConfigured('meta'), true);
    assert.equal(access.status().meta, true);
    assert.equal(await access.resolve('meta'), 'private-meta-fixture');
    const readiness = describeModelProviders({ JARVIS_MISSION_PROVIDER: 'meta', JARVIS_MISSION_MODEL: 'muse-spark-1.3' }, {
      credentialStatus: provider => access.isConfigured(provider), credentialResolverConfigured: true
    }).find(item => item.provider === 'meta');
    assert.equal(readiness.stage, 'configured-unverified');
    assert.equal(readiness.credentialSource, 'dpapi-vault');
    assert.equal(readiness.connectionStatus, 'unverified');
    assert.doesNotMatch(JSON.stringify(readiness), /private-meta-fixture/);
    assert.doesNotMatch(JSON.stringify(vault.list()), /private-meta-fixture|primary/);
    assert.equal(registry.authorize({ connectorId: 'jarvis-model-meta', grantedScopes: connection.scopes,
      capabilityId: 'mission-plan', providerAuthorized: true, jarvisAuthorized: true }).riskTier, 'read');
    assert.equal(registry.authorize({ connectorId: 'jarvis-model-meta', grantedScopes: [],
      capabilityId: 'mission-plan', providerAuthorized: true, jarvisAuthorized: true }).allowed, false);
    assert.equal(access.isConfigured('gemini-interactions'), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('vault provider access fails closed for no connection, wrong scope, expired and ambiguous records', async () => {
  const { directory, vault } = makeVault();
  try {
    const access = createVaultModelCredentialAccess({ registry: new IntegrationConnectorRegistry(), vault });
    await assert.rejects(access.resolve('gemini'), { code: 'A_MODEL_CREDENTIAL_REQUIRED' });
    vault.save({ connectorId: 'jarvis-model-gemini', providerAccountId: 'wrong-scope', authMethod: 'api-key',
      scopes: ['other.scope'], credentials: { apiKey: 'wrong-scope-key' } });
    await assert.rejects(access.resolve('gemini'), { code: 'A_MODEL_CREDENTIAL_REQUIRED' });
    vault.save({ connectorId: 'jarvis-model-gemini', providerAccountId: 'expired', authMethod: 'api-key',
      scopes: ['model.plan'], credentials: { apiKey: 'expired-key' }, expiresAt: '2000-01-01T00:00:00Z' });
    await assert.rejects(access.resolve('gemini'), { code: 'A_MODEL_CREDENTIAL_REQUIRED' });
    vault.save({ connectorId: 'jarvis-model-gemini', providerAccountId: 'primary', authMethod: 'api-key',
      scopes: ['model.plan'], credentials: { apiKey: 'valid-key' } });
    assert.equal(await access.resolve('gemini'), 'valid-key');
    vault.save({ connectorId: 'jarvis-model-gemini', providerAccountId: 'secondary', authMethod: 'api-key',
      scopes: ['model.plan'], credentials: { apiKey: 'second-key' } });
    assert.equal(access.isConfigured('gemini'), false);
    await assert.rejects(access.resolve('gemini'), { code: 'A_MODEL_CREDENTIAL_REQUIRED' });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('one-use broker enrollment reaches the selected provider only through the scoped vault callback', async () => {
  const { directory, vault } = makeVault();
  try {
    const registry = new IntegrationConnectorRegistry();
    const handoffs = new IntegrationCredentialHandoffs({ registry, vault });
    const access = createVaultModelCredentialAccess({ registry, vault });
    const issued = handoffs.issue({ connectorId: 'jarvis-model-xai', authMethod: 'api-key', scopes: ['model.plan'] });
    const secret = 'enrolled-xai-key-fixture';
    const stored = handoffs.complete(issued.handoffId, issued.ticket, {
      providerAccountId: 'primary', credentials: { apiKey: secret }
    });
    assert.equal(stored.executionAuthorized, false);
    let authorization;
    let requestBody;
    const runner = createModelPlanningRunner({ provider: 'xai', model: 'fixture-model',
      resolveApiKey: () => access.resolve('xai'),
      fetchImpl: async (_url, init) => {
        authorization = init.headers.Authorization;
        requestBody = JSON.parse(init.body);
        return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{}' }] }], usage: {} });
      } });
    const receipt = await runner.runWithReceipt('public-data fixture');
    assert.equal(authorization, `Bearer ${secret}`);
    assert.equal(requestBody.store, false);
    assert.equal(receipt.executionAuthorized, false);
    assert.doesNotMatch(JSON.stringify(receipt), /enrolled-xai-key-fixture/);
    assert.doesNotMatch(JSON.stringify(vault.list()), /enrolled-xai-key-fixture|primary/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('OpenAI Agents credentials use a dedicated connector and operation-specific vault scopes', async () => {
  const { directory, vault } = makeVault();
  try {
    const registry = new IntegrationConnectorRegistry();
    const access = createVaultOpenAiAgentsCredentialAccess({ registry, vault });
    const declaration = registry.get('jarvis-openai-agents');
    assert.deepEqual(declaration.scopes, ['agents.provider.verify', 'agents.session.create', 'agents.session.read', 'agents.session.message',
      'agents.session.tool-result', 'agents.session.cancel']);
    assert.equal(access.status()['session.create'], false);
    assert.equal(access.status()['session.read'], false);
    assert.equal(access.status()['provider.verify'], false);

    const handoffs = new IntegrationCredentialHandoffs({ registry, vault });
    const secret = 'private-agents-api-fixture';
    const issued = handoffs.issue({ connectorId: 'jarvis-openai-agents', authMethod: 'api-key',
      scopes: ['agents.session.create', 'agents.session.read', 'agents.provider.verify'] });
    const stored = handoffs.complete(issued.handoffId, issued.ticket, {
      providerAccountId: 'fixture-account', credentials: { apiKey: secret }
    });
    assert.equal(stored.executionAuthorized, false);
    assert.equal(access.isConfigured('session.create'), true);
    assert.equal(access.isConfigured('session.read'), true);
    assert.equal(access.isConfigured('provider.verify'), true);
    assert.equal(access.isConfigured('session.message'), false);
    assert.equal(await access.resolve('session.create'), secret);
    assert.equal(await access.resolve('session.read'), secret);
    await assert.rejects(access.resolve('session.message'), { code: 'A_OPENAI_AGENTS_CREDENTIAL_REQUIRED' });
    assert.doesNotMatch(JSON.stringify(vault.list()), /private-agents-api-fixture|fixture-account/);

    const otherRegistry = new IntegrationConnectorRegistry();
    registerOpenAiAgentsConnector(otherRegistry);
    assert.equal(otherRegistry.authorize({ connectorId: 'jarvis-openai-agents', grantedScopes: ['agents.session.create'],
      capabilityId: 'agents-session-create', providerAuthorized: true, jarvisAuthorized: true }).requiresFreshApproval, true);
    assert.equal(otherRegistry.authorize({ connectorId: 'jarvis-openai-agents', grantedScopes: ['agents.session.read'],
      capabilityId: 'agents-session-create', providerAuthorized: true, jarvisAuthorized: true }).allowed, false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('OpenAI Agents connector refuses a pre-registered declaration with weakened operation scopes', () => {
  const registry = new IntegrationConnectorRegistry();
  registry.register({ id: 'jarvis-openai-agents', displayName: 'fixture', category: 'agent-provider', authMethods: ['api-key'],
    scopes: ['agents.session.create', 'agents.session.read'], credentialFields: ['apiKey'], requiredCredentialFields: ['apiKey'],
    capabilities: [{ id: 'agents-session-create', riskTier: 'read', scopes: ['agents.session.create'] }] });
  assert.throws(() => registerOpenAiAgentsConnector(registry), { code: 'A_OPENAI_AGENTS_CONNECTOR_CONTRACT_CONFLICT' });
});

test('model-provider handoff rejects credential fields outside the api-key contract before vault persistence', () => {
  const { directory, vault } = makeVault();
  try {
    const registry = new IntegrationConnectorRegistry();
    createVaultModelCredentialAccess({ registry, vault });
    const handoffs = new IntegrationCredentialHandoffs({ registry, vault });
    const issued = handoffs.issue({ connectorId: 'jarvis-model-xai', authMethod: 'api-key', scopes: ['model.plan'] });
    assert.throws(() => handoffs.complete(issued.handoffId, issued.ticket, {
      providerAccountId: 'primary', credentials: { apiKey: 'expected-key', refreshToken: 'unneeded-refresh-token' }
    }), { code: 'A_INTEGRATION_CREDENTIAL_FIELDS_INVALID' });
    assert.equal(vault.list().some(item => item.connectorId === 'jarvis-model-xai'), false);
    assert.throws(() => handoffs.complete(issued.handoffId, issued.ticket, {
      providerAccountId: 'primary', credentials: { apiKey: 'expected-key' }
    }), { code: 'A_INTEGRATION_HANDOFF_NOT_FOUND' });
    const valid = handoffs.issue({ connectorId: 'jarvis-model-xai', authMethod: 'api-key', scopes: ['model.plan'] });
    assert.equal(handoffs.complete(valid.handoffId, valid.ticket, {
      providerAccountId: 'primary', credentials: { apiKey: 'expected-key' }
    }).executionAuthorized, false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
