import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate, createHash } from 'node:crypto';
import { startPcOutboundNodeService } from '../packages/core/src/client/pc-outbound-service.js';
import { createPcOutboundTransport } from '../packages/core/src/client/pc-outbound-https.js';
import { createPcOutboundObserver } from '../apps/pc-agent/src/outbound-observer.js';
import { createOperationArtifactReader } from '../apps/pc-agent/src/operation-artifact-reader.js';
import { executionPacketFingerprint } from '../packages/shared/src/execution-packet-fingerprint.js';
import { SqliteMissionStore } from '../packages/core/src/mission/sqlite-mission-store.js';
import { PersonalOperationsStore } from '../packages/core/src/personal-operations/operations-store.js';
import { createRemoteArtifactBinding, createRemoteArtifactIntent } from '../packages/core/src/mission/remote-artifact-contract.js';
import { MissionEffectCoordinator } from '../packages/core/src/mission/mission-effect-coordinator.js';
import { PcAgentExecutionClient } from '../packages/core/src/client/pc-agent-execution-client.js';
import { canonicalJson } from '../packages/core/src/mission/artifact-consistency.js';

const pem=name=>readFileSync(new URL(`./fixtures/google-broker-tls/${name}.pem`,import.meta.url));
const hash=value=>createHash('sha256').update(value).digest('hex');
const kinds=['source','report','table','card'];
// Actual files/descriptor reads/mTLS/SQL/private G; journal receipts are synthetic.
for(const mode of ['correct','facts','revision','missing','duplicate','changed','revoke-after'])test(`remote four-file consistency ${mode}`,async t=>{
  const root=await mkdtemp(join(tmpdir(),'jarvis-remote-consistency-'));
  let relay,transport,operations;
  t.after(async()=>{transport?.close();await relay?.close();operations?.close();await rm(root,{recursive:true,force:true});});
  const facts={total:42,label:'서울'},digest=hash(canonicalJson(facts));
  const source={sourceId:'source',revision:1,digest,facts};
  const documents=kinds.map(kind=>kind==='source'?source:{artifactId:kind,sourceRef:{sourceId:'source',revision:mode==='revision'&&kind==='card'?2:1,digest},facts:mode==='facts'&&kind==='card'?{...facts,total:99}:facts});
  const actions=kinds.map((kind,i)=>({actionId:kind,status:'succeeded',taskId:`task_${kind}`,effect:{effectId:kind},tool:{toolName:'filesystem.createTextFile',arguments:{path:join(root,`${kind}.json`),content:JSON.stringify(documents[i])}}}));
  const records=new Map();
  for(const [i,action] of actions.entries()){
    const taskId=action.taskId,operationId=`mission_op_${String(i+1).repeat(32)}`;
    await writeFile(action.tool.arguments.path,action.tool.arguments.content);
    records.set(taskId,{operationId,taskId,fingerprint:executionPacketFingerprint({taskId,action:action.tool,requestedMode:'execute'}),state:'succeeded',executionAuthority:false,
      receipt:{taskId,status:'COMPLETED',evidence:{evidenceId:`e${i}`,files:[{path:action.tool.arguments.path,size:Buffer.byteLength(action.tool.arguments.content),sha256:hash(action.tool.arguments.content)}]},executionResult:{taskId,status:'success',executedBy:{toolName:action.tool.toolName},packetId:`p${i}`,outputPaths:[action.tool.arguments.path]}}});
  }
  const readOperation=async input=>records.get(input.taskId);
  const reader=createOperationArtifactReader({allowedRoots:[root],allowedTaskIds:actions.map(a=>a.taskId),readOperation});
  const first=actions[0],record=records.get(first.taskId),scope=await reader({taskId:first.taskId,operationId:record.operationId,action:first.tool});
  relay=await startPcOutboundNodeService({dbPath:join(root,'relay.sqlite'),authorityGuard:()=>({token:1}),tls:{key:pem('server-key'),cert:pem('server'),ca:pem('ca')}});
  const enrollment={deviceId:'pc',certificateFingerprint:new X509Certificate(pem('core')).fingerprint256,expiresAt:new Date(Date.now()+60000).toISOString().replace(/\.\d{3}Z$/u,'Z'),expectedGeneration:0,allowedTaskIds:actions.map(a=>a.taskId),allowedArtifactTaskIds:actions.map(a=>a.taskId)};
  relay.controller.enroll(enrollment);
  transport=createPcOutboundTransport({url:`https://127.0.0.1:${relay.address.port}/v1/pc/observe`,key:pem('core-key'),cert:pem('core'),ca:pem('ca')});
  const observer=createPcOutboundObserver({transport,pcClient:{health:async()=>({}),readOperation},allowedTaskIds:enrollment.allowedTaskIds,artifactReader:reader});
  const client=relay.createReceiptClient('pc',{timeoutMs:1500,pollIntervalMs:10});
  const binding=createRemoteArtifactBinding({deviceId:'pc',deviceGeneration:1,certificateFingerprint:enrollment.certificateFingerprint,pathPlatform:process.platform==='win32'?'win32':'posix',allowedRoots:[root],rootScopeSha256:scope.rootScopeSha256});
  operations=new PersonalOperationsStore({dbPath:join(root,'core.sqlite')});const store=new SqliteMissionStore({operationsStore:operations});
  for(const action of actions){
    const r=records.get(action.taskId),intent=createRemoteArtifactIntent({binding,taskId:action.taskId,operationId:r.operationId,action:action.tool});
    store.save([{missionId:'m'}],{effects:[{effectId:action.effect.effectId,missionId:'m',operationId:r.operationId,resourceKey:intent.resourceKey,providerIdempotencyKey:r.operationId,request:{taskId:action.taskId,action:action.tool,remoteArtifactIntent:intent}}]});
    const claim=store.claimEffect({effectId:action.effect.effectId,ownerId:'core'});
    store.completeEffect({effectId:action.effect.effectId,lease:claim.lease,receipt:{taskId:action.taskId,packetId:r.receipt.executionResult.packetId,evidenceId:r.receipt.evidence.evidenceId,receiptRef:`pc-packet:${r.receipt.executionResult.packetId}`,source:'trusted-local-pc-journal'}});
  }
  const coordinator=new MissionEffectCoordinator({store,orchestrationWorker:{pcAgent:new PcAgentExecutionClient({baseUrl:'http://127.0.0.1:17776',executionToken:'synthetic-unused'})},remoteArtifactRecovery:{client,binding}});
  const spec={version:1,kind:'artifact.consistency',...Object.fromEntries(kinds.map(kind=>[`${kind}Path`,join(root,`${kind}.json`)]))};
  assert.equal(await coordinator.createRemoteCriterionValidator()({verificationSpec:spec},null,[]),null,'local criteria keep their existing local verifier');
  if(mode==='duplicate')spec.cardPath=spec.reportPath;
  if(mode==='changed')await writeFile(actions[3].tool.arguments.path,'changed');
  const pending=coordinator.createRemoteCriterionValidator()({verificationSpec:spec},actions[0],mode==='missing'?actions.slice(0,3):actions);
  let settled=false;const outcome=pending.then(value=>{settled=true;return value;});
  while(!settled){await observer.tick().catch(()=>{});await new Promise(resolve=>setTimeout(resolve,5));}
  const result=await outcome;
  if(['correct','revoke-after'].includes(mode)){
    assert.equal(result.status,'passed',JSON.stringify(result));assert.equal(result.checks[0].artifactCount,4);result.revalidate();
    if(mode==='revoke-after'){relay.controller.revoke('pc',{expectedGeneration:1});assert.throws(()=>result.revalidate());}
  }else {
    assert.notEqual(result.status,'passed',mode);
    const expected=mode==='missing'?'remote-consistency-card-evidence-missing':mode==='duplicate'?'remote-consistency-distinct-files-required':mode==='changed'?'remote-consistency-current-observation-unavailable':'criterion-artifact-facts-or-provenance-mismatch';
    assert.ok(result.reasons.includes(expected),JSON.stringify(result));
  }
  if(mode==='revoke-after')await assert.rejects(observer.tick(),/DEVICE_DENIED/u);
  else assert.equal((await observer.tick()).status,'idle','verification never enqueues a write');
});
