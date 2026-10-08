import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileMissionStore } from '../packages/core/src/mission/mission-store.js';
import { createLocalMissionSnapshotRecovery } from '../packages/core/src/mission/local-mission-snapshot-recovery.js';
import { ManagedAgentSessionBroker } from '../packages/core/src/mission/managed-agent-session-broker.js';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { MissionRoleAgentSessionPool } from '../packages/core/src/mission/mission-role-agent-session-pool.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-m07-persisted-'));
  const resources = {};
  t.after(() => { resources.db?.close(); rmSync(root, { recursive: true, force: true }); });
  const file = join(root, 'report.txt');
  writeFileSync(file, 'retained local result');
  const store = new FileMissionStore({ filePath: join(root, 'missions.json') });
  const artifact = { rootIndex: 0, relativePath: 'report.txt', outsideAllowedRoots: false,
    pathHash: hash(file), contentSha256: hash(readFileSync(file)) };
  const mission = { missionId: 'mission-persisted', status: 'PAUSED', observations: [{ artifacts: [artifact] }] };
  store.save([mission]);
  return { root, file, store, mission, artifact, resources };
}

test('reopening disk Mission and broker stores preserves local evidence after remote deletion without execution', async t => {
  const f = fixture(t);
  const dbPath = join(f.root, 'broker.sqlite');
  let db = new DatabaseSync(dbPath);
  let calls = 0;
  const provider = { async retrieveSession() { throw Object.assign(new Error('gone'), { status: 404 }); },
    async submitToolResult() { calls += 1; } };
  const options = { provider, allowedToolNames: ['local.read_verified'], dispatchVerifiedTool: async () => { calls += 1; } };
  new ManagedAgentSessionBroker({ ...options, db }).bindSession({ missionId: f.mission.missionId, sessionId: 'session-removed' });
  db.close();
  db = new DatabaseSync(dbPath); f.resources.db = db;
  const recovery = createLocalMissionSnapshotRecovery({ store: new FileMissionStore({ filePath: f.store.filePath }), allowedRoots: [f.root] });
  const inspected = recovery({ missionId: f.mission.missionId });
  assert.equal(inspected.verifiedArtifacts, 1);
  assert.equal(inspected.automaticResume, false);
  const broker = new ManagedAgentSessionBroker({ ...options, db, restoreLocalMissionSnapshot: recovery });
  const result = await broker.reconcileMission(f.mission.missionId);
  assert.equal(result.localRecoveryStatus, 'restored');
  assert.equal(result.localSnapshot.digest, hash(JSON.stringify(f.mission)));
  assert.deepEqual(result.lostRemoteArtifacts, []);
  assert.equal(result.status, 'blocked');
  assert.equal(result.taskVerified, false);
  assert.equal(calls, 0);
  assert.deepEqual(f.store.load(), [f.mission]);
});

test('modified, absent, unhashed and escaping artifacts remain unverified while the Mission survives', t => {
  const f = fixture(t);
  const recovery = createLocalMissionSnapshotRecovery({ store: f.store, allowedRoots: [f.root] });
  writeFileSync(f.file, 'changed');
  assert.deepEqual(recovery({ missionId: f.mission.missionId }).missingArtifactIds, [f.artifact.pathHash]);
  rmSync(f.file);
  assert.equal(recovery({ missionId: f.mission.missionId }).verifiedArtifacts, 0);
  for (const patch of [{ contentSha256: null }, { relativePath: '../outside.txt' }, { rootIndex: 10 }]) {
    f.store.save([{ ...f.mission, observations: [{ artifacts: [{ ...f.artifact, ...patch }] }] }]);
    assert.deepEqual(recovery({ missionId: f.mission.missionId }).missingArtifactIds, [f.artifact.pathHash]);
  }
  assert.equal(recovery({ missionId: 'missing' }).status, 'unavailable');
  writeFileSync(f.store.filePath, 'broken json');
  assert.throws(() => recovery({ missionId: f.mission.missionId }), { code: 'A_MISSION_STORE_CORRUPT' });
});

test('runtime composition attaches its real store recovery to a broker factory', async t => {
  const f = fixture(t);
  // Runtime Missions require the normal shape; create and persist through the API.
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  let broker;
  const runtime = createAgRuntime({ env: {}, allowedRoots: [f.root], auditRoot: join(f.root, 'audit'),
    workerDaemonEnabled: false, managedAgentSessionBrokerFactory: () => {
      broker = new ManagedAgentSessionBroker({ db, provider: {
        async retrieveSession() { throw Object.assign(new Error('gone'), { status: 404 }); }, async submitToolResult() {} },
      allowedToolNames: ['local.read_verified'], dispatchVerifiedTool: async () => { throw new Error('no dispatch'); } });
      return broker;
    } });
  const mission = runtime.missionRuntime.createMission({ objective: '로컬 파일을 읽어 확인해', allowedRoot: f.root });
  broker.bindSession({ missionId: mission.missionId, sessionId: 'runtime-session' });
  const result = await broker.reconcileMission(mission.missionId);
  assert.equal(result.localRecoveryStatus, 'restored');
  assert.equal(result.taskVerified, false);
});

test('runtime role pool recovers each bound role locally without cross-role fallback or replacing custom recovery', async t => {
  const f = fixture(t);
  const databases = [];
  const db = () => { const value = new DatabaseSync(':memory:'); databases.push(value); return value; };
  t.after(() => databases.forEach(value => value.close()));
  let dispatches = 0, pool;
  const customRecovery = () => ({ status: 'unavailable' });
  const makeBroker = (workerRole, recovery = null) => new ManagedAgentSessionBroker({ db: db(), workerRole,
    restoreLocalMissionSnapshot: recovery, allowedToolNames: ['local.read_verified'],
    dispatchVerifiedTool: async () => { dispatches += 1; }, provider: {
      async retrieveSession() { throw Object.assign(new Error('gone'), { status: 404 }); },
      async submitToolResult() { throw new Error('must not submit'); }
    } });
  const primary = makeBroker(null), researcher = makeBroker('researcher'),
    editor = makeBroker('editor', customRecovery), verifier = makeBroker('verifier');
  const runtime = createAgRuntime({ env: {}, allowedRoots: [f.root], auditRoot: join(f.root, 'role-audit'),
    workerDaemonEnabled: false, managedAgentRoleSessionPoolFactory: () => {
      pool = new MissionRoleAgentSessionPool({ db: db(), primary, roles: { researcher, editor, verifier },
        authorizeRoleMessage: async () => false });
      return pool;
    } });
  const mission = runtime.missionRuntime.createMission({ objective: '자료를 읽고 결과를 확인해', allowedRoot: f.root });
  pool.bindSession({ missionId: mission.missionId, sessionId: 'primary-lost' });
  assert.equal((await pool.reconcileMission(mission.missionId)).localRecoveryStatus, 'restored');
  for (const workerRole of ['researcher', 'editor', 'verifier']) {
    const assignment = { workerRole, collaborationGroupId: 'role-group' };
    pool.bindSession({ missionId: mission.missionId, sessionId: `${workerRole}-lost`, ...assignment });
    const result = await pool.reconcileMission(mission.missionId, assignment);
    assert.equal(result.status, 'blocked');
    assert.equal(result.taskVerified, false);
    assert.equal(result.localRecoveryStatus, workerRole === 'editor' ? 'failed' : 'restored');
    assert.equal(result.sessionId, `${workerRole}-lost`);
  }
  assert.equal(editor.restoreLocalMissionSnapshot, customRecovery);
  await assert.rejects(pool.reconcileMission(mission.missionId,
    { workerRole: 'researcher', collaborationGroupId: 'wrong-group' }), { code: 'A_MANAGED_AGENT_ROLE_SESSION_NOT_BOUND' });
  assert.equal(dispatches, 0);
  assert.throws(() => pool.setLocalSnapshotRecoveryIfAbsent(null), { code: 'A_MANAGED_AGENT_LOCAL_RECOVERY_INVALID' });
});
