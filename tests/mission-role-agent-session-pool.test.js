import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { MissionRoleAgentSessionPool } from '../packages/core/src/mission/mission-role-agent-session-pool.js';
import { ManagedAgentSessionBroker } from '../packages/core/src/mission/managed-agent-session-broker.js';

function broker(name) {
  const calls = [];
  return {
    db: {}, calls, workerRole: ['researcher', 'editor', 'verifier'].includes(name) ? name : null,
    bindSession: request => { calls.push(['bind', request]); return { missionId: request.missionId, sessionId: request.sessionId, replayed: false }; },
    provisionSession: async request => {
      calls.push(['provision', request]);
      const sessionId = `${name}-${request.missionId}-session`;
      return { missionId: request.missionId, sessionId, provisioningId: `provision-${name}`, status: 'bound', replayed: false };
    },
    sendMissionMessage: async request => { calls.push(['message', request]); return { status: 'accepted', accepted: true }; },
    cancelMissionTurn: async request => { calls.push(['cancel', request]); return { status: 'accepted', accepted: true }; },
    reconcileSessionProvision: async (missionId, request) => {
      calls.push(['provision-reconcile', missionId, request]);
      return { missionId, sessionId: `${name}-${missionId}-recovered`, provisioningId: `provision-${name}`, status: 'bound' };
    },
    reconcileMission: async missionId => { calls.push(['reconcile', missionId]); return { missionId, sessionId: name, outcomes: [], taskVerified: false }; }
  };
}

function createPool(t, options) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  t.after(() => db.close());
  return new MissionRoleAgentSessionPool({ db, ...options });
}

test('role session pool routes every role to its own broker and fails closed without fallback', async t => {
  const primary = broker('primary'), researcher = broker('researcher'), editor = broker('editor'), verifier = broker('verifier');
  const pool = createPool(t, { primary, roles: { researcher, editor, verifier },
    authorizeRoleMessage: async () => true });

  const bindings = await Promise.all([
    pool.bindSession({ missionId: 'm-1', sessionId: 'sess-r', workerRole: 'researcher', collaborationGroupId: 'g1' }),
    pool.bindSession({ missionId: 'm-1', sessionId: 'sess-e', workerRole: 'editor', collaborationGroupId: 'g1' }),
    pool.bindSession({ missionId: 'm-1', sessionId: 'sess-v', workerRole: 'verifier', collaborationGroupId: 'g1' })
  ]);
  assert.deepEqual(bindings.map(item => item.workerRole), ['researcher', 'editor', 'verifier']);
  assert.equal(researcher.calls.length, 1);
  assert.equal(editor.calls.length, 1);
  assert.equal(verifier.calls.length, 1);
  assert.equal(primary.calls.length, 0);
  assert.throws(() => pool.bindSession({ missionId: 'm-1', sessionId: 'sess-r-other-group',
    workerRole: 'researcher', collaborationGroupId: 'g2' }), { code: 'A_MANAGED_AGENT_ROLE_SESSION_BINDING_CONFLICT' });
  assert.throws(() => pool.bindSession({ missionId: 'm-1', sessionId: 'sess-r',
    workerRole: 'verifier', collaborationGroupId: 'g1' }), { code: 'A_MANAGED_AGENT_ROLE_SESSION_BINDING_CONFLICT' });

  await pool.reconcileMission('m-1', { workerRole: 'editor', collaborationGroupId: 'g1' });
  assert.deepEqual(editor.calls.at(-1), ['reconcile', 'm-1']);
  const resumedPool = new MissionRoleAgentSessionPool({ db: pool.db, primary,
    roles: { researcher, editor, verifier }, authorizeRoleMessage: async () => true });
  await resumedPool.reconcileMission('m-1', { workerRole: 'researcher', collaborationGroupId: 'g1' });
  assert.deepEqual(researcher.calls.at(-1), ['reconcile', 'm-1'], 'role routing survives pool reconstruction');
  assert.throws(() => pool.bindSession({ missionId: 'm-1', sessionId: 'sess-admin', workerRole: 'admin', collaborationGroupId: 'g1' }),
    { code: 'A_MANAGED_AGENT_ROLE_ASSIGNMENT_INVALID' });
  await assert.rejects(pool.reconcileMission('m-1', { workerRole: 'verifier', collaborationGroupId: 'missing' }),
    { code: 'A_MANAGED_AGENT_ROLE_SESSION_NOT_BOUND' });
  assert.equal(primary.calls.length, 0, 'unsupported roles never fall back to the primary agent');
});

test('role session messages require the external-egress authorizer and never send on denial', async t => {
  const researcher = broker('researcher');
  const observed = [];
  const pool = createPool(t, { roles: { researcher }, authorizeRoleMessage: async input => {
    observed.push(input);
    return input.authorization === 'approved-exact-payload';
  } });
  pool.bindSession({ missionId: 'm-2', sessionId: 'sess-r', workerRole: 'researcher', collaborationGroupId: 'g2' });
  const denied = await pool.sendMissionMessage({ missionId: 'm-2', messageId: 'msg-1', text: 'secret',
    workerRole: 'researcher', collaborationGroupId: 'g2' });
  assert.equal(denied.status, 'blocked');
  assert.equal(denied.accepted, false);
  assert.deepEqual(researcher.calls.map(([kind]) => kind), ['bind'], 'denied text is not sent to the provider');
  const accepted = await pool.sendMissionMessage({ missionId: 'm-2', messageId: 'msg-2', text: 'public source only',
    workerRole: 'researcher', collaborationGroupId: 'g2', messageAuthorization: 'approved-exact-payload' });
  assert.equal(accepted.accepted, true);
  assert.equal(researcher.calls.at(-1)[0], 'message');
  assert.equal(observed.length, 2);
  assert.equal(observed[1].roleAssignment.workerRole, 'researcher');
  assert.equal(accepted.executionAuthority, false);
});

test('blank session provisioning uses only the assigned role broker and persists its assignment before use', async t => {
  const primary = broker('primary'), researcher = broker('researcher'), editor = broker('editor');
  const pool = createPool(t, { primary, roles: { researcher, editor }, authorizeRoleMessage: async () => true });
  const result = await pool.provisionSession({ missionId: 'provision-mission', sessionConfig: { model: 'allowed' },
    authorization: 'approved', workerRole: 'researcher', collaborationGroupId: 'study-1' });

  assert.equal(result.status, 'bound');
  assert.equal(result.sessionId, 'researcher-provision-mission-session');
  assert.deepEqual(researcher.calls.map(([kind]) => kind), ['provision', 'bind']);
  assert.equal(editor.calls.length, 0);
  assert.equal(primary.calls.length, 0, 'a missing or failed specialist never falls back to the primary broker');
  assert.deepEqual({ ...pool.db.prepare('SELECT mission_id,worker_role,collaboration_group_id,session_id FROM managed_agent_role_session_assignments').get() }, {
    mission_id: 'provision-mission', worker_role: 'researcher', collaboration_group_id: 'study-1', session_id: 'researcher-provision-mission-session'
  });
  const replay = await pool.provisionSession({ missionId: 'provision-mission', sessionConfig: { model: 'allowed' },
    authorization: 'approved', workerRole: 'researcher', collaborationGroupId: 'study-1' });
  assert.equal(replay.sessionId, result.sessionId);
  assert.equal(researcher.calls.filter(([kind]) => kind === 'provision').length, 2,
    'the broker sees a replay request and is responsible for returning its durable bound session without remote duplication');
  await assert.rejects(pool.provisionSession({ missionId: 'provision-mission', sessionConfig: { model: 'allowed' },
    workerRole: 'researcher', collaborationGroupId: 'different-study' }), { code: 'A_MANAGED_AGENT_ROLE_SESSION_BINDING_CONFLICT' });
});

test('uncertain session recovery routes to its original role broker and repairs the durable role registry', async t => {
  const primary = broker('primary'), researcher = broker('researcher'), editor = broker('editor');
  const pool = createPool(t, { primary, roles: { researcher, editor }, authorizeRoleMessage: async () => true });
  const recovered = await pool.reconcileSessionProvision({ missionId: 'uncertain-mission', maxPages: 4,
    workerRole: 'researcher', collaborationGroupId: 'research-group' });
  assert.equal(recovered.status, 'bound');
  assert.equal(recovered.sessionId, 'researcher-uncertain-mission-recovered');
  assert.equal(researcher.calls[0][0], 'provision-reconcile');
  assert.equal(researcher.calls[0][2].maxPages, 4);
  assert.equal(editor.calls.length, 0);
  assert.equal(primary.calls.length, 0);
  const assignment = pool.db.prepare('SELECT worker_role,collaboration_group_id,session_id FROM managed_agent_role_session_assignments WHERE mission_id=?').get('uncertain-mission');
  assert.deepEqual({ ...assignment }, { worker_role: 'researcher', collaboration_group_id: 'research-group', session_id: recovered.sessionId });
});

test('role pool rejects reused broker or database identity and requires role-message authorization', t => {
  const shared = broker('shared');
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  assert.throws(() => new MissionRoleAgentSessionPool({ db, roles: { researcher: shared, editor: shared }, authorizeRoleMessage: async () => true }),
    { code: 'A_MANAGED_AGENT_ROLE_BROKER_REUSED' });
  const sameDb = {};
  assert.throws(() => new MissionRoleAgentSessionPool({ db, roles: {
    researcher: { ...broker('r'), workerRole: 'researcher', db: sameDb },
    editor: { ...broker('e'), workerRole: 'editor', db: sameDb }
  },
    authorizeRoleMessage: async () => true }), { code: 'A_MANAGED_AGENT_ROLE_DATABASE_REUSED' });
  assert.throws(() => new MissionRoleAgentSessionPool({ db, roles: { researcher: { ...broker('r'), workerRole: 'researcher' } } }),
    { code: 'A_MANAGED_AGENT_ROLE_MESSAGE_AUTHORIZER_REQUIRED' });
});

test('role pool rejects different SQLite handles that share a durable file', t => {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-role-database-boundary-'));
  const handles = [];
  const open = name => {
    const db = new DatabaseSync(join(directory, name));
    handles.push(db);
    return db;
  };
  t.after(() => {
    for (const db of handles) { try { db.close(); } catch {} }
    rmSync(directory, { recursive: true, force: true });
  });
  const researcherDb = open('shared.sqlite'), editorDb = open('shared.sqlite'), registryDb = open('registry.sqlite');
  const roleBroker = (role, db) => ({ ...broker(role), db });
  assert.throws(() => new MissionRoleAgentSessionPool({ db: registryDb,
    roles: { researcher: roleBroker('researcher', researcherDb), editor: roleBroker('editor', editorDb) },
    authorizeRoleMessage: async () => true }), { code: 'A_MANAGED_AGENT_ROLE_DATABASE_FILE_REUSED' });

  const separateEditorDb = open('editor.sqlite'), registrySharingDb = open('registry-shared.sqlite');
  assert.throws(() => new MissionRoleAgentSessionPool({ db: registrySharingDb,
    roles: { researcher: roleBroker('researcher', open('registry-shared.sqlite')), editor: roleBroker('editor', separateEditorDb) },
    authorizeRoleMessage: async () => true }), { code: 'A_MANAGED_AGENT_ROLE_REGISTRY_DATABASE_REUSED' });
});

test('file-backed role assignments and broker sessions survive database close and reconstruction', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-role-session-restart-'));
  const paths = {
    registry: join(directory, 'registry.sqlite'),
    researcher: join(directory, 'researcher.sqlite'),
    editor: join(directory, 'editor.sqlite')
  };
  const opened = new Set();
  const open = path => {
    const db = new DatabaseSync(path);
    db.exec('PRAGMA foreign_keys=ON');
    opened.add(db);
    return db;
  };
  const providers = Object.fromEntries(['researcher', 'editor'].map(role => [role, {
    retrieved: [], messages: [], cancellations: [],
    retrieveSession: async sessionId => {
      providers[role].retrieved.push(sessionId);
      return { id: sessionId, required_actions: [], status: 'waiting' };
    },
    submitToolResult: async () => ({ status: 'accepted' }),
    cancelTurn: async (sessionId, options) => {
      providers[role].cancellations.push({ sessionId, options });
      return { status: 'accepted' };
    },
    submitMessage: async (sessionId, text, options) => {
      providers[role].messages.push({ sessionId, text, options });
      return { status: 'accepted' };
    }
  }]));
  const makeBroker = (role, db) => new ManagedAgentSessionBroker({ db, provider: providers[role],
    dispatchVerifiedTool: async () => ({ success: true }), allowedToolNames: ['files.read'], workerRole: role,
    ownerId: `owner-${role}` });
  const makePool = () => new MissionRoleAgentSessionPool({ db: open(paths.registry),
    roles: { researcher: makeBroker('researcher', open(paths.researcher)), editor: makeBroker('editor', open(paths.editor)) },
    authorizeRoleMessage: async ({ authorization }) => authorization === 'approved' });
  t.after(() => {
    for (const db of opened) { try { db.close(); } catch {} }
    rmSync(directory, { recursive: true, force: true });
  });

  const initial = makePool();
  initial.bindSession({ missionId: 'durable-mission', sessionId: 'remote-research', workerRole: 'researcher', collaborationGroupId: 'group-7' });
  initial.bindSession({ missionId: 'durable-mission', sessionId: 'remote-edit', workerRole: 'editor', collaborationGroupId: 'group-7' });
  for (const db of opened) db.close();
  opened.clear();

  const resumed = makePool();
  const researcher = await resumed.reconcileMission('durable-mission', { workerRole: 'researcher', collaborationGroupId: 'group-7' });
  const editor = await resumed.reconcileMission('durable-mission', { workerRole: 'editor', collaborationGroupId: 'group-7' });
  assert.equal(researcher.sessionId, 'remote-research');
  assert.equal(editor.sessionId, 'remote-edit');
  assert.deepEqual(providers.researcher.retrieved, ['remote-research']);
  assert.deepEqual(providers.editor.retrieved, ['remote-edit']);

  const message = await resumed.sendMissionMessage({ missionId: 'durable-mission', messageId: 'after-restart', text: 'public follow up',
    workerRole: 'researcher', collaborationGroupId: 'group-7', messageAuthorization: 'approved' });
  assert.equal(message.accepted, true);
  assert.equal(providers.researcher.messages.length, 1);
  assert.equal(providers.editor.messages.length, 0);
  assert.equal(providers.researcher.messages[0].sessionId, 'remote-research');
  const cancelled = await resumed.cancelMissionTurn({ missionId: 'durable-mission', cancellationId: 'cancel-after-restart',
    workerRole: 'editor', collaborationGroupId: 'group-7' });
  assert.equal(cancelled.accepted, true);
  assert.equal(providers.editor.cancellations[0].sessionId, 'remote-edit');
  await assert.rejects(resumed.reconcileMission('durable-mission', { workerRole: 'researcher', collaborationGroupId: 'wrong-group' }),
    { code: 'A_MANAGED_AGENT_ROLE_SESSION_NOT_BOUND' });
});
