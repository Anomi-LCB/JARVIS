import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { PersonalOperationsStore } from '../packages/core/src/personal-operations/operations-store.js';
import { SqliteMissionStore } from '../packages/core/src/mission/sqlite-mission-store.js';
import { PcAgentExecutionClient } from '../packages/core/src/client/pc-agent-execution-client.js';
import { createPcAgentServer, PcAgentApiGuard } from '../apps/pc-agent/src/main.mjs';
import { listenOnFetchSafePort } from '../packages/shared/src/http.js';
import {SqliteMemoryStore} from '../apps/growth-memory/src/db/sqlite-store.js';

async function fixture(t, { local = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-workflow-claim-'));
  const operations = new PersonalOperationsStore({ dbPath: join(root, 'core.sqlite') });
  const memoryStore=new SqliteMemoryStore({dbPath:join(root,'memory.sqlite'),reviewDir:join(root,'memory-reviews'),backupDir:join(root,'memory-backups'),reconcileReviewExports:false});
  const runtime = createAgRuntime({ allowedRoots: [root], auditRoot: join(root, 'audit'), workerDaemonEnabled: false,
    missionStore: new SqliteMissionStore({ operationsStore: operations }),memoryStore,
    env: { JARVIS_TEST_MODE: '1', JARVIS_LLM_INTENT: '0', JARVIS_LLM_PLANNER: '0', JARVIS_LLM_CONTENT: '0' } });
  const executionToken = 'synthetic-publication-claim-http-token';
  const server = createPcAgentServer(runtime.pcAgent, { apiGuard: new PcAgentApiGuard({ apiToken: 'synthetic-admin-publication-token', executionToken }) });
  await listenOnFetchSafePort(server);
  if (local) runtime.missionRuntime.effectCoordinator.workflowEffectsEnabled = true;
  else runtime.orchestrationWorker.pcAgent = new PcAgentExecutionClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, executionToken });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await runtime.coreFacade.cognition?.close?.(); operations.db.close();memoryStore.close();
    await rm(root, { recursive: true, force: true }); });
  await writeFile(join(root, 'input.json'), '[{"total":7}]');
  const make = (name, second = 'two.json') => runtime.missionRuntime.createMission({
    objective: `'input.json' JSON을 '자료'로 읽고; '자료'를 '${name}' JSON으로 저장하고; '자료'를 '${second}' JSON으로 저장해`,
    authorization: { grants: ['read_only', 'local_reversible'] },
    successCriteria: [{ statement: '합계 7 저장', verificationSpec: { version: 1, kind: 'json.value', path: name, pointer: '/0/total', equals: 7 } }] });
  return { root, runtime, make };
}

test('local Core single-file write respects a workflow publication claim', { timeout: 20000 }, async t => {
  const f = await fixture(t, { local: true });
  const bResults = [], receive = f.runtime.pcAgent.receiveExecutionPacket.bind(f.runtime.pcAgent);
  f.runtime.pcAgent.receiveExecutionPacket = async (...args) => { const result = await receive(...args); bResults.push(result); return result; };
  let release, reached;
  const held = new Promise(resolve => { release = resolve; });
  const claimed = new Promise(resolve => { reached = resolve; });
  f.runtime.pcAgent.remoteOperationBoundary = async boundary => {
    if (boundary === 'workflow-publication-claimed') { reached(); await held; }
  };
  const mission = f.make('one.json'), running = f.runtime.missionRuntime.runMission(mission.missionId);
  await claimed;
  try {
    f.runtime.missionRuntime.planner = { async planNextWave(context) {
      return { decision: 'continue', actions: [{ id: 'single', command: 'one 텍스트 파일을 만들어줘',
        expectedToolName: 'filesystem.createTextFile', arguments: { path: join(f.root, 'one.json'), content: 'competing single writer' },
        dependencies: [], requirementIds: context.mission.goalContract.requirements.map(item => item.requirementId) }] };
    } };
    const single = f.runtime.missionRuntime.createMission({ objective: 'one 텍스트 파일을 만들어줘',
      authorization: { grants: ['read_only', 'local_reversible'] }, successCriteria: ['one 파일 생성'] });
    const denied = await f.runtime.missionRuntime.runMission(single.missionId);
    assert.notEqual(denied.status, 'COMPLETED');
    await assert.rejects(access(join(f.root, 'one.json')), error => error.code === 'ENOENT');
    assert.ok(bResults.some(result => result.status === 'BLOCKED' && result.blockedReason === 'B_OPERATION_RESOURCE_UNRESOLVED'));
  } finally { release(); await running; }
  assert.equal((await running).status, 'COMPLETED');
  assert.deepEqual(JSON.parse(await readFile(join(f.root, 'one.json'), 'utf8')), [{ total: 7 }]);
});

test('local file claim blocks an overlapping workflow but permits a different target', { timeout: 20000 }, async t => {
  const f = await fixture(t, { local: true }), originalPlanner = f.runtime.missionRuntime.planner;
  const bResults = [], receive = f.runtime.pcAgent.receiveExecutionPacket.bind(f.runtime.pcAgent);
  f.runtime.pcAgent.receiveExecutionPacket = async (...args) => { const result = await receive(...args); bResults.push(result); return result; };
  let release, reached, holding = false;
  const held = new Promise(resolve => { release = resolve; });
  const claimed = new Promise(resolve => { reached = resolve; });
  f.runtime.pcAgent.remoteOperationBoundary = async boundary => {
    if (boundary === 'claimed' && !holding) { holding = true; reached(); await held; }
  };
  f.runtime.missionRuntime.planner = { async planNextWave(context) {
    if (context.observations.some(item => item.outcome === 'success')) return { decision: 'complete', actions: [] };
    return { decision: 'continue', actions: [{ id: 'single', command: 'one 텍스트 파일을 만들어줘',
      expectedToolName: 'filesystem.createTextFile', arguments: { path: join(f.root, 'one.json'), content: 'local file owner' },
      dependencies: [], requirementIds: context.mission.goalContract.requirements.map(item => item.requirementId) }] };
  } };
  const first = f.runtime.missionRuntime.createMission({ objective: 'one 텍스트 파일을 만들어줘',
    authorization: { grants: ['read_only', 'local_reversible'] },
    successCriteria: [{ statement: 'one 내용', verificationSpec: { version: 1, kind: 'text.equals', path: 'one.json', equals: 'local file owner' } }] });
  const running = f.runtime.missionRuntime.runMission(first.missionId);
  await claimed;
  try {
    f.runtime.missionRuntime.planner = originalPlanner;
    const collision = f.make('one.json', 'collision.json');
    const denied = await f.runtime.missionRuntime.runMission(collision.missionId);
    assert.notEqual(denied.status, 'COMPLETED');
    assert.ok(bResults.some(result => result.blockedReason === 'B_OPERATION_RESOURCE_UNRESOLVED'
      || result.executionResult?.error?.code === 'B_OPERATION_RESOURCE_UNRESOLVED'), JSON.stringify(bResults.map(result => ({ status: result.status, blockedReason: result.blockedReason, error: result.executionResult?.error }))));
    for (const name of ['one.json', 'collision.json']) await assert.rejects(access(join(f.root, name)), error => error.code === 'ENOENT');
    f.runtime.missionRuntime.planner = { async planNextWave(context) {
      if (context.observations.some(item => item.outcome === 'success')) return { decision: 'complete', actions: [] };
      return { decision: 'continue', actions: [{ id: 'different', command: 'different 텍스트 파일을 만들어줘',
        expectedToolName: 'filesystem.createTextFile', arguments: { path: join(f.root, 'different.txt'), content: 'unrelated writer' },
        dependencies: [], requirementIds: context.mission.goalContract.requirements.map(item => item.requirementId) }] };
    } };
    const other = f.runtime.missionRuntime.createMission({ objective: 'different 텍스트 파일을 만들어줘',
      authorization: { grants: ['read_only', 'local_reversible'] },
      successCriteria: [{ statement: 'different 내용', verificationSpec: { version: 1, kind: 'text.equals', path: 'different.txt', equals: 'unrelated writer' } }] });
    assert.equal((await f.runtime.missionRuntime.runMission(other.missionId)).status, 'COMPLETED', 'unrelated single-file targets remain usable');
  } finally { release(); await running; }
  const action = f.runtime.missionRuntime.missions.get(first.missionId).waves[0].actions[0];
  assert.equal(action.status, 'succeeded');
  assert.equal(await readFile(join(f.root, 'one.json'), 'utf8'), 'local file owner');
  const effect = f.runtime.missionRuntime.store.getEffect(action.effect.effectId);
  const bRecord = f.runtime.pcAgent.readRemoteOperation({ operationId: effect.operation_id, taskId: action.taskId,
    action: effect.intent.request.action });
  assert.equal(bRecord.state, 'succeeded');
  assert.equal(bRecord.receipt.taskId, effect.receipt.taskId);
  assert.equal(bRecord.receipt.executionResult.packetId, effect.receipt.packetId);
  assert.equal(effect.provider_idempotency_key, effect.operation_id);
});

test('actual HTTP workflow publication prevents an overlapping workflow and remote single-file write', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  let release; const gate = new Promise(resolve => { release = resolve; }); t.after(() => release());
  let reached; const claimed = new Promise(resolve => { reached = resolve; }); let held = false;
  f.runtime.pcAgent.remoteOperationBoundary = async boundary => {
    if (boundary === 'workflow-publication-claimed' && !held) { held = true; reached(); await gate; }
  };
  const first = f.make('one.json'), running = f.runtime.missionRuntime.runMission(first.missionId);
  await claimed;
  try {
    const other = f.make('one.json', 'three.json');
    const blockedWorkflow = await f.runtime.missionRuntime.runMission(other.missionId);
    assert.notEqual(blockedWorkflow.status, 'COMPLETED');
    assert.match(JSON.stringify(blockedWorkflow), /B_OPERATION_RESOURCE_UNRESOLVED/);
    for (const name of ['one.json', 'two.json', 'three.json']) await assert.rejects(access(join(f.root, name)), error => error.code === 'ENOENT');
    const planner = f.runtime.missionRuntime.planner;
    f.runtime.missionRuntime.planner = { async planNextWave(context) {
      return { decision: 'continue', actions: [{ id: 'single', command: 'one 텍스트 파일을 만들어줘',
        expectedToolName: 'filesystem.createTextFile', arguments: { path: join(f.root, 'one.json'), content: 'single must not overwrite' },
        dependencies: [], requirementIds: context.mission.goalContract.requirements.map(item => item.requirementId) }] };
    } };
    const single = f.runtime.missionRuntime.createMission({ objective: 'one 텍스트 파일을 만들어줘',
      authorization: { grants: ['read_only', 'local_reversible'] }, successCriteria: ['one 파일 생성'] });
    const blockedSingle = await f.runtime.missionRuntime.runMission(single.missionId);
    assert.notEqual(blockedSingle.status, 'COMPLETED');
    assert.match(JSON.stringify(blockedSingle), /B_OPERATION_RESOURCE_UNRESOLVED/);
    assert.equal(blockedSingle.waves[0].actions[0].effect.scope, 'durable-pc-http-filesystem.createTextFile');
    await assert.rejects(access(join(f.root, 'one.json')), error => error.code === 'ENOENT');
    f.runtime.missionRuntime.planner = planner;
  } finally { release(); }
  assert.equal((await running).status, 'COMPLETED');
  assert.deepEqual(JSON.parse(await readFile(join(f.root, 'one.json'), 'utf8')), [{ total: 7 }]);
  assert.equal(f.runtime.pcAgent.operationStore().db.prepare('SELECT count(*) AS n FROM remote_operation_claims').get().n, 0);
});

test('actual B capability revoked after workflow claim cannot publish a target', { timeout: 20000 }, async t => {
  const f = await fixture(t); let reached = false, revoked = 0;
  f.runtime.pcAgent.remoteOperationBoundary = async (boundary, data) => {
    if (boundary === 'workflow-publication-claimed') {
      reached = true;
      for (const [tokenId, token] of f.runtime.policyRuntime.capabilities.tokens) {
        if (token.taskId === data.descriptor.taskId) { f.runtime.policyRuntime.capabilities.revoke({ tokenId, reason: 'test-at-publication' }); revoked++; }
      }
    }
  };
  const mission = f.make('one.json'); const result = await f.runtime.missionRuntime.runMission(mission.missionId);
  assert.equal(reached, true); assert.ok(revoked > 0); assert.notEqual(result.status, 'COMPLETED');
  assert.match(JSON.stringify(result), /REVOKED/);
  for (const name of ['one.json', 'two.json']) await assert.rejects(access(join(f.root, name)), error => error.code === 'ENOENT');
});

for (const corruption of ['task', 'fingerprint', 'destinations']) {
test(`completed workflow receipt with mismatched ${corruption} cannot release claims`, { timeout: 20000 }, async t => {
  const f = await fixture(t);
  f.runtime.pcAgent.remoteOperationBoundary = async boundary => {
    if (boundary === 'workflow-receipt-persisted') throw new Error('synthetic after-receipt interruption');
  };
  const mission = f.make('one.json');
  const interrupted = await f.runtime.missionRuntime.runMission(mission.missionId);
  assert.notEqual(interrupted.status, 'COMPLETED');
  const record = f.runtime.pcAgent.packetJournal.records.findLast(item => item.toolName === 'workflow.execute' && item.status === 'COMPLETED');
  assert.ok(record);
  const original = structuredClone(record);
  if (corruption === 'task') record.result.taskId = 'substituted-task';
  if (corruption === 'fingerprint') record.packetFingerprint = 'a'.repeat(64);
  if (corruption === 'destinations') record.result.executionResult.outputPaths = [join(f.root, 'other.json')];
  const deniedCleanup = await f.runtime.pcAgent.recoverCompletedWorkflowCleanup();
  assert.equal(deniedCleanup.items.find(item => item.taskId === original.taskId)?.status, 'deferred');
  assert.throws(() => f.runtime.pcAgent.taskResult(original.taskId), error => /B_WORKFLOW_RECEIPT_BINDING_MISMATCH/.test(error.code));
  const db = f.runtime.pcAgent.operationStore().db;
  assert.equal(db.prepare('SELECT count(*) AS n FROM remote_operation_claims').get().n, 2);
  Object.assign(record, original);
  f.runtime.pcAgent.packetJournal.results.set(record.idempotencyKey, record.result);
  assert.equal(f.runtime.pcAgent.taskResult(record.taskId).status, 'COMPLETED');
  assert.equal(db.prepare('SELECT count(*) AS n FROM remote_operation_claims').get().n, 0);
  assert.equal(f.runtime.pcAgent.taskResult(record.taskId).status, 'COMPLETED', 'repeated receipt read remains idempotent');
  const cleaned = await f.runtime.pcAgent.recoverCompletedWorkflowCleanup();
  assert.equal(cleaned.items.find(item => item.taskId === record.taskId)?.status, 'removed', JSON.stringify(cleaned));
  assert.deepEqual((await f.runtime.pcAgent.recoverCompletedWorkflowCleanup()).items, [], 'successful cleanup marker avoids starving older receipts');
  assert.deepEqual(JSON.parse(await readFile(join(f.root, 'one.json'), 'utf8')), [{ total: 7 }]);
});
}
