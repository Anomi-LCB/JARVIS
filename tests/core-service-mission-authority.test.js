import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfiguredCoreServiceRuntime, coreServiceRuntimeOptionsFromEnv } from '../scripts/core-service-runtime.mjs';
import { PersonalOperationsStore } from '../packages/core/src/personal-operations/operations-store.js';
import { SqliteMissionStore } from '../packages/core/src/mission/sqlite-mission-store.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-service-authority-')), runtimes = [];
  const env = { JARVIS_TEST_MODE: '1', JARVIS_CORE_ROOT: root, JARVIS_TEST_AUDIT_ROOT: join(root, 'audit'),
    JARVIS_CORE_PORT: '0', JARVIS_CORE_ALLOWED_ROOTS: 'workspace', JARVIS_CORE_WORKER_DAEMON_ENABLED: '0',
    JARVIS_CORE_WORKER_DAEMON_AUTOSTART: '0', JARVIS_PERSONAL_IMPORT_ENABLED: '0', JARVIS_GOOGLE_SYNC_ENABLED: '0',
    JARVIS_PERSONAL_OPERATIONS_DB: join(root, 'operations.sqlite'), JARVIS_CORE_MISSION_STORE_BACKEND: 'sqlite',
    JARVIS_CORE_MISSION_AUTHORITY_ENABLED: '1', JARVIS_CORE_MISSION_AUTHORITY_EXPECTED_TOKEN: '0' };
  const open = async overrides => { const runtime = await createConfiguredCoreServiceRuntime({ env: { ...env, ...overrides } }); runtimes.push(runtime); return runtime; };
  t.after(async () => { for (const runtime of runtimes) await runtime.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, env, open };
}

test('service authority configuration requires SQLite and an explicit valid prior token', () => {
  const env = { JARVIS_CORE_MISSION_AUTHORITY_ENABLED: '1', JARVIS_CORE_MISSION_STORE_BACKEND: 'sqlite' };
  assert.throws(() => coreServiceRuntimeOptionsFromEnv({ env }), /EXPECTED_TOKEN_REQUIRED/);
  for (const token of ['-1', 'NaN', '1.5', '9007199254740992']) assert.throws(() => coreServiceRuntimeOptionsFromEnv({ env: { ...env, JARVIS_CORE_MISSION_AUTHORITY_EXPECTED_TOKEN: token } }), /EXPECTED_TOKEN_REQUIRED/);
  assert.throws(() => coreServiceRuntimeOptionsFromEnv({ env: { ...env, JARVIS_CORE_MISSION_STORE_BACKEND: 'file' } }), /SQLITE_REQUIRED/);
  assert.throws(() => coreServiceRuntimeOptionsFromEnv({ env: { ...env, JARVIS_CORE_MISSION_AUTHORITY_EXPECTED_TOKEN: '0', JARVIS_CORE_MISSION_AUTHORITY_TTL_MS: 'garbage' } }), /TTL_INVALID/);
  assert.equal(coreServiceRuntimeOptionsFromEnv({ env: {} }).missionAuthorityEnabled, false);
});

test('recovery-only service requires an explicit flag, enabled authority and a disabled worker daemon',()=>{
 const env={JARVIS_CORE_MISSION_AUTHORITY_ENABLED:'1',JARVIS_CORE_MISSION_STORE_BACKEND:'sqlite',JARVIS_CORE_MISSION_AUTHORITY_EXPECTED_TOKEN:'0',JARVIS_CORE_MISSION_AUTHORITY_RECOVERY_ONLY:'1',JARVIS_CORE_WORKER_DAEMON_ENABLED:'0'};
 assert.equal(coreServiceRuntimeOptionsFromEnv({env}).missionAuthorityRecoveryOnly,true);
 for(const flag of ['true','',2])assert.throws(()=>coreServiceRuntimeOptionsFromEnv({env:{...env,JARVIS_CORE_MISSION_AUTHORITY_RECOVERY_ONLY:flag}}),/RECOVERY_INVALID/);
 assert.throws(()=>coreServiceRuntimeOptionsFromEnv({env:{...env,JARVIS_CORE_MISSION_AUTHORITY_ENABLED:'0'}}),/RECOVERY_CONFIGURATION_REQUIRED/);
 assert.throws(()=>coreServiceRuntimeOptionsFromEnv({env:{...env,JARVIS_CORE_WORKER_DAEMON_ENABLED:'1'}}),/RECOVERY_CONFIGURATION_REQUIRED/);
});

test('service claims before hydrate, rejects a second owner, and explicitly releases on shutdown', async t => {
  const f = fixture(t), first = await f.open(), token = first.missionExecutionAuthority.lease.token;
  assert.equal(token, 1); first.missionExecutionAuthority.assertActive();
  const before = first.missionRuntime.store.metadata().revision;
  await assert.rejects(f.open({ JARVIS_CORE_MISSION_AUTHORITY_EXPECTED_TOKEN: String(token) }), /ANOTHER_CORE_ACTIVE/);
  assert.equal(first.missionRuntime.store.metadata().revision, before, 'denied service cannot hydrate or save Mission state');
  await first.close();
  await assert.rejects(f.open(), /REVISION_CONFLICT/);
  const next = await f.open({ JARVIS_CORE_MISSION_AUTHORITY_EXPECTED_TOKEN: String(token) });
  assert.equal(next.missionExecutionAuthority.lease.token, 2);
});

test('failed bootstrap releases a quiescent claim so the explicit next revision can start', async t => {
  const f = fixture(t), legacy = join(f.root, 'invalid-missions.json');
  writeFileSync(legacy, '{bad-json');
  await assert.rejects(f.open({ JARVIS_CORE_MISSION_STORE: legacy }), /A_MISSION_STORE_CORRUPT/);
  const operations = new PersonalOperationsStore({ dbPath: f.env.JARVIS_PERSONAL_OPERATIONS_DB });
  try { const status = new SqliteMissionStore({ operationsStore: operations }).coreAuthorityStatus(); assert.equal(status.ownerId, null); assert.equal(status.token, 1); }
  finally { operations.close(); }
  const recovered = await f.open({ JARVIS_CORE_MISSION_AUTHORITY_EXPECTED_TOKEN: '1' });
  assert.equal(recovered.missionExecutionAuthority.lease.token, 2);
});

test('enrolled native service failed bootstrap can restart with unchanged initial token',async t=>{
 const f=fixture(t),legacy=join(f.root,'invalid-service-missions.json');writeFileSync(legacy,'{bad-json');
 const service={JARVIS_WINDOWS_SERVICE:'1',JARVIS_CORE_SERVICE_STDIN_SHUTDOWN:'1',JARVIS_CORE_MISSION_AUTHORITY_SERVICE_ID:'service:11111111-1111-4111-8111-111111111111'};
 await assert.rejects(f.open({...service,JARVIS_CORE_MISSION_STORE:legacy}),/A_MISSION_STORE_CORRUPT/);
 const recovered=await f.open(service);assert.equal(recovered.missionExecutionAuthority.lease.token,2);
 recovered.missionExecutionAuthority.assertActive();
});
