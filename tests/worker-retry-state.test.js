import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { InputSource, ModuleId, TaskStatus } from '../packages/shared/src/types.js';

async function fixture(t, { missing = false, maxAttempts = 2 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-worker-retry-state-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'input.txt');
  if (!missing) await writeFile(path, '원래 파일의 정확한 내용', 'utf8');
  const runtime = createAgRuntime({ allowedRoots: [root], auditRoot: join(root, 'audit'), cwd: () => root,
    env: { JARVIS_TEST_MODE: '1' }, workerDaemonEnabled: false, workerBaseBackoffMs: 1 });
  const task = runtime.coreFacade.createMissionActionTask('입력 텍스트 파일의 내용을 읽어줘.', {
    expectedToolName: 'filesystem.readText', preparedArguments: { path, maxChars: 5000 },
    source: InputSource.TRIGGER, sourceModule: ModuleId.CORE, deviceId: 'mission_executive'
  });
  assert.equal(task.plan.action.toolName, 'filesystem.readText');
  const item = runtime.orchestrationWorker.enqueueTask(task.taskId, { maxAttempts, userConfirmation: { confirmed: true } });
  const due = () => { runtime.orchestrationWorker.queue.find((queued) => queued.queueId === item.queueId).nextAttemptAt = '2000-01-01T00:00:00.000Z'; };
  const packets = () => runtime.pcAgent.packetJournal.records.filter((record) => record.taskId === task.taskId && record.recordType === 'packet_received' && record.dryRun === false);
  return { runtime, task, path, due, packets };
}

function failReads(runtime, count) {
  const adapter = runtime.pcAgent.registry.get('filesystem.readText');
  const execute = adapter.execute.bind(adapter);
  let calls = 0;
  adapter.execute = async (...args) => {
    calls++;
    if (calls <= count) return { status: 'failed', error: 'EAGAIN', summary: 'EAGAIN',
      outputPaths: [], changedItems: [], rollbackAvailable: false, readOnly: true };
    return execute(...args);
  };
  return () => calls;
}

test('a real PC read failure retries through APPROVED and produces a second verified execution packet', async (t) => {
  const f = await fixture(t);
  const calls = failReads(f.runtime, 1);
  const first = await f.runtime.orchestrationWorker.runNext();
  assert.equal(first.item.status, 'retry_scheduled');
  assert.equal(f.task.status, TaskStatus.FAILED);
  assert.equal(f.packets().length, 1);
  f.due();
  const second = await f.runtime.orchestrationWorker.runNext();
  assert.equal(second.item.status, 'succeeded', JSON.stringify(second));
  assert.equal(f.task.status, TaskStatus.COMPLETED);
  assert.equal(second.run.executionVerification.status, 'passed');
  assert.equal(calls(), 2);
  assert.equal(new Set(f.packets().map((packet) => packet.packetId)).size, 2);
  assert.equal(f.task.stateMachine.retryCount, 1);
  assert.equal(f.runtime.orchestrationWorker.activeTaskIds.size, 0);
  assert.equal(f.runtime.orchestrationWorker.leaseTable.leases.size, 0);
  assert.equal(await readFile(f.path, 'utf8'), '원래 파일의 정확한 내용');
});

test('a genuinely missing file fails after one PC packet without retry or a stale EXECUTING task', async (t) => {
  const f = await fixture(t, { missing: true, maxAttempts: 4 });
  const run = await f.runtime.orchestrationWorker.runNext();
  assert.equal(run.item.status, 'failed');
  assert.equal(run.item.lastError, 'text-file-missing');
  assert.equal(run.item.attempts, 1);
  assert.equal(f.task.status, TaskStatus.FAILED);
  assert.equal(f.task.stateMachine.retryCount, 0);
  assert.equal(f.packets().length, 1);
  assert.equal((await f.runtime.orchestrationWorker.runNext()).processed, false);
  assert.equal(f.runtime.orchestrationWorker.activeTaskIds.size, 0);
});

test('exhausted transient read failures leave both the queue and Core task terminal', async (t) => {
  const f = await fixture(t);
  const calls = failReads(f.runtime, 10);
  assert.equal((await f.runtime.orchestrationWorker.runNext()).item.status, 'retry_scheduled');
  f.due();
  const last = await f.runtime.orchestrationWorker.runNext();
  assert.equal(last.item.status, 'failed');
  assert.equal(f.task.status, TaskStatus.FAILED);
  assert.equal(calls(), 2);
  assert.equal(f.packets().length, 2);
  assert.equal(f.runtime.orchestrationWorker.activeTaskIds.size, 0);
});

test('an expired approval between attempts prevents the second packet instead of being renewed by retry', async (t) => {
  const f = await fixture(t);
  const calls = failReads(f.runtime, 1);
  await f.runtime.orchestrationWorker.runNext();
  f.task.approvalCard.expiresAt = '2000-01-01T00:00:00.000Z';
  f.due();
  const last = await f.runtime.orchestrationWorker.runNext();
  assert.equal(last.item.status, 'failed');
  assert.equal(last.item.lastError, 'approval-expired');
  assert.equal(f.task.status, TaskStatus.FAILED);
  assert.equal(f.task.stateMachine.retryCount, 0);
  assert.equal(calls(), 1);
  assert.equal(f.packets().length, 1);
});

test('a final transport exception clears stale Core EXECUTING state along with queue failure', async (t) => {
  const f = await fixture(t, { maxAttempts: 1 });
  f.runtime.pcAgent.receiveExecutionPacket = async () => {
    const error = new Error('Injected refused connection before PC receives the read packet.');
    error.code = 'ECONNREFUSED';
    throw error;
  };
  const last = await f.runtime.orchestrationWorker.runNext();
  assert.equal(last.item.status, 'failed');
  assert.equal(f.task.status, TaskStatus.FAILED);
  assert.equal(f.packets().length, 0);
  assert.equal(f.runtime.orchestrationWorker.activeTaskIds.size, 0);
  assert.equal(f.runtime.orchestrationWorker.leaseTable.leases.size, 0);
});
