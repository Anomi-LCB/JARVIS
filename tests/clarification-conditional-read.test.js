import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {createGoalContract} from '../packages/core/src/mission/goal-contract.js';
import {clarificationReadBinding} from '../packages/core/src/mission/mission-clarification.js';
import {resolveClarificationContext} from '../packages/core/src/mission/clarification-context.js';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {SqliteMissionStore} from '../packages/core/src/mission/sqlite-mission-store.js';
import {SqliteMemoryStore} from '../apps/growth-memory/src/db/sqlite-store.js';
import {verifyReadOnlyText} from '../packages/core/src/mission/read-only-text-proof.js';
const prefixes=['승인하면','허락하면','승인 후','답변을 받은 뒤','내용이 정확하면'];
test('pending conditions cannot become unconditional source facts or independent reads',async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-condition-unit-'));await writeFile(join(root,'source.txt'),'unchanged');
 t.after(async()=>{assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));await rm(root,{recursive:true,force:true});});
 for(const prefix of prefixes){
  const objective=`${prefix} 'source.txt'를 읽어`,goalContract=createGoalContract({objective});
  const mission={objective,goalContract,gates:[]};
  assert.equal(goalContract.requirements[0].interpretation.status,'unresolved',objective);
  assert.equal(clarificationReadBinding(mission,'filesystem.readText',{path:join(root,'source.txt')},[root]),null,objective);
  assert.equal(resolveClarificationContext(mission,{questions:['입력 파일의 이름은 무엇인가요?']}).resolved.length,0,objective);
 }
 for(const objective of ["'승인하면.txt'를 읽어","'답변을 받은 뒤.txt'를 읽어","5분 이내에 'source.txt'를 읽어"]){
  const r=createGoalContract({objective}).requirements[0];assert.equal(r.interpretation.status,'recognized',objective);assert.equal(r.interpretation.unresolvedConditions,undefined);
 }
});
for(const [prefix,mixed,decision] of [['승인하면',false,'ask_user'],['승인 후',false,'ask_user'],['내용이 정확하면',false,'ask_user'],['승인하면',true,'ask_user'],['승인하면',false,'continue']])test('actual Core E B G preserves conditional and independent reads '+prefix+' mixed='+mixed+' decision='+decision,async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-condition-runtime-')),workspace=join(root,'workspace');await mkdir(workspace);
 await writeFile(join(workspace,'source.txt'),'protected until condition resolved');
 await writeFile(join(workspace,'seed.txt'),'independent requested observation');
 const operations=new PersonalOperationsStore({dbPath:join(root,'ops.sqlite')}),memory=new SqliteMemoryStore({dbPath:join(root,'growth.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')});
 const reads={source:0,seed:0};
 const runtime=createAgRuntime({allowedRoots:[workspace],auditRoot:join(root,'audit'),cwd:()=>workspace,memoryStore:memory,missionStore:new SqliteMissionStore({operationsStore:operations}),workerDaemonEnabled:false,
  env:{JARVIS_TEST_MODE:'1',JARVIS_MISSION_EXECUTIVE:'0',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'},missionPlanner:{async planNextWave(context){
   if(decision==='continue'&&context.observations.some(o=>o.toolName==='filesystem.readText'&&o.outcome==='success'))return {decision:'complete',actions:[],criteriaAssessment:context.mission.successCriteria.map(c=>({criterionId:c.criterionId,status:'satisfied',evidenceActionIds:context.observations.filter(o=>o.actionId&&o.outcome==='success').map(o=>o.actionId)}))};
   return {decision,...(decision==='ask_user'?{questions:['조건을 충족했나요?','결과에 어떤 내용을 포함할까요?']}:{}),actions:[{id:'read',command:mixed?"'seed.txt'를 읽어":"'source.txt'를 읽어",expectedToolName:'filesystem.readText',arguments:{path:join(workspace,mixed?'seed.txt':'source.txt')},requirementIds:[context.mission.goalContract.requirements[mixed?1:0].requirementId],dependencies:[],clarificationIndependent:true}]};}}});
 t.after(async()=>{runtime.coreFacade.cognition.close();operations.close();memory.close();assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));await rm(root,{recursive:true,force:true});});
 const adapter=runtime.pcAgent.registry.get('filesystem.readText'),execute=adapter.execute.bind(adapter);adapter.execute=(...args)=>{const path=JSON.stringify(args);if(path.includes('seed.txt'))reads.seed++;else reads.source++;return execute(...args);};
 const objective=`${prefix} 'source.txt'를 읽어`+(mixed?"; 'seed.txt'를 읽어":''),created=runtime.missionRuntime.createMission({objective,authorization:{grants:['read_only']},
  ...(decision==='continue'?{successCriteria:[{statement:'actual source content after explicit goal correction',verificationSpec:{version:1,kind:'text.equals',path:'source.txt',equals:'protected until condition resolved'}}]}:{})});
 const result=await runtime.missionRuntime.runMission(created.missionId);
 assert.equal(reads.source,0,JSON.stringify({prefix,status:result.status,reason:result.stopReason}));
 assert.equal(reads.seed,mixed?1:0);assert.equal(result.metrics.successfulActions,mixed?1:0);
 if(decision==='ask_user'){
  assert.equal(result.pendingGates.length,1);assert.equal(result.pendingGates[0].questions.length,2);
  const again=await runtime.missionRuntime.runMission(created.missionId);assert.equal(again.pendingGates.length,1);assert.equal(reads.seed,mixed?1:0);assert.equal(reads.source,0);
 }
 assert.ok(!JSON.stringify(result.observations).includes('protected until condition resolved'));
 assert.equal(await readFile(join(workspace,'source.txt'),'utf8'),'protected until condition resolved');
 console.log(JSON.stringify({prefix,mixed,decision,objective,status:result.status,reads,successfulActions:result.metrics.successfulActions,questionBatches:decision==='ask_user'?1:0,questions:decision==='ask_user'?2:0,actualCoreEBG:true,actualSQL:true}));
 if(decision==='continue'){
  const revised=runtime.missionRuntime.reviseMissionGoal(created.missionId,{objective:"'source.txt'를 읽어",expectedRevision:1,idempotencyKey:'user-condition-removal',reason:'사용자가 지금 읽도록 조건을 명시적으로 정정함',successCriteria:["'source.txt'를 읽어 목표가 실제 실행 결과로 확인되고 G 검증을 통과한다."]});
  assert.equal(revised.status,'applied');
  const resumed=await runtime.missionRuntime.runMission(created.missionId);
  assert.equal(resumed.status,'COMPLETED',JSON.stringify({status:resumed.status,reason:resumed.stopReason,verification:resumed.verificationSummary}));assert.equal(reads.source,1);
  assert.equal(resumed.goalContract.revision,2);assert.equal(resumed.goalRevisionHistory[0].goalContract.objective,objective);
  const saved=runtime.missionRuntime.missions.get(created.missionId),evidenceActionIds=saved.observations.filter(o=>o.outcome==='success').map(o=>o.actionId);
  assert.equal(verifyReadOnlyText({mission:saved,allowedRoots:[workspace],evidenceActionIds}).passed,true);
  for(const revision of [1,3,undefined]){
   const altered=structuredClone(saved);for(const w of altered.waves)for(const a of w.actions)if(a.goalRevision===2)a.goalRevision=revision;
   assert.notEqual(verifyReadOnlyText({mission:altered,allowedRoots:[workspace],evidenceActionIds}).passed,true,'old/future/missing revisions cannot discharge the current goal');
  }
  console.log(JSON.stringify({explicitCorrection:true,revision:2,status:resumed.status,reads:reads.source,actualCoreEBG:true,actualSQL:true}));
 }
});
