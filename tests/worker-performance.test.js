import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { VerificationReportStore } from '../apps/verification/src/reports/report-store.js';

test('G report index batching persists multiple verification reports with one index write', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-report-index-batch-'));
  try {
    const store = new VerificationReportStore({ reportDir: dir });
    const originalWriteIndex = store.writeIndex.bind(store);
    let indexWriteCount = 0;
    store.writeIndex = (...args) => {
      indexWriteCount += 1;
      return originalWriteIndex(...args);
    };
    const report = (verificationId, status = 'passed') => ({
      verificationId,
      taskId: 'task_report_batch',
      status,
      score: status === 'passed' ? 100 : 0,
      checks: [{
        checkId: `${verificationId}_check`,
        checkName: 'batch check',
        status,
        severity: 'medium',
        message: 'batch persistence contract'
      }],
      evidence: {},
      createdAt: new Date().toISOString()
    });

    let firstPaths;
    let secondPaths;
    await store.runIndexBatch(async () => {
      firstPaths = store.save(report('ver_batch_1'));
      await Promise.resolve();
      secondPaths = store.save(report('ver_batch_2'));
    }, { operation: 'test-index-batch' });

    assert.equal(indexWriteCount, 1);
    assert.equal(store.index().items.length, 2);
    assert.equal(existsSync(firstPaths.jsonPath), true);
    assert.equal(existsSync(secondPaths.htmlPath), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('A worker queue runs independent read-only tasks in a bounded parallel wave', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-worker-read-parallel-'));
  try {
    await writeFile(join(dir, 'fixture.txt'), 'read-only queue fixture', 'utf8');
    const runtime = createAgRuntime({
      auditRoot: dir,
      allowedRoots: [dir],
      cwd: () => dir,
      env: {},
      workerDaemonEnabled: false,
      workerQueueStorePath: join(dir, 'worker-queue.json'),
      workerLeaseStorePath: join(dir, 'worker-leases.json'),
      workerMaxQueueConcurrency: 4
    });
    const originalReceive = runtime.pcAgent.receiveExecutionPacket.bind(runtime.pcAgent);
    const originalSave = runtime.orchestrationWorker.queueStore.save.bind(runtime.orchestrationWorker.queueStore);
    let active = 0;
    let maxActive = 0;
    let queueSaveCount = 0;
    runtime.pcAgent.receiveExecutionPacket = async (...args) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        await delay(25);
        return await originalReceive(...args);
      } finally {
        active -= 1;
      }
    };
    runtime.orchestrationWorker.queueStore.save = (...args) => {
      queueSaveCount += 1;
      return originalSave(...args);
    };

    const taskCount = 4;
    for (let index = 0; index < taskCount; index += 1) {
      const task = runtime.coreFacade.createTask(`파일 목록 보여줘 병렬-${index}`);
      runtime.orchestrationWorker.enqueueTask(task.taskId, { userConfirmation: { confirmed: true } });
    }
    queueSaveCount = 0;
    const drained = await runtime.orchestrationWorker.drain({ limit: taskCount, concurrency: 4 });

    assert.equal(drained.processed, taskCount);
    assert.equal(drained.scheduler.parallelWaveCount, 1);
    assert.equal(drained.scheduler.waves[0].selectedCount, taskCount);
    assert.equal(maxActive, taskCount);
    assert.equal(drained.results.every((result) => result.item.status === 'succeeded'), true);
    assert.equal(queueSaveCount, taskCount * 2);
    const persisted = JSON.parse(await readFile(join(dir, 'worker-queue.json'), 'utf8'));
    assert.equal(persisted.queue.every((item) => item.status === 'succeeded'), true);
    assert.equal(persisted.runs.length, taskCount);
    assert.equal(drained.status.scheduler.privacy.rawCommandsStored, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('A worker queue keeps mutating tasks sequential even when concurrency is requested', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-worker-write-sequential-'));
  try {
    const runtime = createAgRuntime({
      auditRoot: dir,
      allowedRoots: [dir],
      cwd: () => dir,
      env: {},
      workerDaemonEnabled: false,
      workerMaxQueueConcurrency: 4
    });
    const originalReceive = runtime.pcAgent.receiveExecutionPacket.bind(runtime.pcAgent);
    let active = 0;
    let maxActive = 0;
    runtime.pcAgent.receiveExecutionPacket = async (...args) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        await delay(20);
        return await originalReceive(...args);
      } finally {
        active -= 1;
      }
    };

    const taskCount = 3;
    for (let index = 0; index < taskCount; index += 1) {
      const task = runtime.coreFacade.createTask(`파일 만들어 직렬-${index}`);
      runtime.orchestrationWorker.enqueueTask(task.taskId, {
        dryRun: true,
        userConfirmation: { confirmed: true }
      });
    }
    const drained = await runtime.orchestrationWorker.drain({ limit: taskCount, concurrency: 4 });

    assert.equal(drained.processed, taskCount);
    assert.equal(drained.scheduler.parallelWaveCount, 0);
    assert.equal(drained.scheduler.waveCount, taskCount);
    assert.equal(maxActive, 1);
    assert.equal(drained.scheduler.waves.every((wave) => wave.profileReasons.includes('mutating-or-exclusive-action')), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
