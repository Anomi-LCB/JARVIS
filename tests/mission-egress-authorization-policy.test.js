import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { MissionEgressDecisionKeyStore } from '../packages/core/src/security/mission-egress-decision-key-store.js';
import { createMissionEgressAuthorizationPolicy } from '../packages/core/src/mission/mission-egress-authorization-policy.js';
import { MissionGrant } from '../packages/core/src/mission/mission-runtime.js';

const sha256 = value => createHash('sha256').update(value).digest('hex');

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-egress-policy-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const keyStore = new MissionEgressDecisionKeyStore({ path: join(root, 'key.json'), platform: 'win32',
    protect: value => Buffer.from(value, 'base64').toString('base64'),
    unprotect: value => Buffer.from(value, 'base64').toString('base64'), harden: () => {},
    clock: () => new Date('2026-09-27T16:00:00.000Z') });
  keyStore.initialize();
  const mission = { missionId: 'parent-1', status: 'PAUSED', authorization:{grants:[MissionGrant.READ_ONLY]}, goalContract: { revision: 1 }, gates: [] };
  const missionRuntime = { missions: new Map([[mission.missionId, mission]]), clock: () => new Date('2026-09-27T16:00:00.000Z'),
    createExternalEgressGate(parent, scope) {
      const gate = { type: 'external_data_egress', gateId: 'gate-1', missionId: parent.missionId, status: 'pending', goalRevision: parent.goalContract.revision,
        childMissionId: scope.childMissionId, callKey: scope.callKey, providerId: scope.providerId, toolName: scope.toolName,
        contentSha256: scope.contentSha256, dataClass: scope.dataClass, ministryDataClass: scope.ministryDataClass,
        expiresAt: '2026-09-27T16:10:00.000Z' };
      parent.gates.push(gate); return { success: true, gateId: gate.gateId };
    } };
  let sequence = 0;
  const policy = createMissionEgressAuthorizationPolicy({ missionRuntime, keyStore, decisionId: () => `decision-${++sequence}` });
  return { mission, keyStore, policy };
}

function request(content, dataClass = 'D0', ministryDataClass = 'M0') {
  return { parentMissionId: 'parent-1', childMissionId: 'child-1', callKey: 'call-1', providerId: 'openai-agents-api',
    purpose: 'mission-tool-evidence', contentKind: 'LOCAL_FILE_CONTENT',
    toolName: 'jarvis.mission.read_text', content, contentToAuthorizeSha256: sha256(content),
    classification: { dataClass, ministryDataClass, classifierVersion: 'test-classifier-v1' },
    classificationRequired: true, untrusted: true };
}

for (const [label, alter] of [
  ['missing purpose', input => { delete input.purpose; }],
  ['training purpose', input => { input.purpose = 'model-training'; }],
  ['different data kind', input => { input.contentKind = 'USER_CONTEXT'; }],
  ['financial category despite low rank', input => { input.classification.sensitiveFlags = ['financial']; }]
]) {
  test(`egress data/purpose scope refuses ${label}`, async t => {
    const { policy } = await fixture(t);
    const input = request('synthetic notes'); alter(input);
    const output = await policy.authorize(input);
    assert.equal(output.status, 'denied');
  });
}

test('D0/D1 content receives a short-lived exact-scope signed policy grant', async t => {
  const { policy } = await fixture(t);
  const output = await policy.authorize(request('public notes'));
  assert.equal(output.status, 'authorized');
  assert.equal(output.content, 'public notes');
  assert.equal(await policy.verify(output.authorization), true);
  assert.equal(output.authorization.claims.authorizationMode, 'policy-auto');
  assert.equal(output.authorization.claims.contentSha256, sha256('public notes'));
  assert.equal(output.authorization.claims.purpose, 'mission-tool-evidence');
  assert.equal(output.authorization.claims.contentKind, 'LOCAL_FILE_CONTENT');
  assert.equal(Date.parse(output.authorization.claims.expiresAt) - Date.parse(output.authorization.claims.issuedAt), 300_000);
});

test('a valid signature cannot restore obsolete or repurposed data-policy evidence', async t => {
  const {policy,keyStore} = await fixture(t);
  const allowed = await policy.authorize(request('public notes'));
  for (const alter of [claims => { delete claims.purpose; }, claims => { claims.purpose='model-training'; },
    claims => { claims.contentKind='USER_CONTEXT'; }, claims => { claims.dataPolicyVersion='obsolete'; },
    claims => { claims.classification.sensitiveFlags=['financial']; }]) {
    const claims=structuredClone(allowed.authorization.claims);alter(claims);
    assert.equal(policy.verify(keyStore.signDecision(claims)),false);
  }
});

test('D2/M2 material pauses at a scoped Mission gate then signs only its approved identity', async t => {
  const { mission, policy } = await fixture(t), input = request('personal contact', 'D2', 'M2');
  const pending = await policy.authorize(input);
  assert.deepEqual(pending, { status: 'pending_approval', gateId: 'gate-1' });
  assert.equal(mission.gates[0].contentSha256, sha256(input.content));
  mission.gates[0].status = 'approved'; mission.gates[0].decidedBy = 'core-admin:trusted-owner';
  const released = await policy.authorize(input);
  assert.equal(released.status, 'authorized');
  assert.equal(released.authorization.claims.authorizationMode, 'mission-gate');
  assert.equal(released.authorization.claims.approvedBy, 'core-admin:trusted-owner');
  assert.equal(released.authorization.claims.gateId, 'gate-1');
  assert.equal(await policy.verify(released.authorization), true, JSON.stringify({claims:released.authorization.claims,gate:mission.gates[0]}));
});

test('sensitive, mutated, rejected, expired and out-of-scope requests fail closed', async t => {
  const { mission, policy } = await fixture(t);
  assert.equal((await policy.authorize(request('secret', 'D3', 'M0'))).reason, 'sensitive-content-withheld');
  const altered = request('one'); altered.contentToAuthorizeSha256 = sha256('two');
  assert.equal((await policy.authorize(altered)).reason, 'request-scope-invalid');
  const wrongProvider = request('notes'); wrongProvider.providerId = 'other-provider';
  assert.equal((await policy.authorize(wrongProvider)).reason, 'request-scope-invalid');
  const input = request('personal', 'D2'); await policy.authorize(input);
  mission.gates[0].status = 'rejected';
  assert.equal((await policy.authorize(input)).reason, 'gate-not-authorized');
  mission.gates[0].status = 'approved'; mission.gates[0].decidedBy = 'core-admin:trusted-owner';
  mission.gates[0].expiresAt = '2026-09-27T15:59:59.000Z';
  assert.equal((await policy.authorize(input)).reason, 'gate-not-authorized');
});

test('runtime passes an explicitly configured egress policy to the optional broker factory without enabling it by default', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-egress-runtime-wiring-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const keyStore = new MissionEgressDecisionKeyStore({ path: join(root, 'key.json'), platform: 'win32',
    protect: value => Buffer.from(value, 'base64').toString('base64'),
    unprotect: value => Buffer.from(value, 'base64').toString('base64'), harden: () => {} });
  let factoryPolicy = null;
  const broker = { bindSession() {}, sendMissionMessage() {}, cancelMissionTurn() {}, reconcileMission() {} };
  const runtime = createAgRuntime({ env: { JARVIS_TEST_MODE: '1' }, allowedRoots: [root], auditRoot: join(root, 'audit'),
    cwd: () => root, workerDaemonEnabled: false, managedAgentEgressKeyStore: keyStore,
    managedAgentSessionBrokerFactory: ({ managedAgentEgressPolicy }) => { factoryPolicy = managedAgentEgressPolicy; return broker; } });
  t.after(() => { runtime.workerDaemon?.stop({ reason: 'test-finished' }); runtime.coreFacade.cognition?.close(); });
  assert.equal(factoryPolicy, runtime.managedAgentEgressPolicy);
  assert.equal(typeof factoryPolicy.authorize, 'function');
  assert.equal(typeof factoryPolicy.verify, 'function');
  assert.equal(factoryPolicy.status().externalTransferEnabled, false);
  assert.equal(keyStore.status().signingEnabled, false);
});

test('signed egress policy decisions lose authority after goal correction, gate rejection or expiry', async t => {
  const {mission,policy}=await fixture(t);
  const original=await policy.authorize(request('public notes'));
  assert.equal(await policy.verify(original.authorization),true);
  mission.authorization.grants=[];
  assert.equal(await policy.verify(original.authorization),false);
  assert.equal((await policy.authorize(request('public notes'))).reason,'mission-read-grant-missing');
  mission.authorization.grants=[MissionGrant.READ_ONLY];
  mission.goalContract.revision=2;
  assert.equal(await policy.verify(original.authorization),false);
  assert.equal((await policy.authorize({...request('public notes'),goalRevision:1})).reason,'mission-goal-changed');
  const personal=request('personal notes','D2');
  await policy.authorize(personal);
  const gate=mission.gates.at(-1);gate.status='approved';gate.decidedBy='owner';
  const approved=await policy.authorize(personal);
  assert.equal(await policy.verify(approved.authorization),true);
  gate.status='rejected';
  assert.equal(await policy.verify(approved.authorization),false);
  gate.status='approved';gate.expiresAt='2026-09-27T15:00:00.000Z';
  assert.equal(await policy.verify(approved.authorization),false);
});
