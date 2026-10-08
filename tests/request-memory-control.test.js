import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequestMemoryControl} from '../src/ui/request-memory-control.js';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {GoalExecutivePlanner} from '../packages/core/src/mission/mission-planner.js';
import {MissionGrant} from '../packages/core/src/mission/mission-runtime.js';
import {createCoreServer} from '../packages/core/src/main.mjs';
import {CoreFacade} from '../packages/core/src/core-facade.js';
import {DurableRoutineScheduler} from '../packages/core/src/runtime/durable-routine-scheduler.js';
import {MemoryDurableRoutineStore} from '../packages/core/src/runtime/durable-routine-store.js';

test('request control preserves selection on render, blocks in-flight changes and starts fresh without storage',()=>{
 const control=createRequestMemoryControl(); let change; let busy=false;
 control.attach({addEventListener:(name,fn)=>{change=fn;}},{isBusy:()=>busy});
 change({target:{matches:()=>true,checked:false}});
 assert.deepEqual(control.metadata(),{longTermMemory:false});
 assert.doesNotMatch(control.render(),/data-request-memory checked/);
 busy=true;change({target:{matches:()=>true,checked:true}});
 assert.equal(control.metadata().longTermMemory,false);
 assert.match(control.render({busy:true}),/disabled/);
 assert.equal(createRequestMemoryControl().metadata().longTermMemory,true);
});

test('Mission recall choice reaches real child execution and profile context, with unchanged policy verification',async()=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-mission-recall-'));let runtime;
 try{
  writeFileSync(join(root,'input.txt'),'독립 입력');let profileCalls=0;const contexts=[];
  runtime=createAgRuntime({allowedRoots:[root],auditRoot:join(root,'audit'),workerDaemonEnabled:false,
   env:{JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_MISSION_EXECUTIVE:'0'},
   personalContextProvider:()=>{profileCalls++;return null;},missionPlanner:{async planNextWave(context){
    contexts.push(context);return context.observations.length ? {decision:'pause',actions:[],summary:'독립 관측 완료'} : {
     decision:'continue',actions:[{id:'list',command:'파일 목록 보여줘',expectedToolName:'filesystem.listFiles',arguments:{directory:root},dependencies:[]}]};
   }}});
  const mission=runtime.missionRuntime.createMission({objective:'작업 폴더 파일 목록 보여줘',metadata:{longTermMemory:false,conversationId:'synthetic-session'},authorization:{grants:[MissionGrant.READ_ONLY]}});
  const result=await runtime.missionRuntime.runMission(mission.missionId);
  assert.equal(result.longTermMemory,false);
  const child=runtime.coreFacade.getTask(result.waves[0].actions[0].taskId);
  assert.ok(child,JSON.stringify(result.lastError));
  assert.equal(child.request.metadata.longTermMemory,false);
  assert.equal(child.request.metadata.conversationId,'synthetic-session');
  assert.deepEqual(child.memoryContext,[]);assert.equal(child.plan.cognitiveContext,undefined);
  assert.equal(contexts[0].personalContext,null);assert.equal(contexts[0].longTermMemory,false);
  assert.equal(profileCalls,0);
  assert.equal(result.waves[0].actions[0].status,'succeeded');
 }finally{runtime?.coreFacade.cognition?.close();rmSync(root,{recursive:true,force:true});}
});

test('external Mission planner does not retrieve learned skills or archive quotes when recall disabled',async()=>{
 let skills=0,archives=0;
 const planner=new GoalExecutivePlanner({runner:async()=>JSON.stringify({decision:'pause',summary:'자료 준비 필요',actions:[],criteriaAssessment:[]}),
  skillGuidanceProvider:()=>{skills++;return [];},archivalReferenceProvider:()=>{archives++;return [];}});
 const context={longTermMemory:false,mission:{objective:'자료를 분석해줘',successCriteria:[],constraints:[],remainingBudget:{activeRuntimeMs:90000,plannerCalls:2,waves:2,actions:2}},capabilities:[],observations:[]};
 await planner.planNextWave(context);assert.equal(skills,0);assert.equal(archives,0);
 await planner.planNextWave({...context,longTermMemory:true});assert.equal(skills,1);assert.equal(archives,1);
});

test('weekly natural command persists recall choice, rejects non-boolean and retains choice on dispatch',async t=>{
 const dispatched=[];
 const scheduler=new DurableRoutineScheduler({store:new MemoryDurableRoutineStore(),missionRuntime:{
  createMission:request=>{dispatched.push(request);return {missionId:'synthetic-mission'};},runMission:async()=>({status:'COMPLETED'})}});
 const server=createCoreServer(new CoreFacade(),{adminToken:'synthetic-token',routineScheduler:scheduler});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 const call=body=>fetch(`http://127.0.0.1:${server.address().port}/routines/command`,{method:'POST',headers:{authorization:'Bearer synthetic-token','content-type':'application/json'},body:JSON.stringify(body)});
 const body={routineId:'synthetic-recall-off',command:'매주 수요일 오전 9시에 작업 폴더의 새 자료를 읽고 요약 초안을 저장해줘',longTermMemory:false};
 const response=await call(body);assert.equal(response.status,201);
 const saved=await response.json();assert.equal(saved.routine.missionRequest.metadata.longTermMemory,false);
 assert.equal((await call({...body,routineId:'synthetic-invalid',longTermMemory:'false'})).status,400);
 scheduler.clock=()=>new Date(saved.routine.scheduledAt);
 await scheduler.tick();
 assert.equal(dispatched[0].metadata.longTermMemory,false);
});
