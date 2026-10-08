import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PersonalOperationsStore } from '../packages/core/src/personal-operations/operations-store.js';
import { SqliteSourceRevisionInbox, SourceRevisionScheduler } from '../packages/core/src/runtime/source-revision-inbox.js';
import { CoreWorkerDaemon } from '../packages/core/src/runtime/core-worker-daemon.js';
import { LocalWorkflowToolAdapter } from '../apps/pc-agent/src/adapters/workflow/local-workflow-adapter.js';

const hash = value => createHash('sha256').update(value).digest('hex');
async function withStore(run) {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-source-revision-'));
  let now = new Date('2026-09-30T00:00:00.000Z');
  let operations = new PersonalOperationsStore({ dbPath: join(root, 'operations.sqlite'), clock: () => now });
  const store = new SqliteSourceRevisionInbox({ operationsStore: operations, clock: () => now });
  const env = { root, get now() { return now; }, set now(value) { now = new Date(value); }, get operations() { return operations; }, set operations(value) { operations = value; }, store };
  try { return await run(env); } finally { try { operations.close(); } catch {} rmSync(root, { recursive: true, force: true }); }
}
const event = (id, body, observedAt = '2026-09-30T00:00:00.000Z') => ({ sourceKey: 'research-report', eventId: id,
  sourcePath: 'C:/workspace/source.json', sourceSha256: hash(body), observedAt, quietPeriodMs: 100 });

test('SQLite inbox coalesces duplicate file notifications by identity and unchanged content', () => withStore(({ store, now }) => {
  const first = store.ingest(event('e1', 'rev-1'));
  const duplicate = store.ingest(event('e1', 'rev-1'));
  const sameBytesNewEvent = store.ingest(event('e2', 'rev-1'));
  const latest = store.ingest(event('e3', 'rev-2'));
  assert.equal(first.current.revision, 1);
  assert.equal(duplicate.reason, 'event-already-seen');
  assert.equal(sameBytesNewEvent.reason, 'content-unchanged');
  assert.equal(latest.current.revision, 2);
  assert.equal(store.due(now.toISOString()).length, 0);
  now.setTime(Date.parse('2026-09-30T00:00:00.101Z'));
  assert.equal(store.due(now.toISOString())[0].sourceSha256, hash('rev-2'));
}));

test('older reversed notifications cannot replace the latest revision and a newer event fences an active claim', async () => withStore(async ({ store, now }) => {
  store.ingest(event('e1', 'rev-1', '2026-09-30T00:00:00.000Z'));
  store.ingest(event('e2', 'rev-2', '2026-09-30T00:00:00.050Z'));
  const stale = store.ingest(event('e0', 'rev-0', '2026-09-29T23:59:59.000Z'));
  assert.equal(stale.reason, 'stale-event-time');
  now.setTime(Date.parse('2026-09-30T00:00:00.151Z'));
  const seen = [];
  const scheduler = new SourceRevisionScheduler({ store, clock: () => now, ownerId: 'worker-a', async processRevision(item) {
    seen.push({ revision: item.claimRevision, sha256: item.sourceSha256 });
    if (item.claimRevision === 2) store.ingest(event('e3', 'rev-3', '2026-09-30T00:00:00.200Z'));
  } });
  const first = await scheduler.tick();
  assert.equal(first.results[0].status, 'superseded');
  assert.equal(store.get('research-report').state, 'pending');
  now.setTime(Date.parse('2026-09-30T00:00:00.301Z'));
  const second = await scheduler.tick();
  assert.equal(second.results[0].revision, 3);
  assert.equal(second.results[0].status, 'completed');
  assert.deepEqual(seen.map(item => item.sha256), [hash('rev-2'), hash('rev-3')]);
  assert.equal(store.get('research-report').completedRevision, 3);
}));

test('expired SQLite claims recover after reopening and retain single-owner lease fencing', () => withStore(async env => {
  const { root, store, now } = env;
  store.ingest(event('e1', 'rev-1'));
  now.setTime(Date.parse('2026-09-30T00:00:00.101Z'));
  const firstClaim = store.claim('research-report', { ownerId: 'worker-old', nowIso: now.toISOString(), leaseMs: 1_000 });
  assert.equal(firstClaim.claimRevision, 1);
  env.operations.close();
  env.operations = new PersonalOperationsStore({ dbPath: join(root, 'operations.sqlite'), clock: () => now });
  const reopened = new SqliteSourceRevisionInbox({ operationsStore: env.operations, clock: () => now });
  assert.equal(reopened.claim('research-report', { ownerId: 'worker-new', nowIso: now.toISOString(), leaseMs: 1_000 }), null);
  now.setTime(Date.parse('2026-09-30T00:00:01.102Z'));
  const recovered = reopened.claim('research-report', { ownerId: 'worker-new', nowIso: now.toISOString(), leaseMs: 1_000 });
  assert.equal(recovered.claimOwner, 'worker-new');
  assert.equal(recovered.attempts, 2);
  assert.equal(reopened.settle('research-report', { ownerId: 'worker-old', claimRevision: 1, nowIso: now.toISOString() }).settled, false);
}));

test('an active worker can renew its lease while a second worker is prevented from claiming it', () => withStore(({ store, now }) => {
  store.ingest(event('e1', 'rev-1'));
  now.setTime(Date.parse('2026-09-30T00:00:00.101Z'));
  const claim = store.claim('research-report', { ownerId: 'worker-old', nowIso: now.toISOString(), leaseMs: 1_000 });
  now.setTime(Date.parse('2026-09-30T00:00:00.900Z'));
  assert.equal(store.renewClaim('research-report', { ownerId: 'worker-old', claimRevision: 1, nowIso: now.toISOString(), leaseMs: 1_000 }), true);
  now.setTime(Date.parse('2026-09-30T00:00:01.101Z'));
  assert.equal(store.claim('research-report', { ownerId: 'worker-new', nowIso: now.toISOString(), leaseMs: 1_000 }), null);
  assert.equal(store.get('research-report').claimOwner, 'worker-old');
}));

test('Core worker daemon ticks the injected durable latest-revision scheduler', async () => {
  let now = new Date('2026-09-30T00:00:00.101Z');
  let executions = 0;
  const scheduler = { async tick() { executions += 1; return { success: true, processed: 0, results: [] }; }, status() { return { durable: true }; } };
  const worker = { queueStatus: () => ({ total: 0, leases: { activeLeaseCount: 0 } }), async drain() { return { processed: 0 }; }, recoverExpiredLeases() { return { recoveredCount: 0 }; } };
  const daemon = new CoreWorkerDaemon({ worker, sourceRevisionScheduler: scheduler, clock: () => now, recoverLeases: false });
  const tick = await daemon.tick();
  assert.equal(tick.success, true);
  assert.equal(executions, 1);
  assert.equal(daemon.status().sourceRevisionScheduler.durable, true);
});

test('coalesced source revisions rerun after a stale workflow is compensated and publish only the latest report', async () => withStore(async ({ root, store, now }) => {
  const workspace = join(root, 'workspace'); await mkdir(workspace, { recursive: true });
  const sourcePath = join(workspace, 'source.json'); const outputPath = join(workspace, 'report.json');
  const putSource = async revision => { const bytes = JSON.stringify({ revision, headline: `headline-${revision}` }); await writeFile(sourcePath, bytes, 'utf8'); return bytes; };
  const workflow = revision => ({ schemaVersion: 'jarvis-local-workflow-v1', workflowId: `source-report-${revision}`, nodes: [
    { id: 'read', op: 'data.readJson', args: { path: sourcePath } },
    { id: 'write', op: 'write.json', dependsOn: ['read'], args: { path: outputPath, value: { $ref: { nodeId: 'read', pointer: '/value' } } } }
  ] });
  const revision1 = await putSource(1);
  const eventResults = [store.ingest({ ...event('watch-1', revision1), sourcePath, quietPeriodMs: 100 })];
  eventResults.push(store.ingest({ ...event('watch-1', revision1), sourcePath, quietPeriodMs: 100 }));
  eventResults.push(store.ingest({ ...event('watch-stale', JSON.stringify({ revision: 0, headline: 'stale' }), '2026-09-29T23:59:59.000Z'), sourcePath, quietPeriodMs: 100 }));
  now.setTime(Date.parse('2026-09-30T00:00:00.101Z'));
  let raceInjected = false; const outcomes = [];
  class WatchRaceWorkflowAdapter extends LocalWorkflowToolAdapter {
    async executeNode(node, state, waveIndex) {
      const result = await super.executeNode(node, state, waveIndex);
      if (!raceInjected && node.op === 'data.readJson') {
        raceInjected = true;
        const revision2 = await putSource(2);
        eventResults.push(store.ingest({ ...event('watch-2', revision2, '2026-09-30T00:00:00.200Z'), sourcePath, quietPeriodMs: 100 }));
      }
      return result;
    }
  }
  const scheduler = new SourceRevisionScheduler({ store, clock: () => now, ownerId: 'source-worker', async processRevision(item) {
    const result = await new WatchRaceWorkflowAdapter({ allowedRoots: [workspace] }).execute({ spec: workflow(item.revision), allowOverwrite: true });
    outcomes.push({ revision: item.revision, status: result.status, error: result.error?.code ?? null,
      manifest: result.evidence?.manifest?.map(file => ({ path: file.path.endsWith('report.json') ? 'report.json' : 'unexpected', sha256: file.sha256, size: file.size })) ?? [] });
    if (result.status !== 'success') throw Object.assign(new Error(result.error?.code ?? result.status), { code: result.error?.code ?? 'WORKFLOW_FAILED' });
  } });
  const first = await scheduler.tick();
  assert.equal(first.results[0].status, 'superseded');
  await assert.rejects(readFile(outputPath), error => error.code === 'ENOENT');
  now.setTime(Date.parse('2026-09-30T00:00:00.301Z'));
  const second = await scheduler.tick();
  assert.equal(second.results[0].revision, 2);
  assert.equal(second.results[0].status, 'completed');
  const published = JSON.parse(await readFile(outputPath, 'utf8'));
  const source = JSON.parse(await readFile(sourcePath, 'utf8'));
  assert.deepEqual(published, source);
  assert.deepEqual(outcomes.map(item => item.status), ['failed', 'success']);
  assert.equal(store.get('research-report').completedRevision, 2);
  if (process.env.JARVIS_S03_EVIDENCE_PATH) {
    const sourceBytes = await readFile(sourcePath); const artifactBytes = await readFile(outputPath);
    const evidence = { schemaVersion: 1, scenarioId: 'S03', fixtureId: 's03-reversed-source-events-and-latest-report-v1', inputPath: 'source.json', outputPath: 'report.json',
      eventSequence: ['watch-1', 'watch-1', 'watch-stale', 'watch-2'],
      eventResults: eventResults.map(item => ({ accepted: item.accepted, duplicate: item.duplicate, reason: item.reason ?? null, revision: item.current?.revision ?? null })),
      firstDispatch: { revision: first.results[0].revision,
        status: first.results[0].status, settlement: first.results[0].settlement, outputAbsentAfterCompensation: true },
      finalDispatch: { revision: second.results[0].revision, status: second.results[0].status,
        completedRevision: store.get('research-report').completedRevision, manifest: outcomes.at(-1).manifest },
      attempts: outcomes, source: { sha256: hash(sourceBytes), byteLength: sourceBytes.length, base64: sourceBytes.toString('base64') },
      artifact: { sha256: hash(artifactBytes), byteLength: artifactBytes.length, base64: artifactBytes.toString('base64') },
      sideEffects: { networkRequests: 0, externalWrites: 0, providerCalls: 0 } };
    await writeFile(process.env.JARVIS_S03_EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  }
}));
