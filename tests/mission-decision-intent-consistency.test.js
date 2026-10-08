import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {GoalExecutivePlanner} from '../packages/core/src/mission/mission-planner.js';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
const context={mission:{objective:"'source.txt'를 읽어",successCriteria:[],constraints:[],remainingBudget:{plannerCalls:2,activeRuntimeMs:60000}},
 capabilities:[{toolName:'filesystem.readText'}],observations:[]};
const action={id:'read',command:'source.txt를 읽어',expectedToolName:'filesystem.readText',arguments:{path:'source.txt'},dependencies:[],clarificationIndependent:true};
for(const decision of ['continue','complete','blocked'])for(const field of ['question','questions'])test(`${decision} cannot hide a required user ${field}`,()=>{
 const diagnostics={},payload={decision,actions:decision==='continue'?[action]:[],[field]:field==='question'?'어느 파일인가요?':['어느 파일인가요?']};
 assert.equal(new GoalExecutivePlanner().sanitizePlan(payload,context,diagnostics),null);
 assert.equal(diagnostics.reason,'decision-question-conflict');
});
for(const decision of ['continue','complete','ask_user'])test(`${decision} cannot also claim blocked`,()=>{
 const diagnostics={};
 assert.equal(new GoalExecutivePlanner().sanitizePlan({decision,actions:decision==='continue'?[action]:[],blockedReason:'권한 필요'},context,diagnostics),null);
 assert.equal(diagnostics.reason,'decision-blocked-reason-conflict');
});
test('actual prior model output is rejected without silently discarding its question or blocker',()=>{
 const original=JSON.parse(readFileSync('artifacts/local-model-path-contract-20261008-native/plan-0.json','utf8'));
 const previous=JSON.parse(readFileSync('artifacts/local-model-path-contract-20261008-native/result.json','utf8')).mission;
 const copy=structuredClone(original),diagnostics={};
 assert.equal(new GoalExecutivePlanner().sanitizePlan(original,{...context,mission:previous},diagnostics),null);
 assert.equal(diagnostics.reason,'decision-question-conflict');assert.deepEqual(original,copy);
});
test('a contradictory response is repaired as a full plan before any action can be accepted',async()=>{
 let calls=0;
 const planner=new GoalExecutivePlanner({runner:async()=>JSON.stringify({decision:'continue',actions:[action],question:calls++===0?'파일을 읽어주실래요?':null,blockedReason:null})});
 const plan=await planner.planNextWave(context);
 assert.equal(calls,2);assert.equal(plan.decision,'continue');assert.equal(plan.question,null);
 assert.equal(plan.planning.transientFailures[0].validationReason,'decision-question-conflict');
});
test('ask_user preserves bundled questions and its explicitly independent read',()=>{
 const plan=new GoalExecutivePlanner().sanitizePlan({decision:'ask_user',actions:[action],questions:['어느 기간인가요?','출력 이름은 무엇인가요?'],blockedReason:null},context);
 assert.equal(plan.decision,'ask_user');assert.equal(plan.actions.length,1);assert.equal(plan.questions.length,2);
});

for(const repair of [false,true])test(`real Core dispatches only after decision intent is consistent: repair=${repair}`,async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-decision-intent-'));let runtime,planner,calls=0,dispatched=0;
 try{
  await writeFile(join(root,'source.txt'),'synthetic input');
  const env={JARVIS_TEST_MODE:'1',JARVIS_MISSION_EXECUTIVE:'0',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'};
  runtime=createAgRuntime({allowedRoots:[root],cwd:()=>root,auditRoot:join(root,'audit'),env,taskEnv:env,workerDaemonEnabled:false,
   missionPlanner:{planNextWave:(c,o)=>planner.planNextWave(c,o)}});
  const mission=runtime.missionRuntime.createMission({objective:"'source.txt'를 읽어",authorization:{grants:['read_only']},metadata:{longTermMemory:false},
   successCriteria:[{statement:"'source.txt'를 읽어 목표가 실제 실행 결과로 확인되고 G 검증을 통과한다."}]});
  planner=new GoalExecutivePlanner({maxTransientRetries:repair?1:0,runner:async()=>JSON.stringify({decision:'continue',
   question:++calls===1?'파일 내용을 대신 읽어주실래요?':null,blockedReason:null,
   actions:[{...action,arguments:{path:join(root,'source.txt')},requirementIds:[mission.goalContract.requirements[0].requirementId]}]})});
  const run=runtime.orchestrationWorker.runTask.bind(runtime.orchestrationWorker);
  runtime.orchestrationWorker.runTask=(...args)=>{dispatched++;return run(...args);};
  const result=await runtime.missionRuntime.runMission(mission.missionId);
  assert.equal(result.status,repair?'COMPLETED':'PAUSED',JSON.stringify(result));assert.equal(dispatched,repair?1:0);
  assert.equal(calls,repair?2:1);assert.equal(result.pendingGates.length,0);
  if(!repair)assert.equal(result.stopReason,'mission-planner-invalid-response');
 }finally{runtime?.pcAgent.remoteOperationStore?.close();runtime?.coreFacade.cognition.close();await rm(root,{recursive:true,force:true});}
});
