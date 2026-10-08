import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate,createHash } from 'node:crypto';
import { startPcOutboundNodeService } from '../packages/core/src/client/pc-outbound-service.js';
import { createPcOutboundTransport } from '../packages/core/src/client/pc-outbound-https.js';
import { createPcOutboundObserver } from '../apps/pc-agent/src/outbound-observer.js';
import { createOperationArtifactReader } from '../apps/pc-agent/src/operation-artifact-reader.js';
import { executionPacketFingerprint } from '../packages/shared/src/execution-packet-fingerprint.js';
import { SqliteMissionStore } from '../packages/core/src/mission/sqlite-mission-store.js';
import { PersonalOperationsStore } from '../packages/core/src/personal-operations/operations-store.js';
import { createRemoteArtifactBinding,createRemoteArtifactIntent } from '../packages/core/src/mission/remote-artifact-contract.js';
import { RemoteArtifactVerifier } from '../apps/verification/src/remote-artifact-verifier.js';
import { MissionEffectCoordinator } from '../packages/core/src/mission/mission-effect-coordinator.js';
import { PcAgentExecutionClient } from '../packages/core/src/client/pc-agent-execution-client.js';
import { recoverMissionAction,ensureMissionActionOperation,checkpointMissionActionDispatch,getRecoveredMemoryScopeProof,consumeRecoveredMemoryScopeProof } from '../packages/core/src/mission/mission-action-recovery.js';

const pem = name => readFileSync(new URL(`./fixtures/google-broker-tls/${name}.pem`, import.meta.url));
test('configured effect coordinator stages remote SQL scope and reconciles only after actual remote G',async t=>{
  const f=await fixture(t),coreRoot=await mkdtemp(join(f.root,'coordinator-core-'));
  const action={actionId:'write',command:'원격 결과 저장',arguments:f.action.arguments,expectedToolName:f.action.toolName,
    attempts:1,taskId:f.input.taskId,actualToolName:f.action.toolName};
  const operation=ensureMissionActionOperation('m',action,[coreRoot]);
  f.input.operationId=operation.operationId;f.record.operationId=operation.operationId;
  const task={taskId:f.input.taskId,plan:{action:f.action},request:{userId:'test-user'}};
  checkpointMissionActionDispatch(action,task,{}, {mutatesSystem:true},new Date().toISOString());
  const scope=await f.reader(f.input),binding=createRemoteArtifactBinding({deviceId:'pc',deviceGeneration:1,
    certificateFingerprint:f.enrollment.certificateFingerprint,pathPlatform:process.platform==='win32'?'win32':'posix',
    allowedRoots:[f.root],rootScopeSha256:scope.rootScopeSha256});
  const operations=new PersonalOperationsStore({dbPath:join(f.root,'coordinator.sqlite')}),store=new SqliteMissionStore({operationsStore:operations});
  f.cleanup.push(()=>operations.close());
  const mission={missionId:'m'},runtime={store,allowedRoots:[coreRoot],missions:new Map([['m',mission]]),pcAgent:{},
    orchestrationWorker:{pcAgent:new PcAgentExecutionClient({baseUrl:'http://127.0.0.1:17776',executionToken:'synthetic-unused'})},
    remoteArtifactRecovery:{client:f.client,binding},persist:(reason,{effects})=>store.save([mission],{effects,reason})};
  assert.throws(()=>new MissionEffectCoordinator({...runtime,remoteArtifactRecovery:{client:{},binding}}),/CONFIG_INVALID/);
  const coordinator=new MissionEffectCoordinator(runtime);
  await coordinator.stage(mission,action,task);
  const effectId=action.effect.effectId,staged=store.getEffect(effectId);
  assert.equal(staged.intent.request.remoteArtifactIntent.binding.version,'remote-artifact-binding-v2');
  assert.match(staged.resource_key,/^remote-file:/);
  const claim=store.claimEffect({effectId,ownerId:'test'});store.markUncertain({effectId,lease:claim.lease});
  const {value:recovered,error}=await drive(f.observer,recoverMissionAction({missionId:'m',action,allowedRoots:[coreRoot],
    coreFacade:{getTask:()=>null,workspaceRoot:coreRoot},worker:runtime.orchestrationWorker,
    durableEffect:store.getEffect(effectId),remoteArtifactRecovery:coordinator.remoteArtifactRecoveryContext(action)}));
  assert.equal(error,undefined);assert.equal(recovered.status,'recovered');
  coordinator.recovered(action,recovered);
  assert.equal(store.getEffect(effectId).state,'succeeded');assert.equal(store.pendingFollowups().length,1);
  assert.throws(()=>coordinator.verified(action,recovered.execution),/GROWTH_NOT_PERSISTED/);
  assert.equal(store.pendingFollowups().length,1,'no followup ACK without persisted F memory');
});
async function fixture(t, { grant = true, localGrant = true, mutate = null, lostAck = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-artifact-channel-'));
  let relay, transport;const cleanup=[];
  t.after(async () => { for(const close of cleanup)await close();transport?.close(); await relay?.close(); await rm(root, { recursive: true, force: true }); });
  let epoch = 1, offset = 0;
  relay = await startPcOutboundNodeService({ dbPath: join(root, 'relay.sqlite'), clock: () => Date.now()+offset, authorityGuard: () => ({ token: epoch }),
    tls: { key: pem('server-key'), cert: pem('server'), ca: pem('ca') } });
  const taskId = 'task_한글', operationId = `mission_op_${'a'.repeat(32)}`;
  const action = { toolName: 'filesystem.createTextFile', arguments: { path: join(root, 'result.txt'), content: '선택된 실제 파일' } };
  await writeFile(action.arguments.path, action.arguments.content);
  const enrollment = { deviceId: 'pc', certificateFingerprint: new X509Certificate(pem('core')).fingerprint256,
    expiresAt: new Date(Date.now() + 60000).toISOString().replace(/\.\d{3}Z$/u, 'Z'), expectedGeneration: 0,
    allowedTaskIds: [taskId], ...(grant ? { allowedArtifactTaskIds: [taskId] } : {}) };
  relay.controller.enroll(enrollment);
  const record = { operationId, taskId, fingerprint: executionPacketFingerprint({ taskId, action, requestedMode: 'execute' }),
    state: 'succeeded', executionAuthority: false, receipt: { taskId, status: 'COMPLETED', evidence: { evidenceId: 'e1',files:[{
      path:action.arguments.path,exists:true,size:Buffer.byteLength(action.arguments.content),sha256:createHash('sha256').update(action.arguments.content).digest('hex')}] },
      executionResult: { taskId, success: true, executedBy: { toolName: action.toolName }, packetId: 'p1', outputPaths: [action.arguments.path] } } };
  transport = createPcOutboundTransport({ url: `https://127.0.0.1:${relay.address.port}/v1/pc/observe`,
    key: pem('core-key'), cert: pem('core'), ca: pem('ca') });
  let reads = 0, dropped = false, changed = false;
  const reader = createOperationArtifactReader({ allowedRoots: [root], allowedTaskIds: [taskId],
    readOperation: async () => { reads++; return record; },
    onRead: async () => { if (!changed && mutate) { changed = true; await mutate({ relay, nextEpoch: () => epoch++, advance: ms => offset+=ms }); } } });
  const wrapped = { exchange: async (method, body) => {
    const value = await transport.exchange(method, body);
    if (lostAck && method === 'submit' && !dropped) { dropped = true; throw new Error('A_PC_OUTBOUND_NETWORK'); }
    return value;
  } };
  const observer = createPcOutboundObserver({ transport: wrapped, pcClient: { health: async () => ({}), readOperation: async () => record },
    allowedTaskIds: [taskId], artifactReader: localGrant ? reader : null });
  const client = relay.createReceiptClient('pc', { timeoutMs: 1000, pollIntervalMs: 10 });
  return { root,cleanup,relay, observer, client, action, record, reader, input: { operationId, taskId, action }, reads: () => reads, enrollment };
}

async function drive(observer,promise) {
  let settled=false;
  const outcome=promise.then(value=>{settled=true;return {value};},error=>{settled=true;return {error};});
  while(!settled){await observer.tick().catch(()=>{});await new Promise(resolve=>setTimeout(resolve,5));}
  return outcome;
}
function durable(f,rootScopeSha256=null,metadata={}){
  const operations=new PersonalOperationsStore({dbPath:join(f.root,'durable.sqlite')}),store=new SqliteMissionStore({operationsStore:operations});
  f.cleanup.push(()=>operations.close());
  const binding=createRemoteArtifactBinding({deviceId:'pc',deviceGeneration:1,
    certificateFingerprint:f.enrollment.certificateFingerprint,pathPlatform:process.platform==='win32'?'win32':'posix',allowedRoots:[f.root],...(rootScopeSha256?{rootScopeSha256}:{})});
  const intent=createRemoteArtifactIntent({...f.input,binding}),effectId='effect';
  store.save([{missionId:'m'}],{effects:[{effectId,missionId:'m',operationId:f.input.operationId,resourceKey:intent.resourceKey,
    providerIdempotencyKey:f.input.operationId,
    request:{taskId:f.input.taskId,action:f.action,remoteArtifactIntent:intent,...metadata}}]});
  const claim=store.claimEffect({effectId,ownerId:'core'});store.markUncertain({effectId,lease:claim.lease});
  return {store,effectId,binding};
}
test('Mission recovery uses provisioned remote G with a distinct Core workspace and fails closed without it',async t=>{
  for(const mode of ['correct','missing-context','v1','wrong-evidence','wrong-checkpoint','scope-revoked','checkpoint-mutated-during-read','missing-effect']){
    let pendingAction;
    const f=await fixture(t,{mutate:mode==='checkpoint-mutated-during-read'?()=>{pendingAction.command='변경된 요청';}:null}),coreRoot=await mkdtemp(join(f.root,'core-workspace-'));
    const action={actionId:'remote-write',command:'원격 PC에 결과 저장',expectedToolName:f.action.toolName,
      arguments:structuredClone(f.action.arguments),attempts:1,taskId:f.input.taskId,actualToolName:f.action.toolName};
    pendingAction=action;
    const operation=ensureMissionActionOperation('m',action,[coreRoot]);
    f.input.operationId=operation.operationId;f.record.operationId=operation.operationId;
    checkpointMissionActionDispatch(action,{taskId:f.input.taskId,plan:{action:f.action}}, {},{mutatesSystem:true},new Date().toISOString());
    const scopeReader=mode==='checkpoint-mutated-during-read'
      ?createOperationArtifactReader({allowedRoots:[f.root],allowedTaskIds:[f.input.taskId],readOperation:async()=>f.record}):f.reader;
    const scope=await scopeReader(f.input),dispatch=operation.dispatch;
    const metadata={taskRequest:{userId:'test-user'},toolName:dispatch.toolName,arguments:dispatch.arguments,
      plannedRequestSha256:operation.requestSha256,actionSha256:dispatch.actionSha256,
      allowedRootsSha256:operation.allowedRootsSha256,resolvedAllowedRootsSha256:operation.resolvedAllowedRootsSha256};
    const d=durable(f,mode==='v1'?null:scope.rootScopeSha256,metadata);
    f.record.receipt.memoryEvent={eventId:'test-event',eventType:'execution.completed',taskId:f.input.taskId,source:{}};
    if(mode==='wrong-evidence')f.record.receipt.evidence.files[0].sha256='0'.repeat(64);
    if(mode==='scope-revoked')f.relay.controller.revoke('pc',{expectedGeneration:1});
    const effect=d.store.getEffect(d.effectId);
    if(mode==='wrong-checkpoint')effect.request_sha256='0'.repeat(64);
    let localGCalls=0;
    const outcome=await drive(f.observer,recoverMissionAction({missionId:'m',action,allowedRoots:[coreRoot],
      coreFacade:{getTask:()=>null,workspaceRoot:coreRoot},worker:{verifyExecution:()=>{localGCalls++;throw new Error('must not use Core filesystem');}},
      durableEffect:mode==='missing-effect'?null:effect,...(mode==='missing-context'?{}:{remoteArtifactRecovery:{...d,client:f.client}})}));
    assert.equal(outcome.error,undefined,mode);
    const result=outcome.value;
    assert.equal(result.status,mode==='correct'?'recovered':'blocked',mode);
    if(mode==='checkpoint-mutated-during-read')assert.equal(result.error.code,'A_MISSION_RECOVERY_RECEIPT_DISPATCH_MISMATCH');
    assert.equal(localGCalls,0,mode);assert.equal(d.store.getEffect(d.effectId).state,'uncertain',mode);
    if(mode==='correct'){
      assert.equal(result.source,'pc-outbound-verified-artifact');assert.equal(result.verification.status,'passed');
      assert.equal(result.execution.executionResult.outputPaths[0],f.action.arguments.path);
      assert.equal(getRecoveredMemoryScopeProof(result),result);
      assert.equal(getRecoveredMemoryScopeProof(structuredClone(result)),null);
      const event=structuredClone(result.execution.memoryEvent);
      event.source.memoryScope={userId:'test-user',workspaceRoot:coreRoot,conversationId:null};
      const input={taskId:f.input.taskId,event,workspaceRoot:coreRoot};
      assert.equal(consumeRecoveredMemoryScopeProof(result,input).valid,true);
      assert.equal(consumeRecoveredMemoryScopeProof(result,input).valid,false,'memory scope is single use');
    }else assert.equal(getRecoveredMemoryScopeProof(result),null);
  }
});
test('SQL uncertain intent binds current enrolled device to actual outbound receipt and bytes without changing effect state',async t=>{
  const f=await fixture(t),d=durable(f),before=d.store.getEffect(d.effectId);
  const result=await drive(f.observer,f.client.reconcileDurableArtifact(d));
  assert.equal(result.error,undefined);assert.equal(result.value.effectId,d.effectId);
  assert.equal(result.value.requestSha256,before.request_sha256);
  assert.equal(result.value.artifact.bytes.toString('utf8'),f.action.arguments.content);
  assert.equal(d.store.getEffect(d.effectId).state,'uncertain');assert.equal(result.value.verifiedCompletion,false);
});
test('SQL-backed reconciliation rejects current device mismatch or a non-reconcilable prepared effect before PC reads',async t=>{
  const f=await fixture(t),d=durable(f);
  await assert.rejects(f.client.reconcileDurableArtifact({...d,binding:{...d.binding,deviceGeneration:2}}),{code:'A_PC_OUTBOUND_DURABLE_DEVICE_MISMATCH'});
  d.store.db.prepare("UPDATE mission_effects SET state='prepared' WHERE effect_id=?").run(d.effectId);
  await assert.rejects(f.client.reconcileDurableArtifact(d),{code:'A_PC_OUTBOUND_DURABLE_EFFECT_NOT_RECONCILABLE'});
  assert.equal(f.reads(),0);
});
test('durable effect state changed during byte observation cannot become a reconciled result',async t=>{
  let d;
  const f=await fixture(t,{mutate:()=>d.store.db.prepare("UPDATE mission_effects SET state='succeeded' WHERE effect_id=?").run(d.effectId)});
  d=durable(f);
  const result=await drive(f.observer,f.client.reconcileDurableArtifact(d));
  assert.equal(result.error.code,'A_PC_OUTBOUND_DURABLE_EFFECT_CHANGED');
});
test('durable provider idempotency mismatch is denied before observing PC data',async t=>{
  const f=await fixture(t),d=durable(f);
  d.store.db.prepare('UPDATE mission_effects SET provider_idempotency_key=? WHERE effect_id=?').run('other-operation',d.effectId);
  await assert.rejects(f.client.reconcileDurableArtifact(d),{code:'A_REMOTE_ARTIFACT_REQUEST_MISMATCH'});
  assert.equal(f.reads(),0);
});
test('v2 SQL root digest accepts provisioned physical scope and rejects another scope despite identical original bytes',async t=>{
  for(const correct of [true,false]){
    const f=await fixture(t),observed=await f.reader(f.input),d=durable(f,correct?observed.rootScopeSha256:'0'.repeat(64));
    const result=await drive(f.observer,f.client.reconcileDurableArtifact(d));
    if(correct){assert.equal(result.error,undefined);assert.equal(result.value.contract.binding.version,'remote-artifact-binding-v2');}
    else assert.equal(result.error.code,'A_PC_OUTBOUND_DURABLE_ROOT_SCOPE_MISMATCH');
    assert.equal(d.store.getEffect(d.effectId).state,'uncertain');
  }
});
test('v2 verification handoff is single-use and rejects cloned or another client observations',async t=>{
  const f=await fixture(t),scope=await f.reader(f.input),d=durable(f,scope.rootScopeSha256);
  const {value}=await drive(f.observer,f.client.reconcileDurableArtifact(d));
  const input={taskId:f.input.taskId,packetId:'p1',evidenceId:'e1'};
  assert.throws(()=>f.client.consumeDurableArtifactObservation(structuredClone(value),input),{code:'A_PC_OUTBOUND_ARTIFACT_PROOF_UNRECOGNIZED'});
  assert.throws(()=>f.relay.createReceiptClient('pc').consumeDurableArtifactObservation(value,input),{code:'A_PC_OUTBOUND_ARTIFACT_PROOF_UNRECOGNIZED'});
  const measured=f.client.consumeDurableArtifactObservation(value,input);
  assert.equal(measured.sha256,value.artifact.sha256);assert.equal(measured.verifiedCompletion,false);
  assert.throws(()=>f.client.consumeDurableArtifactObservation(value,input),{code:'A_PC_OUTBOUND_ARTIFACT_PROOF_UNRECOGNIZED'});
});
test('consumed observation can only be rechecked while SQL, scope and freshness remain current',async t=>{
  for(const mode of ['expiry','revocation','sql']){
    let advance;const f=await fixture(t,{mutate:ctx=>{advance=ctx.advance;}}),scope=await f.reader(f.input),d=durable(f,scope.rootScopeSha256);
    const {value}=await drive(f.observer,f.client.reconcileDurableArtifact(d));
    assert.throws(()=>f.client.assertConsumedArtifactObservationCurrent(value),/UNRECOGNIZED/);
    assert.equal(new RemoteArtifactVerifier({client:f.client}).verify({observation:value,action:f.action,taskId:f.input.taskId}).status,'passed');
    f.client.assertConsumedArtifactObservationCurrent(value);
    assert.throws(()=>f.client.assertConsumedArtifactObservationCurrent(structuredClone(value)),/UNRECOGNIZED/);
    if(mode==='expiry')advance(16000);
    if(mode==='revocation')f.relay.controller.revoke('pc',{expectedGeneration:1});
    if(mode==='sql')d.store.db.prepare("UPDATE mission_effects SET state='prepared' WHERE effect_id=?").run(d.effectId);
    assert.throws(()=>f.client.assertConsumedArtifactObservationCurrent(value),/ARTIFACT_PROOF_/);
  }
});
test('actual G remote verifier checks original request and consumes only a current registered observation',async t=>{
  for(const mode of ['correct','clone','wrong-action','revoked','wrong-output','wrong-evidence','wrong-exists']){
    const f=await fixture(t),scope=await f.reader(f.input),d=durable(f,scope.rootScopeSha256);
    if(mode==='wrong-evidence')f.record.receipt.evidence.files[0].sha256='0'.repeat(64);
    if(mode==='wrong-exists')f.record.receipt.evidence.files[0].exists=false;
    const {value}=await drive(f.observer,f.client.reconcileDurableArtifact(d));
    const input={observation:mode==='clone'?structuredClone(value):value,action:structuredClone(f.action),taskId:f.input.taskId};
    if(mode==='wrong-action')input.action.arguments.content='other';
    if(mode==='revoked')f.relay.controller.revoke('pc',{expectedGeneration:1});
    if(mode==='wrong-output')value.receipt.executionResult.outputPaths=[join(f.root,'other.txt')];
    const verifier=new RemoteArtifactVerifier({client:f.client}),result=verifier.verify(input);
    assert.equal(result.status,mode==='correct'?'passed':'failed',mode);
    if(mode==='wrong-evidence')assert.equal(result.checks.find(c=>c.checkName==='receipt_file_consistency')?.status,'failed');
    assert.equal(result.missionCompletion,false);assert.equal(d.store.getEffect(d.effectId).state,'uncertain');
    if(mode==='correct')assert.equal(verifier.verify(input).status,'failed','single use');
  }
});
test('handoff rejects post-read byte mutation, SQL changes, revocation and freshness expiry',async t=>{
  for(const change of ['bytes','sql','revoke','freshness','binding']){
    let advance;
    const f=await fixture(t,{mutate:ctx=>{advance=ctx.advance;}}),scope=await f.reader(f.input),d=durable(f,scope.rootScopeSha256);
    const {value}=await drive(f.observer,f.client.reconcileDurableArtifact(d));
    if(change==='bytes')value.artifact.bytes[0]^=1;
    if(change==='sql')d.store.db.prepare("UPDATE mission_effects SET state='succeeded' WHERE effect_id=?").run(d.effectId);
    if(change==='revoke')f.relay.controller.revoke('pc',{expectedGeneration:1});
    if(change==='freshness')advance(16000);
    assert.throws(()=>f.client.consumeDurableArtifactObservation(value,{taskId:f.input.taskId,packetId:change==='binding'?'wrong':'p1',evidenceId:'e1'}),/ARTIFACT_PROOF_/u,change);
  }
});

test('joint reconciliation binds current receipt and actual bytes to one generation and authority',async t=>{
  const f=await fixture(t),result=await drive(f.observer,f.client.reconcileOperationArtifact(f.input));
  assert.equal(result.error,undefined);
  assert.equal(result.value.receipt.executionResult.packetId,result.value.artifact.packetId);
  assert.equal(result.value.receipt.evidence.evidenceId,result.value.artifact.evidenceId);
  assert.equal(result.value.artifact.bytes.toString('utf8'),f.action.arguments.content);
  assert.equal(result.value.deviceGeneration,1);assert.equal(result.value.authorityToken,1);
  assert.equal(result.value.verifiedCompletion,false);
});
test('packet or evidence changed between receipt and actual byte observation cannot reconcile',async t=>{
  for(const field of ['packet','evidence']){
    let f;
    f=await fixture(t,{mutate:()=>{if(field==='packet')f.record.receipt.executionResult.packetId='changed';else f.record.receipt.evidence.evidenceId='changed';}});
    const result=await drive(f.observer,f.client.reconcileOperationArtifact(f.input));
    assert.equal(result.error.code,'A_PC_OUTBOUND_ARTIFACT_BINDING_MISMATCH');
  }
});
test('joint reconciliation rejects old receipt after scope rotation, authority change or receipt freshness expiry',async t=>{
  for(const mode of ['rotation','authority','freshness']){
    let f;
    f=await fixture(t,{mutate:({relay,nextEpoch,advance})=>{
      if(mode==='authority')nextEpoch();
      else if(mode==='freshness')advance(16000);
      else relay.controller.enroll({...f.enrollment,expectedGeneration:1});
    }});
    const result=await drive(f.observer,f.client.reconcileOperationArtifact(f.input));
    assert.equal(result.error.code,'A_PC_OUTBOUND_RECONCILIATION_INVALIDATED',mode);
  }
});

test('real mTLS carries selected actual bytes and lost ACK never re-reads or executes', async t => {
  const f = await fixture(t, { lostAck: true });
  const pending = f.client.artifactForOperation(f.input);
  await assert.rejects(f.observer.tick(), /NETWORK/u);
  await f.observer.tick();
  const result = await pending;
  assert.equal(result.bytes.toString('utf8'), f.action.arguments.content);
  assert.equal(result.verifiedCompletion, false); assert.equal(f.reads(), 1);
});
test('artifact bytes require separate opt-in and grant cannot exceed selected tasks', async t => {
  const f = await fixture(t, { grant: false });
  await assert.rejects(f.client.artifactForOperation(f.input), /ARTIFACT_SCOPE_DENIED/u);
  assert.equal((await f.observer.tick()).status, 'idle'); assert.equal(f.reads(), 0);
  assert.throws(() => f.relay.controller.enroll({ ...f.enrollment, expectedGeneration: 1, allowedArtifactTaskIds: ['other'] }), /READ_SCOPE_DENIED/u);
  assert.deepEqual(f.relay.controller.scope('pc').allowedArtifactTaskIds, []);
});
test('identity update without artifact opt-in removes old content permission', async t => {
  const f = await fixture(t);
  f.relay.controller.enroll({ ...f.enrollment, expectedGeneration: 1, allowedArtifactTaskIds: [] });
  await assert.rejects(f.client.artifactForOperation(f.input), /ARTIFACT_SCOPE_DENIED/u);
  assert.equal(f.reads(), 0);
});
test('Core artifact grant cannot override absent PC-side content permission', async t => {
  const f = await fixture(t, { localGrant: false });
  const rejected = assert.rejects(f.client.artifactForOperation(f.input), { code: 'A_PC_OUTBOUND_OBSERVATION_UNAVAILABLE' });
  await f.observer.tick(); await rejected; assert.equal(f.reads(), 0);
});
test('revocation or authority change during physical read rejects submission and Core completion', async t => {
  for (const mode of ['revoke', 'authority']) {
    const f = await fixture(t, { mutate: ({ relay, nextEpoch }) => mode === 'revoke'
      ? relay.controller.revoke('pc', { expectedGeneration: 1 }) : nextEpoch() });
    const outcome = f.client.artifactForOperation(f.input).then(value => ({ value }), error => ({ error }));
    await assert.rejects(f.observer.tick(), /DEVICE_DENIED|AUTHORITY_CHANGED/u);
    assert.equal((await outcome).error.code, 'A_PC_OUTBOUND_RECONCILIATION_INVALIDATED');
  }
});
test('changed bytes become unavailable, never a successful receipt-only artifact', async t => {
  const f = await fixture(t); await writeFile(f.action.arguments.path, '변조');
  const pending = f.client.artifactForOperation(f.input);
  const rejected = assert.rejects(pending, { code: 'A_PC_OUTBOUND_OBSERVATION_UNAVAILABLE' });
  await f.observer.tick();
  await rejected;
});
