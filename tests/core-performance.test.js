import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  appendJsonlBatchSync,
  appendJsonlSync,
  beginJsonlBatchSync,
  commitJsonlBatchSync,
  discardJsonlBatchSync,
  readJsonl
} from '../packages/shared/src/jsonl.js';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';

test('JSONL operation batches preserve per-file order across nested batches', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-jsonl-batch-'));
  try {
    const firstPath = join(dir, 'first.jsonl');
    const secondPath = join(dir, 'second.jsonl');
    const outer = beginJsonlBatchSync({ operation: 'outer-test' });
    appendJsonlSync(firstPath, { sequence: 1 });
    const inner = beginJsonlBatchSync({ operation: 'inner-test' });
    appendJsonlBatchSync(firstPath, [{ sequence: 2 }, { sequence: 3 }]);
    appendJsonlSync(secondPath, { sequence: 10 });
    const innerSummary = commitJsonlBatchSync(inner);
    appendJsonlSync(firstPath, { sequence: 4 });
    const outerSummary = commitJsonlBatchSync(outer);

    assert.equal(innerSummary.nested, true);
    assert.equal(innerSummary.physicalWriteCount, 0);
    assert.equal(outerSummary.logicalRecordCount, 5);
    assert.equal(outerSummary.physicalWriteCount, 2);
    assert.equal(outerSummary.fileCount, 2);
    assert.deepEqual((await readJsonl(firstPath)).map((item) => item.sequence), [1, 2, 3, 4]);
    assert.deepEqual((await readJsonl(secondPath)).map((item) => item.sequence), [10]);

    const discarded = beginJsonlBatchSync({ operation: 'discard-test' });
    appendJsonlSync(firstPath, { sequence: 99 });
    const discardedSummary = discardJsonlBatchSync(discarded);
    assert.equal(discardedSummary.state, 'discarded');
    assert.deepEqual((await readJsonl(firstPath)).map((item) => item.sequence), [1, 2, 3, 4]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Core durable batching keeps legacy event and orchestration record semantics', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-core-batch-contract-'));
  const clock = () => new Date('2026-07-21T12:00:00.000Z');
  try {
    const batchedRoot = join(dir, 'batched');
    const legacyRoot = join(dir, 'legacy');
    const common = {
      allowedRoots: [dir],
      env: {},
      clock,
      workerDaemonEnabled: false
    };
    const batched = createAgRuntime({ ...common, auditRoot: batchedRoot, coreDurabilityBatching: true });
    const legacy = createAgRuntime({ ...common, auditRoot: legacyRoot, coreDurabilityBatching: false });

    const batchedTask = batched.coreFacade.createTask('회의 메모 파일 만들어');
    const legacyTask = legacy.coreFacade.createTask('회의 메모 파일 만들어');
    assert.equal(batchedTask.status, legacyTask.status);
    assert.equal(batchedTask.plan.action.actionType, legacyTask.plan.action.actionType);
    assert.equal(batchedTask.policy.decision, legacyTask.policy.decision);

    const batchedEvents = await readJsonl(join(batchedRoot, 'core-events.jsonl'));
    const legacyEvents = await readJsonl(join(legacyRoot, 'core-events.jsonl'));
    assert.deepEqual(
      batchedEvents.map((event) => event.eventType),
      legacyEvents.map((event) => event.eventType)
    );

    const batchedJournal = await readJsonl(join(batchedRoot, 'core-orchestration.jsonl'));
    const legacyJournal = await readJsonl(join(legacyRoot, 'core-orchestration.jsonl'));
    assert.deepEqual(
      batchedJournal.map((record) => record.recordType),
      legacyJournal.map((record) => record.recordType)
    );

    const restarted = createAgRuntime({ ...common, auditRoot: batchedRoot, coreDurabilityBatching: true });
    assert.deepEqual(
      restarted.coreFacade.eventBus.recent(batchedEvents.length).map((event) => event.eventType),
      [...batchedEvents].reverse().map((event) => event.eventType)
    );

    const telemetry = batched.coreFacade.adminDiagnostics().performance;
    assert.equal(telemetry.telemetryVersion, 'a-core-performance-telemetry-v1');
    assert.equal(telemetry.mode, 'operation-scoped-durable-batching');
    assert.equal(telemetry.sampleCount, 1);
    assert.equal(telemetry.durability.logicalRecordCount > telemetry.durability.physicalWriteCount, true);
    assert.equal(telemetry.durability.writeReductionRatio > 0.5, true);
    assert.equal(JSON.stringify(telemetry).includes('회의 메모'), false);
    assert.equal(telemetry.privacy.rawCommandStored, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Core durable batching flushes audit evidence produced before an operation error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-core-batch-error-'));
  try {
    const runtime = createAgRuntime({
      auditRoot: dir,
      allowedRoots: [dir],
      env: {},
      workerDaemonEnabled: false,
      coreDurabilityBatching: true,
      intentParser: { parse: () => null }
    });
    assert.throws(() => runtime.coreFacade.createTask('오류 기록 보존 확인'));

    const events = await readJsonl(join(dir, 'core-events.jsonl'));
    assert.deepEqual(events.map((event) => event.eventType), ['task.requested']);
    const telemetry = runtime.coreFacade.adminDiagnostics().performance;
    assert.equal(telemetry.aggregate.failedCount, 1);
    assert.equal(telemetry.recent[0].status, 'failed');
    assert.equal(telemetry.recent[0].durability.logicalRecordCount, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
