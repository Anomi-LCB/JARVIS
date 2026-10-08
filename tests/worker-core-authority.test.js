import { PcOutboundMailbox } from '../packages/core/src/client/pc-outbound-mailbox.js';
import { PcOutboundCommandMailbox } from '../packages/core/src/client/pc-outbound-command-mailbox.js';
import { PcOutboundExecutionClient } from '../packages/core/src/client/pc-outbound-execution-client.js';
import { PcOutboundReceiptClient } from '../packages/core/src/client/pc-outbound-receipt-client.js';
import { PcOutboundNodeController } from '../packages/core/src/client/pc-outbound-service.js';
import { createRemoteArtifactBinding } from '../packages/core/src/mission/remote-artifact-contract.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { PersonalOperationsStore } from '../packages/core/src/personal-operations/operations-store.js';
import { SqliteMissionStore } from '../packages/core/src/mission/sqlite-mission-store.js';
import { MissionExecutionAuthority } from '../packages/core/src/mission/mission-execution-authority.js';
import { InputSource, ModuleId, TaskStatus } from '../packages/shared/src/types.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-worker-authority-'));
  let time = Date.now();const cleanups=[];
  const operations = new PersonalOperationsStore({ dbPath: join(root, 'isolated.sqlite'), clock: () => new Date(time) });
  const store = new SqliteMissionStore({ operationsStore: operations });
  const authority = new MissionExecutionAuthority({ store, ttlMs: 30_000 });
  authority.activate({ expectedToken: 0, heartbeat: false });
  const runtime = createAgRuntime({ allowedRoots: [root], auditRoot: join(root, 'audit'), cwd: () => root,
    env: { JARVIS_TEST_MODE: '1' }, missionStore: store, missionExecutionAuthority: authority, workerDaemonEnabled: false });
  t.after(() => { for(const cleanup of cleanups)cleanup(); authority.stopHeartbeat(); runtime.coreFacade.cognition?.close?.(); operations.close(); rmSync(root, { recursive: true, force: true }); });
  const path = join(root, 'output.txt');
  const task = () => runtime.coreFacade.createMissionActionTask('결과 텍스트 파일을 만들어줘.', {
    expectedToolName: 'filesystem.createTextFile', preparedArguments: { path, content: 'independently checked output' },
    source: InputSource.TRIGGER, sourceModule: ModuleId.CORE, deviceId: 'mission_executive'
  });
  return { root, addCleanup:fn=>cleanups.push(fn), runtime, authority, task, path, expire: () => { time += 60_000; } };
}

test('ordinary worker task completes one actual guarded file action through E/B/G', async t => {
  const f = fixture(t), task = f.task();
  const result = await f.runtime.orchestrationWorker.runTask(task.taskId);
  assert.equal(result.execution.status, TaskStatus.COMPLETED, JSON.stringify(result));
  assert.equal(readFileSync(f.path, 'utf8'), 'independently checked output');
  assert.equal(result.executionVerification.status, 'passed');
});

test('expired authority cannot enqueue or dispatch a previously queued ordinary task', async t => {
  const f = fixture(t), task = f.task(), worker = f.runtime.orchestrationWorker;
  worker.enqueueTask(task.taskId); const before = JSON.stringify(worker.queue);
  f.expire();
  assert.throws(() => worker.enqueueTask(task.taskId), /STALE_FENCE/);
  await assert.rejects(worker.runNext(), /STALE_FENCE/);
  await assert.rejects(worker.runTask(task.taskId), /STALE_FENCE/);
  assert.equal(JSON.stringify(worker.queue), before); assert.equal(existsSync(f.path), false);
});

test('authority loss during async B shadow fences ordinary task before adapter execution', async t => {
  const f = fixture(t), task = f.task(), adapter = f.runtime.pcAgent.registry.get('filesystem.createTextFile');
  const shadow = adapter.shadow.bind(adapter); let executions = 0;
  adapter.shadow = async (...args) => { const result = await shadow(...args); f.expire(); return result; };
  const execute = adapter.execute.bind(adapter);
  adapter.execute = async (...args) => { executions++; return execute(...args); };
  const result = await f.runtime.orchestrationWorker.runTask(task.taskId);
  assert.notEqual(result.execution.status, TaskStatus.COMPLETED); assert.equal(executions, 0); assert.equal(existsSync(f.path), false);
});

test('local authority refuses an executor without a mutation fence and refuses unguarded rollback', async t => {
  const f = fixture(t), worker = f.runtime.orchestrationWorker;
  let dispatched = 0;
  worker.pcAgent = { receiveExecutionPacket: async () => { dispatched++; } };
  await assert.rejects(worker.executePacketWithHealth({ action: { toolName: 'filesystem.createTextFile' } }), /EXECUTOR_FENCE_UNSUPPORTED/);
  await assert.rejects(worker.executeRollbackProof({ taskId: 'fixture' }, { reason: 'fixture', compensationActions: [{}] }), /ROLLBACK_FENCE_UNSUPPORTED/);
  assert.equal(dispatched, 0);
});

test('authority binding is validated before task/queue/runtime hydration', t => {
  const f = fixture(t);
  assert.throws(() => createAgRuntime({ missionExecutionAuthority: f.authority, missionStore: {}, env: { JARVIS_TEST_MODE: '1' } }), /BINDING_INVALID/);
});

for(const mode of ['no-final-fence','no-effect-hook','wrong-tool','fake-advertisement'])test(`Core authority rejects incomplete outbound contract ${mode}`,async t=>{
  const f=fixture(t),worker=f.runtime.orchestrationWorker;
  const guard=()=>f.authority.assertActive();
  const mailbox=new PcOutboundMailbox({dbPath:join(f.root,'outbound.sqlite'),authorityGuard:guard});f.addCleanup(()=>mailbox.close());
  const commands=new PcOutboundCommandMailbox({mailbox,executionFenceRequired:true});
  const controller=new PcOutboundNodeController({mailbox,authorityGuard:guard});
  const reader=new PcOutboundReceiptClient({controller,deviceId:'pc'});
  const binding=createRemoteArtifactBinding({deviceId:'pc',deviceGeneration:1,certificateFingerprint:'A'.repeat(64),pathPlatform:process.platform==='win32'?'win32':'posix',allowedRoots:[f.root],rootScopeSha256:'a'.repeat(64)});
  const client=new PcOutboundExecutionClient({commands,deviceId:'pc',receiptClient:reader,artifactBinding:binding,requireMutationFence:mode!=='no-final-fence'});
  let dispatched=0;
  worker.pcAgent=mode==='fake-advertisement'?{supportsCoreAuthorityFencing:()=>true,receiveExecutionPacket:async()=>{dispatched++;}}:client;
  const packet={action:{toolName:mode==='wrong-tool'?'filesystem.readText':'filesystem.createTextFile'}};
  const options=mode==='no-effect-hook'?{}:{beforeLocalExecute:async()=>()=>{}};
  await assert.rejects(worker.executePacketWithHealth(packet,options),/EXECUTOR_FENCE_UNSUPPORTED/u);
  assert.equal(dispatched,0);assert.equal(mailbox.db.prepare('SELECT COUNT(*) AS n FROM pc_commands').get().n,0);
});

test('Core authority wrapper preserves the original remote cancellation callback',async t=>{
  const f=fixture(t),worker=f.runtime.orchestrationWorker;let confirmed=0;
  // Focused wrapper contract test; not an actual B receipt or Mission success.
  worker.pcAgent={supportsTrustedLocalMissionEffects:()=>true,receiveExecutionPacket:async(packet,{beforeLocalExecute})=>{
    const fence=await beforeLocalExecute(packet);fence();await fence.onRemoteCancellation({state:'cancelled'});return {status:'BLOCKED'};
  }};
  const original=()=>{};original.onRemoteCancellation=value=>{assert.equal(value.state,'cancelled');confirmed++;};
  await worker.executePacketWithHealth({action:{toolName:'filesystem.createTextFile'}},{beforeLocalExecute:async()=>original});
  assert.equal(confirmed,1);
});
