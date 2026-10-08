import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { ManagedAgentSessionBroker } from '../packages/core/src/mission/managed-agent-session-broker.js';

const fixtureBytes = readFileSync(new URL('../packages/core/fixtures/m07-managed-environment-loss.json', import.meta.url));
const fixture = JSON.parse(fixtureBytes.toString('utf8'));
const fixtureSha256 = createHash('sha256').update(fixtureBytes).digest('hex');

test('M07 detects a missing remote session while preserving local binding and blocking false completion', async t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  let dispatches = 0;
  const provider = {
    async retrieveSession() { throw Object.assign(new Error('not found'), { status: 404, code: 'A_OPENAI_AGENTS_HTTP_ERROR' }); },
    async submitToolResult() { throw new Error('must not submit without a remote session'); }
  };
  const broker = new ManagedAgentSessionBroker({ db, provider, allowedToolNames: ['local.read_verified'],
    dispatchVerifiedTool: async () => { dispatches += 1; return { status: 'blocked' }; },
    restoreLocalMissionSnapshot: async () => ({ status: 'restored', snapshotSha256: fixture.localSnapshot.sha256,
      missingArtifactIds: fixture.localSnapshot.remoteOnlyArtifactIds }) });
  broker.bindSession({ missionId: fixture.missionId, sessionId: fixture.sessionId });
  const result = await broker.reconcileMission(fixture.missionId);
  const binding = db.prepare('SELECT mission_id,session_id FROM managed_agent_session_bindings WHERE mission_id=?').get(fixture.missionId);
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'remote-session-not-found');
  assert.equal(result.taskVerified, false);
  assert.equal(result.localBindingPreserved, true);
  assert.equal(result.automaticRecreation, false);
  assert.equal(result.localRecoveryStatus, 'restored');
  assert.equal(binding.mission_id, fixture.missionId);
  assert.equal(binding.session_id, fixture.sessionId);
  assert.equal(dispatches, 0);
  assert.equal(result.localSnapshot.digest, fixture.localSnapshot.sha256);
  assert.deepEqual(result.lostRemoteArtifacts, [fixture.remoteOnlyArtifactId]);
  if (process.env.JARVIS_M07_ORACLE_EVIDENCE_PATH) {
    writeFileSync(process.env.JARVIS_M07_ORACLE_EVIDENCE_PATH, `${JSON.stringify({ schemaVersion: 1, scenarioId: 'M07',
      fixtureId: fixture.fixtureId, fixtureSha256, result, binding, dispatches,
      localManifestSha256: fixture.localSnapshot.sha256, remoteLookupStatus: 404,
      completionClaimed: result.taskVerified === true || result.remoteTurnComplete === true }, null, 2)}\n`,
    { encoding: 'utf8', flag: 'wx' });
  }
});

test('M07 propagates transient provider errors rather than misclassifying them as deletion', async t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const provider = { async retrieveSession() { throw Object.assign(new Error('timeout'), { status: 503 }); }, async submitToolResult() {} };
  const broker = new ManagedAgentSessionBroker({ db, provider, allowedToolNames: ['local.read_verified'], dispatchVerifiedTool: async () => ({}) });
  broker.bindSession({ missionId: fixture.missionId, sessionId: fixture.sessionId });
  await assert.rejects(broker.reconcileMission(fixture.missionId), { status: 503 });
});
