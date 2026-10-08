import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { CoreClient } from '../packages/core/src/client/core-client.js';
import { createCoreServer } from '../packages/core/src/main.mjs';
import { MissionRoleAgentSessionPool } from '../packages/core/src/mission/mission-role-agent-session-pool.js';
import { listenOnFetchSafePort } from '../packages/shared/src/http.js';

const mission = runtime => runtime.missionRuntime.createMission({ objective: '로컬 임무와 선택형 관리 세션을 연결한다.',
  successCriteria: ['로컬 임무 상태를 보존한다.'] });

test('managed-agent bridge is disabled by default and does not require a provider or secret', () => {
  const runtime = createAgRuntime({ env: {}, workerDaemonEnabled: false });
  const created = mission(runtime);
  assert.equal(runtime.missionRuntime.bindManagedAgentSession(created.missionId, 'sess-disabled').error.code, 'A_MANAGED_AGENT_DISABLED');
  runtime.workerDaemon?.stop?.();
});

test('managed session creation blocks sensitive instructions before any remote provisioning call', async t => {
  let provisions = 0;
  const broker = {
    bindSession(value) { return { ...value, replayed: false }; },
    async provisionSession() { provisions++; return { status: 'bound', sessionId: 'must-not-exist' }; },
    async sendMissionMessage() { return { accepted: true }; },
    async cancelMissionTurn() { return { accepted: true }; },
    async reconcileMission() { return { outcomes: [] }; }
  };
  const runtime = createAgRuntime({ env: {}, workerDaemonEnabled: false,
    managedAgentSessionBrokerFactory: () => broker });
  t.after(() => runtime.workerDaemon?.stop?.());
  const created = mission(runtime);
  const result = await runtime.missionRuntime.createManagedAgentSession(created.missionId, {
    authorization: { resourceApproval: true },
    sessionConfig: { model: 'test-model', instructions: 'Summarize these notes for pastor@example.org.' }
  });
  assert.equal(result.success, false);
  assert.equal(result.error.code, 'A_MANAGED_AGENT_SESSION_CONFIG_EGRESS_BLOCKED');
  assert.equal(result.dataClass, 'D2');
  assert.equal(provisions, 0, 'classification must happen before the provider/broker create path');
  assert.doesNotMatch(JSON.stringify(result), /pastor@example\.org/u, 'response must not echo transferred content');
  runtime.missionRuntime.dataClassifier.classify = () => { throw new Error('synthetic classifier failure'); };
  const classifierFailure = await runtime.missionRuntime.createManagedAgentSession(created.missionId, {
    authorization: { resourceApproval: true },
    sessionConfig: { model: 'test-model', instructions: 'Generic public instructions.' }
  });
  assert.equal(classifierFailure.error.code, 'A_MANAGED_AGENT_SESSION_CONFIG_CLASSIFICATION_UNAVAILABLE');
  assert.equal(provisions, 0, 'classifier errors must fail closed before remote provisioning');
});

test('Mission Runtime routes role sessions by assignment and does not fall back to a legacy broker', async t => {
  const makeBroker = (role, sessionName) => ({
    db: {}, calls: [], workerRole: role,
    bindSession(request) { this.calls.push(['bind', request]); return { ...request, replayed: false }; },
    async provisionSession(request) {
      this.calls.push(['provision', request]);
      return { missionId: request.missionId, sessionId: `${sessionName}-provisioned`, provisioningId: `provision-${role}`,
        status: 'bound', replayed: false };
    },
    async reconcileSessionProvision(missionId, request) {
      const input = missionId && typeof missionId === 'object' ? missionId : { missionId, ...(request ?? {}) };
      this.calls.push(['provision-reconcile', input.missionId, Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'missionId'))]);
      return { missionId: input.missionId, sessionId: `${sessionName}-recovered`, provisioningId: `provision-${role}`,
        status: 'bound', replayed: true };
    },
    async sendMissionMessage(request) { this.calls.push(['message', request]); return { accepted: true, eventId: sessionName }; },
    async cancelMissionTurn(request) { this.calls.push(['cancel', request]); return { accepted: true, eventId: sessionName }; },
    async reconcileMission(missionId) { this.calls.push(['reconcile', missionId]); return { missionId, sessionId: sessionName, outcomes: [] }; }
  });
  const researcher = makeBroker('researcher', 'researcher-session'), editor = makeBroker('editor', 'editor-session');
  const roleRegistry = new DatabaseSync(':memory:');
  t.after(() => roleRegistry.close());
  const pool = new MissionRoleAgentSessionPool({ db: roleRegistry, roles: { researcher, editor }, authorizeRoleMessage: async () => true });
  const runtime = createAgRuntime({ env: {}, workerDaemonEnabled: false,
    managedAgentRoleSessionPoolFactory: ({ missionRuntime }) => {
      assert.ok(missionRuntime);
      return pool;
    } });
  const created = mission(runtime);
  const provisionMission = mission(runtime);
  const provisioned = await runtime.missionRuntime.createManagedAgentSession(provisionMission.missionId, {
    sessionConfig: { model: 'test-model', instructions: 'blank configuration' }, authorization: 'approved',
    workerRole: 'researcher', collaborationGroupId: 'g-provision'
  });
  assert.equal(provisioned.status, 'bound');
  assert.equal(provisioned.sessionId, 'researcher-session-provisioned');
  assert.equal(runtime.missionRuntime.missions.get(provisionMission.missionId).managedAgentSessions['g-provision:researcher'], provisioned.sessionId);
  assert.deepEqual(researcher.calls.map(([kind]) => kind), ['provision', 'bind']);
  assert.equal(editor.calls.length, 0);
  const provisionedMessage = await runtime.missionRuntime.sendManagedAgentMessage(provisionMission.missionId, {
    messageId: 'first-input', text: '별도 egress 경로를 통해 전송', workerRole: 'researcher',
    collaborationGroupId: 'g-provision', messageAuthorization: 'approved'
  });
  assert.equal(provisionedMessage.accepted, true);
  assert.equal(researcher.calls.at(-1)[0], 'message');
  assert.equal(runtime.missionRuntime.missions.get(provisionMission.missionId).status, provisionMission.status,
    'a remote acceptance does not complete the local Mission');
  const bound = runtime.missionRuntime.bindManagedAgentSession(created.missionId, 'researcher-session', {
    workerRole: 'researcher', collaborationGroupId: 'g-1'
  });
  assert.equal(bound.workerRole, 'researcher');
  assert.equal(runtime.missionRuntime.missions.get(created.missionId).managedAgentSessions['g-1:researcher'], 'researcher-session');
  const sent = await runtime.missionRuntime.sendManagedAgentMessage(created.missionId, {
    messageId: 'public-only', text: '공개 자료만 조사', workerRole: 'researcher', collaborationGroupId: 'g-1',
    messageAuthorization: 'approved'
  });
  assert.equal(sent.accepted, true);
  assert.equal(researcher.calls.at(-1)[0], 'message');
  assert.equal(editor.calls.length, 0);
  const reconciled = await runtime.missionRuntime.reconcileManagedAgentSession(created.missionId, {
    workerRole: 'researcher', collaborationGroupId: 'g-1'
  });
  assert.equal(reconciled.sessionId, 'researcher-session');

  const uncertainMission = mission(runtime);
  const recoveredProvision = await runtime.missionRuntime.reconcileManagedAgentSessionProvision(uncertainMission.missionId, {
    workerRole: 'researcher', collaborationGroupId: 'g-recovery', maxPages: 3
  });
  assert.equal(recoveredProvision.status, 'bound');
  assert.equal(recoveredProvision.sessionId, 'researcher-session-recovered');
  assert.equal(runtime.missionRuntime.missions.get(uncertainMission.missionId).managedAgentSessions['g-recovery:researcher'], recoveredProvision.sessionId);
  assert.equal(researcher.calls.find(([kind]) => kind === 'provision-reconcile')[1], uncertainMission.missionId);
  assert.deepEqual(researcher.calls.find(([kind]) => kind === 'provision-reconcile')[2], {
    maxPages: 3, workerRole: 'researcher', collaborationGroupId: 'g-recovery'
  });

  const legacyRuntime = createAgRuntime({ env: {}, workerDaemonEnabled: false, managedAgentSessionBroker: {
    bindSession: value => ({ ...value }), sendMissionMessage: async () => ({ accepted: true }),
    cancelMissionTurn: async () => ({ accepted: true }), reconcileMission: async () => ({ outcomes: [] })
  } });
  const legacyMission = mission(legacyRuntime);
  assert.equal(legacyRuntime.missionRuntime.bindManagedAgentSession(legacyMission.missionId, 'must-not-fallback', {
    workerRole: 'researcher', collaborationGroupId: 'g-1'
  }).error.code, 'A_MANAGED_AGENT_ROLE_SESSIONS_UNSUPPORTED');
  runtime.workerDaemon?.stop?.();
  legacyRuntime.workerDaemon?.stop?.();
});

test('role-scoped pool composition rejects an unscoped broker and conflicting broker sources', () => {
  const unscoped = { bindSession() {}, sendMissionMessage() {}, cancelMissionTurn() {}, reconcileMission() {} };
  assert.throws(() => createAgRuntime({ env: {}, workerDaemonEnabled: false,
    managedAgentRoleSessionPoolFactory: () => unscoped }), /must return a role-scoped session pool/u);
  assert.throws(() => createAgRuntime({ env: {}, workerDaemonEnabled: false, managedAgentSessionBroker: unscoped,
    managedAgentRoleSessionPoolFactory: () => unscoped }), /Configure only one managed agent broker/u);
});

test('optional managed session APIs require an existing nonterminal Mission and never promote remote acceptance to local success', async () => {
  const events = [];
  const broker = {
    bindSession: value => ({ ...value, replayed: false }),
    sendMissionMessage: async value => ({ status: 'accepted', accepted: true, eventId: 'e-message', providerStatus: 202, request: value }),
    cancelMissionTurn: async value => ({ status: 'accepted', accepted: true, eventId: 'e-cancel', providerStatus: 202,
      remoteTurnCancelled: false, missionCompleted: false, request: value }),
    reconcileMission: async () => ({ missionId: 'mission', sessionId: 'sess-1', remoteStatus: 'completed', outcomes: [],
      remoteTurnComplete: false, taskVerified: false, executionAuthority: false })
  };
  const runtime = createAgRuntime({ env: {}, workerDaemonEnabled: false, managedAgentSessionBrokerFactory: () => broker });
  const created = mission(runtime);
  assert.equal(runtime.missionRuntime.bindManagedAgentSession('missing', 'sess-1').error.code, 'A_MISSION_NOT_FOUND');
  const binding = runtime.missionRuntime.bindManagedAgentSession(created.missionId, 'sess-1');
  assert.equal(binding.sessionId, 'sess-1');
  assert.equal(binding.executionAuthority, false);
  runtime.missionRuntime.recordEvent = (type, current, payload) => events.push({ type, status: current.status, payload });
  const message = await runtime.missionRuntime.sendManagedAgentMessage(created.missionId, { messageId: 'msg-1', text: '추가 조건' });
  assert.equal(message.accepted, true);
  assert.equal(message.taskVerified, false);
  assert.equal(runtime.missionRuntime.getMission(created.missionId).status, created.status);
  const cancel = await runtime.missionRuntime.cancelManagedAgentTurn(created.missionId, 'cancel-request-1');
  assert.equal(cancel.remoteTurnCancelled, false);
  assert.equal(cancel.missionCompleted, false);
  const reconciled = await runtime.missionRuntime.reconcileManagedAgentSession(created.missionId);
  assert.equal(reconciled.remoteStatus, 'completed');
  assert.equal(reconciled.missionStatus, created.status);
  assert.equal(reconciled.taskVerified, false);
  assert.equal(events.length, 3);
  assert.equal(events.every(event => event.status === created.status), true);
});

test('authenticated Core client can provision and reconcile only empty Mission sessions', async t => {
  const calls = [];
  const broker = {
    bindSession: input => ({ ...input, replayed: false }),
    async provisionSession(input) {
      calls.push(['provision', input]);
      return { missionId: input.missionId, sessionId: 'api-empty-session', provisioningId: 'api-provision-1', status: 'bound' };
    },
    async reconcileSessionProvision(missionId, options) {
      const input = missionId && typeof missionId === 'object' ? missionId : { missionId, ...(options ?? {}) };
      calls.push(['reconcile-provision', input.missionId, Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'missionId'))]);
      return { missionId: input.missionId, sessionId: 'api-recovered-session', provisioningId: 'api-provision-2', status: 'bound' };
    },
    async sendMissionMessage() { return { accepted: true }; },
    async cancelMissionTurn() { return { accepted: true }; },
    async reconcileMission() { return { outcomes: [] }; }
  };
  const runtime = createAgRuntime({ env: {}, workerDaemonEnabled: false, managedAgentSessionBrokerFactory: () => broker });
  const created = mission(runtime);
  const server = createCoreServer(runtime.coreFacade, { adminToken: 'agents-session-api-test-token', missionRuntime: runtime.missionRuntime });
  const address = await listenOnFetchSafePort(server);
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    runtime.workerDaemon?.stop?.();
    runtime.coreFacade.cognition?.close();
  });

  const unauthorized = await fetch(`http://127.0.0.1:${address.port}/missions/${encodeURIComponent(created.missionId)}/managed-agent/session`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionConfig: { model: 'test-model' } })
  });
  assert.equal(unauthorized.status, 401);
  assert.equal(calls.length, 0, 'unauthenticated requests cannot create remote sessions');

  const client = new CoreClient({ baseUrl: `http://127.0.0.1:${address.port}`, adminToken: 'agents-session-api-test-token' });
  const openApi = await client.openApi();
  assert.equal(openApi.paths['/missions/{missionId}/managed-agent/session'].post.operationId, 'createManagedAgentMissionSession');
  assert.equal(openApi.paths['/missions/{missionId}/managed-agent/session'].post.security[0].bearerAuth.length, 0);
  assert.equal(openApi.paths['/missions/{missionId}/managed-agent/session/reconcile'].post.operationId,
    'reconcileManagedAgentMissionSessionProvision');
  const provisioned = await client.createManagedAgentSession(created.missionId, {
    sessionConfig: { model: 'test-model', instructions: 'blank session only' }, authorization: { approvalId: 'operator-approved' }
  });
  assert.equal(provisioned.status, 'bound');
  assert.equal(provisioned.sessionId, 'api-empty-session');
  assert.equal('input' in calls[0][1].sessionConfig, false);
  assert.equal(runtime.missionRuntime.missions.get(created.missionId).status, created.status);

  const recovered = await client.reconcileManagedAgentSessionProvision(created.missionId, { maxPages: 2 });
  assert.equal(recovered.status, 'bound');
  assert.equal(recovered.sessionId, 'api-recovered-session');
  assert.equal(calls[1][0], 'reconcile-provision');
  assert.equal(calls[1][2].maxPages, 2);
});

test('failed role session pauses the Mission and permits only another role to continue from verified work', async () => {
  const broker = {
    supportsRoleScopedSessions: true,
    bindSession: value => ({ ...value, replayed: false, executionAuthority: false }),
    sendMissionMessage: async () => ({ accepted: true }),
    cancelMissionTurn: async () => ({ accepted: true }),
    reconcileMission: async (missionId, assignment) => ({ missionId, sessionId: 'research-session', remoteStatus: 'failed',
      outcomes: [], ...assignment, executionAuthority: false })
  };
  const runtime = createAgRuntime({ env: {}, workerDaemonEnabled: false,
    managedAgentSessionBrokerFactory: () => broker });
  try {
    const created = mission(runtime);
    runtime.missionRuntime.bindManagedAgentSession(created.missionId, 'research-session', {
      workerRole: 'researcher', collaborationGroupId: 'group-g12'
    });
    const observed = await runtime.missionRuntime.reconcileManagedAgentSession(created.missionId, {
      workerRole: 'researcher', collaborationGroupId: 'group-g12'
    });
    assert.equal(observed.handoffPermitted, true);
    assert.equal(observed.missionStatus, 'PAUSED');
    const stored = runtime.missionRuntime.missions.get(created.missionId);
    assert.equal(stored.stopReason, 'managed-agent-worker-failed');
    assert.equal(stored.observations.at(-1).data.disposition, 'handoff-permitted-from-verified-artifacts');
    assert.equal(runtime.missionRuntime.plannerContext(stored, Date.now()).managedAgentWorkerFailures[0].workerRole, 'researcher');

    const action = workerRole => ({ id: `${workerRole}-continue`, title: `${workerRole} 이어 하기`, command: '계속 처리해줘',
      expectedToolName: workerRole === 'editor' ? 'filesystem.createTextFile' : 'filesystem.readText',
      arguments: workerRole === 'editor' ? { path: 'continued.txt', content: 'from verified evidence' } : { path: 'verified.txt' },
      dependencies: [], collaborationGroupId: 'group-g12', workerRole, successSignal: '검증 가능한 결과 확인' });
    assert.equal(runtime.missionRuntime.createWave(stored, { actions: [action('researcher')] }), null,
      'the failed worker cannot be silently retried under the same role/group');
    assert.equal(stored.stopReason, 'managed-agent-role-worker-unavailable');
    const successorWave = runtime.missionRuntime.createWave(stored, { actions: [action('editor')] });
    assert.equal(successorWave?.actions[0].workerRole, 'editor', 'a different role can continue the durable Mission');
  } finally {
    runtime.workerDaemon?.stop?.();
    runtime.coreFacade.cognition?.close();
  }
});

test('failed role session with an unverified tool outcome blocks every role handoff', async () => {
  const broker = {
    supportsRoleScopedSessions: true,
    bindSession: value => ({ ...value, replayed: false }),
    sendMissionMessage: async () => ({ accepted: true }),
    cancelMissionTurn: async () => ({ accepted: true }),
    reconcileMission: async (missionId, assignment) => ({ missionId, sessionId: 'research-session', remoteStatus: 'failed',
      outcomes: [{ status: 'blocked', reason: 'execution-outcome-uncertain', verified: false }], ...assignment })
  };
  const runtime = createAgRuntime({ env: {}, workerDaemonEnabled: false,
    managedAgentSessionBrokerFactory: () => broker });
  try {
    const created = mission(runtime);
    runtime.missionRuntime.bindManagedAgentSession(created.missionId, 'research-session', {
      workerRole: 'researcher', collaborationGroupId: 'group-uncertain'
    });
    const observed = await runtime.missionRuntime.reconcileManagedAgentSession(created.missionId, {
      workerRole: 'researcher', collaborationGroupId: 'group-uncertain'
    });
    assert.equal(observed.handoffPermitted, false);
    const stored = runtime.missionRuntime.missions.get(created.missionId);
    assert.equal(stored.stopReason, 'managed-agent-worker-result-uncertain');
    assert.equal(stored.managedAgentWorkerFailures[0].handoffPermitted, false);
    assert.equal(runtime.missionRuntime.plannerContext(stored, Date.now()).managedAgentWorkerFailures[0].disposition,
      'failed-result-uncertain');
  } finally {
    runtime.workerDaemon?.stop?.();
    runtime.coreFacade.cognition?.close();
  }
});
