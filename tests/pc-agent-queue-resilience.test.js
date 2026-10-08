import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import {
  ExecutionPacketQueue
} from '../apps/pc-agent/src/pc-agent-runtime.js';
import { ActionType, TaskStatus } from '../packages/shared/src/types.js';

function queuePacket(overrides = {}) {
  return {
    taskId: 'task_queue_resilience',
    packetId: 'packet_queue_resilience',
    idempotencyKey: 'queue-resilience-key',
    capabilityToken: { tokenId: 'cap_queue_resilience' },
    userConfirmation: { confirmed: true },
    action: {
      actionType: ActionType.BROWSER_SEARCH,
      toolName: 'browser.search',
      arguments: { query: 'resilience' }
    },
    ...overrides,
    action: {
      actionType: ActionType.BROWSER_SEARCH,
      toolName: 'browser.search',
      arguments: { query: 'resilience' },
      ...(overrides.action ?? {})
    }
  };
}

test('PC Agent queue retries a returned transient failure and journals only the later success as terminal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-pc-queue-transient-'));
  try {
    let now = new Date('2032-01-01T00:00:00.000Z');
    const clock = () => now;
    const runtime = createAgRuntime({ allowedRoots: [dir], auditRoot: dir, clock });
    const toolName = 'test.transient-read';
    let adapterCalls = 0;
    runtime.pcAgent.registry.register(toolName, {
      contract: {
        toolName,
        modes: ['shadow', 'execute'],
        readOnly: true,
        mutatesSystem: false,
        rollback: false,
        evidence: []
      },
      async shadow() {
        return { mode: 'shadow', expectedChangesCount: 0, warnings: [] };
      },
      async execute() {
        adapterCalls += 1;
        if (adapterCalls === 1) {
          return {
            status: 'failed',
            error: 'B_TEST_UPSTREAM_TIMEOUT',
            summary: 'temporary upstream timeout',
            outputPaths: [],
            changedItems: [],
            rollbackAvailable: false,
            readOnly: true
          };
        }
        return {
          status: 'success',
          summary: 'upstream recovered',
          outputPaths: [],
          changedItems: [],
          rollbackAvailable: false,
          readOnly: true
        };
      }
    });
    const token = runtime.policyRuntime.capabilities.issue({
      taskId: 'task_transient_runtime',
      planId: 'plan_transient_runtime',
      approvalId: 'approval_transient_runtime',
      action: { actionType: ActionType.BROWSER_SEARCH, toolName, skillId: 'test.resilience' },
      allowedPaths: [dir]
    });
    const packet = queuePacket({
      taskId: 'task_transient_runtime',
      packetId: 'packet_transient_runtime',
      idempotencyKey: 'transient-runtime-key',
      capabilityToken: token,
      action: {
        actionType: ActionType.BROWSER_SEARCH,
        toolName,
        skillId: 'test.resilience',
        arguments: { query: 'temporary outage' }
      }
    });
    runtime.pcAgent.executionQueue.baseBackoffMs = 100;
    runtime.pcAgent.queueExecutionPacket(packet);

    const first = await runtime.pcAgent.processExecutionQueue({ limit: 1 });
    assert.equal(first.results[0].retryScheduled, true);
    assert.equal(first.results[0].item.status, 'retry_scheduled');
    assert.equal(runtime.pcAgent.packetJournal.resultFor(packet), null);
    assert.equal(runtime.pcAgent.packetJournal.records.some((record) => (
      record.recordType === 'packet_succeeded' && record.idempotencyKey === packet.idempotencyKey
    )), false);

    now = new Date('2032-01-01T00:00:00.100Z');
    const second = await runtime.pcAgent.processExecutionQueue({ limit: 1 });
    assert.equal(second.results[0].item.status, 'succeeded');
    assert.equal(second.results[0].result.status, TaskStatus.COMPLETED);
    assert.equal(adapterCalls, 2);
    assert.equal(runtime.pcAgent.packetJournal.resultFor(packet)?.status, TaskStatus.COMPLETED);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('PC Agent queue treats blocked results as terminal and malformed results as poison', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-pc-queue-outcomes-'));
  try {
    const queue = new ExecutionPacketQueue({
      queuePath: join(dir, 'queue.jsonl'),
      baseBackoffMs: 100
    });
    queue.enqueue(queuePacket({ idempotencyKey: 'blocked-result-key' }));
    const blocked = await queue.processNext(async () => ({
      status: TaskStatus.BLOCKED,
      blockedReason: 'B_USER_CONFIRMATION_REQUIRED'
    }));
    assert.equal(blocked.terminalBlocked, true);
    assert.equal(blocked.item.status, 'blocked');
    assert.equal(queue.status().blocked, 1);

    queue.enqueue(queuePacket({
      taskId: 'task_ambiguous_email',
      packetId: 'packet_ambiguous_email',
      idempotencyKey: 'ambiguous-email-key',
      action: {
        actionType: ActionType.SEND_EMAIL,
        toolName: 'email.send',
        arguments: { to: 'owner@example.com', subject: 'once', body: 'once' }
      }
    }));
    const ambiguousEmail = await queue.processNext(async () => ({
      status: TaskStatus.BLOCKED,
      blockedReason: 'email-delivery-state-uncertain',
      executionResult: {
        status: 'blocked',
        error: 'email-delivery-state-uncertain'
      }
    }));
    assert.equal(ambiguousEmail.terminalBlocked, true);
    assert.equal(ambiguousEmail.item.status, 'blocked');
    assert.equal(queue.status().retryScheduled, 0);

    queue.enqueue(queuePacket({
      taskId: 'task_malformed_result',
      packetId: 'packet_malformed_result',
      idempotencyKey: 'malformed-result-key'
    }));
    const malformed = await queue.processNext(async () => ({ status: 'surprise' }));
    assert.equal(malformed.quarantined, true);
    assert.equal(malformed.item.status, 'quarantined');
    assert.equal(malformed.item.error, 'B_QUEUE_HANDLER_RESULT_INVALID');

    const records = (await readFile(join(dir, 'queue.jsonl'), 'utf8'))
      .trim().split(/\r?\n/u).map((line) => JSON.parse(line));
    assert.equal(records.some((record) => record.recordType === 'packet_terminal_blocked'), true);
    assert.equal(records.some((record) => record.recordType === 'packet_succeeded' && record.idempotencyKey === 'blocked-result-key'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('PC Agent blocks a different canonical payload that reuses an idempotency key before mutation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-pc-idempotency-conflict-'));
  try {
    const runtime = createAgRuntime({ allowedRoots: [dir], auditRoot: dir });
    const firstPath = join(dir, 'first.txt');
    const conflictingPath = join(dir, 'conflicting.txt');
    const issueToken = (suffix) => runtime.policyRuntime.capabilities.issue({
      taskId: 'task_idempotency_conflict',
      planId: `plan_idempotency_conflict_${suffix}`,
      approvalId: `approval_idempotency_conflict_${suffix}`,
      action: {
        actionType: ActionType.CREATE_FILE,
        toolName: 'filesystem.createTextFile',
        skillId: 'jarvis.local.mvp'
      },
      allowedPaths: [dir]
    });
    const firstPacket = {
      taskId: 'task_idempotency_conflict',
      packetId: 'packet_idempotency_conflict_1',
      idempotencyKey: 'shared-canonical-key',
      capabilityToken: issueToken('first'),
      userConfirmation: { confirmed: true },
      action: {
        actionType: ActionType.CREATE_FILE,
        toolName: 'filesystem.createTextFile',
        skillId: 'jarvis.local.mvp',
        arguments: { path: firstPath, content: 'first payload' }
      }
    };
    const first = await runtime.pcAgent.receiveExecutionPacket(firstPacket);
    assert.equal(first.status, TaskStatus.COMPLETED);

    const replay = await runtime.pcAgent.receiveExecutionPacket({
      ...firstPacket,
      packetId: 'packet_idempotency_conflict_retry',
      capabilityToken: issueToken('retry')
    });
    assert.equal(replay.status, TaskStatus.COMPLETED);
    assert.equal(replay.idempotentReplay, true);

    const conflict = await runtime.pcAgent.receiveExecutionPacket({
      ...firstPacket,
      packetId: 'packet_idempotency_conflict_2',
      capabilityToken: issueToken('conflict'),
      action: {
        ...firstPacket.action,
        arguments: { path: conflictingPath, content: 'different payload' }
      }
    });
    assert.equal(conflict.status, TaskStatus.BLOCKED);
    assert.equal(conflict.blockedReason, 'B_IDEMPOTENCY_CONFLICT');
    await assert.rejects(access(conflictingPath));
    assert.equal(runtime.pcAgent.packetJournal.records.some((record) => (
      record.recordType === 'packet_idempotency_conflict'
    )), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('PC Agent queue rejects a different payload with the same idempotency key before dispatch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-pc-queue-conflict-'));
  try {
    const queue = new ExecutionPacketQueue({ queuePath: join(dir, 'queue.jsonl') });
    queue.enqueue(queuePacket({ idempotencyKey: 'queue-shared-key' }));
    const conflict = queue.enqueue(queuePacket({
      taskId: 'task_queue_conflict',
      packetId: 'packet_queue_conflict',
      idempotencyKey: 'queue-shared-key',
      action: { arguments: { query: 'different payload' } }
    }));
    assert.equal(conflict.status, 'quarantined');
    assert.equal(conflict.error, 'B_IDEMPOTENCY_CONFLICT');

    let dispatches = 0;
    await queue.drain(async () => {
      dispatches += 1;
      return { status: TaskStatus.COMPLETED };
    });
    assert.equal(dispatches, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('PC Agent queue recovers stranded read-only work and quarantines uncertain mutations on load', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-pc-queue-restart-'));
  try {
    const queuePath = join(dir, 'queue.jsonl');
    let now = new Date('2032-02-01T00:00:00.000Z');
    const clock = () => now;
    const queue = new ExecutionPacketQueue({ queuePath, clock, maxAttempts: 3 });
    const readOnly = queue.enqueue(queuePacket({ idempotencyKey: 'stranded-read-key' }));
    const mutating = queue.enqueue(queuePacket({
      taskId: 'task_stranded_mutation',
      packetId: 'packet_stranded_mutation',
      idempotencyKey: 'stranded-mutation-key',
      action: {
        actionType: ActionType.CREATE_FILE,
        toolName: 'filesystem.createTextFile',
        arguments: { path: join(dir, 'uncertain.txt'), content: 'uncertain' }
      }
    }));
    const leasedRead = queue.enqueue(queuePacket({
      taskId: 'task_stranded_leased_read',
      packetId: 'packet_stranded_leased_read',
      idempotencyKey: 'stranded-leased-read-key'
    }));
    queue.append({
      recordType: 'packet_attempt',
      queueId: readOnly.queueId,
      idempotencyKey: readOnly.idempotencyKey,
      attempt: 1,
      attemptedAt: clock().toISOString()
    });
    queue.append({
      recordType: 'packet_attempt',
      queueId: mutating.queueId,
      idempotencyKey: mutating.idempotencyKey,
      attempt: 1,
      attemptedAt: clock().toISOString()
    });
    queue.append({
      recordType: 'packet_attempt',
      queueId: leasedRead.queueId,
      idempotencyKey: leasedRead.idempotencyKey,
      attempt: 1,
      attemptedAt: clock().toISOString(),
      attemptOwnerPid: 999999,
      attemptLeaseExpiresAt: '2032-02-01T00:01:00.000Z'
    });

    const restored = new ExecutionPacketQueue({ queuePath, clock, maxAttempts: 3 });
    const readItem = restored.status().next.find((item) => item.idempotencyKey === 'stranded-read-key');
    const mutationItem = restored.status().deadLetters.find((item) => item.idempotencyKey === 'stranded-mutation-key');
    assert.equal(readItem.status, 'retry_scheduled');
    assert.equal(readItem.error, 'B_QUEUE_RESTART_SAFE_RETRY');
    assert.equal(mutationItem.status, 'quarantined');
    assert.equal(mutationItem.reason, 'stranded-running-execution-uncertain');
    assert.equal(mutationItem.error, 'B_QUEUE_STRANDED_EXECUTION_UNCERTAIN');
    assert.equal(restored.status().running, 1);

    now = new Date('2032-02-01T00:01:00.001Z');
    restored.nextRunnable(now);
    const recoveredLease = restored.status().next.find((item) => item.idempotencyKey === 'stranded-leased-read-key');
    assert.equal(recoveredLease.status, 'retry_scheduled');
    assert.equal(recoveredLease.error, 'B_QUEUE_RESTART_SAFE_RETRY');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
