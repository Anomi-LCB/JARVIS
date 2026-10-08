import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {PersonalMandateBudget} from '../packages/core/src/personal-operations/mandate-budget.js';
import {MissionBudgetGate} from '../packages/core/src/personal-operations/mission-budget-gate.js';
import {localMandateFileRef,localMandateTreeRef} from '../packages/core/src/personal-operations/local-mandate-observation.js';
import {SqliteMissionStore} from '../packages/core/src/mission/sqlite-mission-store.js';
import {withMissionMandateFence} from '../packages/core/src/personal-operations/mission-mandate-fence.js';
import {LocalWorkflowToolAdapter} from '../apps/pc-agent/src/adapters/workflow/local-workflow-adapter.js';
import {SqliteMemoryStore} from '../apps/growth-memory/src/db/sqlite-store.js';
import {verifyFieldSummaryResult} from '../packages/core/src/mission/mission-field-summary-result.js';

for(const mode of ['ready','metadata-only','no-tree','excluded-input','excluded-subtree','walk-revoke','read-revoke','publication-revoke','duplicate','missing','changed-source'])test(`actual discovered source workflow scope: ${mode}`,async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-discovered-scope-')),research=join(root,'research'),nested=join(research,'nested'),sourcePath=join(nested,'source.txt'),output=join(root,'result.json');
 await mkdir(nested,{recursive:true});const source='실제 지출액: 0원\n승인 여부: 미승인\n확정일: 미정\n';
 if(mode!=='missing')await writeFile(sourcePath,source);
 if(mode==='duplicate')await writeFile(join(research,'source.txt'),source);
 const operations=new PersonalOperationsStore({dbPath:join(root,'ops.sqlite')}),budget=new PersonalMandateBudget(operations),gate=new MissionBudgetGate({store:operations,budget});
 const inputRef=localMandateFileRef(sourcePath,root),treeRef=localMandateTreeRef(research,root);
 const quota=gate.createQuota({validFrom:'2020-01-01T00:00:00Z',expiresAt:'2099-01-01T00:00:00Z',maxCalls:2,scope:{accountRef:null,
  dataRefs:[localMandateFileRef(output,root),...(mode==='no-tree'?[]:[treeRef]),...(mode==='metadata-only'?[]:[inputRef]),...(mode==='excluded-subtree'?[localMandateTreeRef(nested,root)]:[])],deniedDataRefs:mode==='excluded-input'?[inputRef]:mode==='excluded-subtree'?[localMandateTreeRef(nested,root)]:[]}});
 const env={JARVIS_TEST_MODE:'1',JARVIS_MISSION_EXECUTIVE:'0',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'};
 const memory=new SqliteMemoryStore({dbPath:join(root,'growth.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')});
 const runtime=createAgRuntime({allowedRoots:[root],auditRoot:join(root,'audit'),env,taskEnv:env,workerDaemonEnabled:false,missionStore:new SqliteMissionStore({operationsStore:operations}),memoryStore:memory});runtime.missionRuntime.executionBudget=gate;
 t.after(async()=>{runtime.close?.();runtime.coreFacade.cognition?.close();memory.close();operations.close();await rm(root,{recursive:true,force:true});});
 const adapter=runtime.pcAgent.registry.get('workflow.execute'),safe=adapter.assertSafePath.bind(adapter),read=adapter.readBounded.bind(adapter),walk=adapter.walk.bind(adapter),shadow=adapter.shadow.bind(adapter);
 let reading=false,walking=false,reads=0,walks=0,shadows=0;
 adapter.shadow=async(...args)=>{shadows++;return shadow(...args);};
 adapter.walk=async(...args)=>{walking=true;try{const value=await walk(...args);walks++;return value;}finally{walking=false;}};
 adapter.assertSafePath=async(...args)=>{const value=await safe(...args);if((mode==='walk-revoke'&&walking)||(mode==='read-revoke'&&reading))operations.revokeMandate(quota.mandate.id);return value;};
 adapter.readBounded=async(...args)=>{reading=true;try{const value=await read(...args);reads++;if(mode==='changed-source'&&args[0]===sourcePath)await writeFile(sourcePath,'실제 지출액: 99원\n승인 여부: 승인\n확정일: 미정\n');return value;}finally{reading=false;}};
 const claim=runtime.pcAgent.claimWorkflowPublication.bind(runtime.pcAgent);
 runtime.pcAgent.claimWorkflowPublication=async(...args)=>{const value=await claim(...args);if(mode==='publication-revoke')operations.revokeMandate(quota.mandate.id);return value;};
 const owner=runtime.personalOwnerSession.activate({durationMinutes:5,requestedBy:'synthetic-discovery-scope'});
 const objective="'research' 폴더에서 'source.txt' 파일을 찾아 항목 '실제 지출액'의 '원' 단위 숫자, '승인 여부'의 승인 상태, '확정일'의 미정 여부를 정리해 'result.json'에 JSON으로 저장하고 다시 읽어 확인해줘";
 const created=runtime.missionRuntime.createMission({objective,executionMandateId:quota.mandate.id,
  authorization:{mode:'trusted_session',ownerSessionId:owner.session.sessionId,grants:['read_only','local_reversible']},
  successCriteria:[['field1','0'],['field2','미승인'],['field3','미정']].map(([field,equals])=>({statement:`원문 항목 ${field} 확인`,verificationSpec:{version:1,kind:'json.value',path:'result.json',pointer:`/facts/${field}`,equals}}))});
 const result=await runtime.missionRuntime.runMission(created.missionId),diagnostic=JSON.stringify({status:result.status,errors:result.observations.map(o=>o.error),lastError:result.lastError});
 assert.equal(result.status==='COMPLETED',mode==='ready',diagnostic);
 if(mode==='ready'){
  const saved=JSON.parse(await readFile(output,'utf8'));
  assert.deepEqual(Object.values(saved.facts),['0','미승인','미정']);
  for(const quote of Object.values(saved.evidence))assert.equal(source.includes(quote),true);
  assert.equal(result.gates.length,0);assert.equal(budget.summary(quota.mandate.id).usedOrHeldCalls,1);
  const receipt=await runtime.pcAgent.taskResult(result.waves[0].actions[0].taskId);
  assert.ok(receipt.executionResult.evidence.workflow.receipts.some(r=>r.op==='fs.inventory'));
  assert.ok(receipt.executionResult.evidence.workflow.receipts.some(r=>r.op==='text.extractFields'));
  assert.equal(receipt.executionResult.evidence.workflow.receipts.at(-1).op,'data.readJson');
  for(const excluded of [false,true]){
   const nestedRef=localMandateTreeRef(nested,root);
   const previewQuota=gate.createQuota({validFrom:'2020-01-01T00:00:00Z',expiresAt:'2099-01-01T00:00:00Z',maxCalls:1,scope:{accountRef:null,dataRefs:[treeRef,nestedRef,inputRef,localMandateFileRef(output,root)],deniedDataRefs:excluded?[nestedRef]:[]}});
   let reachedNested=false;
   const checked=verifyFieldSummaryResult({objective,statement:`${objective} 목표가 실제 실행 결과로 확인되고 G 검증을 통과한다.`,observations:result.observations,allowedRoots:[root],beforeAccess:({path,kind})=>{
    if(path===nested)reachedNested=true;
    gate.beforeResultRead({missionId:'synthetic-preview',executionMandateId:previewQuota.mandate.id},{workspaceRoot:root,path,kind});
   }});
   assert.equal(reachedNested,true);assert.equal(checked.passed,!excluded,JSON.stringify(checked));
   if(excluded)assert.deepEqual(checked.checks,[]);
  }
 }else await assert.rejects(readFile(output),{code:'ENOENT'});
 if(mode==='no-tree')assert.equal(shadows,0);
 if(['metadata-only','excluded-input','excluded-subtree','walk-revoke','read-revoke','duplicate','missing'].includes(mode))assert.equal(reads,0);
 if(mode==='excluded-subtree'){assert.equal(walks,0);assert.match(diagnostic,/DATA_SCOPE_DENIED/);}
 if(mode==='metadata-only'||mode==='excluded-input'){assert.equal(walks,1);assert.match(diagnostic,/DATA_SCOPE_DENIED/);}
 if(mode!=='missing'&&mode!=='changed-source')assert.equal(await readFile(sourcePath,'utf8'),source);
 if(mode==='changed-source')assert.match(diagnostic,/SOURCE_CHANGED/);
});

for(const mode of ['allowed','outside','excluded'])test(`actual adapter observes dynamic output at write boundary: ${mode}`,async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-dynamic-output-')),input=join(root,'target.txt'),output=join(root,'result.txt');await writeFile(input,output);
 const store=new PersonalOperationsStore({dbPath:join(root,'ops.sqlite')}),budget=new PersonalMandateBudget(store),gate=new MissionBudgetGate({store,budget});
 t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
 const outputRef=localMandateFileRef(output,root),quota=gate.createQuota({validFrom:'2020-01-01T00:00:00Z',expiresAt:'2099-01-01T00:00:00Z',maxCalls:2,
  scope:{accountRef:null,dataRefs:[localMandateFileRef(input,root),...(mode==='outside'?[]:[outputRef])],deniedDataRefs:mode==='excluded'?[outputRef]:[]}});
 const mission={missionId:'synthetic-dynamic-write',executionMandateId:quota.mandate.id};gate.beforeRun(mission);
 const args={spec:{schemaVersion:'jarvis-local-workflow-v1',workflowId:'dynamic-output',nodes:[
  {id:'read',op:'text.read',args:{path:input}},
  {id:'write',op:'write.text',dependsOn:['read'],args:{path:{$ref:{nodeId:'read',pointer:'/text',expectedType:'string'}},text:'synthetic generated result'}}]}};
 const packet={taskId:'synthetic-dynamic-write',packetId:'synthetic-dynamic-packet',action:{toolName:'workflow.execute',arguments:args}};
 const hooks=withMissionMandateFence({mission,gate,executor:{supportsTrustedLocalMissionEffects:()=>true},workspaceRoot:root,hooks:null});
 const fence=await hooks.beforeExecute(packet),adapter=new LocalWorkflowToolAdapter({allowedRoots:[root]});
 const result=await adapter.execute(args,packet,{assertAccess:fence,assertDataAccess:(path,kind)=>fence.assertWorkflowAccess(path,{kind}),beforePublication:async()=>fence});
 assert.equal(result.status==='success',mode==='allowed',JSON.stringify(result.error));
 if(mode==='allowed')assert.equal(await readFile(output,'utf8'),'synthetic generated result');
 else {await assert.rejects(readFile(output),{code:'ENOENT'});assert.equal(result.error.code,'A_MANDATE_DATA_SCOPE_DENIED');}
});

for(const contentGranted of [false,true])test(`recursive metadata grant does not imply hashing contents: granted=${contentGranted}`,async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-inventory-scope-')),folder=join(root,'research'),input=join(folder,'private.txt');await mkdir(folder);await writeFile(input,'synthetic private bytes');
 const store=new PersonalOperationsStore({dbPath:join(root,'ops.sqlite')}),budget=new PersonalMandateBudget(store),gate=new MissionBudgetGate({store,budget});
 t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
 const quota=gate.createQuota({validFrom:'2020-01-01T00:00:00Z',expiresAt:'2099-01-01T00:00:00Z',maxCalls:2,scope:{accountRef:null,
  dataRefs:[localMandateTreeRef(folder,root),...(contentGranted?[localMandateFileRef(input,root)]:[])],deniedDataRefs:[]}});
 const mission={missionId:'synthetic-hash',executionMandateId:quota.mandate.id};gate.beforeRun(mission);
 const args={spec:{schemaVersion:'jarvis-local-workflow-v1',workflowId:'inventory-hash',nodes:[{id:'list',op:'fs.inventory',args:{path:folder,recursive:true,hash:true}}]}};
 const packet={taskId:'synthetic-hash',packetId:'synthetic-hash-packet',action:{toolName:'workflow.execute',arguments:args}},hooks=withMissionMandateFence({mission,gate,executor:{supportsTrustedLocalMissionEffects:()=>true},workspaceRoot:root,hooks:null});
 const fence=await hooks.beforeExecute(packet),adapter=new LocalWorkflowToolAdapter({allowedRoots:[root]});
 const result=await adapter.execute(args,packet,{assertAccess:fence,assertDataAccess:(path,kind)=>fence.assertWorkflowAccess(path,{kind})});
 assert.equal(result.status==='success',contentGranted,JSON.stringify(result.error));
 if(!contentGranted)assert.equal(result.error.code,'A_MANDATE_DATA_SCOPE_DENIED');
 assert.equal(await readFile(input,'utf8'),'synthetic private bytes');
});
