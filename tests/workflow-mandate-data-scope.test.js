import {SqliteMemoryStore} from '../apps/growth-memory/src/db/sqlite-store.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,mkdir,symlink} from 'node:fs/promises';
import {renameSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {PersonalMandateBudget} from '../packages/core/src/personal-operations/mandate-budget.js';
import {MissionBudgetGate} from '../packages/core/src/personal-operations/mission-budget-gate.js';
import {localMandateFileRef,observeLocalMandateDataRefs} from '../packages/core/src/personal-operations/local-mandate-observation.js';
import {SqliteMissionStore} from '../packages/core/src/mission/sqlite-mission-store.js';

for(const mode of ['ready','memory-not-configured','missing-input','missing-output','shadow-revoke','read-revoke','alias-change','publication-revoke'])test(`actual scoped workflow Mission: ${mode}`,async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-workflow-scope-'));
 const operations=new PersonalOperationsStore({dbPath:join(root,'ops.sqlite')}),budget=new PersonalMandateBudget(operations),gate=new MissionBudgetGate({store:operations,budget});
 await writeFile(join(root,'input.json'),'[{"total":42}]');
 const input=mode==='alias-change'?'alias/input.json':'input.json';
 if(mode==='alias-change'){
  for(const name of ['a','b'])await mkdir(join(root,name));
  await writeFile(join(root,'a','input.json'),'[{"total":42}]');await writeFile(join(root,'b','input.json'),'[{"total":99}]');
  await symlink(join(root,'a'),join(root,'alias'),'junction');
 }
 const names=[input,'output.json',...(mode==='alias-change'?['b/input.json']:[])].filter(name=>name!==({'missing-input':'input.json','missing-output':'output.json'}[mode]));
 const quota=gate.createQuota({validFrom:'2020-01-01T00:00:00Z',expiresAt:'2099-01-01T00:00:00Z',maxCalls:2,
  scope:{accountRef:null,dataRefs:names.map(name=>localMandateFileRef(join(root,name),root)),deniedDataRefs:[]}});
 const env={JARVIS_TEST_MODE:'1',JARVIS_MISSION_EXECUTIVE:'0',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'};
 let memoryStore=mode==='memory-not-configured'?null:new SqliteMemoryStore({dbPath:join(root,'growth.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')});
 let runtime=createAgRuntime({memoryStore,allowedRoots:[root],auditRoot:join(root,'audit'),env,taskEnv:env,workerDaemonEnabled:false,missionStore:new SqliteMissionStore({operationsStore:operations})});
 runtime.missionRuntime.executionBudget=gate;
 t.after(async()=>{runtime.close?.();runtime.coreFacade.cognition?.close();operations.close();memoryStore?.close();await rm(root,{recursive:true,force:true});});
 const adapter=runtime.pcAgent.registry.get('workflow.execute'),shadow=adapter.shadow.bind(adapter),safe=adapter.assertSafePath.bind(adapter),read=adapter.readBounded.bind(adapter);
 let shadows=0,reads=0,reading=false,changed=false;
 adapter.shadow=async(...args)=>{const value=await shadow(...args);shadows++;if(mode==='shadow-revoke')operations.revokeMandate(quota.mandate.id);return value;};
 adapter.assertSafePath=async(path,options)=>{
  const value=await safe(path,options);
  if(mode==='read-revoke'&&reading)operations.revokeMandate(quota.mandate.id);
  if(mode==='alias-change'&&reading&&!changed){changed=true;renameSync(join(root,'alias'),join(root,'old-alias'));symlinkSync(join(root,'b'),join(root,'alias'),'junction');}
  return value;
 };
 adapter.readBounded=async(...args)=>{reading=true;try{const value=await read(...args);reads++;return value;}finally{reading=false;}};
 const claim=runtime.pcAgent.claimWorkflowPublication.bind(runtime.pcAgent);
 runtime.pcAgent.claimWorkflowPublication=async(...args)=>{const value=await claim(...args);if(mode==='publication-revoke')operations.revokeMandate(quota.mandate.id);return value;};
 const owner=runtime.personalOwnerSession.activate({durationMinutes:5,requestedBy:'synthetic-workflow-scope'});
 const created=runtime.missionRuntime.createMission({objective:`'${input}' JSON을 '원본'으로 읽고; '원본'을 'output.json' JSON으로 저장해`,
  executionMandateId:quota.mandate.id,authorization:{mode:'trusted_session',ownerSessionId:owner.session.sessionId,grants:['read_only','local_reversible']},
  successCriteria:[{statement:'합계 확인',verificationSpec:{version:1,kind:'json.value',path:'output.json',pointer:'/0/total',equals:42}}]});
 const result=await runtime.missionRuntime.runMission(created.missionId);
 assert.equal(result.status==='COMPLETED',mode==='ready',JSON.stringify({status:result.status,stopReason:result.stopReason,lastError:result.lastError,waves:result.waves,observations:result.observations}));
 assert.equal(await readFile(join(root,'input.json'),'utf8'),'[{"total":42}]');
 if(mode==='memory-not-configured'){
  assert.equal(result.status,'PAUSED');assert.equal(result.stopReason,'durable-memory-unavailable');
  assert.equal(result.lastError.code,'A_MISSION_DURABLE_MEMORY_UNAVAILABLE');
  assert.equal(result.lastError.reason,'persistent-growth-store-not-configured');
  assert.match(result.lastError.nextAction,/아직 파일 작업은 시작하지 않았습니다/);
  await assert.rejects(readFile(join(root,'output.json')),{code:'ENOENT'});
  assert.equal(reads,0);assert.equal(shadows,0);assert.equal(result.metrics.executedActions,0);
  const priorReads=reads,priorShadows=shadows;
  assert.equal((await runtime.missionRuntime.runMission(created.missionId)).status,'PAUSED');
  assert.equal(reads,priorReads);assert.equal(shadows,priorShadows);
  assert.equal(operations.db.prepare('SELECT count(*) AS n FROM workflow_cognition_intents').get().n,0);
  await runtime.close?.();runtime.coreFacade.cognition.close();
  memoryStore=new SqliteMemoryStore({dbPath:join(root,'growth.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')});
  runtime=createAgRuntime({memoryStore,allowedRoots:[root],auditRoot:join(root,'audit'),env,taskEnv:env,workerDaemonEnabled:false,missionStore:new SqliteMissionStore({operationsStore:operations})});
  runtime.missionRuntime.executionBudget=gate;
  const renewedOwner=runtime.personalOwnerSession.activate({durationMinutes:5,requestedBy:'synthetic-restored-memory'});
  runtime.missionRuntime.updateMission(created.missionId,{authorization:{mode:'trusted_session',ownerSessionId:renewedOwner.session.sessionId,grants:['read_only','local_reversible']}});
  let restoredCalls=0;const restoredAdapter=runtime.pcAgent.registry.get('workflow.execute'),restoredExecute=restoredAdapter.execute.bind(restoredAdapter);
  restoredAdapter.execute=async(...args)=>{restoredCalls++;return restoredExecute(...args);};
  const resumed=await runtime.missionRuntime.runMission(created.missionId);
  assert.equal(resumed.status,'COMPLETED',JSON.stringify({status:resumed.status,reason:resumed.stopReason,error:resumed.lastError,completion:resumed.completion,observations:resumed.observations.map(o=>({toolName:o.toolName,outcome:o.outcome,data:o.data,error:o.error})),plans:resumed.planHistory.map(p=>p.planning)}));
  assert.equal(restoredCalls,1);assert.equal(JSON.parse(await readFile(join(root,'output.json'),'utf8'))[0].total,42);
  assert.equal(memoryStore.allEvents().filter(event=>event.eventType==='execution.completed').length,1);
  return;
 }
 if(mode==='ready'){
  assert.equal(JSON.parse(await readFile(join(root,'output.json'),'utf8'))[0].total,42);
  assert.equal(result.gates.length,0);assert.equal(budget.summary(quota.mandate.id).usedOrHeldCalls,1);
  const action=result.waves[0].actions[0],receipt=await runtime.pcAgent.taskResult(action.taskId);
  assert.equal(receipt.status,'COMPLETED');assert.equal(Object.hasOwn(receipt,'cognitionPersistence'),false);
  receipt.cognitionPersistence={status:'pending'};receipt.executionResult.outputPaths.push(join(root,'not-produced.json'));
  const again=await runtime.pcAgent.taskResult(action.taskId);
  assert.equal(Object.hasOwn(again,'cognitionPersistence'),false);assert.equal(again.executionResult.outputPaths.length,1);
 }else await assert.rejects(readFile(join(root,'output.json')),{code:'ENOENT'});
 if(mode.startsWith('missing-'))assert.equal(shadows,0);
 if(['read-revoke','shadow-revoke','alias-change'].includes(mode))assert.equal(reads,0);
 if(mode==='alias-change'){
  assert.equal(changed,false);assert.equal(result.lastError.causeCode,'WORKFLOW_SYMLINK_BLOCKED');
  assert.equal(result.lastError.code,'A_MISSION_RECOVERY_EXECUTION_UNCERTAIN');
 }
});

test('workflow scope refuses unobserved operations and file specs; typed paths require private IO observation',async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-workflow-observe-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const base={schemaVersion:'jarvis-local-workflow-v1',workflowId:'scope-test',nodes:[{id:'one',op:'text.read',args:{path:'input.txt'}}]};
 const observe=args=>observeLocalMandateDataRefs({toolName:'workflow.execute',arguments:args},root);
 assert.deepEqual(observe({spec:base}),[localMandateFileRef('input.txt',root)]);
 assert.throws(()=>observe({specPath:'spec.json'}),/OBSERVATION_UNSUPPORTED/);
 assert.throws(()=>observe({spec:base,dataRefs:[]}),/OBSERVATION_UNSUPPORTED/);
 for(const op of ['process.run','sqlite.query','fs.search'])assert.throws(()=>observe({spec:{...base,nodes:[{id:'one',op,args:{path:'input.txt'}}]}}),/OPERATION_UNSUPPORTED/);
 const dynamic={...base,nodes:[{id:'one',op:'text.read',args:{path:'input.txt'}},{id:'two',op:'write.text',dependsOn:['one'],args:{path:{$ref:{nodeId:'one',pointer:'/text',expectedType:'string'}},text:'x'}}]};
 assert.deepEqual(observe({spec:dynamic}),[localMandateFileRef('input.txt',root)]);
});
