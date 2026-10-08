import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PolicySecurityRuntime } from '../apps/policy-security/src/policy-runtime.js';
import { createCoreGrowthReviewAuthorizer } from '../apps/bridge/src/core-growth-review-authorizer.js';
import { CoreFacade } from '../packages/core/src/core-facade.js';
import { createCoreServer } from '../packages/core/src/main.mjs';
import { MissionRuntime } from '../packages/core/src/mission/mission-runtime.js';
import { CoreAdminScope } from '../packages/core/src/security/core-admin-auth.js';
import {
  PersonalOwnerSessionManager,
  isLoopbackAddress
} from '../packages/core/src/security/personal-owner-session.js';
import { ActionType, TaskStatus } from '../packages/shared/src/types.js';
import { listenOnFetchSafePort } from '../packages/shared/src/http.js';

test('personal owner session authorizes bounded local control and expires closed', () => {
  let now = Date.parse('2026-08-21T00:00:00.000Z');
  const manager = new PersonalOwnerSessionManager({ clock: () => new Date(now) });
  const activated = manager.activate({ durationMinutes: 30, requestedBy: 'test-owner' });
  assert.equal(activated.success, true);
  assert.equal(activated.active, true);

  const task = ownerTaskFixture({
    actionType: ActionType.DESKTOP_CONTROL,
    toolName: 'desktop.control',
    riskTier: 3
  });
  const authorized = manager.authorizeTask({
    sessionId: activated.session.sessionId,
    task,
    remoteAddress: '127.0.0.1'
  });
  assert.equal(authorized.allowed, true);
  assert.equal(authorized.requiredGrant, 'high_impact');
  assert.equal(authorized.standingApproval, true);
  assert.equal(authorized.externalTransferAuthorized, false);

  now += 30 * 60 * 1000 + 1;
  const expired = manager.authorizeTask({
    sessionId: activated.session.sessionId,
    task,
    remoteAddress: '127.0.0.1'
  });
  assert.equal(expired.allowed, false);
  assert.equal(expired.code, 'A_OWNER_SESSION_INACTIVE');
  assert.equal(manager.status().active, false);
  assert.equal(manager.status().recentAudit.some((entry) => entry.eventType === 'owner_session.expired'), true);
});

test('personal owner session keeps external, destructive, elevated, and remote actions per-action', () => {
  const manager = new PersonalOwnerSessionManager();
  const session = manager.activate({ durationMinutes: 15 }).session;
  const external = manager.authorizeTask({
    sessionId: session.sessionId,
    task: ownerTaskFixture({
      actionType: ActionType.SEND_EMAIL,
      toolName: 'email.send',
      riskTier: 2,
      externalTransfer: true
    }),
    remoteAddress: '127.0.0.1'
  });
  assert.equal(external.allowed, false);
  assert.equal(external.code, 'A_OWNER_TASK_RISK_BLOCKED');

  const elevatedTask = ownerTaskFixture({
    actionType: ActionType.DESKTOP_CONTROL,
    toolName: 'desktop.control',
    riskTier: 3
  });
  elevatedTask.policy.constraints.allowAdminPrivilege = true;
  const elevated = manager.authorizeTask({
    sessionId: session.sessionId,
    task: elevatedTask,
    remoteAddress: '127.0.0.1'
  });
  assert.equal(elevated.allowed, false);
  assert.equal(elevated.code, 'A_OWNER_TASK_ELEVATION_REQUIRED');

  const remote = manager.authorizeTask({
    sessionId: session.sessionId,
    task: ownerTaskFixture({ actionType: ActionType.LIST_FILES, toolName: 'filesystem.listFiles', riskTier: 5 }),
    remoteAddress: '192.168.0.10'
  });
  assert.equal(remote.allowed, false);
  assert.equal(remote.code, 'A_OWNER_SESSION_LOCAL_ONLY');
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('192.168.0.10'), false);
});

test('capability package approval is local, high-impact, session-bound, action-bound, and digest-bound', () => {
  const manager = new PersonalOwnerSessionManager();
  const packageDigest = 'a'.repeat(64);
  const artifactSha256 = 'b'.repeat(64);
  const inactive = manager.authorizeCapabilityPackageReview({ action: 'review', sessionId: 'missing', packageDigest, artifactSha256 });
  assert.equal(inactive.allowed, false);
  assert.equal(inactive.reason, 'A_OWNER_SESSION_INACTIVE');

  const lowPrivilege = manager.activate({ durationMinutes: 15, grants: ['read_only'] });
  const denied = manager.authorizeCapabilityPackageReview({ action: 'review', sessionId: lowPrivilege.session.sessionId,
    packageDigest, artifactSha256, remoteAddress: '127.0.0.1' });
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, 'owner-session-high-impact-grant-missing');

  manager.revoke();
  const activated = manager.activate({ durationMinutes: 15, grants: ['high_impact'] });
  const authorized = manager.authorizeCapabilityPackageReview({ action: 'review', sessionId: activated.session.sessionId,
    packageDigest, artifactSha256, deviceId: 'control-center', remoteAddress: '127.0.0.1' });
  assert.equal(authorized.allowed, true);
  assert.equal(authorized.packageDigest, packageDigest);
  assert.equal(authorized.artifactSha256, artifactSha256);
  assert.match(authorized.reviewerId, /^owner-session:/u);

  const mismatch = manager.authorizeCapabilityPackageReview({ action: 'promote', sessionId: activated.session.sessionId,
    packageDigest, artifactSha256: 'c'.repeat(64), remoteAddress: '127.0.0.1' });
  assert.equal(mismatch.allowed, true);
  assert.equal(mismatch.artifactSha256, 'c'.repeat(64));
  assert.notEqual(mismatch.artifactSha256, authorized.artifactSha256);
  const remote = manager.authorizeCapabilityPackageReview({ action: 'promote', sessionId: activated.session.sessionId,
    packageDigest, artifactSha256, remoteAddress: '192.168.1.9' });
  assert.equal(remote.allowed, false);
  assert.equal(remote.reason, 'A_OWNER_SESSION_LOCAL_ONLY');
  const invalidDigest = manager.authorizeCapabilityPackageReview({ action: 'review', sessionId: activated.session.sessionId,
    packageDigest: 'bad', artifactSha256, remoteAddress: '127.0.0.1' });
  assert.equal(invalidDigest.allowed, false);
  assert.equal(invalidDigest.reason, 'package-digest-invalid');
  manager.revoke();
  const revoked = manager.authorizeCapabilityPackageReview({ action: 'rollback', sessionId: activated.session.sessionId,
    packageDigest, artifactSha256, remoteAddress: '127.0.0.1' });
  assert.equal(revoked.allowed, false);
});

test('trusted mission grants stop authorizing actions as soon as the owner session expires', () => {
  let now = Date.parse('2026-08-21T00:00:00.000Z');
  const manager = new PersonalOwnerSessionManager({ clock: () => new Date(now) });
  const session = manager.activate({ durationMinutes: 5 }).session;
  const runtime = new MissionRuntime({
    coreFacade: {},
    orchestrationWorker: {},
    pcAgent: {},
    planner: { planNextWave() {} },
    ownerSessionManager: manager,
    clock: () => new Date(now)
  });
  const mission = {
    gates: [],
    authorization: {
      mode: 'trusted_session',
      grants: ['read_only', 'local_reversible', 'high_impact'],
      ownerSessionId: session.sessionId
    }
  };
  const profile = { executionClass: 'high_impact', perActionApproval: false };
  assert.equal(runtime.actionAuthorized(mission, {}, profile), true);
  assert.equal(runtime.actionAuthorized(mission, {}, { ...profile, perActionApproval: true }), false);
  now += 5 * 60 * 1000 + 1;
  assert.equal(runtime.actionAuthorized(mission, {}, profile), false);
});

test('Core HTTP owner session requires admin auth and applies standing approval to an eligible local task', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-owner-session-'));
  const policyRuntime = new PolicySecurityRuntime({ auditRoot: dir });
  const coreFacade = new CoreFacade({
    policyEngine: policyRuntime,
    workspaceRoot: dir,
    cwd: () => dir,
    eventLogPath: join(dir, 'core-events.jsonl'),
    orchestrationJournalPath: join(dir, 'orchestration.jsonl')
  });
  const ownerSessionManager = new PersonalOwnerSessionManager({ eventBus: coreFacade.eventBus });
  const server = createCoreServer(coreFacade, {
    adminToken: 'owner-session-test-admin',
    ownerSessionManager
  });
  const address = await listenOnFetchSafePort(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const deniedActivation = await fetch(`${baseUrl}/owner-session/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ durationMinutes: 30 })
    });
    assert.equal(deniedActivation.status, 401);

    const activated = await postJson(`${baseUrl}/owner-session/activate`, {
      durationMinutes: 30,
      grants: ['read_only', 'local_reversible', 'high_impact']
    }, 'owner-session-test-admin');
    assert.equal(activated.active, true);

    const task = await postJson(`${baseUrl}/tasks`, {
      rawText: '작업 폴더의 파일 목록을 보여줘',
      options: {
        source: 'pc_ui',
        sourceModule: 'B_PC_AGENT',
        deviceId: 'owner-session-test',
        ownerSessionId: activated.session.sessionId
      }
    }, 'owner-session-test-admin');
    assert.equal(task.status, TaskStatus.APPROVED);
    assert.equal(task.ownerAuthorization.allowed, true);
    assert.equal(task.ownerAuthorization.approvalApplied, true);
    assert.equal(task.ownerAuthorization.externalTransferAuthorized, false);

    const status = await getJson(`${baseUrl}/owner-session`, 'owner-session-test-admin');
    assert.equal(status.active, true);
    assert.equal(status.recentAudit.some((entry) => entry.eventType === 'owner_session.task_authorized'), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('Core growth skill review endpoint requires its narrow service scope and an active owner session', async () => {
  const manager = new PersonalOwnerSessionManager();
  const scopedToken = 'bridge-review-only-test-token';
  const server = createCoreServer(new CoreFacade(), {
    adminTokens: [{ token: 'owner-admin-token', tokenId: 'owner-admin', scopes: ['*'] }],
    adminTokenHashes: [{
      tokenHash: createHash('sha256').update(scopedToken).digest('hex'), tokenId: 'bridge-review-only', role: 'bridge-review-authorizer',
      scopes: [CoreAdminScope.AUTHORIZE_GROWTH_SKILL_REVIEW]
    }],
    ownerSessionManager: manager
  });
  const address = await listenOnFetchSafePort(server);
  const url = `http://127.0.0.1:${address.port}`;
  const authorizeFromBridge = createCoreGrowthReviewAuthorizer({ coreApiUrl: url, token: scopedToken });
  try {
    const request = (token, body) => fetch(`${url}/owner-session/authorize-growth-skill-review`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    assert.equal((await request('owner-admin-token', { action: 'review', deviceId: 'phone-1' })).status, 403);

    const activated = await postJson(`${url}/owner-session/activate`, {
      durationMinutes: 30, grants: ['read_only', 'local_reversible', 'high_impact']
    }, 'owner-admin-token');
    assert.equal(activated.active, true);

    const authorized = await request(scopedToken, { action: 'review', deviceId: 'phone-1' });
    assert.equal(authorized.status, 200);
    const decision = await authorized.json();
    assert.equal(decision.allowed, true);
    assert.equal(decision.deviceId, 'phone-1');
    assert.equal(decision.action, 'review');
    const bridgeDecision = await authorizeFromBridge({ action: 'promote', deviceId: 'phone-1' });
    assert.equal(bridgeDecision.allowed, true);
    assert.equal(bridgeDecision.authorization.deviceId, 'phone-1');

    const deniedAction = await request(scopedToken, { action: 'activate', deviceId: 'phone-1' });
    assert.equal(deniedAction.status, 403);
    const scopeDenied = await fetch(`${url}/owner-session`, {
      headers: { Authorization: `Bearer ${scopedToken}` }
    });
    assert.equal(scopeDenied.status, 403);

    manager.revoke();
    const afterRevoke = await request(scopedToken, { action: 'promote', deviceId: 'phone-1' });
    assert.equal(afterRevoke.status, 403);
    assert.equal((await afterRevoke.json()).reason, 'owner-session-inactive');
    const bridgeAfterRevoke = await authorizeFromBridge({ action: 'promote', deviceId: 'phone-1' });
    assert.equal(bridgeAfterRevoke.allowed, false);
    assert.equal(bridgeAfterRevoke.error.code, 'A_OWNER_SESSION_INACTIVE');
    assert.match(bridgeAfterRevoke.error.message, /PC에서 소유자 모드/u);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('capability package lifecycle HTTP routes enforce narrow scopes and attach loopback review context', async () => {
  const calls = [];
  const manager = {
    status: () => ({ lifecycleJournal: { integrity: 'verified', automaticExecutableRecovery: false } }),
    review: async (stageId, context) => { calls.push({ action: 'review', stageId, context }); return { stageId, status: 'reviewed' }; },
    promote: async stageId => { calls.push({ action: 'promote', stageId }); return { stageId, status: 'promoted' }; },
    rollback: async (rollbackId, context) => { calls.push({ action: 'rollback', rollbackId, context }); return { rollbackId, status: 'rolled_back' }; }
  };
  const server = createCoreServer(new CoreFacade(), {
    adminTokens: [
      { token: 'package-review-token', tokenId: 'package-review', scopes: [CoreAdminScope.AUTHORIZE_CAPABILITY_PACKAGE_REVIEW] },
      { token: 'package-manage-token', tokenId: 'package-manage', scopes: [CoreAdminScope.MANAGE_CAPABILITY_PACKAGES] },
      { token: 'diagnostics-token', tokenId: 'diagnostics', scopes: [CoreAdminScope.READ_DIAGNOSTICS] }
    ],
    capabilityPackagePromotionManager: manager
  });
  const address = await listenOnFetchSafePort(server);
  const url = `http://127.0.0.1:${address.port}/capability-package-promotions`;
  const post = (path, token, body) => fetch(`${url}/${path}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  try {
    assert.equal((await fetch(`${url}/status`, { headers: { Authorization: 'Bearer package-manage-token' } })).status, 403);
    const statusResponse = await fetch(`${url}/status`, { headers: { Authorization: 'Bearer diagnostics-token' } });
    assert.equal(statusResponse.status, 200);
    assert.equal((await statusResponse.json()).lifecycleJournal.automaticExecutableRecovery, false);
    assert.equal((await post('review', 'package-manage-token', { stageId: 's', ownerSessionId: 'o', deviceId: 'd' })).status, 403);
    assert.equal((await post('review', 'package-review-token', { stageId: 's', ownerSessionId: 'o', deviceId: 'd' })).status, 200);
    assert.equal((await post('promote', 'package-review-token', { stageId: 's' })).status, 403);
    assert.equal((await post('promote', 'package-manage-token', { stageId: 's' })).status, 200);
    assert.equal((await post('rollback', 'package-manage-token', { rollbackId: 'r', ownerSessionId: 'o', deviceId: 'd' })).status, 200);
    assert.equal(calls[0].context.remoteAddress === '::ffff:127.0.0.1' || calls[0].context.remoteAddress === '127.0.0.1', true);
    assert.equal(calls[2].context.ownerSessionId, 'o');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

function ownerTaskFixture({ actionType, toolName, riskTier, externalTransfer = false }) {
  return {
    taskId: 'task_owner_fixture',
    status: TaskStatus.WAITING_APPROVAL,
    plan: {
      action: {
        actionType,
        toolName,
        capability: {
          writesLocalFiles: actionType === ActionType.CREATE_FILE,
          reversible: true,
          externalTransfer
        }
      }
    },
    policy: {
      decision: 'require_approval',
      risk: { tier: riskTier },
      constraints: {
        allowExternalTransfer: externalTransfer,
        allowAdminPrivilege: false,
        reversibleRequired: true
      }
    },
    approvalCard: { riskTier }
  };
}

async function postJson(url, body, token) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  assert.equal(response.ok, true, JSON.stringify(payload));
  return payload;
}

async function getJson(url, token) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const payload = await response.json();
  assert.equal(response.ok, true, JSON.stringify(payload));
  return payload;
}
