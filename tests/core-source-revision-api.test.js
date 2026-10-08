import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCoreServiceRuntime } from '../scripts/core-service-runtime.mjs';
import { createCoreServer } from '../packages/core/src/main.mjs';

test('explicit source-revision dispatch binds the exact current hash to a read-only bounded Mission', async t => {
  const sourceSha256 = 'b'.repeat(64);
  const source = { sourceKey: 'briefing', sourcePath: 'C:\\workspace\\briefing.md', revision: 7, sourceSha256 };
  let createdInput;
  let runCall;
  const missionRuntime = {
    createMission(input) { createdInput = input; return { missionId: 'mission-test-1', status: 'CREATED' }; },
    async runMission(id, options) { runCall = { id, options }; return { missionId: id, status: 'BLOCKED' }; }
  };
  const server = createCoreServer(undefined, { adminToken: 'local-core-admin', missionRuntime,
    sourceRevisionInbox: { get: () => source }, sourceRevisionWatcher: { async reconcileCurrent() { return { changed: false }; } } });
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/source-revisions/briefing/mission`, {
    method: 'POST', headers: { authorization: 'Bearer local-core-admin', 'content-type': 'application/json' },
    body: JSON.stringify({ revision: 7, sourceSha256, objective: '논지를 세 문장으로 요약해줘' })
  });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.missionId, 'mission-test-1');
  assert.match(createdInput.objective, /기대 SHA-256: b{64}/u);
  assert.deepEqual(createdInput.authorization.grants, ['read_only']);
  assert.equal(createdInput.budgets.maxWaves, 1);
  assert.equal(createdInput.budgets.maxPlannerCalls, 2);
  assert.equal(createdInput.metadata.sourceRevision.revision, 7);
  assert.deepEqual(runCall, { id: 'mission-test-1', options: { maxWaves: 1 } });
});

test('source revision changed while the Mission ran cannot be reported as a current result', async t => {
  let source = { sourceKey: 'briefing', sourcePath: 'C:\\workspace\\briefing.md', revision: 3, sourceSha256: 'c'.repeat(64) };
  const missionRuntime = {
    createMission() { return { missionId: 'mission-test-race', status: 'CREATED' }; },
    async runMission() { source = { ...source, revision: 4, sourceSha256: 'd'.repeat(64) }; return { status: 'COMPLETED' }; }
  };
  const server = createCoreServer(undefined, { adminToken: 'local-core-admin', missionRuntime,
    sourceRevisionInbox: { get: () => source }, sourceRevisionWatcher: { async reconcileCurrent() { return { changed: false }; } } });
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/source-revisions/briefing/mission`, {
    method: 'POST', headers: { authorization: 'Bearer local-core-admin', 'content-type': 'application/json' },
    body: JSON.stringify({ revision: 3, sourceSha256: 'c'.repeat(64), objective: '요약해줘' })
  });
  const payload = await response.json();
  assert.equal(response.status, 409);
  assert.equal(payload.error.code, 'A_SOURCE_REVISION_CHANGED_DURING_MISSION');
  assert.equal(payload.missionStatus, 'COMPLETED');
  assert.equal(payload.current.revision, 4);
});

test('Core API registers a scoped file watch, persists revisions, restores it after restart, and removes it', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-source-revision-api-'));
  const allowed = join(root, 'workspace');
  const dbPath = join(root, 'personal.sqlite');
  const sourcePath = join(allowed, 'briefing.txt');
  await mkdir(allowed, { recursive: true });
  await writeFile(sourcePath, 'first version', 'utf8');
  const env = {
    ...process.env,
    JARVIS_TEST_MODE: '1',
    JARVIS_CORE_ROOT: root,
    JARVIS_CORE_ALLOWED_ROOTS: 'workspace',
    JARVIS_PERSONAL_OPERATIONS_DB: dbPath,
    JARVIS_CORE_HOST: '127.0.0.1',
    JARVIS_CORE_PORT: '0',
    JARVIS_CORE_WORKER_DAEMON_ENABLED: '0',
    JARVIS_CORE_WORKER_DAEMON_AUTOSTART: '0',
    JARVIS_PERSONAL_IMPORT_ENABLED: '0',
    JARVIS_GOOGLE_SYNC_ENABLED: '0'
  };
  let runtime;
  t.after(async () => { if (runtime) await runtime.close(); await rm(root, { recursive: true, force: true }); });
  runtime = await startCoreServiceRuntime({ env });
  const base = runtime.baseUrl;
  const request = (path, init = {}) => fetch(`${base}${path}`, { ...init, headers: { authorization: 'Bearer local-core-admin', ...(init.headers ?? {}) } });
  const registered = await request('/source-revisions/watch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceKey: 'briefing', sourcePath, quietPeriodMs: 100 }) });
  assert.equal(registered.status, 201);
  assert.equal((await registered.json()).status, 'watching');
  await writeFile(sourcePath, 'second version', 'utf8');
  let observed;
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const response = await request('/source-revisions');
    observed = await response.json();
    if (observed.items?.length) break;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.equal(observed.items?.length, 1);
  assert.equal(observed.items[0].sourceKey, 'briefing');
  assert.equal(observed.items[0].revision, 1);
  assert.equal('contents' in observed.items[0], false);
  await writeFile(sourcePath, 'third version', 'utf8');
  const staleMission = await request('/source-revisions/briefing/mission', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ revision: 1, sourceSha256: observed.items[0].sourceSha256, objective: '요약해줘' }) });
  assert.equal(staleMission.status, 409);
  assert.equal((await staleMission.json()).error.code, 'A_SOURCE_REVISION_STALE');
  assert.equal(runtime.missionRuntime.listMissions().items.length, 0, 'stale input must not create or run a Mission');
  await runtime.close();
  runtime = null;
  runtime = await startCoreServiceRuntime({ env });
  const restored = await (async () => { const response = await fetch(`${runtime.baseUrl}/source-revisions`, { headers: { authorization: 'Bearer local-core-admin' } }); return response.json(); })();
  assert.equal(restored.watcher.registrations.length, 1);
  assert.equal(restored.watcher.registrations[0].sourceKey, 'briefing');
  const removed = await fetch(`${runtime.baseUrl}/source-revisions/watch/briefing`, { method: 'DELETE', headers: { authorization: 'Bearer local-core-admin' } });
  assert.equal(removed.status, 200);
  const final = await (async () => { const response = await fetch(`${runtime.baseUrl}/source-revisions`, { headers: { authorization: 'Bearer local-core-admin' } }); return response.json(); })();
  assert.equal(final.watches[0].active, false);
});
