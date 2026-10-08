import assert from 'node:assert/strict';
import test from 'node:test';
import { CoreOrchestrationWorker } from '../packages/core/src/orchestration/core-orchestration-worker.js';

function createWorker({ timeoutMs = 8, abortSettleTimeoutMs = 80, maxAttempts = 2, pcAgent = null } = {}) {
  const events = [];
  const task = { taskId: 'task-timeout-resilience', status: 'READY' };
  const coreFacade = {
    eventBus: {
      publish(eventType, payload) {
        events.push({ eventType, payload });
      }
    },
    getTask(taskId) {
      return taskId === task.taskId ? task : null;
    },
    recordToolExecution() {}
  };
  const worker = new CoreOrchestrationWorker({
    coreFacade,
    pcAgent,
    defaultTimeoutMs: timeoutMs,
    abortSettleTimeoutMs,
    maxAttempts,
    baseBackoffMs: 1,
    leaseTtlMs: 1_000
  });
  return { worker, task, events };
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test('cooperative timeout keeps the active guard and lease until the aborted run settles', async () => {
  const { worker, task } = createWorker();
  const queued = worker.enqueueTask(task.taskId, { timeoutMs: 8, abortSettleTimeoutMs: 80 });
  let observedSignal = null;
  let handlerSettled = false;
  let releaseAbortSettlement;
  let reportAbort;
  const abortObserved = new Promise((resolve) => { reportAbort = resolve; });
  const abortSettlementGate = new Promise((resolve) => { releaseAbortSettlement = resolve; });

  worker.runTask = (_taskId, options = {}) => {
    observedSignal = options.signal;
    return new Promise((_resolve, reject) => {
      observedSignal.addEventListener('abort', () => {
        reportAbort();
        void abortSettlementGate.then(() => {
          handlerSettled = true;
          const error = new Error('cooperatively aborted');
          error.name = 'AbortError';
          error.code = 'ABORT_ERR';
          reject(error);
        });
      }, { once: true });
    });
  };

  const pending = worker.runNext();
  await abortObserved;
  assert.equal(observedSignal instanceof AbortSignal, true);
  assert.equal(observedSignal.aborted, true);
  assert.equal(handlerSettled, false);
  assert.equal(worker.activeTaskIds.has(task.taskId), true);
  assert.equal(worker.leaseTable.status().activeLeaseCount, 1);
  assert.equal(worker.queue.find((item) => item.queueId === queued.queueId).status, 'running');

  releaseAbortSettlement();
  const result = await pending;
  assert.equal(handlerSettled, true);
  assert.equal(result.error.code, 'A_WORKER_TIMEOUT');
  assert.equal(result.item.status, 'retry_scheduled');
  assert.equal(worker.activeTaskIds.has(task.taskId), false);
  assert.equal(worker.leaseTable.status().activeLeaseCount, 0);
});

test('non-cooperative timeout is quarantined as uncertain and cannot start a duplicate mutation', async () => {
  const { worker, task, events } = createWorker({ abortSettleTimeoutMs: 12, maxAttempts: 3 });
  const first = worker.enqueueTask(task.taskId, { timeoutMs: 5, abortSettleTimeoutMs: 12, maxAttempts: 3 });
  let observedSignal = null;
  let settleHandler;
  let runTaskCalls = 0;
  worker.runTask = (_taskId, options = {}) => {
    runTaskCalls += 1;
    observedSignal = options.signal;
    return new Promise((resolve) => { settleHandler = resolve; });
  };

  const timedOut = await worker.runNext();
  assert.equal(observedSignal instanceof AbortSignal, true);
  assert.equal(observedSignal.aborted, true);
  assert.equal(timedOut.uncertain, true);
  assert.equal(timedOut.quarantined, true);
  assert.equal(timedOut.error.code, 'A_WORKER_TIMEOUT_UNCERTAIN');
  assert.equal(timedOut.item.status, 'quarantined');
  assert.equal(timedOut.item.retrySuppressed, true);
  assert.equal(timedOut.item.executionUncertain, true);
  assert.equal(timedOut.item.attempts, 1);
  assert.equal(worker.activeTaskIds.has(task.taskId), true);
  assert.equal(worker.leaseTable.status().activeLeaseCount, 1);
  assert.equal(events.some((event) => event.eventType === 'worker.queue.retry_scheduled'), false);

  const heldLease = worker.leaseTable.status().leases[0];
  const recovery = worker.recoverExpiredLeases({
    now: new Date(Date.parse(heldLease.expiresAt) + 1).toISOString()
  });
  assert.equal(recovery.recoveredCount, 1);
  assert.equal(worker.activeTaskIds.has(task.taskId), true);
  assert.equal(worker.leaseTable.status().activeLeaseCount, 1);
  assert.equal(worker.queue.find((item) => item.queueId === first.queueId).status, 'quarantined');
  assert.equal(events.some((event) => event.eventType === 'worker.lease.recovery_deferred'), true);
  assert.equal(events.some((event) => event.eventType === 'worker.queue.retry_scheduled'), false);

  const duplicate = worker.enqueueTask(task.taskId, { timeoutMs: 5, maxAttempts: 3 });
  const duplicateResult = await worker.runNext();
  assert.equal(duplicateResult.uncertain, true);
  assert.equal(duplicateResult.quarantined, true);
  assert.equal(duplicateResult.reason, 'task-execution-uncertain');
  assert.equal(duplicateResult.item.queueId, duplicate.queueId);
  assert.equal(duplicateResult.item.status, 'quarantined');
  assert.equal(runTaskCalls, 1);

  settleHandler({ success: true, runId: 'late-known-result' });
  await nextTurn();
  assert.equal(worker.activeTaskIds.has(task.taskId), false);
  assert.equal(worker.leaseTable.status().activeLeaseCount, 0);
  assert.equal(worker.queue.find((item) => item.queueId === first.queueId).status, 'quarantined');
  assert.equal(events.filter((event) => event.eventType === 'worker.queue.retry_scheduled').length, 0);
});

test('execution boundary forwards the attempt signal while preserving calls without one', async () => {
  const seenSignals = [];
  const pcAgent = {
    async receiveExecutionPacket(_packet, options = {}) {
      seenSignals.push(options.signal ?? null);
      return { status: 'COMPLETED', executionResult: { status: 'success' } };
    }
  };
  const { worker } = createWorker({ pcAgent });
  const packet = { action: { toolName: 'fixture.mutation' } };
  const controller = new AbortController();

  const signalled = await worker.executePacketWithHealth(packet, { dryRun: true, signal: controller.signal });
  const legacy = await worker.executePacketWithHealth(packet, { dryRun: true });
  assert.equal(signalled.status, 'COMPLETED');
  assert.equal(legacy.status, 'COMPLETED');
  assert.deepEqual(seenSignals, [controller.signal, null]);

  controller.abort();
  await assert.rejects(
    worker.executePacketWithHealth(packet, { dryRun: true, signal: controller.signal }),
    (error) => error.code === 'A_WORKER_ABORTED'
  );
  assert.equal(seenSignals.length, 2, 'an already-aborted attempt must not cross the execution boundary');
});

test('execution boundary marks a handler that resolves after abort as uncertain', async () => {
  let finishExecution;
  const pcAgent = {
    receiveExecutionPacket() {
      return new Promise((resolve) => { finishExecution = resolve; });
    }
  };
  const { worker } = createWorker({ pcAgent });
  const controller = new AbortController();
  const execution = worker.executePacketWithHealth(
    { action: { toolName: 'fixture.non_cooperative_mutation' } },
    { signal: controller.signal }
  );

  controller.abort();
  finishExecution({ status: 'COMPLETED', executionResult: { status: 'success' } });

  await assert.rejects(
    execution,
    (error) => error.code === 'A_WORKER_ABORTED_UNCERTAIN' && error.executionUncertain === true
  );
});
