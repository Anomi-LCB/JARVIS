import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileWorkerQueueStore } from '../packages/core/src/runtime/worker-queue-store.js';

const STORE_VERSION = 'a-worker-queue-store-v1';

test('worker queue store migrates legacy partial v1 collections to empty arrays', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-worker-queue-legacy-'));
  try {
    const filePath = join(root, 'queue.json');
    const store = new FileWorkerQueueStore({ filePath });

    await writeFile(filePath, JSON.stringify({
      storeVersion: STORE_VERSION,
      persistedAt: '2034-01-02T03:04:05.000Z',
      queue: [{ queueId: 'legacy-queue-item', taskId: 'legacy-task', status: 'queued' }]
    }), 'utf8');
    assert.deepEqual(store.load(), {
      storeVersion: STORE_VERSION,
      persistedAt: '2034-01-02T03:04:05.000Z',
      queue: [{ queueId: 'legacy-queue-item', taskId: 'legacy-task', status: 'queued' }],
      runs: []
    });

    await writeFile(filePath, JSON.stringify({
      storeVersion: STORE_VERSION,
      persistedAt: '2034-01-03T03:04:05.000Z',
      runs: [{ runId: 'legacy-run', taskId: 'legacy-task', status: 'completed' }]
    }), 'utf8');
    assert.deepEqual(store.load(), {
      storeVersion: STORE_VERSION,
      persistedAt: '2034-01-03T03:04:05.000Z',
      runs: [{ runId: 'legacy-run', taskId: 'legacy-task', status: 'completed' }],
      queue: []
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('worker queue store normalizes partial saves while retaining metadata ownership', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-worker-queue-partial-save-'));
  try {
    const filePath = join(root, 'queue.json');
    const store = new FileWorkerQueueStore({
      filePath,
      clock: () => new Date('2035-01-02T03:04:05.000Z')
    });
    const saved = store.save({
      storeVersion: 'caller-version',
      persistedAt: '1900-01-01T00:00:00.000Z',
      runs: [{ runId: 'partial-save-run', taskId: 'partial-save-task', status: 'completed' }]
    });

    assert.deepEqual(saved.queue, []);
    assert.deepEqual(saved.runs, [{ runId: 'partial-save-run', taskId: 'partial-save-task', status: 'completed' }]);
    assert.equal(saved.storeVersion, STORE_VERSION);
    assert.equal(saved.persistedAt, '2035-01-02T03:04:05.000Z');
    assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')), saved);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('worker queue store accepts every persisted CoreOrchestrationWorker queue state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-worker-queue-states-'));
  try {
    const filePath = join(root, 'queue.json');
    const store = new FileWorkerQueueStore({ filePath });
    const queueStatuses = ['queued', 'running', 'retry_scheduled', 'succeeded', 'failed', 'quarantined'];
    const runStatuses = ['CREATED', 'PLANNING', 'WAITING_APPROVAL', 'APPROVED', 'EXECUTING', 'VERIFYING',
      'RETRYING', 'COMPENSATING', 'COMPENSATED', 'COMPLETED', 'FAILED', 'EXPIRED', 'BLOCKED', 'CANCELLED'];
    const saved = store.save({
      queue: queueStatuses.map((status, index) => ({
        queueId: `queue-한글-${index}`,
        taskId: `task-한글-${index}`,
        status,
        options: { userConfirmation: { confirmed: true } }
      })),
      runs: runStatuses.map((status, index) => ({
        runId: `run-한글-${index}`,
        taskId: `task-한글-${index}`,
        status,
        success: status === 'COMPLETED' || status === 'COMPENSATED'
      }))
    });

    assert.deepEqual(saved.queue.map((item) => item.status), queueStatuses);
    assert.deepEqual(saved.runs.map((item) => item.status), runStatuses);
    assert.deepEqual(store.load(), saved);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('worker queue store rejects malformed collection elements before persistence or restore', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-worker-queue-element-poison-'));
  try {
    const filePath = join(root, 'queue.json');
    const store = new FileWorkerQueueStore({ filePath });
    const malformedQueueItems = [undefined, null, [], {}, { queueId: 'q1', taskId: 't1' }, {
      queueId: 'q1', taskId: 't1', status: 'unknown'
    }];
    const malformedRunItems = [undefined, null, [], {}, { runId: 'r1', taskId: 't1' }];

    for (const item of malformedQueueItems) {
      assert.throws(
        () => store.save({ queue: [item], runs: [] }),
        (error) => error.code === 'A_WORKER_QUEUE_STORE_SNAPSHOT_INVALID'
      );
      await writeFile(filePath, JSON.stringify({ storeVersion: STORE_VERSION, queue: [item], runs: [] }), 'utf8');
      assert.throws(
        () => store.load(),
        (error) => error.code === 'A_WORKER_QUEUE_STORE_CORRUPT'
      );
    }

    for (const item of malformedRunItems) {
      assert.throws(
        () => store.save({ queue: [], runs: [item] }),
        (error) => error.code === 'A_WORKER_QUEUE_STORE_SNAPSHOT_INVALID'
      );
      await writeFile(filePath, JSON.stringify({ storeVersion: STORE_VERSION, queue: [], runs: [item] }), 'utf8');
      assert.throws(
        () => store.load(),
        (error) => error.code === 'A_WORKER_QUEUE_STORE_CORRUPT'
      );
    }

    assert.equal(existsSync(filePath), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('worker queue store rejects explicitly malformed collection values', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-worker-queue-malformed-'));
  try {
    const filePath = join(root, 'queue.json');
    const store = new FileWorkerQueueStore({ filePath });

    for (const malformed of [null, {}, 'runs']) {
      await writeFile(filePath, JSON.stringify({
        storeVersion: STORE_VERSION,
        queue: [],
        runs: malformed
      }), 'utf8');
      assert.throws(
        () => store.load(),
        (error) => error.code === 'A_WORKER_QUEUE_STORE_CORRUPT'
      );
      assert.throws(
        () => store.save({ queue: malformed }),
        (error) => error.code === 'A_WORKER_QUEUE_STORE_SNAPSHOT_INVALID'
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('worker queue store rejects prototype and toJSON serialization bypasses', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-worker-queue-serialization-'));
  try {
    const filePath = join(root, 'queue.json');
    const store = new FileWorkerQueueStore({ filePath });
    const validQueueItem = { queueId: 'q1', taskId: 't1', status: 'queued' };

    const customPrototype = Object.assign(Object.create({ inherited: true }), {
      queue: [validQueueItem],
      runs: []
    });
    assert.throws(
      () => store.save(customPrototype),
      (error) => error.code === 'A_WORKER_QUEUE_STORE_SNAPSHOT_INVALID'
    );

    assert.throws(
      () => store.save({
        queue: [validQueueItem],
        runs: [],
        toJSON() {
          return {
            storeVersion: 'caller-controlled-version',
            persistedAt: '1900-01-01T00:00:00.000Z',
            queue: [],
            runs: []
          };
        }
      }),
      (error) => error.code === 'A_WORKER_QUEUE_STORE_SNAPSHOT_INVALID'
    );

    assert.throws(
      () => store.save({
        queue: [{
          ...validQueueItem,
          toJSON() {
            return null;
          }
        }],
        runs: []
      }),
      (error) => error.code === 'A_WORKER_QUEUE_STORE_SNAPSHOT_INVALID'
    );

    const circular = { ...validQueueItem };
    circular.options = circular;
    assert.throws(
      () => store.save({ queue: [circular], runs: [] }),
      (error) => error.code === 'A_WORKER_QUEUE_STORE_SNAPSHOT_INVALID'
    );
    assert.equal(existsSync(filePath), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
