import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrowthRuntime } from '../apps/growth-memory/src/growth-runtime.js';
import { SqliteMemoryStore } from '../apps/growth-memory/src/db/sqlite-store.js';
import { CoreWorkerDaemon } from '../packages/core/src/runtime/core-worker-daemon.js';
const settled = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, count = 1) {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-core-retraction-'));
  const store = new SqliteMemoryStore({ dbPath: join(root, 'memory.sqlite'), reviewDir: join(root, 'reviews'), backupDir: join(root, 'backups') });
  const runtime = new GrowthRuntime({ memoryStore: store, auditRoot: root });
  for (let i=0; i<count; i++) runtime.ingest({ eventId: `source-${i}`, taskId: `task-${i}`, eventType: 'task.created',
    source: { module: 'CORE', memoryScope: { userId: 'synthetic-owner', workspaceRoot: root, conversationId: null } },
    payload: { rawText: '합성 자료' }, learningFlags: { canBeUsedForWorkflow: true }, trustBoundary: { userProvided: true } });
  for (let i=0; i<count; i++) store.saveHygieneDecision({ decisionId: `delete-${i}`, targetType: 'memory_event', targetId: `source-${i}`, action: 'delete', decidedAt: '2026-10-03T00:00:00Z' });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { runtime, store };
}
function worker(runtime) { return { growthRuntime: runtime, queueStatus: () => ({ total:0,
  persistence:{enabled:true}, leases:{activeLeaseCount:0,persistence:{enabled:true}} }), drain: async()=>({processed:0}) }; }

test('idle Core timer retries rejected source withdrawal without a new user query', async t => {
  const {runtime}=fixture(t); let calls=0;
  runtime.setSourceRetractionHandler(()=> ++calls===1 ? Promise.reject(new Error('PRIVATE_REASON')) : Promise.resolve({revoked:true}));
  await settled();
  const daemon=new CoreWorkerDaemon({worker:worker(runtime),intervalMs:20,sourceRetractionIntervalMs:100});
  t.after(()=>daemon.stop()); daemon.start();
  const deadline=Date.now()+2000;
  while(runtime.deliveredSourceRetractions.size!==1 && Date.now()<deadline) await new Promise(r=>setTimeout(r,20));
  assert.equal(runtime.deliveredSourceRetractions.size,1); assert.equal(calls,2);
  await new Promise(r=>setTimeout(r,150));
  assert.equal(daemon.lastSourceRetractionSync.pendingCount,0);
  assert.equal(daemon.processedTotal,0);
  const telemetry=JSON.stringify(daemon.status());
  assert.equal(telemetry.includes('source-0'),false); assert.equal(telemetry.includes('PRIVATE_REASON'),false);
  daemon.stop();
});

test('Core bounds retry dispatch at ten and rotates past repeatedly failing entries', async t => {
  const {runtime}=fixture(t,11); let called=[];
  runtime.setSourceRetractionHandler(({sourceEventId})=>{called.push(sourceEventId);return {revoked:false};});
  called=[]; let now=0;
  const daemon=new CoreWorkerDaemon({worker:worker(runtime),clock:()=>new Date(now)});
  await daemon.tick(); assert.equal(called.length,10); assert.equal(daemon.lastSourceRetractionSync.deferredCount,1);
  const first=new Set(called); const missing=Array.from({length:11},(_,i)=>`source-${i}`).find(id=>!first.has(id));
  called=[]; now=5000; await daemon.tick(); assert.equal(called.length,10); assert.ok(called.includes(missing));
  assert.equal(daemon.lastSourceRetractionSync.pendingCount,11);
  assert.equal(daemon.lastWatchdog.checks.find(c=>c.id==='source-retraction-retry').status,'warning');
});

test('pending async dispatch is not repeated by scheduled retries and interval throttles synchronization', async t => {
  const {runtime}=fixture(t);let calls=0,resolve,now=0,syncs=0;
  runtime.setSourceRetractionHandler(()=>{calls++;return new Promise(r=>resolve=r);});
  const original=runtime.synchronizeSourceRetractions.bind(runtime);
  runtime.synchronizeSourceRetractions=(options)=>{syncs++;return original(options);};
  const daemon=new CoreWorkerDaemon({worker:worker(runtime),clock:()=>new Date(now)});
  await daemon.tick(); now=1000; await daemon.tick(); assert.equal(syncs,1);
  now=5000; await daemon.tick(); assert.equal(syncs,2); assert.equal(calls,1);
  assert.equal(daemon.lastSourceRetractionSync.pendingCount,1);
  resolve({revoked:true});await settled(); now=10000;await daemon.tick();
  assert.equal(daemon.lastSourceRetractionSync.pendingCount,0);assert.equal(calls,1);
});

test('source synchronization outage is sanitized and does not stop unrelated Core tasks', async()=>{
  let drains=0;
  const daemon=new CoreWorkerDaemon({worker:{...worker({synchronizeSourceRetractions(){throw new Error('PRIVATE_PAYLOAD');}}),
    drain:async()=>{drains++;return {processed:1};}}});
  const result=await daemon.tick();assert.equal(result.success,true);assert.equal(drains,1);
  assert.equal(daemon.lastSourceRetractionSync.success,false);assert.equal(daemon.lastSourceRetractionSync.pendingCount,null);
  assert.equal(JSON.stringify(daemon.status()).includes('PRIVATE_PAYLOAD'),false);
});

test('invalid delivery bounds mutate nothing and disabled or overlapping ticks do not retry', async t=>{
  const {runtime}=fixture(t);let calls=0;
  runtime.setSourceRetractionHandler(()=>{calls++;return {revoked:false};}); const before=calls;
  assert.throws(()=>runtime.synchronizeSourceRetractions({deliveryLimit:0}),RangeError);assert.equal(calls,before);
  const daemon=new CoreWorkerDaemon({worker:worker(runtime),enabled:false});await daemon.tick();assert.equal(calls,before);
  daemon.enabled=true;daemon.draining=true;await daemon.tick();assert.equal(calls,before);
  assert.throws(()=>new CoreWorkerDaemon({worker:worker(runtime),sourceRetractionIntervalMs:0}),RangeError);
});


test('missing projection is explicit and preference update failure remains a warning', async t => {
  const {runtime}=fixture(t);
  const daemon=new CoreWorkerDaemon({worker:worker(runtime)});
  await daemon.tick();assert.equal(daemon.lastSourceRetractionSync.projectionConfigured,false);
  const failing=new CoreWorkerDaemon({worker:worker({synchronizeSourceRetractions:()=>({
    deliveries:[], dispatchedCount:0, deferredDeliveryCount:0, preferenceUpdateFailedCount:1, projectionConfigured:true
  })})});
  await failing.tick();
  assert.equal(failing.lastWatchdog.checks.find(c=>c.id==='source-retraction-retry').status,'warning');
  assert.equal(failing.lastSourceRetractionSync.preferenceUpdateFailedCount,1);
});
