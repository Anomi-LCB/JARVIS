import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { MissionGrant } from '../packages/core/src/mission/mission-runtime.js';
import { MissionCapabilityAvailabilityGuard } from '../packages/core/src/mission/mission-capability-availability.js';

const binding = { capabilityId: 'workflow.execute', providerId: 'isolated-fixture',
  accountRef: 'fixture-account-a', deviceRef: 'fixture-device-a', scopes: ['fixture.read'] };
const objective = "'input.json' JSON을 '원본'으로 읽고; '원본'을 'output.json' JSON으로 저장해";

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-availability-guard-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'input.json'), '[{"total":42}]');
  let now = Date.now(), runtime, probeCalls = 0;
  const env = { JARVIS_TEST_MODE: '1', JARVIS_MISSION_EXECUTIVE: '0', JARVIS_LLM_INTENT: '0', JARVIS_LLM_PLANNER: '0', JARVIS_LLM_CONTENT: '0' };
  const time = () => new Date(now).toISOString();
  const observe = changes => ({ ...binding, codeVersion: runtime.capabilityPackageRegistry.availabilityFor(binding).codeVersion,
    permissionRevision: 'grant-1', observedAt: time(), accountStatus: 'connected', observedAccountRef: binding.accountRef,
    deviceStatus: 'online', observedDeviceRef: binding.deviceRef, grantedScopes: binding.scopes,
    // This is isolated provider evidence for contract tests, never a claim of a live provider connection.
    verificationLevel: 'live-probe', evidenceRef: 'isolated-contract-fixture', ...changes });
  runtime = createAgRuntime({ allowedRoots: [root], auditRoot: join(root, 'audit'), env, taskEnv: env,
    workerDaemonEnabled: false, clock: () => new Date(now),
    capabilityBindingResolver: options.unbound ? undefined : context => options.resolver
      ? options.resolver(context) : context.toolName === 'workflow.execute' ? { required: true, binding } : { required: false },
    capabilityAvailabilityProbe: options.probe ? async context => {
      probeCalls += 1;
      now += 1;
      return options.probe(context, observe);
    } : undefined });
  if (options.observation !== false) runtime.capabilityPackageRegistry.recordAvailability(observe(options.observation));
  const owner = runtime.personalOwnerSession.activate({ requestedBy: 'availability-contract-test', durationMinutes: 5 });
  const authorization = { mode: 'trusted_session', ownerSessionId: owner.session.sessionId,
    grants: options.grants ?? [MissionGrant.READ_ONLY, MissionGrant.LOCAL_REVERSIBLE] };
  const created = runtime.missionRuntime.createMission({ objective, authorization,
    successCriteria: [{ statement: '합계 42가 저장된다.', verificationSpec: { version: 1, kind: 'json.value',
      path: 'output.json', pointer: '/0/total', equals: 42 } }] });
  let workerCalls = 0;
  const originalRun = runtime.orchestrationWorker.runTask.bind(runtime.orchestrationWorker);
  runtime.orchestrationWorker.runTask = (...args) => { workerCalls += 1; return originalRun(...args); };
  return { root, runtime, missionId: created.missionId, observe, advance: ms => { now += ms; },
    run: () => runtime.missionRuntime.runMission(created.missionId), calls: () => ({ workerCalls, probeCalls }) };
}

const reasonCodes = result => result.lastError?.reasons?.map(item => item.code) ?? [];

test('an ordinary local workflow keeps its actual execution path without a connection prerequisite', async t => {
  const f = await fixture(t, { unbound: true });
  const result = await f.run();
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.waves[0].actions[0].availability, undefined);
  assert.equal(f.calls().workerCalls, 1);
});

test('fresh exact binding is checked in planning and immediately before real local execution; E and G remain active', async t => {
  const f = await fixture(t, { probe: (context, observe) => observe() });
  const result = await f.run();
  assert.equal(result.status, 'COMPLETED', JSON.stringify(result.lastError));
  const action = result.waves[0].actions[0];
  assert.equal(action.availability.phase, 'dispatch');
  assert.equal(action.availability.executionAuthorized, false);
  assert.equal(action.availability.requiresPolicyCheck, true);
  assert.equal(action.availabilityBindingSnapshot.binding.accountRef, binding.accountRef);
  assert.equal(result.verificationStatus, 'passed');
  assert.equal(JSON.parse(await readFile(join(f.root, 'output.json'), 'utf8'))[0].total, 42);
  assert.deepEqual(f.calls(), { workerCalls: 1, probeCalls: 5 });
});

test('missing live observation blocks before worker handoff even when code is ready and planner omitted the binding', async t => {
  const f = await fixture(t, { observation: false });
  const result = await f.run();
  assert.equal(result.status, 'PAUSED');
  assert.equal(result.stopReason, 'capability-unavailable');
  assert.ok(reasonCodes(result).includes('availability-not-observed'));
  assert.equal(result.waves[0].actions[0].availability.codeReady, true);
  assert.equal(result.waves[0].actions[0].taskId, null);
  assert.equal(f.calls().workerCalls, 0);
});

test('synthetic and sandbox observations do not unlock the mission', async t => {
  for (const verificationLevel of ['synthetic', 'sandbox']) {
    const f = await fixture(t, { observation: { verificationLevel } });
    const result = await f.run();
    assert.equal(result.status, 'PAUSED');
    assert.ok(reasonCodes(result).includes('execution-unverified'));
    assert.equal(f.calls().workerCalls, 0);
  }
});

test('revocation, scope loss and offline device discovered by dispatch probe stop all worker calls', async t => {
  for (const [changes, expected] of [[{ accountStatus: 'revoked' }, 'account-revoked'],
    [{ grantedScopes: [] }, 'scope-not-granted'], [{ deviceStatus: 'offline' }, 'device-offline'],
    [{ observedAccountRef: 'wrong-account' }, 'account-identity-unverified']]) {
    const f = await fixture(t, { probe: (context, observe) => observe(changes) });
    const result = await f.run();
    assert.equal(result.status, 'PAUSED');
    assert.ok(reasonCodes(result).includes(expected), JSON.stringify(result.lastError));
    assert.equal(result.waves[0].actions[0].attempts, 0);
    assert.equal(f.calls().workerCalls, 0);
  }
});

test('account, device, scope or required binding removal after planning cannot inherit the earlier ready result', async t => {
  for (const replacement of [null, { ...binding, accountRef: 'fixture-account-b' },
    { ...binding, deviceRef: 'fixture-device-b' }, { ...binding, scopes: [] }]) {
    const f = await fixture(t, { resolver: ({ phase }) => phase === 'dispatch'
      ? replacement ? { required: true, binding: replacement } : { required: false }
      : { required: true, binding } });
    const result = await f.run();
    assert.equal(result.status, 'PAUSED');
    assert.ok(reasonCodes(result).includes(replacement ? 'binding-changed' : 'binding-removed'));
    assert.equal(f.calls().workerCalls, 0);
  }
});

test('an observation that becomes stale after authorization cannot reach worker dispatch', async t => {
  const f = await fixture(t);
  const runtime = f.runtime.missionRuntime, authorize = runtime.actionAuthorized.bind(runtime);
  runtime.actionAuthorized = (...args) => { const result = authorize(...args); f.advance(60_001); return result; };
  const result = await f.run();
  assert.equal(result.status, 'PAUSED');
  assert.ok(reasonCodes(result).includes('observation-stale'));
  assert.equal(f.calls().workerCalls, 0);
});

test('availability does not grant a local write permission or bypass the owner approval boundary', async t => {
  const f = await fixture(t, { grants: [MissionGrant.READ_ONLY] });
  const result = await f.run();
  assert.equal(result.status, 'WAITING_APPROVAL');
  assert.equal(result.pendingGates.length, 1);
  assert.equal(f.calls().workerCalls, 0);
});

test('a failed read probe cannot use cached readiness and does not expose provider error secrets', async t => {
  const f = await fixture(t, { probe: () => { throw new Error('fixture-secret-never-log'); } });
  const result = await f.run();
  assert.equal(result.status, 'PAUSED');
  assert.ok(reasonCodes(result).includes('availability-probe-failed'));
  assert.equal(JSON.stringify(result).includes('fixture-secret-never-log'), false);
  assert.equal(f.calls().workerCalls, 0);
});

test('planner-supplied readiness cannot substitute for a trusted connector binding', async () => {
  const guard = new MissionCapabilityAvailabilityGuard();
  const action = { plannedCapabilityBinding: binding };
  const result = await guard.assess({ mission: {}, action, toolName: 'fixture.connector', phase: 'planning' });
  assert.equal(result.available, false);
  assert.equal(result.reasons[0].code, 'binding-required');
  const omitted = await guard.assess({ mission: {}, action: {}, toolName: 'fixture.connector',
    contract: { requiresAvailabilityBinding: true }, phase: 'planning' });
  assert.equal(omitted.available, false);
  assert.equal(omitted.reasons[0].code, 'binding-required');
});

test('revocation during asynchronous effect staging is rechecked before worker handoff', async t => {
  const f = await fixture(t);
  const coordinator = f.runtime.missionRuntime.effectCoordinator;
  const stage = coordinator.stage.bind(coordinator);
  coordinator.stage = async (...args) => {
    const hooks = await stage(...args);
    f.advance(1);
    f.runtime.capabilityPackageRegistry.recordAvailability(f.observe({ accountStatus: 'revoked' }));
    return hooks;
  };
  const result = await f.run();
  assert.equal(result.status, 'PAUSED');
  assert.ok(reasonCodes(result).includes('account-revoked'));
  assert.equal(f.calls().workerCalls, 0);
  await assert.rejects(readFile(join(f.root, 'output.json')), { code: 'ENOENT' });
});

test('owner session revoked during effect staging withdraws the old Task approval before handoff', async t => {
  const f = await fixture(t);
  const coordinator = f.runtime.missionRuntime.effectCoordinator;
  const stage = coordinator.stage.bind(coordinator);
  coordinator.stage = async (...args) => {
    const hooks = await stage(...args);
    f.runtime.personalOwnerSession.revoke({ reason: 'test-revocation', revokedBy: 'test-owner' });
    return hooks;
  };
  const result = await f.run();
  assert.equal(result.status, 'WAITING_APPROVAL');
  assert.equal(f.calls().workerCalls, 0);
  const action = result.waves[0].actions[0];
  assert.equal(action.attempts, 0);
  assert.equal(f.runtime.coreFacade.getTask(action.taskId).status, 'CANCELLED');
  await assert.rejects(readFile(join(f.root, 'output.json')), { code: 'ENOENT' });
});

test('permission revision disappearing after planning cannot use the prior ready observation', async t => {
  const f = await fixture(t, { resolver: ({ phase }) => ({ required: true, binding,
    permissionRevision: phase === 'planning' ? 'grant-1' : null }) });
  const result = await f.run();
  assert.equal(result.status, 'PAUSED');
  assert.ok(reasonCodes(result).includes('permission-revision-removed'));
  assert.equal(f.calls().workerCalls, 0);
  await assert.rejects(readFile(join(f.root, 'output.json')), { code: 'ENOENT' });
});

test('older persisted binding cannot guess whether its permission revision came from the resolver', async t => {
  const f = await fixture(t);
  const action = {};
  const guard = f.runtime.missionRuntime.capabilityAvailabilityGuard;
  const args = {mission:{},action,toolName:'workflow.execute',phase:'planning'};
  assert.equal((await guard.assess(args)).available,true);
  action.availabilityBindingSnapshot=JSON.parse(JSON.stringify(action.availabilityBindingSnapshot));
  assert.equal((await guard.assess({...args,phase:'dispatch'})).available,true,'new snapshot survives serialization');
  delete action.availabilityBindingSnapshot.resolvedPermissionRevision;
  const legacy=await guard.assess({...args,phase:'dispatch'});
  assert.equal(legacy.available,false);
  assert.equal(legacy.reasons[0].code,'binding-snapshot-refresh-required');
  assert.equal(f.calls().workerCalls,0);
});

test('revocation while worker preflight awaits blocks the actual PC handoff', async t => {
  const f = await fixture(t);
  const worker=f.runtime.orchestrationWorker;
  const batch=worker.runVerificationIndexBatch.bind(worker);
  worker.runVerificationIndexBatch=async (operation,callback)=>{
    const value=await batch(operation,callback);
    if(operation==='worker.preflight.index'){f.advance(1);f.runtime.capabilityPackageRegistry.recordAvailability(f.observe({accountStatus:'revoked'}));}
    return value;
  };
  let packets=0;
  const receive=f.runtime.pcAgent.receiveExecutionPacket.bind(f.runtime.pcAgent);
  f.runtime.pcAgent.receiveExecutionPacket=(...args)=>{packets++;return receive(...args);};
  const result=await f.run();
  t.diagnostic(JSON.stringify({status:result.status,packets,stopReason:result.stopReason,lastError:result.lastError}));
  assert.equal(packets,0);
  assert.equal(result.status,'PAUSED');
  assert.equal(f.calls().workerCalls,1);
  assert.ok(reasonCodes(result).includes('account-revoked'));
  await assert.rejects(readFile(join(f.root,'output.json')),{code:'ENOENT'});
});
