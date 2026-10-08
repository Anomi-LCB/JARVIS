import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { MissionGrant } from '../packages/core/src/mission/mission-runtime.js';
import { SqliteMissionStore } from '../packages/core/src/mission/sqlite-mission-store.js';
import { PersonalOperationsStore } from '../packages/core/src/personal-operations/operations-store.js';
import { PersonalMandateBudget } from '../packages/core/src/personal-operations/mandate-budget.js';
import { MissionBudgetGate } from '../packages/core/src/personal-operations/mission-budget-gate.js';
import { localMandateFileRef } from '../packages/core/src/personal-operations/local-mandate-observation.js';
import { SqliteMemoryStore } from '../apps/growth-memory/src/db/sqlite-store.js';
import { VerificationRuntime } from '../apps/verification/src/verification-runtime.js';

for (const mode of ['ready', 'revoked', 'expired', 'guard-unavailable', 'scope-denied', 'mid-read-revoked', 'mandate-detached', 'before-g-revoked', 'during-g-revoked']) {
  test(`cancelled real workflow scoped result inspection: ${mode}`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'jarvis-cancelled-read-scope-'));
    const source = join(root, 'input.json'), output = join(root, 'output.json');
    await writeFile(source, JSON.stringify([{ total: 42, padding: 'synthetic '.repeat(18000) }]));
    const store = new PersonalOperationsStore({ dbPath: join(root, 'ops.sqlite') });
    const budget = new PersonalMandateBudget(store), gate = new MissionBudgetGate({ store, budget });
    const quota = gate.createQuota({ validFrom: '2020-01-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z', maxCalls: 2,
      scope: { accountRef: null, dataRefs: [source, output].map(path => localMandateFileRef(path, root)), deniedDataRefs: [] } });
    const memory = new SqliteMemoryStore({ dbPath: join(root, 'growth.sqlite'), reviewDir: join(root, 'reviews'), backupDir: join(root, 'backups') });
    const env = { JARVIS_TEST_MODE: '1', JARVIS_MISSION_EXECUTIVE: '0', JARVIS_LLM_INTENT: '0', JARVIS_LLM_PLANNER: '0', JARVIS_LLM_CONTENT: '0' };
    const runtime = createAgRuntime({ memoryStore: memory, allowedRoots: [root], auditRoot: join(root, 'audit'),
      env, taskEnv: env, workerDaemonEnabled: false, missionStore: new SqliteMissionStore({ operationsStore: store }) });
    runtime.missionRuntime.executionBudget = gate;
    t.after(async () => { runtime.pcAgent.remoteOperationStore?.close(); runtime.coreFacade.cognition?.close(); store.close(); memory.close(); await rm(root, { recursive: true, force: true }); });
    const owner = runtime.personalOwnerSession.activate({ durationMinutes: 5, requestedBy: 'synthetic-scoped-review' });
    const created = runtime.missionRuntime.createMission({ objective: "'input.json' JSON을 '원본'으로 읽고; '원본'을 'output.json' JSON으로 저장해",
      authorization: { mode: 'trusted_session', ownerSessionId: owner.session.sessionId, grants: [MissionGrant.READ_ONLY, MissionGrant.LOCAL_REVERSIBLE] },
      executionMandateId: quota.mandate.id,
      successCriteria: [{ statement: '합계', verificationSpec: { version: 1, kind: 'json.value', path: 'output.json', pointer: '/0/total', equals: 42 } }] });
    const record = runtime.pcAgent.packetJournal.recordResult.bind(runtime.pcAgent.packetJournal);
    let cancelled = 0;
    runtime.pcAgent.packetJournal.recordResult = (packet, result, options) => {
      const saved = record(packet, result, options);
      if (!options?.dryRun && result.executionResult?.status === 'success') { cancelled++; runtime.missionRuntime.cancelMission(created.missionId); }
      return saved;
    };
    const stopped = await runtime.missionRuntime.runMission(created.missionId);
    assert.equal(stopped.status, 'CANCELLED'); assert.equal(cancelled, 1);
    const eventCount = memory.allEvents().length, quotaUsed = budget.summary(quota.mandate.id).usedOrHeldCalls;
    const original = gate.beforeResultRead.bind(gate); let accesses = 0, gCalls = 0;
    gate.beforeResultRead = (...args) => {
      accesses++;
      if (mode === 'mid-read-revoked' && accesses === 4) store.revokeMandate(quota.mandate.id);
      if (mode === 'mandate-detached' && accesses === 4) runtime.missionRuntime.missions.get(created.missionId).executionMandateId = null;
      return original(...args);
    };
    const verify = runtime.orchestrationWorker.verifyExecution.bind(runtime.orchestrationWorker);
    runtime.orchestrationWorker.verifyExecution = async (...args) => {
      gCalls++; if (mode === 'before-g-revoked') store.revokeMandate(quota.mandate.id);
      return verify(...args);
    };
    const packageVerifier = runtime.verificationRuntime.capabilityPackageVerifier;
    runtime.verificationRuntime.capabilityPackageVerifier = async (...args) => {
      const proof = await packageVerifier(...args);
      if (mode === 'during-g-revoked') store.revokeMandate(quota.mandate.id);
      return proof;
    };
    if (mode === 'revoked') store.revokeMandate(quota.mandate.id);
    if (['expired', 'scope-denied'].includes(mode)) {
      const changed = gate.mandate(quota.mandate.id);
      if (mode === 'expired') changed.expiresAt = '2020-01-02T00:00:00Z';
      else changed.scope.deniedDataRefs = [source, output].map(path => localMandateFileRef(path, root));
      store.db.prepare('UPDATE personal_mandates SET body=? WHERE id=?').run(JSON.stringify(changed), quota.mandate.id);
    }
    if (mode === 'guard-unavailable') runtime.missionRuntime.executionBudget = null;
    const request = { expectedGoalRevision: stopped.goalContract.revision, expectedObjectiveSha256: stopped.goalContract.objectiveSha256 };
    const reviewed = await runtime.missionRuntime.reviewCancelledMission(created.missionId, request);
    assert.equal(runtime.missionRuntime.getMission(created.missionId).status, 'CANCELLED');
    assert.equal(memory.allEvents().length, eventCount);
    assert.equal(budget.summary(quota.mandate.id).usedOrHeldCalls, quotaUsed);
    if (mode === 'mandate-detached') {
      assert.equal(reviewed.error.code, 'A_MISSION_CANCELLATION_REVIEW_SOURCE_CHANGED');
      assert.equal(gCalls, 0); return;
    }
    assert.equal(reviewed.success, true, JSON.stringify(reviewed));
    assert.equal(reviewed.items[0].status, mode === 'ready' ? 'verified-executed' : 'unresolved', JSON.stringify(reviewed));
    assert.equal(reviewed.items[0].currentArtifactVerified, mode === 'ready');
    if (mode === 'ready') { assert.ok(accesses >= 8); assert.equal(gCalls, 1); }
    if (['revoked', 'expired', 'scope-denied', 'guard-unavailable', 'mid-read-revoked'].includes(mode)) assert.equal(gCalls, 0);
    console.log(JSON.stringify({ mode, accesses, gCalls, status: reviewed.items[0].status, reason: reviewed.items[0].reason ?? null,
      extraQuotaCalls: 0, extraMemoryEvents: 0, externalSends: 0 }));
  });
}

test('scoped G rejects unreviewed format readers before invoking any verifier', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-scoped-g-format-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = new VerificationRuntime({ auditRoot: join(root, 'audit') });
  let calls = 0;
  runtime.capabilityPackageVerifier = () => { calls++; throw Error('must not invoke package verifier'); };
  runtime.executionVerifier.verify = () => { calls++; throw Error('must not invoke file verifier'); };
  for (const extra of [ { executedBy: { toolName: 'mcp.external' } }, { xlsxRead: {} },
    { pdfRead: {} }, { pdfExport: {} }, { evidence: { workbook: {} } } ]) {
    const executionResult = { executedBy: { toolName: 'workflow.execute' }, outputPaths: [], ...extra };
    await assert.rejects(runtime.verifyExecution({ verificationId: 'synthetic-format', target: { executionResult } },
      { observationOnly: true, beforeResultRead: () => { calls++; } }), { code: 'G_RESULT_SCOPE_UNSUPPORTED' });
  }
  assert.equal(calls, 0, 'unsupported formats must not read files or execute verifier code');
});
