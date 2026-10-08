import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { MissionGrant } from '../packages/core/src/mission/mission-runtime.js';
import { SqliteMissionStore } from '../packages/core/src/mission/sqlite-mission-store.js';
import { PersonalOperationsStore } from '../packages/core/src/personal-operations/operations-store.js';
import { SqliteMemoryStore } from '../apps/growth-memory/src/db/sqlite-store.js';
import { createCoreServer } from '../packages/core/src/main.mjs';

for (const phase of ['prepared', 'availability', 'shadow', 'publication', 'receipt']) {
  test(`actual workflow cancellation at ${phase} preserves durable outcome and never replays`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'jarvis-cancel-publication-'));
    const operations = new PersonalOperationsStore({ dbPath: join(root, 'ops.sqlite') });
    const memoryStore = new SqliteMemoryStore({ dbPath: join(root, 'growth.sqlite'), reviewDir: join(root, 'reviews'), backupDir: join(root, 'backups') });
    const env = { JARVIS_TEST_MODE: '1', JARVIS_MISSION_EXECUTIVE: '0', JARVIS_LLM_INTENT: '0', JARVIS_LLM_PLANNER: '0', JARVIS_LLM_CONTENT: '0' };
    const options = { memoryStore, allowedRoots: [root], auditRoot: join(root, 'audit'), env, taskEnv: env,
      workerDaemonEnabled: false };
    const runtime = createAgRuntime({ ...options, missionStore: new SqliteMissionStore({ operationsStore: operations }) });
    const runtimes = [runtime];
    t.after(async () => { for (const item of runtimes) { item.close?.(); item.pcAgent.remoteOperationStore?.close(); item.coreFacade.cognition?.close(); }
      operations.close(); memoryStore.close(); await rm(root, { recursive: true, force: true }); });
    await writeFile(join(root, 'input.json'), '[{"total":42}]');
    const owner = runtime.personalOwnerSession.activate({ durationMinutes: 5, requestedBy: 'synthetic-cancel-boundary' });
    const created = runtime.missionRuntime.createMission({
      objective: "'input.json' JSON을 '원본'으로 읽고; '원본'을 'output.json' JSON으로 저장해",
      authorization: { mode: 'trusted_session', ownerSessionId: owner.session.sessionId,
        grants: [MissionGrant.READ_ONLY, MissionGrant.LOCAL_REVERSIBLE] },
      successCriteria: [{ statement: '합계 확인', verificationSpec: { version: 1, kind: 'json.value', path: 'output.json', pointer: '/0/total', equals: 42 } }]
    });
    let cancellations = 0, dispatches = 0;
    const cancel = () => { cancellations++; runtime.missionRuntime.cancelMission(created.missionId, { reason: `synthetic-${phase}` }); };
    const adapter = runtime.pcAgent.registry.get('workflow.execute');
    const execute = adapter.execute.bind(adapter);
    adapter.execute = async (...args) => { dispatches++; return execute(...args); };
    if (phase === 'prepared' || phase === 'availability') {
      let staged = false;
      const stage = runtime.missionRuntime.effectCoordinator.stage.bind(runtime.missionRuntime.effectCoordinator);
      runtime.missionRuntime.effectCoordinator.stage = async (...args) => {
        const result = await stage(...args); staged = true;
        if (phase === 'prepared') cancel();
        return result;
      };
      if (phase === 'availability') {
        const guard = runtime.missionRuntime.capabilityAvailabilityGuard;
        const assess = guard.assess.bind(guard);
        guard.assess = async (...args) => {
          const result = await assess(...args);
          if (staged && cancellations === 0) cancel();
          return result;
        };
      }
    } else if (phase === 'shadow') {
      const shadow = adapter.shadow.bind(adapter);
      adapter.shadow = async (...args) => { const result = await shadow(...args); cancel(); return result; };
    } else if (phase === 'publication') {
      const claim = runtime.pcAgent.claimWorkflowPublication.bind(runtime.pcAgent);
      runtime.pcAgent.claimWorkflowPublication = async (...args) => { const result = await claim(...args); cancel(); return result; };
    } else {
      const record = runtime.pcAgent.packetJournal.recordResult.bind(runtime.pcAgent.packetJournal);
      runtime.pcAgent.packetJournal.recordResult = (packet, result, options) => {
        const saved = record(packet, result, options);
        if (!options?.dryRun && result.executionResult?.status === 'success') cancel();
        return saved;
      };
    }
    const result = await runtime.missionRuntime.runMission(created.missionId);
    assert.equal(cancellations, 1, JSON.stringify(result));
    assert.equal(result.status, 'CANCELLED');
    const action = result.waves[0].actions[0];
    const effect = runtime.missionRuntime.effectCoordinator.effect(action);
    assert.ok(effect, 'the actual SQL effect must exist');
    if (!['prepared', 'availability'].includes(phase)) {
      assert.equal(action.recovery?.error?.code, 'A_MISSION_RECOVERY_EXECUTION_UNCERTAIN');
      assert.equal(result.lastError?.code, 'A_MISSION_RECOVERY_EXECUTION_UNCERTAIN',
        'cancellation must expose unresolved execution rather than hide the receipt reconciliation');
    }
    if (phase !== 'receipt') {
      await assert.rejects(readFile(join(root, 'output.json')), { code: 'ENOENT' });
      if (['prepared', 'availability'].includes(phase)) {
        assert.equal(dispatches, 0);
        assert.equal(effect.receipt?.notDispatched, true);
        assert.equal(action.status, 'skipped', 'cancelled undispatched actions must remain skipped');
      }
    } else {
      assert.equal(JSON.parse(await readFile(join(root, 'output.json'), 'utf8'))[0].total, 42);
      assert.notEqual(effect.state, 'prepared', 'published output must not be reclassified as undispatched');
    }
    const before = dispatches;
    const resumed = await runtime.missionRuntime.runMission(created.missionId);
    assert.equal(resumed.status, 'CANCELLED');
    assert.equal(dispatches, before);
    const fresh = createAgRuntime({ ...options, missionStore: new SqliteMissionStore({ operationsStore: operations }) });
    runtimes.push(fresh);
    const restored = fresh.missionRuntime.getMission(created.missionId);
    assert.equal(restored.status, 'CANCELLED');
    if (['prepared', 'availability'].includes(phase)) assert.equal(restored.waves[0].actions[0].status, 'skipped',
      'restart must not revive a durably cancelled undispatched action');
    if (['prepared', 'availability'].includes(phase)) assert.equal(restored.uncertainEffectCount, 0);
    const reviewRequest = { expectedGoalRevision: restored.goalContract.revision,
      expectedObjectiveSha256: restored.goalContract.objectiveSha256 };
    const snapshotBefore = JSON.stringify([...fresh.missionRuntime.missions.values()]);
    const effectBefore = JSON.stringify(fresh.missionRuntime.effectCoordinator.effect(restored.waves[0].actions[0]));
    const eventsBefore = memoryStore.allEvents().length;
    fresh.orchestrationWorker.runTask = () => { throw new Error('review must not execute'); };
    fresh.pcAgent.resumeWorkflowPublication = () => { throw new Error('review must not resume publication'); };
    const review = await fresh.missionRuntime.reviewCancelledMission(created.missionId, reviewRequest);
    assert.equal(review.success, true, JSON.stringify(review));
    assert.equal(review.items[0].status, ['prepared', 'availability'].includes(phase) ? 'not-dispatched'
      : phase === 'receipt' ? 'verified-executed' : 'unresolved', JSON.stringify(review));
    assert.equal(review.executionAuthority, false);
    assert.equal(review.effectsChanged, false);
    assert.equal(review.memoriesChanged, false);
    assert.equal(JSON.stringify([...fresh.missionRuntime.missions.values()]), snapshotBefore);
    assert.equal(JSON.stringify(fresh.missionRuntime.effectCoordinator.effect(restored.waves[0].actions[0])), effectBefore);
    assert.equal(memoryStore.allEvents().length, eventsBefore);
    assert.equal(fresh.missionRuntime.getMission(created.missionId).status, 'CANCELLED');
    assert.equal((await fresh.missionRuntime.reviewCancelledMission(created.missionId, {
      ...reviewRequest, expectedGoalRevision: reviewRequest.expectedGoalRevision + 1
    })).error.code, 'A_MISSION_CANCELLATION_REVIEW_SOURCE_CHANGED');
    if (phase === 'receipt') {
      assert.ok(review.items[0].verificationId);
      assert.equal(review.items[0].currentArtifactVerified, true);
      assert.equal(JSON.stringify(review).includes('input.json'), false, 'review does not return input contents or paths');
      const current = fresh.missionRuntime.missions.get(created.missionId);
      const oldTime = current.updatedAt;
      const verify = fresh.orchestrationWorker.verifyExecution.bind(fresh.orchestrationWorker);
      fresh.orchestrationWorker.verifyExecution = async (...args) => {
        const result = await verify(...args); current.updatedAt = 'synthetic-concurrent-source-change'; return result;
      };
      assert.equal((await fresh.missionRuntime.reviewCancelledMission(created.missionId, reviewRequest)).error.code,
        'A_MISSION_CANCELLATION_REVIEW_SOURCE_CHANGED');
      fresh.orchestrationWorker.verifyExecution = verify;
      current.updatedAt = oldTime;
      const failedObservation = await fresh.verificationRuntime.verifyExecution({ verificationId: 'synthetic-review-negative',
        taskId: action.taskId, target: {} }, { observationOnly: true });
      assert.equal(failedObservation.status, 'failed', 'observation mode never relaxes G checks');
      assert.equal(memoryStore.allEvents().length, eventsBefore);
      await fresh.verificationRuntime.verifyExecution({ verificationId: 'synthetic-normal-verification', taskId: action.taskId, target: {} });
      assert.equal(memoryStore.allEvents().length, eventsBefore + 1, 'ordinary verification retains its learning signal');
      await writeFile(join(root, 'output.json'), '[{"total":99}]');
      const changed = await fresh.missionRuntime.reviewCancelledMission(created.missionId, reviewRequest);
      assert.equal(changed.items[0].status, 'unresolved');
      assert.equal(changed.items[0].currentArtifactVerified, false);
      current.executionMandateId = 'synthetic-scoped-review';
      const scoped = await fresh.missionRuntime.reviewCancelledMission(created.missionId, reviewRequest);
      assert.equal(scoped.items[0].status, 'unresolved');
      assert.equal(scoped.items[0].causeCode, 'A_MANDATE_RESULT_PERMISSION_UNAVAILABLE');
      delete current.executionMandateId;
      const server = createCoreServer(fresh.coreFacade, { adminToken: 'synthetic-cancellation-review-admin', missionRuntime: fresh.missionRuntime });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      try {
        const url = `http://127.0.0.1:${server.address().port}/missions/${encodeURIComponent(created.missionId)}/cancellation-review`;
        const post = (body, authorized) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json',
          ...(authorized ? { authorization: 'Bearer synthetic-cancellation-review-admin' } : {}) }, body: JSON.stringify(body) });
        assert.equal((await post(reviewRequest, false)).status, 401);
        assert.equal((await post({ ...reviewRequest, resume: true }, true)).status, 400);
        assert.equal((await post({ ...reviewRequest, expectedGoalRevision: 99 }, true)).status, 409);
        const response = await post(reviewRequest, true);
        assert.equal(response.status, 200);
        assert.equal((await response.json()).items[0].status, 'unresolved');
      } finally { await new Promise(resolve => server.close(resolve)); }
    }
    console.log(JSON.stringify({ phase, cancellations, dispatches, effectState: effect.state, actionStatus: action.status,
      outputPublished: phase === 'receipt', externalSends: 0 }));
  });
}
