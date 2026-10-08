import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { recoverMissionAction } from '../packages/core/src/mission/mission-action-recovery.js';
import { ExecutionResultVerifier } from '../apps/verification/src/verification-runtime.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-workflow-recovery-bind-'));
  const options = { allowedRoots: [root], auditRoot: join(root, 'audit'), workerDaemonEnabled: false,
    env: { JARVIS_TEST_MODE: '1', JARVIS_LLM_INTENT: '0', JARVIS_LLM_PLANNER: '0', JARVIS_LLM_CONTENT: '0' } };
  const runtime = createAgRuntime(options), runtimes = [runtime];
  t.after(async () => { for (const item of runtimes) { try { await item.coreFacade.cognition?.close?.(); } catch {} }
    await rm(root, { recursive: true, force: true }); });
  await writeFile(join(root, 'input.json'), '[{"total":7}]');
  const mission = runtime.missionRuntime.createMission({
    objective: "'input.json' JSON을 '원본'으로 읽고; '원본'의 개수가 1인지 검증하고; '원본'을 'output.json' JSON으로 저장해",
    authorization: { grants: ['read_only', 'local_reversible'] },
    successCriteria: [{ statement: '합계 7이 저장된다.', verificationSpec: { version: 1, kind: 'json.value', path: 'output.json', pointer: '/0/total', equals: 7 } }] });
  let checkpoint;
  const save = runtime.missionRuntime.store.save.bind(runtime.missionRuntime.store);
  runtime.missionRuntime.store.save = (missions, metadata) => {
    if (!checkpoint && metadata.reason.startsWith('mission-action-running:')) checkpoint = structuredClone(missions);
    return save(missions, metadata);
  };
  const completed = await runtime.missionRuntime.runMission(mission.missionId);
  assert.equal(completed.status, 'COMPLETED');
  const action = structuredClone(completed.waves[0].actions[0]);
  const receipt = await runtime.pcAgent.taskResult(action.taskId);
  let gCalls = 0;
  const verifier = new ExecutionResultVerifier();
  const recover = execution => recoverMissionAction({ missionId: mission.missionId, action, allowedRoots: [root],
    coreFacade: { getTask: () => null }, worker: { pcAgent: { taskResult: () => execution }, verifyExecution: async (_task, saved) => {
      gCalls++;
      const checks = await verifier.verify({ executionResult: saved.executionResult, evidence: saved.evidence });
      return { status: checks.some(check => check.status === 'failed') ? 'failed' : 'passed', verificationId: 'workflow-real-g', checks };
    } } });
  return { root, action, receipt, recover, runtime, options, runtimes, mission, checkpoint, save, gCalls: () => gCalls };
}

test('actual workflow receipt recovers without dispatch and rejects a different spec before G', async t => {
  const f = await fixture(t);
  assert.equal((await f.recover(f.receipt)).status, 'recovered');
  for (const mutate of [w => { w.specSha256 = 'a'.repeat(64); }, w => { w.workflowId = 'other-workflow'; },
    w => { w.receipts[0].nodeId = 'other-node'; }, w => { w.receipts[0].op = 'data.sort'; },
    w => { w.specSource = 'file'; }, w => { w.receipts.push(w.receipts[0]); }]) {
    const changed = structuredClone(f.receipt);
    mutate(changed.executionResult.evidence.workflow);
    if (changed.evidence.adapterEvidence?.workflow) changed.evidence.adapterEvidence.workflow = structuredClone(changed.executionResult.evidence.workflow);
    const result = await f.recover(changed);
    assert.equal(result.status, 'blocked');
    assert.equal(result.error.code, 'A_MISSION_RECOVERY_RECEIPT_DISPATCH_MISMATCH');
  }
  assert.equal(f.gCalls(), 1, 'another-spec receipt never reaches G or memory acknowledgement');
});

test('fresh Core restores an interrupted workflow checkpoint using persisted PC receipt, without executing it again', async t => {
  const f = await fixture(t);
  assert.ok(f.checkpoint);
  f.save(f.checkpoint, { reason: 'synthetic-response-loss-before-core-observation' });
  const fresh = createAgRuntime(f.options); f.runtimes.push(fresh);
  assert.equal(fresh.coreFacade.getTask(f.action.taskId), undefined);
  let dispatches = 0;
  fresh.orchestrationWorker.runTask = async () => { dispatches++; throw new Error('unexpected redispatch'); };
  const recovered = await fresh.missionRuntime.runMission(f.mission.missionId);
  assert.equal(recovered.status, 'COMPLETED', JSON.stringify({ status: recovered.status, stopReason: recovered.stopReason }));
  assert.equal(recovered.waves[0].actions[0].recovery.source, 'pc-task-receipt');
  assert.equal(dispatches, 0);
});

test('a self-consistent actual workflow receipt for another destination is not completion of the requested write', async t => {
  const f = await fixture(t);
  const original = join(f.root, 'output.json'), substituted = join(f.root, 'substituted.json');
  await writeFile(substituted, await readFile(original));
  function replace(value) {
    if (value === original) return substituted;
    if (Array.isArray(value)) return value.map(replace);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]));
    return value;
  }
  const result = await f.recover(replace(f.receipt));
  assert.equal(result.status, 'blocked');
  assert.equal(result.error.code, 'A_MISSION_RECOVERY_RECEIPT_DISPATCH_MISMATCH');
  assert.equal(f.gCalls(), 0);
});
