import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { ensureMissionActionOperation, checkpointMissionActionDispatch, recoverMissionAction } from '../packages/core/src/mission/mission-action-recovery.js';
import { ExecutionResultVerifier } from '../apps/verification/src/verification-runtime.js';
import { ExecutionPacketJournal, PcAgentRuntime } from '../apps/pc-agent/src/pc-agent-runtime.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const sorted = value => value && typeof value === 'object' ? Array.isArray(value) ? value.map(sorted)
  : Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-receipt-binding-'));
  t.after(async () => { assert.ok(root.startsWith(resolve(tmpdir()) + sep)); await rm(root, { recursive: true, force: true }); });
  const path = join(root, 'expected.txt'), other = join(root, 'other.txt'), content = '독립 기대 내용\n';
  await writeFile(path, content); await writeFile(other, '다른 작업의 실제 파일\n');
  const action = { actionId: 'write', taskId: 'binding-task', command: 'expected.txt를 저장해', expectedToolName: 'filesystem.createTextFile',
    actualToolName: 'filesystem.createTextFile', arguments: { path, content }, attempts: 1 };
  const task = { taskId: action.taskId, plan: { action: { toolName: action.actualToolName, actionType: 'CREATE_TEXT_FILE', arguments: action.arguments } } };
  ensureMissionActionOperation('binding-mission', action, [root]);
  checkpointMissionActionDispatch(action, task, {}, { mutatesSystem: true }, new Date().toISOString());
  const receipt = async (output = path) => {
    const now = new Date().toISOString();
    return { taskId: task.taskId, status: 'COMPLETED', executionResult: { taskId: task.taskId, status: 'success',
      packetId: 'binding-packet', startedAt: now, finishedAt: now,
      executedBy: { module: 'B_PC_AGENT', toolName: 'filesystem.createTextFile' }, outputPaths: [output],
      rollbackAvailable: true, undoJournalId: 'binding-undo' }, evidence: { evidenceId: 'binding-evidence', taskId: task.taskId,
      status: 'success', outputPaths: [output], shadow: { expectedChangesCount: 1 }, files: [{ path: output, sha256: sha(await readFile(output)), exists: true }] } };
  };
  let gCalls = 0;
  const verifier = new ExecutionResultVerifier();
  const worker = { verifyExecution: async (_task, result) => {
        gCalls++;
        const checks = await verifier.verify({ executionResult: result.executionResult, evidence: result.evidence });
        return { status: checks.some(check => check.status === 'failed') ? 'failed' : 'passed', verificationId: 'actual-execution-verifier', checks };
      } };
  const run = (execution, extra = {}) => recoverMissionAction({ missionId: 'binding-mission', action, allowedRoots: [root],
    coreFacade: { getTask: () => null }, worker: { ...worker, pcAgent: { taskResult: () => execution } }, ...extra });
  return { root, path, other, content, action, task, receipt, run, worker, gCalls: () => gCalls };
}

function durableJournal(f, execution, { journalAction = f.task.plan.action } = {}) {
  const operation = f.action.operation, dispatch = operation.dispatch;
  const request = { taskId: f.task.taskId, taskRequest: { synthetic: true }, plannedRequestSha256: operation.requestSha256,
    actionSha256: dispatch.actionSha256, action: structuredClone(f.task.plan.action), arguments: dispatch.arguments,
    toolName: dispatch.toolName, allowedRootsSha256: operation.allowedRootsSha256, resolvedAllowedRootsSha256: operation.resolvedAllowedRootsSha256 };
  const effect = { effect_id: 'binding-effect', mission_id: 'binding-mission', operation_id: operation.operationId,
    provider_idempotency_key: operation.operationId, state: 'succeeded', request_sha256: sha(JSON.stringify(sorted(request))),
    intent: { request }, receipt: { taskId: f.task.taskId, packetId: execution.executionResult.packetId,
      evidenceId: execution.evidence.evidenceId, receiptRef: `pc-packet:${execution.executionResult.packetId}`, source: 'trusted-local-pc-journal' } };
  const journalPath = join(f.root, 'packet-journal.jsonl'), journal = new ExecutionPacketJournal({ journalPath });
  const packet = { taskId: f.task.taskId, packetId: execution.executionResult.packetId, idempotencyKey: operation.operationId,
    requestedMode: 'execute', action: journalAction };
  journal.recordReceived(packet); journal.recordResult(packet, execution);
  const restoredJournal = new ExecutionPacketJournal({ journalPath });
  const executor = { receiptForOperation: args => PcAgentRuntime.prototype.receiptForOperation.call({ packetJournal: restoredJournal }, args) };
  return { effect, executor };
}

test('a self-consistent other-file receipt cannot recover the requested write or reach G/F acknowledgement', async t => {
  const f = await fixture(t), result = await f.run(await f.receipt(f.other));
  assert.equal(result.status, 'blocked');
  assert.equal(result.error.code, 'A_MISSION_RECOVERY_RECEIPT_DISPATCH_MISMATCH');
  assert.equal(f.gCalls(), 0);
});

test('a self-consistent current file with different content does not bind to the dispatched content', async t => {
  const f = await fixture(t);
  await writeFile(f.path, '다른 작업에서 쓴 내용');
  const result = await f.run(await f.receipt());
  assert.equal(result.status, 'blocked');
  assert.equal(result.error.code, 'A_MISSION_RECOVERY_RECEIPT_DISPATCH_MISMATCH');
  assert.equal(f.gCalls(), 0);
});

test('correct target and bytes retain the existing real G recovery path without redispatch', async t => {
  const f = await fixture(t), result = await f.run(await f.receipt());
  assert.equal(result.status, 'recovered');
  assert.equal(result.verification.status, 'passed');
  assert.equal(f.gCalls(), 1);
});

test('SQL recovery uses the persisted B operation journal and real G, ignoring a different latest task result', async t => {
  const f = await fixture(t), receipt = await f.receipt(), { effect, executor } = durableJournal(f, receipt);
  const wrong = await f.receipt(f.other);
  executor.taskResult = () => wrong;
  for (const state of ['succeeded', 'uncertain']) {
    const result = await f.run(wrong, { durableEffect: { ...effect, state }, worker: { ...f.worker, pcAgent: executor } });
    assert.equal(result.status, 'recovered');
    assert.equal(result.source, 'pc-operation-receipt');
    assert.deepEqual(result.execution.executionResult.outputPaths, [f.path]);
  }
  assert.equal(f.gCalls(), 2);
});

test('SQL packet, evidence and task identifiers must match the independently located operation receipt', async t => {
  const f = await fixture(t), receipt = await f.receipt(), { effect, executor } = durableJournal(f, receipt);
  for (const field of ['packetId', 'evidenceId', 'taskId', 'receiptRef', 'source']) {
    const changed = structuredClone(effect); changed.receipt[field] = 'different';
    const result = await f.run(receipt, { durableEffect: changed, worker: { ...f.worker, pcAgent: executor } });
    assert.equal(result.status, 'blocked', field);
    assert.equal(result.error.code, 'A_MISSION_RECOVERY_RECEIPT_DISPATCH_MISMATCH', field);
  }
  assert.equal(f.gCalls(), 0);
});

test('SQL original action and scope hashes cannot be replaced or omitted when no Core task survives', async t => {
  const f = await fixture(t), receipt = await f.receipt(), { effect, executor } = durableJournal(f, receipt);
  const changes = [x => { x.mission_id = 'other'; }, x => { x.operation_id = 'other'; }, x => { x.request_sha256 = '0'.repeat(64); },
    x => { x.intent.request.action.toolName = 'other'; }, x => { delete x.intent.request.action; },
    x => { x.intent.request.allowedRootsSha256 = 'other'; }, x => { x.intent.request.arguments = { path: f.other }; }];
  for (const change of changes) {
    const changed = structuredClone(effect); change(changed);
    const result = await f.run(receipt, { durableEffect: changed, worker: { ...f.worker, pcAgent: executor } });
    assert.equal(result.status, 'blocked');
    assert.equal(result.error.code, 'A_MISSION_RECOVERY_RECEIPT_DISPATCH_MISMATCH');
  }
  assert.equal(f.gCalls(), 0);
});

test('a completed journal result for another action under the same operation is not accepted', async t => {
  const f = await fixture(t), receipt = await f.receipt();
  const changedAction = structuredClone(f.task.plan.action); changedAction.arguments.content = 'different request';
  const { effect, executor } = durableJournal(f, receipt, { journalAction: changedAction });
  const result = await f.run(receipt, { durableEffect: effect, worker: { ...f.worker, pcAgent: executor } });
  assert.equal(result.status, 'blocked');
  assert.equal(result.error.code, 'A_MISSION_RECOVERY_EXECUTION_UNCERTAIN');
  assert.equal(f.gCalls(), 0);
});
