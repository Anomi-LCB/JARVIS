import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createConfiguredCoreServiceRuntime } from '../scripts/core-service-runtime.mjs';
import { ManagedAgentSessionBroker } from '../packages/core/src/mission/managed-agent-session-broker.js';
import { createOpenAiAgentsSessionProvider } from '../packages/core/src/mission/openai-agents-api-provider.js';
import { createOpenAiWorkloadIdentityTokenSource } from '../packages/core/src/mission/openai-workload-identity-token.js';

test('Core service registers scoped model connectors and reports DPAPI vault presence without secrets', async () => {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-core-model-vault-'));
  const secret = 'fixture-model-provider-secret';
  const vault = {
    list: () => [{ connectionId: 'meta-connection', connectorId: 'jarvis-model-meta', status: 'credentials-stored-unverified',
      authMethod: 'api-key', scopes: ['model.plan'], providerVerification: { status: 'authorization-rejected', providerVerified: false,
        checkedAt: '2026-09-30T00:00:00.000Z', modelCount: 0, errorCode: 'A_MODEL_PROVIDER_POLICY_OR_SCOPE_REJECTED' } }],
    withCredentials: async (_connectionId, callback) => callback({ apiKey: secret }, {
      connectorId: 'jarvis-model-meta', connectionId: 'meta-connection', scopes: ['model.plan'], grants: [], authMethod: 'api-key'
    }),
    status: () => ({ configured: true, state: 'present-not-probed', provider: 'test-vault', protectedByOs: true,
      storageLocation: 'isolated-test', verificationState: 'not-probed', storesPlaintextCredentials: false }),
    save: () => { throw new Error('not used'); }, remove: () => ({ removed: false, remoteGrantRevoked: false })
  };
  const env = { PATH: process.env.PATH, TEMP: root, TMP: root, JARVIS_TEST_MODE: '1', JARVIS_TEST_AUDIT_ROOT: join(root, 'audit'), JARVIS_CORE_ROOT: root,
    JARVIS_CORE_PORT: '0', JARVIS_CORE_HOST: '127.0.0.1', JARVIS_CORE_ADMIN_TOKEN: 'fixture-admin-token',
    JARVIS_CORE_ALLOWED_ROOTS: 'workspace', JARVIS_CORE_WORKER_DAEMON_ENABLED: '0', JARVIS_CORE_WORKER_DAEMON_AUTOSTART: '0',
    JARVIS_PERSONAL_IMPORT_ENABLED: '0', JARVIS_GOOGLE_SYNC_ENABLED: '0', JARVIS_MISSION_PROVIDER: 'meta',
    JARVIS_MISSION_MODEL: 'muse-spark-1.3', JARVIS_META_API_KEY: '' };
  let runtime;
  try {
    runtime = await createConfiguredCoreServiceRuntime({ env, integrationVault: vault });
    assert.equal(runtime.missionRuntime.managedAgentSessionBroker, null, 'managed sessions stay disabled unless a factory is injected');
    runtime.server.listen(0, '127.0.0.1');
    await once(runtime.server, 'listening');
    const address = runtime.server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/integrations`, {
      headers: { Authorization: 'Bearer fixture-admin-token' }
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(payload.connectors.map(item => item.id), ['jarvis-model-xai', 'jarvis-model-meta', 'jarvis-model-gemini', 'jarvis-google-workspace', 'jarvis-openai-agents']);
    assert.ok(payload.connectors.slice(0, 3).every(item => item.capabilities[0].riskTier === 'read' && item.scopes.includes('model.plan')));
    const google = payload.connectors.find(item => item.id === 'jarvis-google-workspace');
    assert.deepEqual(google.scopes, ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/calendar.events.readonly']);
    assert.ok(google.capabilities.every(item => item.riskTier === 'read'));
    const readiness = payload.modelProviders.configuration.find(item => item.provider === 'meta');
    assert.equal(readiness.stage, 'configured-unverified');
    assert.equal(readiness.credentialSource, 'dpapi-vault');
    assert.equal(readiness.connectionStatus, 'unverified');
    assert.equal(readiness.executionAuthorized, false);
    assert.equal(payload.connections[0].providerVerification.status, 'authorization-rejected');
    assert.equal(payload.connections[0].providerVerification.errorCode, 'A_MODEL_PROVIDER_POLICY_OR_SCOPE_REJECTED');
    assert.deepEqual(payload.managedAgentCredentials, { 'provider.verify': false, 'session.create': false, 'session.read': false, 'session.message': false,
      'session.tool-result': false, 'session.cancel': false });
    assert.doesNotMatch(JSON.stringify(payload), /fixture-model-provider-secret/);
  } finally {
    if (runtime) await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Core service keeps managed sessions disabled by default and accepts only explicit broker-factory injection', async () => {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-core-managed-agent-factory-'));
  const env = { PATH: process.env.PATH, TEMP: root, TMP: root, JARVIS_TEST_MODE: '1', JARVIS_TEST_AUDIT_ROOT: join(root, 'audit'),
    JARVIS_CORE_ROOT: root, JARVIS_CORE_PORT: '0', JARVIS_CORE_HOST: '127.0.0.1', JARVIS_CORE_ADMIN_TOKEN: 'fixture-admin-token',
    JARVIS_CORE_ALLOWED_ROOTS: 'workspace', JARVIS_CORE_WORKER_DAEMON_ENABLED: '0', JARVIS_CORE_WORKER_DAEMON_AUTOSTART: '0',
    JARVIS_PERSONAL_IMPORT_ENABLED: '0', JARVIS_GOOGLE_SYNC_ENABLED: '0' };
  const broker = {
    bindSession: value => ({ ...value, executionAuthority: false }),
    sendMissionMessage: async () => ({ accepted: true, executionAuthority: false }),
    cancelMissionTurn: async () => ({ accepted: true, executionAuthority: false }),
    reconcileMission: async () => ({ outcomes: [], taskVerified: false, executionAuthority: false })
  };
  let factoryContext;
  let runtime;
  try {
    runtime = await createConfiguredCoreServiceRuntime({ env, managedAgentSessionBrokerFactory: context => {
      factoryContext = context;
      return broker;
    } });
    assert.equal(runtime.missionRuntime.managedAgentSessionBroker, broker);
    assert.equal(typeof factoryContext.managedAgentCredentialAccess?.resolve, 'function');
    assert.equal(factoryContext.managedAgentCredentialAccess.status()['session.create'], false);
    assert.ok(factoryContext.managedAgentEgressPolicy);
    runtime.server.listen(0, '127.0.0.1');
    await once(runtime.server, 'listening');
    const response = await fetch(`http://127.0.0.1:${runtime.server.address().port}/security/managed-agent-egress`, {
      headers: { Authorization: 'Bearer fixture-admin-token' }
    });
    assert.equal(response.status, 200);
    const status = await response.json();
    assert.equal(status.managedSessionConfigured, true);
    assert.equal(status.externalTransferEnabled, false, 'attaching the session broker must not grant egress');
  } finally {
    if (runtime) await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Core service can provision a Mission through the broker, Agents transport and synthetic WIF exchange', async () => {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-core-wif-session-e2e-'));
  const env = { PATH: process.env.PATH, TEMP: root, TMP: root, JARVIS_TEST_MODE: '1', JARVIS_TEST_AUDIT_ROOT: join(root, 'audit'),
    JARVIS_CORE_ROOT: root, JARVIS_CORE_PORT: '0', JARVIS_CORE_HOST: '127.0.0.1', JARVIS_CORE_ADMIN_TOKEN: 'fixture-admin-token',
    JARVIS_CORE_ALLOWED_ROOTS: 'workspace', JARVIS_CORE_WORKER_DAEMON_ENABLED: '0', JARVIS_CORE_WORKER_DAEMON_AUTOSTART: '0',
    JARVIS_PERSONAL_IMPORT_ENABLED: '0', JARVIS_GOOGLE_SYNC_ENABLED: '0' };
  const db = new DatabaseSync(':memory:');
  const calls = [];
  let subjectTokenReads = 0;
  let runtime;
  const tokenSource = createOpenAiWorkloadIdentityTokenSource({ identityProviderId: 'fixture-idp', serviceAccountId: 'fixture-service-account',
    getSubjectToken: async () => { subjectTokenReads++; return 'synthetic-oidc-subject-token'; },
    now: () => Date.parse('2026-09-30T00:00:00.000Z'),
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return { ok: true, status: 200, json: async () => ({ access_token: 'synthetic-openai-bearer', token_type: 'Bearer',
        expires_in: 300, expires_at: Math.floor(Date.parse('2026-09-30T00:05:00.000Z') / 1000) }) };
    } });
  const provider = createOpenAiAgentsSessionProvider({ resolveAccessToken: async () => tokenSource.getAccessToken(),
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return { ok: true, status: 200, json: async () => ({ id: 'remote-session-wif-1', status: 'idle' }) };
    } });
  try {
    runtime = await createConfiguredCoreServiceRuntime({ env, managedAgentSessionBrokerFactory: ({ managedAgentEgressPolicy }) => {
      assert.ok(managedAgentEgressPolicy, 'factory receives JARVIS egress policy for any future tool-data transfer');
      return new ManagedAgentSessionBroker({ db, provider, dispatchVerifiedTool: async () => ({ status: 'blocked' }),
        allowedToolNames: ['local.read_verified'],
        authorizeSessionCreate: async request => request.authorization?.resourceApproval === true
          && request.authorization?.missionId === request.missionId });
    } });
    const created = runtime.missionRuntime.createMission({ objective: '격리된 Agents 세션 경로를 검증한다.',
      successCriteria: ['원격 세션이 JARVIS Mission에 바인딩된다.'] });
    const provision = await runtime.missionRuntime.createManagedAgentSession(created.missionId, {
      authorization: { resourceApproval: true, missionId: created.missionId },
      sessionConfig: { model: 'gpt-test', instructions: 'No remote tools are enabled in this contract test.', tools: [] }
    });
    assert.equal(provision.status, 'bound', JSON.stringify({ provision,
      persisted: runtime.missionRuntime.managedAgentSessionBroker.sessionProvision(created.missionId), calls: calls.map(call => call.url) }));
    assert.equal(provision.sessionId, 'remote-session-wif-1');
    assert.equal(runtime.missionRuntime.missions.get(created.missionId).managedAgentSessionId, 'remote-session-wif-1');
    assert.equal(subjectTokenReads, 1);
    assert.equal(calls.length, 2, 'one OIDC exchange and one Agents API request');
    assert.equal(calls[0].url, 'https://auth.openai.com/oauth/token');
    assert.equal(calls[1].url, 'https://api.openai.com/v1/agents/sessions');
    assert.equal(calls[1].init.headers.Authorization, 'Bearer synthetic-openai-bearer');
    assert.doesNotMatch(JSON.stringify(provision), /synthetic-(?:oidc-subject-token|openai-bearer)/u);
    assert.doesNotMatch(JSON.stringify(runtime.missionRuntime.missions.get(created.missionId)), /synthetic-(?:oidc-subject-token|openai-bearer)/u);
  } finally {
    tokenSource.clearMemoryCache();
    if (runtime) await runtime.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Core provider verification safely persists a mocked 403 policy/scope result for the readiness UI', async () => {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-core-provider-403-'));
  const secret = 'synthetic-provider-api-key';
  const connection = { connectionId: 'meta-fixture', connectorId: 'jarvis-model-meta', providerAccountId: 'primary',
    status: 'credentials-stored-unverified', authMethod: 'api-key', scopes: ['model.plan'], grants: [],
    updatedAt: '2026-09-30T00:00:00.000Z' };
  let verification = null;
  const vault = {
    list: () => [{ ...connection, ...(verification ? { providerVerification: verification } : {}) }],
    withCredentials: async (_id, callback) => callback({ apiKey: secret }, { connectorId: connection.connectorId,
      connectionId: connection.connectionId, scopes: [...connection.scopes], grants: [], authMethod: 'api-key', updatedAt: connection.updatedAt }),
    recordProviderVerification: (_id, result, { expectedUpdatedAt } = {}) => {
      assert.equal(expectedUpdatedAt, connection.updatedAt);
      verification = { ...result };
      return { ...connection, providerVerification: verification };
    },
    status: () => ({ configured: true, state: 'present-not-probed', storesPlaintextCredentials: false }),
    save: () => { throw new Error('not used'); }, remove: () => ({ removed: false, remoteGrantRevoked: false })
  };
  const env = { PATH: process.env.PATH, TEMP: root, TMP: root, JARVIS_TEST_MODE: '1', JARVIS_TEST_AUDIT_ROOT: join(root, 'audit'),
    JARVIS_CORE_ROOT: root, JARVIS_CORE_PORT: '0', JARVIS_CORE_HOST: '127.0.0.1', JARVIS_CORE_ADMIN_TOKEN: 'fixture-admin-token',
    JARVIS_CORE_ALLOWED_ROOTS: 'workspace', JARVIS_CORE_WORKER_DAEMON_ENABLED: '0', JARVIS_CORE_WORKER_DAEMON_AUTOSTART: '0',
    JARVIS_PERSONAL_IMPORT_ENABLED: '0', JARVIS_GOOGLE_SYNC_ENABLED: '0' };
  let runtime;
  try {
    runtime = await createConfiguredCoreServiceRuntime({ env, integrationVault: vault,
      modelProviderFetch: async url => {
        assert.equal(String(url), 'https://api.meta.ai/v1/models');
        return new Response('{"detail":"must not be retained"}', { status: 403 });
      } });
    runtime.server.listen(0, '127.0.0.1');
    await once(runtime.server, 'listening');
    const base = `http://127.0.0.1:${runtime.server.address().port}`;
    const headers = { Authorization: 'Bearer fixture-admin-token' };
    const checked = await fetch(`${base}/integrations/model-providers/meta/verify`, { method: 'POST', headers: {
      ...headers, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(checked.status, 200);
    const checkResult = await checked.json();
    assert.equal(checkResult.status, 'authorization-rejected');
    assert.equal(checkResult.errorCode, 'A_MODEL_PROVIDER_POLICY_OR_SCOPE_REJECTED');
    assert.equal(checkResult.providerVerified, false);
    assert.equal(checkResult.executionAuthorized, false);
    assert.doesNotMatch(JSON.stringify(checkResult), /must not be retained|synthetic-provider-api-key/u);

    const readiness = await fetch(`${base}/integrations`, { headers });
    assert.equal(readiness.status, 200);
    const payload = await readiness.json();
    assert.equal(payload.connections[0].providerVerification.status, 'authorization-rejected');
    assert.equal(payload.connections[0].providerVerification.errorCode, 'A_MODEL_PROVIDER_POLICY_OR_SCOPE_REJECTED');
    assert.equal(payload.connections[0].grants.length, 0);
    assert.doesNotMatch(JSON.stringify(payload), /must not be retained|synthetic-provider-api-key/u);
  } finally {
    if (runtime) await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});
