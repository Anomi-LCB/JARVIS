import { createCoreServer } from '../packages/core/src/main.mjs';
import { listenOnFetchSafePort } from '../packages/shared/src/http.js';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { GoalExecutivePlanner } from '../packages/core/src/mission/mission-planner.js';
import { MissionGrant, MissionStatus } from '../packages/core/src/mission/mission-runtime.js';
import { clarificationQuestions, clarificationDispatchAllowed, clarificationAnswerBatch } from '../packages/core/src/mission/mission-clarification.js';
const read = { id:'read', title:'자료 목록', command:'작업 폴더 파일 목록 보여줘', expectedToolName:'filesystem.listFiles', dependencies:[], clarificationIndependent:true };
const questions=['결과의 제목은 무엇인가요?', '어느 자료를 최종 결과에 포함할까요?'];
const ctx={mission:{objective:'자료를 읽고 지정한 결과를 작성', successCriteria:[], constraints:[]},capabilities:[{toolName:'filesystem.listFiles'},{toolName:'filesystem.createTextFile'}],observations:[]};
test('planner preserves grouped questions and explicitly independent reads',()=>{
 const p=new GoalExecutivePlanner(); const result=p.sanitizePlan({decision:'ask_user',questions,actions:[read]},ctx);
 assert.deepEqual(result.questions,questions); assert.equal(result.actions.length,1); assert.equal(result.actions[0].clarificationIndependent,true);
 for(const bad of [{...read,clarificationIndependent:false},{...read,expectedToolName:'filesystem.createTextFile'},{...read,dependencies:['read']}]) assert.equal(p.sanitizePlan({decision:'ask_user',questions,actions:[bad]},ctx),null);
 for(const qs of [[],[''],questions.concat(questions),Array(9).fill('q')]) assert.throws(()=>clarificationQuestions({questions:qs}));
});
test('dispatch guard requires actual reviewed local contract and rejects route or contract changes',()=>{
 const a={...read,actualToolName:read.expectedToolName}; const profile={contractReadOnly:true,readOnly:true,mutatesSystem:false,externalTransfer:false,externalNetwork:false,executionClass:'read_only'};
 assert.equal(clarificationDispatchAllowed({clarificationGateId:'gate'},a,profile),true);
 for(const patch of [{contractReadOnly:false},{mutatesSystem:true},{externalTransfer:true},{externalNetwork:true},{executionClass:'local_reversible'}]) assert.equal(clarificationDispatchAllowed({clarificationGateId:'gate'},a,{...profile,...patch}),false);
 assert.equal(clarificationDispatchAllowed({clarificationGateId:'gate'},{...a,actualToolName:'shell.execute'},profile),false);
});
for(const decision of ['approve','reject']) test(`actual local reads continue during one grouped gate, restart then ${decision}`,async()=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-clarification-')); let calls=0;
 try{
  await writeFile(join(root,'source.txt'),'source');
  const planner={async planNextWave(context){calls++;
   if(!context.observations.some(o=>o.category==='user_clarification'&&o.outcome==='success')) return {decision:'ask_user',questions,actions:[{...read,expectedToolName:'filesystem.readText',command:"'source.txt'를 읽어",arguments:{path:join(root,'source.txt')},requirementIds:[context.mission.goalContract.requirements[0].requirementId]}],criteriaAssessment:[]};
   if(!context.observations.some(o=>o.outcome==='success'&&o.category!=='user_clarification'&&o.summary?.includes('filesystem.createTextFile'))) return {decision:'continue',actions:[{id:'write',command:'answer-result 메모 파일을 만들어줘. 내용은 확인 완료',expectedToolName:'filesystem.createTextFile',dependencies:[],requirementIds:[context.mission.goalContract.requirements[1].requirementId]}],criteriaAssessment:[]};
   return {decision:'complete',actions:[],criteriaAssessment:context.mission.successCriteria.map(c=>({criterionId:c.criterionId,status:'satisfied',evidenceActionIds:context.observations.filter(o=>o.actionId&&o.outcome==='success').map(o=>o.actionId),reason:'verified'}))};
  }};
  const options={allowedRoots:[root],auditRoot:join(root,'audit'),cwd:()=>root,env:{},missionPlanner:planner,workerDaemonEnabled:false};
  const runtime=createAgRuntime(options);
  const created=runtime.missionRuntime.createMission({objective:"'source.txt'를 읽어; 'answer-result.txt'를 저장해",successCriteria:['answer-result.txt 생성'],authorization:{grants:[MissionGrant.READ_ONLY,MissionGrant.LOCAL_REVERSIBLE]}});
  const waiting=await runtime.missionRuntime.runMission(created.missionId);
  assert.equal(waiting.status,MissionStatus.WAITING_APPROVAL,JSON.stringify(waiting)); assert.equal(waiting.metrics.successfulActions,1,JSON.stringify(waiting));
  assert.equal(waiting.pendingGates.length,1);assert.deepEqual(waiting.pendingGates[0].questions,questions); assert.equal(calls,1);
  await assert.rejects(access(join(root,'answer-result.txt')));
  // Real persisted Mission store; running without an answer must not repeat reads or ask again.
  const restored=createAgRuntime(options); const again=await restored.missionRuntime.runMission(created.missionId);
  assert.equal(again.metrics.successfulActions,1);assert.equal(again.pendingGates.length,1);assert.equal(calls,1);
  assert.equal(restored.missionRuntime.decideGate(created.missionId,again.pendingGates[0].gateId,{decision:'approve'}).error.code,'A_MISSION_CLARIFICATION_ANSWER_REQUIRED');
  assert.equal(restored.missionRuntime.decideGate(created.missionId,again.pendingGates[0].gateId,{decision:'approve',answers:['answer-result']}).error.code,'A_MISSION_CLARIFICATION_ANSWERS_INVALID');
  assert.equal(restored.missionRuntime.getMission(created.missionId).pendingGates.length,1);
  restored.missionRuntime.decideGate(created.missionId,again.pendingGates[0].gateId,{decision,answers:['answer-result','source.txt만 포함']});
  const result=await restored.missionRuntime.runMission(created.missionId);
  if(decision==='reject'){assert.equal(result.status,MissionStatus.CANCELLED);await assert.rejects(access(join(root,'answer-result.txt')));}
  else{assert.equal(result.status,MissionStatus.COMPLETED,JSON.stringify(result));assert.match(await readFile(join(root,'answer-result.txt'),'utf8'),/확인 완료/);assert.equal(result.metrics.successfulActions,2);}
  runtime.coreFacade.cognition?.close();restored.coreFacade.cognition?.close();
 }finally{await rm(root,{recursive:true,force:true});}
});
test('runtime rejects mixed clarification writes before any execution',async()=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-clarification-negative-'));
 try{const r=createAgRuntime({allowedRoots:[root],auditRoot:join(root,'audit'),cwd:()=>root,env:{},workerDaemonEnabled:false,missionPlanner:{async planNextWave(){return {decision:'ask_user',questions,actions:[read,{...read,id:'write',expectedToolName:'filesystem.createTextFile'}]};}}});
 const m=r.missionRuntime.createMission({objective:'資料の確認',authorization:{grants:[MissionGrant.READ_ONLY,MissionGrant.LOCAL_REVERSIBLE]}});const result=await r.missionRuntime.runMission(m.missionId);
 assert.equal(result.status,MissionStatus.BLOCKED);assert.equal(result.metrics.executedActions,0);r.coreFacade.cognition?.close();
 }finally{await rm(root,{recursive:true,force:true});}
});

test('fixed two-question comparison: sequential legacy gates versus grouped observation gate',async t=>{
 const measurements=[];
 for(const grouped of [false,true]){
  const root=await mkdtemp(join(tmpdir(),'jarvis-question-comparison-'));let runtime;
  try{
   const start=performance.now();
   runtime=createAgRuntime({allowedRoots:[root],auditRoot:join(root,'audit'),cwd:()=>root,env:{},workerDaemonEnabled:false,missionPlanner:{async planNextWave(context){
    const answers=context.observations.filter(o=>o.category==='user_clarification'&&o.outcome==='success').length;
    return answers<(grouped?1:2)?{decision:'ask_user',...(grouped?{questions,actions:[read]}:{question:questions[answers],actions:[]})}:{decision:'blocked',blockedReason:'comparison-stops-before-any-write',actions:[]};
   }}});
   const created=runtime.missionRuntime.createMission({objective:`'${root.replaceAll('\\','/')}'를 나열해; 이름과 대상 선택`,authorization:{grants:[MissionGrant.READ_ONLY]}});
   let result=await runtime.missionRuntime.runMission(created.missionId);let interventions=0;const readBeforeAnswer=result.metrics.successfulActions;
   while(result.pendingGates.length){interventions++;runtime.missionRuntime.decideGate(created.missionId,result.pendingGates[0].gateId,{decision:'approve',responseText:grouped?'answer-result; source.txt':'고정 답변'});result=await runtime.missionRuntime.runMission(created.missionId);}
   measurements.push({mode:grouped?'grouped':'sequential',interventions,readBeforeAnswer,successfulReads:result.metrics.successfulActions,plannerCalls:result.metrics.plannerCalls,elapsedMs:performance.now()-start,cost:'미측정',finalStatus:result.status});
   assert.equal(result.metrics.failedActions,0);
  }finally{runtime?.coreFacade.cognition?.close();await rm(root,{recursive:true,force:true});}
 }
 assert.deepEqual(measurements.map(m=>m.interventions),[2,1]);assert.deepEqual(measurements.map(m=>m.readBeforeAnswer),[0,1]);
 t.diagnostic(JSON.stringify({comparison:'fixed-structured-two-question',measurements,scope:'Scripted plans and actual local A-G; not general language quality or independent semantic evaluation.'}));
});

test('typed batch preserves index mapping and rejects partial, blank, extra and oversized answers',()=>{
 const gate={type:'clarification',questions};
 const valid=clarificationAnswerBatch(gate,[' result ', 'source.txt']);
 assert.deepEqual(valid.answers,['result','source.txt']);assert.equal(valid.responseText,'1. result\n2. source.txt');assert.equal(valid.semanticVerification,'unverified');
 for(const bad of [[],['one'],['one',''],['one',null],['one','two','extra'],['x'.repeat(501),'two'],{}]) assert.throws(()=>clarificationAnswerBatch(gate,bad));
 assert.throws(()=>clarificationAnswerBatch({type:'action_approval',questions},['one','two']));
});

test('authenticated Core HTTP preserves gate on partial answers and accepts complete batch without auto resume',async()=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-batch-http-'));let server,r;
 try{
  r=createAgRuntime({allowedRoots:[root],auditRoot:join(root,'audit'),cwd:()=>root,env:{},workerDaemonEnabled:false,missionPlanner:{async planNextWave(){return {decision:'ask_user',questions,actions:[]};}}});
  const m=r.missionRuntime.createMission({objective:'출력 이름과 자료 선택',authorization:{grants:[MissionGrant.READ_ONLY]}});const wait=await r.missionRuntime.runMission(m.missionId);const gateId=wait.pendingGates[0].gateId;
  server=createCoreServer(r.coreFacade,{adminToken:'batch-fixture-only',missionRuntime:r.missionRuntime});const addr=await listenOnFetchSafePort(server);
  const url=`http://127.0.0.1:${addr.port}/missions/${encodeURIComponent(m.missionId)}/gates/${encodeURIComponent(gateId)}/decision`;
  const post=answers=>fetch(url,{method:'POST',headers:{authorization:'Bearer batch-fixture-only','content-type':'application/json'},body:JSON.stringify({decision:'approve',answers,resume:false})});
  const bad=await post(['name']);assert.equal(bad.status,409);assert.equal((await bad.json()).error.code,'A_MISSION_CLARIFICATION_ANSWERS_INVALID');assert.equal(r.missionRuntime.getMission(m.missionId).pendingGates.length,1);
  const ok=await post(['name','source.txt']);assert.equal(ok.status,200);const result=await ok.json();assert.equal(result.status,MissionStatus.PAUSED);assert.equal(result.pendingGates.length,0);
  const gate=result.gates.find(g=>g.gateId===gateId);assert.deepEqual(gate.answers,['name','source.txt']);assert.equal(gate.answerCoverage,'all-fields-present');assert.equal(gate.answerSemanticVerification,'unverified');assert.equal(result.metrics.executedActions,0);
 }finally{if(server)await new Promise(resolve=>server.close(resolve));r?.coreFacade.cognition?.close();await rm(root,{recursive:true,force:true});}
});
