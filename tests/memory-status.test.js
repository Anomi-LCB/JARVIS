import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrowthRuntime } from '../apps/growth-memory/src/growth-runtime.js';
import { SqliteMemoryStore } from '../apps/growth-memory/src/db/sqlite-store.js';
import { CoreFacade } from '../packages/core/src/core-facade.js';
import { createCoreServer, createCoreOpenApiSpec } from '../packages/core/src/main.mjs';
import { createMemoryStatusPanel } from '../src/ui/memory-status.js';

test('actual Core status is admin-only, counts-only, never drains and fails closed on storage error', async t => {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-memory-status-'));
  const store = new SqliteMemoryStore({ dbPath: join(root, 'memory.sqlite'), reviewDir: join(root, 'reviews'), backupDir: join(root, 'backups') });
  const growth = new GrowthRuntime({ memoryStore: store, auditRoot: root });
  store.queueMemoryEvent({ eventId: 'synthetic-private-id', payload: { rawText: 'SYNTHETIC_PRIVATE_CONTENT' } });
  let drains = 0; growth.drainPendingMemory = () => { drains++; };
  const daemon = { timer: {}, lastMemoryReplay: { success: true, stored: 0, failed: 1, suppressed: 0, pendingCount: 1, at: '2026-10-03T00:00:00Z', rawText: 'SYNTHETIC_PRIVATE_REPLAY' } };
  const server = createCoreServer(new CoreFacade({ memoryStore: growth, workspaceRoot: root }), {
    adminToken: 'synthetic-admin', adminTokens: [{ token: 'synthetic-reader', scopes: ['read_diagnostics'] }], workerDaemon: daemon
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(root, { recursive: true, force: true }); });
  const call = (token = 'synthetic-admin', method = 'GET') => fetch(`http://127.0.0.1:${server.address().port}/memory/status`, { method, headers: { authorization: `Bearer ${token}` } });
  assert.equal((await call('wrong')).status, 401);
  assert.equal((await call('synthetic-reader')).status, 403);
  const result = await (await call()).json();
  assert.equal(result.status, 'pending'); assert.equal(result.pending.pendingCount, 1);
  assert.equal(result.worker.lastReplay.failed, 1); assert.equal(result.executionAuthority, false);
  assert.equal(JSON.stringify(result).includes('SYNTHETIC_PRIVATE'), false);
  assert.equal(JSON.stringify(result).includes('synthetic-private-id'), false);
  assert.equal(drains, 0);
  assert.equal((await call('synthetic-admin', 'POST')).status, 405);
  store.pendingMemoryStatus = () => { throw new Error('PRIVATE_STORAGE_ERROR'); };
  const failed = await call(); assert.equal(failed.status, 503);
  assert.equal((await failed.json()).error.code, 'F_MEMORY_STATUS_UNAVAILABLE');
});

test('panel distinguishes pending, missing storage, stopped worker and unavailable status', async () => {
  let value = { success: true, status: 'pending', observedAt: '2026-10-03', pending: { pendingCount: 2, replayAttempts: 3 }, worker: { running: false, lastReplay: { success: false, stored: null, suppressed: null, failed: null } } };
  const panel = createMemoryStatusPanel({ canManage: () => true, request: async () => { if (!value) throw new Error('private'); return value; } });
  await panel.refresh(); assert.match(panel.render(), /아직 저장하지 못한 기억/); assert.match(panel.render(), /실패 미확인/);
  value = null; await panel.refresh(); assert.match(panel.render(), /상태를 확인할 수 없습니다/); assert.doesNotMatch(panel.render(), /저장 대기: 0건/);
  value = { success: true, status: 'not_configured', pending: { pendingCount: null, replayAttempts: null }, worker: {} };
  await panel.refresh(); assert.match(panel.render(), /기억 저장 연결 필요/); assert.match(panel.render(), /저장 대기: 미확인/);
  const denied = createMemoryStatusPanel({ request: () => { throw new Error('must not request'); } });
  await denied.refresh(); assert.match(denied.render(), /관리자 연결 후/);
});

test('open-panel polling does not restart or fetch on rerendered same-state toggle and stops on close', async () => {
  let listeners = {}, calls = 0, scheduled = 0, cleared = 0;
  const panel = createMemoryStatusPanel({ canManage: () => true, request: async () => { calls++; return { success: true, status: 'ready', pending: { pendingCount: 0, replayAttempts: 0 }, worker: {} }; },
    setTimer: () => { scheduled++; return 1; }, clearTimer: () => { cleared++; } });
  panel.attach({ addEventListener: (name, fn) => { listeners[name] = fn; } });
  const target = { matches: () => true, open: true };
  listeners.toggle({ target }); await new Promise(resolve => setImmediate(resolve));
  listeners.toggle({ target }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1); assert.equal(scheduled, 1);
  target.open = false; listeners.toggle({ target }); assert.equal(cleared, 1);
});

test('status contract and production memory screen are wired', () => {
  assert.ok(createCoreOpenApiSpec().paths['/memory/status'].get.responses[503]);
  const source = readFileSync(new URL('../src/ui/app.js', import.meta.url), 'utf8');
  assert.ok(source.includes('${memoryStatusPanel.render()}'));
  assert.ok(source.includes('memoryStatusPanel.attach(app)'));
});
