import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep,basename} from 'node:path';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {SqliteMissionStore} from '../packages/core/src/mission/sqlite-mission-store.js';
import {SqliteMemoryStore} from '../apps/growth-memory/src/db/sqlite-store.js';

const modes=['exact','permuted','skewed-same-total','wrong-total','missing-recipient','extra-recipient','duplicate-recipient','wrong-label','fractional-copy','negative-copy','overflow','claimed-delivery','extra-field','duplicate-json-key','tampered','source-changed','read-revoked','typed-exact','typed-skewed','source-count-mismatch','source-duplicate-label','source-fractional-copy','metadata-forged'];
for(const mode of modes)test('actual allocation plan target/count/total '+mode,async()=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-allocation-plan-')),workspace=join(root,'workspace');mkdirSync(workspace);
 let runtime,operations,memory;
 try{
  operations=new PersonalOperationsStore({dbPath:join(root,'operations.sqlite')});
  memory=new SqliteMemoryStore({dbPath:join(root,'growth.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')});
  const recipients=['A','B','C'];
  const plan={version:1,kind:'planned-copy-allocation',allocations:recipients.map(recipient=>({recipient,copies:2})),totalCopies:6,deliveryVerified:false};
  if(['skewed-same-total','typed-skewed','metadata-forged'].includes(mode)){plan.allocations[0].copies=3;plan.allocations[1].copies=1;}
  if(mode==='permuted')plan.allocations.reverse();
  if(mode==='wrong-total')plan.totalCopies=7;
  if(mode==='missing-recipient'){plan.allocations.pop();plan.totalCopies=4;}
  if(mode==='extra-recipient'){plan.allocations.push({recipient:'D',copies:2});plan.totalCopies=8;}
  if(mode==='duplicate-recipient')plan.allocations[2].recipient='B';
  if(mode==='wrong-label')plan.allocations[2].recipient='c';
  if(mode==='fractional-copy')plan.allocations[0].copies=2.5;
  if(mode==='negative-copy')plan.allocations[0].copies=-2;
  if(mode==='overflow')plan.allocations[0].copies=Number.MAX_SAFE_INTEGER+1;
  if(mode==='claimed-delivery')plan.deliveryVerified=true;
  if(mode==='extra-field')plan.verified=true;
  let content=JSON.stringify(plan);
  if(mode==='duplicate-json-key')content=content.replace('"totalCopies":6','"totalCopies":999,"totalCopies":6');
  const labels=mode==='source-duplicate-label'?"'A', 'B', 'B'":"'A', 'B', 'C'";
  const people=mode==='source-count-mismatch'?'4명':'3명',copies=mode==='source-fractional-copy'?'0.5부씩':'2부씩';
  const objective=`${labels} ${people}에게 ${copies} 배부할 계획을 'allocation.json'에 JSON으로 저장해`;
  runtime=createAgRuntime({allowedRoots:[workspace],auditRoot:join(root,'audit'),missionStore:new SqliteMissionStore({operationsStore:operations}),memoryStore:memory,workerDaemonEnabled:false,
   env:{JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'},
   missionPlanner:{async planNextWave({mission,observations}){
    const successes=observations.filter(o=>o.outcome==='success');
    if(successes.length)return {decision:'complete',actions:[],criteriaAssessment:[{criterionId:'allocation',status:'satisfied',evidenceActionIds:successes.map(o=>o.actionId)}]};
    return {decision:'continue',actions:[{id:'save',command:'텍스트 파일을 만들어줘',expectedToolName:'filesystem.createTextFile',arguments:{path:join(workspace,'allocation.json'),content},dependencies:[],requirementIds:mission.goalContract.requirements.map(r=>r.requirementId)}]};
   }}});
  const created=runtime.missionRuntime.createMission({objective,successCriteria:[{criterionId:'allocation',statement:objective,...(mode.startsWith('typed-')?{verificationSpec:{version:1,kind:'text.equals',path:'allocation.json',equals:content}}:{})}],authorization:{grants:['read_only','local_reversible']}});
  if(mode==='metadata-forged')runtime.missionRuntime.missions.get(created.missionId).goalContract.quantities[1].baseUnits=3;
  const complete=runtime.missionRuntime.completeMission.bind(runtime.missionRuntime);
  runtime.missionRuntime.completeMission=(mission,completion)=>{
   if(mode==='tampered')writeFileSync(join(workspace,'allocation.json'),'{}');
   if(mode==='source-changed')mission.objective="'allocation.json' 파일을 만들어줘";
   if(mode==='read-revoked')runtime.missionRuntime.resultReadGuard=()=>()=>{throw Error('READ_PERMISSION_REVOKED');};
   return complete(mission,completion);
  };
  const result=await runtime.missionRuntime.runMission(created.missionId),mission=runtime.missionRuntime.missions.get(created.missionId);
  const expected=['exact','permuted','typed-exact'].includes(mode);
  assert.equal(result.status==='COMPLETED',expected,JSON.stringify({status:result.status,stopReason:mission.stopReason,lastError:mission.lastError,verification:mission.verificationSummary}));
  const output=join(workspace,'allocation.json');
  // Even invalid local plans retain the created artifact for correction.
  assert.equal(readFileSync(output,'utf8'),mode==='tampered'?'{}':content);
  const persisted=new SqliteMissionStore({operationsStore:operations}).load().find(m=>m.missionId===created.missionId);
  assert.equal(persisted.status,mission.status);
  assert.ok(mission.waves.flatMap(w=>w.actions).every(a=>a.actualToolName==='filesystem.createTextFile'));
  if(expected){
   const proof=mission.completion.quantityVerification.checks[0];
   assert.equal(proof.checkId,'source_quantity_allocation_plan');assert.equal(proof.actualRecipientCount,3);assert.equal(proof.actualTotalCopies,6);
   assert.equal(proof.plannedAllocationVerified,true);assert.equal(proof.deliveryVerified,false);assert.equal(proof.executionAuthorized,false);
   assert.deepEqual(persisted.completion.quantityVerification,mission.completion.quantityVerification);
  }
  console.log(JSON.stringify({allocationEvidence:true,actualCoreEBG:true,actualSQL:true,mode,status:mission.status,expectedComplete:expected}));
 }finally{
  await runtime?.missionRuntime.requestShutdown({reason:'isolated-allocation-cleanup'});runtime?.coreFacade.cognition.close();memory?.close();operations?.close();
  assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep)&&basename(root).startsWith('jarvis-allocation-plan-'));rmSync(root,{recursive:true,force:true});
 }
});
