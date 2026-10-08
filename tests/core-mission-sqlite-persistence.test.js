import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfiguredCoreServiceRuntime, coreServiceRuntimeOptionsFromEnv } from '../scripts/core-service-runtime.mjs';

const environment = root => ({ JARVIS_TEST_MODE: '1', JARVIS_TEST_AUDIT_ROOT: root,
  JARVIS_CORE_ALLOWED_ROOTS: join(root, 'workspace'), JARVIS_CORE_ADMIN_TOKEN: 'sqlite-service-test',
  JARVIS_CORE_WORKER_DAEMON_ENABLED: '0', JARVIS_CORE_WORKER_DAEMON_AUTOSTART: '0',
  JARVIS_PERSONAL_IMPORT_ENABLED: '0', JARVIS_GOOGLE_SYNC_ENABLED: '0' });

test('configured Core opts into the existing operations DB, preserves original JSON and keeps later SQL missions on restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-core-mission-sqlite-'));
  const env = environment(root);
  let runtime;
  try {
    runtime = await createConfiguredCoreServiceRuntime({ env });
    assert.equal(runtime.options.missionStoreBackend, 'file');
    const first = runtime.missionRuntime.createMission({ objective: '자료 목록 확인', successCriteria: ['파일 목록 확인'] });
    const legacyPath = runtime.options.missionStorePath;
    const originalBytes = await readFile(legacyPath);
    runtime.growthRuntime.recordFeedback({ taskId: 'preserved-feedback', feedbackType: 'result_good', text: '검증된 원본 보존' });
    const memoryCount = runtime.growthRuntime.storageStatus().counts.memoryEvents;
    const identity = runtime.coreFacade.cognitiveStatus().identity.id;
    await runtime.close();
    const sqliteEnv = { ...env, JARVIS_CORE_MISSION_STORE_BACKEND: 'sqlite' };
    runtime = await createConfiguredCoreServiceRuntime({ env: sqliteEnv });
    const store = runtime.missionRuntime.store;
    assert.equal(store.db, runtime.personalOperations.store.db);
    assert.equal(store.metadata().storeVersion, 'a-mission-sqlite-store-v1');
    assert.equal(runtime.missionRuntime.getMission(first.missionId).objective, first.objective);
    const second = runtime.missionRuntime.createMission({ objective: '두 번째 자료 목록 확인', successCriteria: ['파일 목록 확인'] });
    await runtime.close();
    runtime = await createConfiguredCoreServiceRuntime({ env: sqliteEnv });
    assert.equal(runtime.missionRuntime.getMission(first.missionId).objective, first.objective);
    assert.equal(runtime.missionRuntime.getMission(second.missionId).objective, second.objective);
    assert.deepEqual(await readFile(legacyPath), originalBytes);
    assert.equal(runtime.growthRuntime.storageStatus().counts.memoryEvents, memoryCount);
    assert.equal(runtime.coreFacade.cognitiveStatus().identity.id, identity);
    assert.equal(runtime.missionRuntime.store.pendingEffects().length, 0,
      'snapshot storage adoption does not claim effects are automatically dispatched through the new outbox');
  } finally {
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('unknown storage backend cannot silently fall back and lose durable mission state', () => {
  assert.throws(() => coreServiceRuntimeOptionsFromEnv({ env: { ...environment(tmpdir()), JARVIS_CORE_MISSION_STORE_BACKEND: 'sqllite' } }),
    { code: 'A_MISSION_STORE_BACKEND_INVALID' });
});
