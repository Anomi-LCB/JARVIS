import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { coreServiceRuntimeOptionsFromEnv, createConfiguredCoreServiceRuntime } from '../scripts/core-service-runtime.mjs';

function isolatedEnv(root, overrides = {}) {
  return {
    JARVIS_TEST_MODE: '1',
    JARVIS_TEST_AUDIT_ROOT: root,
    JARVIS_CORE_ALLOWED_ROOTS: join(root, 'workspace'),
    JARVIS_CORE_ADMIN_TOKEN: 'isolated-growth-test',
    JARVIS_CORE_WORKER_DAEMON_ENABLED: '0',
    JARVIS_CORE_WORKER_DAEMON_AUTOSTART: '0',
    JARVIS_PERSONAL_IMPORT_ENABLED: '0',
    JARVIS_GOOGLE_SYNC_ENABLED: '0',
    ...overrides
  };
}

test('Core growth paths inherit the isolated audit root and allow explicit deployment paths', () => {
  const root = join(tmpdir(), 'jarvis-growth-options-only');
  const options = coreServiceRuntimeOptionsFromEnv({ env: isolatedEnv(root) });
  assert.equal(options.growthMemoryDbPath, join(options.auditRoot, 'growth-memory', 'growth.sqlite'));
  assert.equal(options.growthMemoryReviewDir, join(options.auditRoot, 'growth-memory', 'reviews'));
  assert.equal(options.growthMemoryBackupDir, join(options.auditRoot, 'growth-memory', 'backups'));
  assert.equal(options.cognitionStorePath, join(options.auditRoot, 'cognition.sqlite'));
  const custom = coreServiceRuntimeOptionsFromEnv({ cwd: root, env: isolatedEnv(root, {
    JARVIS_CORE_GROWTH_DB: 'state/memory.sqlite',
    JARVIS_CORE_GROWTH_REVIEW_DIR: 'state/reviews',
    JARVIS_CORE_GROWTH_BACKUP_DIR: 'state/backups'
  }) });
  assert.equal(custom.growthMemoryDbPath, resolve(root, 'state/memory.sqlite'));
  assert.equal(custom.growthMemoryReviewDir, resolve(root, 'state/reviews'));
  assert.equal(custom.growthMemoryBackupDir, resolve(root, 'state/backups'));
});

test('Configured Core restores feedback and a confirmed preference into the next planning context', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-core-growth-restart-'));
  const env = isolatedEnv(root);
  let runtime;
  try {
    runtime = await createConfiguredCoreServiceRuntime({ env });
    assert.equal(runtime.growthRuntime.storageStatus().integrity.status, 'ok');
    const statement = '회의 자료는 표로 정리해 주세요.';
    for (let index = 0; index < 3; index += 1) {
      const result = runtime.growthRuntime.recordFeedback({
        taskId: `meeting-${index}`, feedbackType: 'approval_edited', text: statement
      });
      assert.equal(result.success, true);
      assert.equal(result.stored, true);
    }
    const candidate = runtime.growthRuntime.query('회의').find((item) => item.hypothesisId);
    assert.ok(candidate, 'repeated feedback produces a preference candidate');
    const confirmed = runtime.growthRuntime.decidePreference({ hypothesisId: candidate.hypothesisId, decision: 'confirm' });
    assert.equal(confirmed.success, true);
    const expectedPreference = runtime.growthRuntime.planningPreferenceContext('회의 준비').confirmedPreferenceHints;
    assert.equal(expectedPreference.length, 1);
    assert.equal(runtime.growthRuntime.storageStatus().counts.memoryEvents, 3);
    const store = runtime.growthRuntime.memoryStore;
    await runtime.close();
    await runtime.close();
    assert.throws(() => store.integrityCheck(), /not open|closed/iu);
    runtime = await createConfiguredCoreServiceRuntime({ env });
    assert.equal(runtime.growthRuntime.storageStatus().counts.memoryEvents, 3);
    assert.equal(runtime.growthRuntime.storageStatus().counts.confirmedPreferences, 1);
    assert.deepEqual(runtime.growthRuntime.planningPreferenceContext('회의 준비').confirmedPreferenceHints, expectedPreference);
    assert.ok(runtime.coreFacade.memoryStore.query('회의').some((item) => item.memoryType === 'confirmed_preference'));
    // A restarted process must still recognize the same user event as a duplicate.
    assert.equal(runtime.growthRuntime.recordFeedback({
      taskId: 'meeting-0', feedbackType: 'approval_edited', text: statement
    }).stored, false);
    assert.equal(runtime.growthRuntime.storageStatus().counts.memoryEvents, 3);
  } finally {
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Closing the HTTP server releases growth storage after an in-flight worker finishes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-core-growth-close-'));
  let runtime;
  try {
    runtime = await createConfiguredCoreServiceRuntime({ env: isolatedEnv(root) });
    runtime.server.listen(0, '127.0.0.1');
    await once(runtime.server, 'listening');
    runtime.workerDaemon.draining = true;
    const workerFinished = new Promise((resolveWorker, rejectWorker) => setTimeout(() => {
      try {
        const result = runtime.growthRuntime.recordFeedback({ taskId: 'in-flight', feedbackType: 'result_good', text: '정리 완료' });
        assert.equal(result.stored, true);
        resolveWorker();
      } catch (error) { rejectWorker(error); }
      finally { runtime.workerDaemon.draining = false; }
    }, 35));
    await new Promise((resolveClose) => runtime.server.close(resolveClose));
    await Promise.all([workerFinished, runtime.close()]);
    assert.throws(() => runtime.growthRuntime.memoryStore.integrityCheck(), /not open|closed/iu);
    assert.throws(() => runtime.personalOperations.store.db.prepare('SELECT 1'), /not open|closed/iu);
  } finally {
    if (runtime) runtime.workerDaemon.draining = false;
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('An unavailable growth database blocks startup instead of silently discarding future memories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-core-growth-unavailable-'));
  try {
    await assert.rejects(createConfiguredCoreServiceRuntime({
      env: isolatedEnv(root, { JARVIS_CORE_GROWTH_DB: root })
    }), /unable to open database|cannot open|SQLITE_CANTOPEN/iu);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
