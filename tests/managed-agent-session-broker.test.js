import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ManagedAgentSessionBroker } from '../packages/core/src/mission/managed-agent-session-broker.js';

async function fixture(t, { dispatchVerifiedTool = async () => ({ status: 'verified', output: '{"ok":true}',
  verification: { status: 'passed', verificationId: 'g-1', evidenceRef: 'g:receipt-1' } }), submitToolResult = async () => {},
  submitMessage = async () => ({ accepted: true, status: 202 }), cancelTurn = async () => ({ accepted: true, status: 202 }),
  workerRole = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-managed-agent-broker-'));
  const dbPath = join(root, 'operations.sqlite');
  let db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys=ON');
  let requiredActions = [];
  const provider = {
    async retrieveSession(sessionId) { return { id: sessionId, status: requiredActions.length ? 'requires_action' : 'in_progress', required_actions: structuredClone(requiredActions) }; },
    submitToolResult, submitMessage, cancelTurn
  };
  const makeBroker = dispatch => new ManagedAgentSessionBroker({ db, provider, dispatchVerifiedTool: dispatch,
    allowedToolNames: ['local.read_verified'], workerRole, clock: () => new Date('2026-09-27T14:00:00.000Z') });
  const broker = makeBroker(dispatchVerifiedTool);
  broker.bindSession({ missionId: 'mission-1', sessionId: 'sess-1', ...(workerRole ? { workerRole, collaborationGroupId: 'test-group' } : {}) });
  t.after(async () => { try { db?.close(); } catch {} await rm(root, { recursive: true, force: true }); });
  return { broker, makeBroker, provider, dbPath, setActions: actions => { requiredActions = actions; },
    getDb: () => db,
    reopen: () => { db.close(); db = new DatabaseSync(dbPath); db.exec('PRAGMA foreign_keys=ON'); return makeBroker(dispatchVerifiedTool); } };
}

const action = overrides => ({ type: 'function_call', turn_id: 'turn-1', call_id: 'call-1', name: 'local.read_verified', arguments: { path: 'notes.txt' }, ...overrides });

test('saved tool result has one submission owner across two brokers', async t=>{
  let calls=0,release,entered;
  const started=new Promise(resolve=>{entered=resolve;});
  const f=await fixture(t,{submitToolResult:async()=>{calls++;if(calls===1)throw new Error('lost');if(calls===2){entered();await new Promise(resolve=>{release=resolve;});}}});
  f.setActions([action()]);await assert.rejects(f.broker.reconcileMission('mission-1'),/lost/);
  const secondDb=new DatabaseSync(f.dbPath);
  const second=new ManagedAgentSessionBroker({db:secondDb,provider:f.provider,dispatchVerifiedTool:async()=>{throw new Error('do not redispatch');},allowedToolNames:['local.read_verified'],clock:()=>new Date('2026-09-27T14:00:00.000Z')});
  const first=f.broker.reconcileMission('mission-1');await started;
  try {
    await assert.rejects(second.reconcileMission('mission-1'),{code:'A_MANAGED_AGENT_TOOL_RESULT_SUBMISSION_BUSY'});
    assert.equal(calls,2,'first lost attempt plus one active send');
  }finally{release();await first;secondDb.close();}
  assert.equal(f.broker.callState({sessionId:'sess-1',turnId:'turn-1',callId:'call-1'}).state,'submitted');
});

test('expired tool-result owner cannot commit or clear a newer submission',async t=>{
  let calls=0,release,entered;const started=new Promise(r=>{entered=r;});
  const f=await fixture(t,{submitToolResult:async()=>{calls++;if(calls===1)throw new Error('lost');if(calls===2){entered();await new Promise(r=>{release=r;});}}});
  f.setActions([action()]);await assert.rejects(f.broker.reconcileMission('mission-1'),/lost/);
  const old=f.broker.reconcileMission('mission-1');const oldOutcome=assert.rejects(old,{code:'A_MANAGED_AGENT_TOOL_RESULT_SUBMISSION_OWNER_LOST'});await started;
  f.getDb().prepare('UPDATE managed_agent_tool_calls SET claim_expires_ms=0 WHERE state=?').run('result_ready');
  const fresh=f.makeBroker(async()=>{throw new Error('no redispatch');});
  try{await fresh.reconcileMission('mission-1');}finally{release();await oldOutcome;}
  assert.equal(calls,3);assert.equal(fresh.callState({sessionId:'sess-1',turnId:'turn-1',callId:'call-1'}).state,'submitted');
});

test('blank session provisioning is authorized, durable, role-bound, and idempotent', async t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  let creates = 0, authorization = null, createConfig = null;
  const provider = {
    async createSession(config, { authorizeSessionCreate }) {
      createConfig = config;
      authorization = await authorizeSessionCreate({ operation: 'create-agent-session', provider: 'openai-agents',
        model: config.model, environment: { type: 'openai_hosted' }, functionToolNames: [], metadata: config.metadata });
      if (!authorization) throw Object.assign(new Error('denied'), { code: 'A_OPENAI_AGENTS_SESSION_CREATE_UNAUTHORIZED' });
      creates++;
      return { id: 'remote-created-1', status: 'idle', metadata: config.metadata };
    },
    async retrieveSession(sessionId) { return { id: sessionId, status: 'idle', required_actions: [] }; },
    async submitToolResult() {}
  };
  const broker = new ManagedAgentSessionBroker({ db, provider, dispatchVerifiedTool: async () => ({}),
    allowedToolNames: ['local.read_verified'], workerRole: 'researcher',
    authorizeSessionCreate: async request => request.authorization?.resourceApproval === true
      && request.missionId === 'mission-provision-1' && request.workerRole === 'researcher' });
  const input = { missionId: 'mission-provision-1', workerRole: 'researcher', collaborationGroupId: 'research-group',
    authorization: { resourceApproval: true }, sessionConfig: { model: 'gpt-6-sol', instructions: 'Only use supplied local functions.',
      tools: [{ name: 'local.read_verified', description: 'Read one allowed file.', parameters: { type: 'object', properties: {} } }] } };
  const first = await broker.provisionSession(input);
  const replay = await broker.provisionSession(input);
  assert.equal(first.status, 'bound');
  assert.equal(first.sessionId, 'remote-created-1');
  assert.equal(first.replayed, false);
  assert.equal(replay.status, 'bound');
  assert.equal(replay.replayed, true);
  assert.equal(creates, 1);
  assert.equal(authorization, true);
  assert.equal('input' in createConfig, false);
  assert.match(createConfig.metadata.jarvisProvisioningId, /^[0-9a-f-]{36}$/u);
  assert.deepEqual(broker.sessionProvision(input.missionId), {
    missionId: input.missionId, provisioningId: createConfig.metadata.jarvisProvisioningId,
    workerRole: 'researcher', collaborationGroupId: 'research-group', state: 'bound', sessionId: 'remote-created-1',
    remoteStatus: 'idle', errorCode: null, createdAt: broker.sessionProvision(input.missionId).createdAt,
    updatedAt: broker.sessionProvision(input.missionId).updatedAt
  });
});

test('uncertain session-create result is not retried and reconciles by bounded opaque metadata lookup after restart', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-managed-agent-provision-'));
  const dbPath = join(root, 'operations.sqlite');
  let db = new DatabaseSync(dbPath), creates = 0, lists = 0;
  const provider = {
    async createSession(config) { creates++; throw Object.assign(new Error('response lost'), { code: 'A_OPENAI_AGENTS_TIMEOUT' }); },
    async listSessions(query) {
      lists++;
      assert.deepEqual(query, { limit: 100, order: 'desc' });
      const provisioningId = broker.sessionProvision('mission-provision-2').provisioningId;
      return { data: [{ id: 'remote-recovered-2', status: 'idle', metadata: { jarvisProvisioningId: provisioningId } }], has_more: false };
    },
    async retrieveSession(sessionId) { return { id: sessionId, status: 'idle', required_actions: [] }; },
    async submitToolResult() {}
  };
  const makeBroker = () => new ManagedAgentSessionBroker({ db, provider, dispatchVerifiedTool: async () => ({}),
    allowedToolNames: ['local.read_verified'], authorizeSessionCreate: async () => true });
  let broker = makeBroker();
  t.after(() => { try { db.close(); } catch {} return rm(root, { recursive: true, force: true }); });
  const request = { missionId: 'mission-provision-2', sessionConfig: { model: 'gpt-6-sol', instructions: 'Use only app functions.' } };
  const first = await broker.provisionSession(request);
  assert.equal(first.status, 'blocked');
  assert.equal(first.reason, 'session-create-outcome-uncertain');
  assert.equal(broker.sessionProvision(request.missionId).state, 'uncertain');
  db.close();
  db = new DatabaseSync(dbPath);
  broker = makeBroker();
  const recovered = await broker.reconcileSessionProvision(request.missionId);
  assert.equal(recovered.status, 'bound');
  assert.equal(recovered.sessionId, 'remote-recovered-2');
  assert.equal(broker.sessionProvision(request.missionId).state, 'bound');
  const replay = await broker.provisionSession(request);
  assert.equal(replay.sessionId, 'remote-recovered-2');
  assert.equal(creates, 1);
  assert.equal(lists, 1);
});

test('parallel session provisioning calls share one durable create and return a pending result to the second caller', async t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  let creates = 0, resolveCreate;
  const provider = {
    createSession: async () => { creates++; return new Promise(resolve => { resolveCreate = resolve; }); },
    async retrieveSession(sessionId) { return { id: sessionId, status: 'idle', required_actions: [] }; },
    async submitToolResult() {}
  };
  const broker = new ManagedAgentSessionBroker({ db, provider, dispatchVerifiedTool: async () => ({}),
    allowedToolNames: ['local.read_verified'], authorizeSessionCreate: async () => true });
  const request = { missionId: 'mission-provision-race', sessionConfig: { model: 'gpt-6-sol', instructions: 'Use app functions.' } };
  const firstPromise = broker.provisionSession(request);
  while (!resolveCreate) await new Promise(resolve => setImmediate(resolve));
  const second = await broker.provisionSession(request);
  assert.equal(second.status, 'pending');
  assert.equal(creates, 1);
  resolveCreate({ id: 'remote-race-1', status: 'idle' });
  const first = await firstPromise;
  assert.equal(first.status, 'bound');
  assert.equal(creates, 1);
});

test('managed session accepts only allowlisted required actions and submits a G-bound tool result once', async t => {
  let dispatches = 0; const submitted = [];
  const f = await fixture(t, {
    dispatchVerifiedTool: async () => { dispatches++; return { status: 'verified', output: '{"text":"verified"}', verification: { status: 'passed', verificationId: 'g-proof-1', evidenceRef: 'g:file:sha256' } }; },
    submitToolResult: async (_sessionId, result, options) => submitted.push({ result, options })
  });
  f.setActions([action()]);
  const result = await f.broker.reconcileMission('mission-1');
  assert.deepEqual(result.outcomes, [{ callId: 'call-1', status: 'result-submitted', verified: true, replayed: false }]);
  assert.equal(dispatches, 1);
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].result.turn_id, 'turn-1');
  assert.equal(submitted[0].result.call_id, 'call-1');
  assert.equal(submitted[0].result.success, true);
  assert.equal(typeof submitted[0].options.idempotencyKey, 'string');
  assert.equal(f.broker.callState({ sessionId: 'sess-1', turnId: 'turn-1', callId: 'call-1' }).state, 'submitted');
});

test('role-configured managed broker requires matching assignment and forwards it into guarded Mission dispatch', async t => {
  let dispatchRequest = null;
  const f = await fixture(t, { workerRole: 'researcher', dispatchVerifiedTool: async request => {
    dispatchRequest = request;
    return { status: 'verified', output: 'public source result',
      verification: { status: 'passed', verificationId: 'g-role', evidenceRef: 'g:role-proof' } };
  } });
  f.setActions([action()]);
  await assert.rejects(f.broker.reconcileMission('mission-1'), { code: 'A_MANAGED_AGENT_ROLE_ASSIGNMENT_MISMATCH' });
  const result = await f.broker.reconcileMission('mission-1', { workerRole: 'researcher', collaborationGroupId: 'test-group' });
  assert.equal(result.outcomes[0].verified, true);
  assert.equal(dispatchRequest.workerRole, 'researcher');
  assert.equal(dispatchRequest.collaborationGroupId, 'test-group');
  await assert.rejects(f.broker.reconcileMission('mission-1', { workerRole: 'editor', collaborationGroupId: 'test-group' }),
    { code: 'A_MANAGED_AGENT_ROLE_ASSIGNMENT_MISMATCH' });
  await assert.rejects(f.broker.sendMissionMessage({ missionId: 'mission-1', messageId: 'unscoped', text: 'message' }),
    { code: 'A_MANAGED_AGENT_ROLE_ASSIGNMENT_MISMATCH' });
});

test('unapproved tool is denied without entering the local dispatcher', async t => {
  let dispatches = 0; const submitted = [];
  const f = await fixture(t, { dispatchVerifiedTool: async () => { dispatches++; throw new Error('must not dispatch'); },
    submitToolResult: async (_sessionId, result) => submitted.push(result) });
  f.setActions([action({ name: 'filesystem.deleteEverything' })]);
  const result = await f.broker.reconcileMission('mission-1');
  assert.equal(dispatches, 0);
  assert.equal(result.outcomes[0].blocked, 'tool-not-allowlisted');
  assert.equal(submitted[0].success, false);
  assert.match(submitted[0].error, /not enabled/);
});

test('reused remote call identity with different arguments fails closed', async t => {
  const f = await fixture(t);
  f.setActions([action()]);
  await f.broker.reconcileMission('mission-1');
  f.setActions([action({ arguments: { path: 'different.txt' } })]);
  await assert.rejects(f.broker.reconcileMission('mission-1'), { code: 'A_MANAGED_AGENT_CALL_ID_REUSED' });
});

test('lost submit response retries the saved verified result with the same idempotency key and never reruns the effect', async t => {
  let dispatches = 0, submissions = 0; const keys = [];
  const f = await fixture(t, {
    dispatchVerifiedTool: async () => { dispatches++; return { status: 'verified', output: 'saved-output', verification: { status: 'passed', verificationId: 'g-proof', evidenceRef: 'g:receipt' } }; },
    submitToolResult: async (_sessionId, _result, options) => { keys.push(options.idempotencyKey); if (++submissions === 1) throw new Error('response lost after provider acceptance'); }
  });
  f.setActions([action()]);
  await assert.rejects(f.broker.reconcileMission('mission-1'), /response lost/);
  assert.equal(f.broker.callState({ sessionId: 'sess-1', turnId: 'turn-1', callId: 'call-1' }).state, 'result_ready');
  f.setActions([]);
  const resumedBroker = f.reopen();
  const resumed = await resumedBroker.reconcileMission('mission-1');
  assert.equal(resumed.outcomes.length, 0);
  assert.equal(dispatches, 1);
  assert.equal(submissions, 2);
  assert.equal(keys[0], keys[1]);
  assert.equal(resumedBroker.callState({ sessionId: 'sess-1', turnId: 'turn-1', callId: 'call-1' }).state, 'submitted');
});

test('a concurrent broker sees an active dispatch lease and cannot mark or rerun the call', async t => {
  let dispatches = 0, releaseDispatch;
  let enteredDispatch;
  const entered = new Promise(resolve => { enteredDispatch = resolve; });
  const hold = new Promise(resolve => { releaseDispatch = resolve; });
  const f = await fixture(t, { dispatchVerifiedTool: async () => {
    dispatches++; enteredDispatch(); await hold;
    return { status: 'verified', output: 'done', verification: { status: 'passed', verificationId: 'g-lease', evidenceRef: 'g:lease' } };
  } });
  f.setActions([action()]);
  const firstRun = f.broker.reconcileMission('mission-1');
  await entered;
  const secondBroker = f.makeBroker(async () => { dispatches++; throw new Error('concurrent dispatch must not run'); });
  const secondRun = await secondBroker.reconcileMission('mission-1');
  assert.equal(secondRun.outcomes[0].reason, 'dispatch-in-progress');
  assert.equal(f.broker.callState({ sessionId: 'sess-1', turnId: 'turn-1', callId: 'call-1' }).state, 'claimed');
  releaseDispatch();
  const firstResult = await firstRun;
  assert.equal(firstResult.outcomes[0].status, 'result-submitted');
  assert.equal(dispatches, 1);
});

test('an expired claimed lease becomes uncertain after restart and is not dispatched again', async t => {
  let dispatches = 0;
  const f = await fixture(t, { dispatchVerifiedTool: async () => { dispatches++; throw new Error('force uncertain state'); } });
  f.setActions([action()]);
  await f.broker.reconcileMission('mission-1');
  f.getDb().prepare("UPDATE managed_agent_tool_calls SET state='claimed',claim_owner='crashed-owner',claim_expires_ms=0,result_json=NULL,verification_id=NULL,evidence_ref=NULL WHERE session_id='sess-1' AND turn_id='turn-1' AND call_id='call-1'").run();
  const restarted = f.makeBroker(async () => { dispatches++; throw new Error('must not redispatch'); });
  const result = await restarted.reconcileMission('mission-1');
  assert.equal(result.outcomes[0].reason, 'execution-outcome-uncertain');
  assert.equal(f.getDb().prepare('SELECT state FROM managed_agent_tool_calls WHERE session_id=? AND turn_id=? AND call_id=?').get('sess-1','turn-1','call-1').state, 'uncertain');
  assert.equal(dispatches, 1);
});

test('uncertain B outcome never retries automatically and only a receipt-bound fresh G result releases it', async t => {
  let dispatches = 0; const f = await fixture(t, { dispatchVerifiedTool: async () => { dispatches++; throw new Error('lost after possible execution'); } });
  f.setActions([action()]);
  const first = await f.broker.reconcileMission('mission-1');
  assert.equal(first.outcomes[0].reason, 'dispatch-outcome-uncertain');
  const second = await f.broker.reconcileMission('mission-1');
  assert.equal(second.outcomes[0].reason, 'execution-outcome-uncertain');
  assert.equal(dispatches, 1);
  await assert.rejects(f.broker.reconcileUncertain({ sessionId: 'sess-1', turnId: 'turn-1', callId: 'call-1',
    result: { success: true, output: 'verified' }, verification: { status: 'passed', verificationId: 'g-2', evidenceRef: 'g:2' } }),
  { code: 'A_MANAGED_AGENT_EFFECT_RECEIPT_REQUIRED' });
  const reconciled = await f.broker.reconcileUncertain({ sessionId: 'sess-1', turnId: 'turn-1', callId: 'call-1',
    result: { success: true, output: 'verified' }, verification: { status: 'passed', verificationId: 'g-2', evidenceRef: 'g:2', sideEffectReceiptVerified: true } });
  assert.equal(reconciled.status, 'result-submitted-after-reconciliation');
  assert.equal(dispatches, 1);
});

test('nonterminal model turn never becomes a verified JARVIS mission completion', async t => {
  const f = await fixture(t);
  f.setActions([]);
  const result = await f.broker.reconcileMission('mission-1');
  assert.equal(result.remoteTurnComplete, false);
  assert.equal(result.taskVerified, false);
  assert.equal(result.executionAuthority, false);
});

test('message outbox persists before send and after restart replays exact payload with the same idempotency key', async t => {
  const calls = []; let first = true;
  const f = await fixture(t, { submitMessage: async (sessionId, text, options) => {
    calls.push({ sessionId, text, key: options.idempotencyKey });
    if (first) { first = false; throw Object.assign(new Error('response lost'), { code: 'transport-lost' }); }
    return { accepted: true, status: 202 };
  } });
  await assert.rejects(f.broker.sendMissionMessage({ missionId: 'mission-1', messageId: 'msg-1', text: 'resume this mission' }), /response lost/);
  let row = f.getDb().prepare('SELECT * FROM managed_agent_session_events WHERE event_type=?').get('message');
  assert.equal(row.state, 'ready');
  assert.equal(JSON.parse(row.payload_json).text, 'resume this mission');
  const restarted = f.reopen();
  const result = await restarted.sendMissionMessage({ missionId: 'mission-1', messageId: 'msg-1', text: 'resume this mission' });
  assert.equal(result.status, 'accepted');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1]);
  row = f.getDb().prepare('SELECT * FROM managed_agent_session_events WHERE event_type=?').get('message');
  assert.equal(row.state, 'submitted');
  assert.equal(row.payload_json, null);
  const duplicate = await restarted.sendMissionMessage({ missionId: 'mission-1', messageId: 'msg-1', text: 'resume this mission' });
  assert.equal(duplicate.status, 'already-submitted');
  assert.equal(calls.length, 2);
});

test('message outbox rejects reuse of a stable client key for different content', async t => {
  const f = await fixture(t, { submitMessage: async () => ({ accepted: true, status: 202 }) });
  await f.broker.sendMissionMessage({ missionId: 'mission-1', messageId: 'msg-unique', text: 'first content' });
  await assert.rejects(f.broker.sendMissionMessage({ missionId: 'mission-1', messageId: 'msg-unique', text: 'changed content' }),
    { code: 'A_MANAGED_AGENT_EVENT_ID_REUSED' });
});

test('session-current-turn cancellation fences an unknown outcome and never claims cancellation or mission completion', async t => {
  const calls = []; let first = true;
  const f = await fixture(t, { cancelTurn: async (sessionId, options) => {
    calls.push({ sessionId, key: options.idempotencyKey });
    if (first) { first = false; throw new Error('lost cancel acknowledgement'); }
    return { accepted: true, status: 202 };
  } });
  const uncertain = await f.broker.cancelMissionTurn({ missionId: 'mission-1', cancellationId: 'cancel-request-1' });
  assert.equal(uncertain.status, 'blocked');
  assert.equal(uncertain.cancellationOutcomeUncertain, true);
  const restarted = f.reopen();
  const result = await restarted.cancelMissionTurn({ missionId: 'mission-1', cancellationId: 'cancel-request-1' });
  assert.equal(result.status, 'blocked');
  assert.equal(result.remoteTurnCancelled, false);
  assert.equal(result.missionCompleted, false);
  assert.equal(result.automaticRetry, false);
  assert.equal(calls.length, 1);
  assert.equal(f.getDb().prepare('SELECT state FROM managed_agent_session_events WHERE event_type=?').get('cancel').state, 'submitting');
  const another = await restarted.cancelMissionTurn({ missionId: 'mission-1', cancellationId: 'cancel-request-2' });
  assert.equal(another.status, 'accepted');
  assert.notEqual(calls[0].key, calls[1].key);
});

test('concurrent outbox submitters cannot issue duplicate provider sends while a lease is active', async t => {
  let entered; const started = new Promise(resolve => { entered = resolve; }); let release;
  const held = new Promise(resolve => { release = resolve; }); let calls = 0;
  const f = await fixture(t, { submitMessage: async () => { calls++; entered(); await held; return { accepted: true, status: 202 }; } });
  const first = f.broker.sendMissionMessage({ missionId: 'mission-1', messageId: 'msg-lease', text: 'hello' });
  await started;
  const second = await f.makeBroker(async () => {}).sendMissionMessage({ missionId: 'mission-1', messageId: 'msg-lease', text: 'hello' });
  assert.equal(second.status, 'pending');
  assert.equal(calls, 1);
  release(); await first;
  assert.equal(calls, 1);
});

test('expired in-flight message after process loss replays from the durable payload and stable key', async t => {
  const calls = []; let first = true;
  const f = await fixture(t, { submitMessage: async (sessionId, text, options) => {
    calls.push({ sessionId, text, key: options.idempotencyKey });
    if (first) { first = false; throw new Error('transport ended before receipt'); }
    return { accepted: true, status: 202 };
  } });
  await assert.rejects(f.broker.sendMissionMessage({ missionId: 'mission-1', messageId: 'msg-crash', text: 'durable after crash' }), /transport ended/);
  f.getDb().prepare("UPDATE managed_agent_session_events SET state='submitting',claim_owner='crashed-owner',claim_expires_ms=0 WHERE event_type='message'").run();
  const restarted = f.reopen();
  const replay = await restarted.sendMissionMessage({ missionId: 'mission-1', messageId: 'msg-crash', text: 'durable after crash' });
  assert.equal(replay.status, 'accepted');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(f.getDb().prepare('SELECT version FROM managed_agent_broker_meta WHERE id=1').get().version, 'a-managed-agent-session-broker-v4');
});

test('tool call waits durably for user approval and resumes the same call without redispatch loss', async t => {
  let dispatches = 0; const submitted = [];
  const f = await fixture(t, {
    dispatchVerifiedTool: async () => {
      dispatches++;
      return dispatches === 1 ? { status: 'pending_approval', gateId: 'egress-gate-1' }
        : { status: 'verified', output: 'approved output', verification: { status: 'passed', verificationId: 'g-approved', evidenceRef: 'g:approved' } };
    },
    submitToolResult: async (_sessionId, result) => submitted.push(result)
  });
  f.setActions([action()]);
  const pending = await f.broker.reconcileMission('mission-1');
  assert.equal(pending.outcomes[0].status, 'approval-required');
  assert.equal(pending.outcomes[0].gateId, 'egress-gate-1');
  assert.equal(submitted.length, 0);
  assert.equal(f.broker.callState({ sessionId: 'sess-1', turnId: 'turn-1', callId: 'call-1' }).state, 'awaiting_approval');

  const resumedBroker = f.reopen();
  assert.equal(resumedBroker.callState({ sessionId: 'sess-1', turnId: 'turn-1', callId: 'call-1' }).state, 'awaiting_approval');
  const resumed = await resumedBroker.reconcileMission('mission-1');
  assert.equal(resumed.outcomes[0].status, 'result-submitted');
  assert.equal(dispatches, 2);
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].success, true);
  assert.equal(resumedBroker.callState({ sessionId: 'sess-1', turnId: 'turn-1', callId: 'call-1' }).state, 'submitted');
});

test('broker schema migration preserves prior tool-call records from v2 and v3', async t => {
  for (const version of ['a-managed-agent-session-broker-v2', 'a-managed-agent-session-broker-v3']) {
    const f = await fixture(t);
    f.getDb().prepare('UPDATE managed_agent_broker_meta SET version=? WHERE id=1').run(version);
    f.getDb().prepare(`INSERT INTO managed_agent_tool_calls(session_id,turn_id,call_id,tool_name,arguments_sha256,state,result_json,verification_id,evidence_ref,updated_at)
      VALUES('sess-1','turn-migrate','call-migrate','local.read_verified','args-hash','submitted','{"success":true,"output":"saved"}','g-old','g:evidence','2026-09-27T14:00:00.000Z')`).run();
    const migrated = f.reopen();
    const row = migrated.callState({ sessionId: 'sess-1', turnId: 'turn-migrate', callId: 'call-migrate' });
    assert.equal(row.state, 'submitted');
    assert.equal(row.result.output, 'saved');
    assert.equal(f.getDb().prepare('SELECT version FROM managed_agent_broker_meta WHERE id=1').get().version, 'a-managed-agent-session-broker-v4');
  }
});
