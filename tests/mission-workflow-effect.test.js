import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {SqliteMissionStore} from '../packages/core/src/mission/sqlite-mission-store.js';
import {SqliteMemoryStore} from '../apps/growth-memory/src/db/sqlite-store.js';
import {readWorkflowResumeCheckpoint} from '../packages/core/src/mission/workflow-resume-checkpoint.js';
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'jarvis-workflow-effect-')),workspace=join(root,'workspace');mkdirSync(workspace);
 writeFileSync(join(workspace,'input.json'),'[{"total":7}]');
 const handles=[],runtimes=[];
 const open=()=>{
  const operations=new PersonalOperationsStore({dbPath:join(root,'operations.sqlite')});
  const memoryStore=new SqliteMemoryStore({dbPath:join(root,'growth.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')});
  const store=new SqliteMissionStore({operationsStore:operations});handles.push(operations,memoryStore);
  const runtime=createAgRuntime({missionStore:store,memoryStore,allowedRoots:[workspace],cwd:()=>workspace,auditRoot:join(root,'audit'),cognitionStorePath:join(root,'cognition.sqlite'),workerDaemonEnabled:false,
   env:{JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'}});
  runtime.missionRuntime.effectCoordinator.workflowEffectsEnabled=true;
  runtimes.push(runtime);return {runtime,store,operations};
 };
 t.after(()=>{for(const r of runtimes)r.coreFacade.cognition?.close?.();for(const h of handles)h.close();rmSync(root,{recursive:true,force:true});});
 return {root,workspace,open};
}
const request={objective:"'input.json' JSON을 '원본'으로 읽고; '원본'의 개수가 1인지 검증하고; '원본'을 'output.json' JSON으로 저장해",
 authorization:{grants:['read_only','local_reversible']},successCriteria:[{statement:'합계7',verificationSpec:{version:1,kind:'json.value',path:'output.json',pointer:'/0/total',equals:7}}]};
test('actual workflow binds the original operation to SQL effect, B idempotency key and receipt',async t=>{
 const f=fixture(t),{runtime,store}=f.open();let packet;
 const execute=runtime.pcAgent.receiveExecutionPacket.bind(runtime.pcAgent);
 runtime.pcAgent.receiveExecutionPacket=async(p,...args)=>{packet=structuredClone(p);return execute(p,...args);};
 const mission=runtime.missionRuntime.createMission(structuredClone(request)),result=await runtime.missionRuntime.runMission(mission.missionId);
 assert.equal(result.status,'COMPLETED',JSON.stringify(result.stopReason));
 const action=result.waves[0].actions[0];assert.ok(action.effect?.effectId,'workflow requires an EffectRecord');
 const effect=store.getEffect(action.effect.effectId);
 assert.equal(effect.operation_id,action.operation.operationId);assert.equal(effect.provider_idempotency_key,effect.operation_id);
 assert.equal(packet.idempotencyKey,effect.operation_id);assert.match(effect.request_sha256,/^[a-f0-9]{64}$/);
 assert.equal(effect.state,'succeeded');assert.ok(effect.receipt.evidenceId);assert.equal(effect.receipt.taskId,action.taskId);
 assert.equal(JSON.parse(readFileSync(join(f.workspace,'output.json'),'utf8'))[0].total,7);
 const reopened=f.open();assert.deepEqual(reopened.store.getEffect(effect.effect_id).receipt,effect.receipt);
 const restored=reopened.store.load().find(m=>m.missionId===mission.missionId).waves[0].actions[0];
 assert.equal(JSON.stringify(readWorkflowResumeCheckpoint(restored.operation)),action.operation.resumeAuthorizationSource);
});
test('durable workflow receipt repairs a lost Core observation without redispatch',async t=>{
 const f=fixture(t),{runtime,store}=f.open();let checkpoint;
 const save=store.save.bind(store);store.save=(missions,metadata)=>{if(!checkpoint&&metadata.reason.startsWith('mission-action-running:'))checkpoint=structuredClone(missions);return save(missions,metadata);};
 const mission=runtime.missionRuntime.createMission(structuredClone(request)),result=await runtime.missionRuntime.runMission(mission.missionId);
 assert.equal(result.status,'COMPLETED');const action=result.waves[0].actions[0];assert.ok(action.effect?.effectId);
 // Restore only the Core observation; keep the effect and the original B receipt.
 const saved=checkpoint.find(m=>m.missionId===mission.missionId).waves[0].actions[0];saved.effect=structuredClone(action.effect);
 save(checkpoint,{reason:'synthetic-response-loss'});
 const fresh=f.open();let dispatches=0;fresh.runtime.orchestrationWorker.runTask=async()=>{dispatches++;throw Error('unexpected redispatch');};
 const recovered=await fresh.runtime.missionRuntime.runMission(mission.missionId);
 assert.equal(recovered.status,'COMPLETED',JSON.stringify(recovered.stopReason));assert.equal(dispatches,0);
 assert.equal(recovered.waves[0].actions[0].recovery.source,'pc-operation-receipt');
});
test('revoked workflow authority after effect claim cannot publish output',async t=>{
 const f=fixture(t),{runtime,store}=f.open();const mission=runtime.missionRuntime.createMission(structuredClone(request));
 let reached=false;runtime.missionRuntime.effectCoordinator.onBoundary=async boundary=>{
  if(boundary==='claimed'){reached=true;runtime.missionRuntime.missions.get(mission.missionId).authorization.grants=[];}
 };
 const result=await runtime.missionRuntime.runMission(mission.missionId);
 assert.equal(reached,true);assert.notEqual(result.status,'COMPLETED');assert.equal(existsSync(join(f.workspace,'output.json')),false);
 const action=result.waves[0].actions[0];assert.notEqual(store.getEffect(action.effect.effectId).state,'succeeded');
});
