import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,basename} from 'node:path';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {SqliteMissionStore} from '../packages/core/src/mission/sqlite-mission-store.js';
import {SqliteDurableRoutineStore} from '../packages/core/src/runtime/durable-routine-store.js';
import {DurableRoutineScheduler} from '../packages/core/src/runtime/durable-routine-scheduler.js';
import {routineMissionRequest} from '../packages/core/src/runtime/routine-mission-temporal-guard.js';
import {SqliteMemoryStore} from '../apps/growth-memory/src/db/sqlite-store.js';
const due=Date.parse('2026-10-07T00:01:00.000Z'),iso=ms=>new Date(ms).toISOString();
for(const mode of ['on-time','inline-source-time','inline-source-mismatch','direct-run-forged-metadata','late-shadow','clock-back-shadow','same-owner-new-attempt','changed-request-shadow','changed-mission-objective','changed-goal-revision','late-completion','changed-claim-completion','missing-dispatch-proof','changed-dispatch-proof'])test('actual SQL Core/E/B/G scheduled temporal binding '+mode,async()=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-routine-time-')),workspace=join(root,'workspace');mkdirSync(workspace);
 let now=due-60_000,operations,runtime,adapterCalls=0,shadowCalls=0;
 try{
  const clock=()=>new Date(now);operations=new PersonalOperationsStore({dbPath:join(root,'operations.sqlite'),clock});
  const target=join(workspace,'result.txt'),content='fixed temporal result';
  runtime=createAgRuntime({allowedRoots:[workspace],auditRoot:join(root,'audit'),missionStore:new SqliteMissionStore({operationsStore:operations}),workerDaemonEnabled:false,clock,
   memoryStore:new SqliteMemoryStore({dbPath:join(root,'growth.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups'),clock}),
   env:{JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'},
   missionPlanner:{async planNextWave(context){if(context.observations.some(item=>item.outcome==='success'))return {decision:'complete',actions:[],criteriaAssessment:context.mission.successCriteria.map(c=>({criterionId:c.criterionId,status:'satisfied',evidenceActionIds:context.observations.map(o=>o.actionId)}))};return {decision:'continue',actions:[{id:'write',command:'result 메모 파일을 만들어줘. 내용은 fixed temporal result',expectedToolName:'filesystem.createTextFile',arguments:{path:target,content},dependencies:[],requirementIds:[context.mission.goalContract.requirements[0].requirementId]}],criteriaAssessment:[]};}}});
  const store=new SqliteDurableRoutineStore({operationsStore:operations}),scheduler=new DurableRoutineScheduler({store,missionRuntime:runtime.missionRuntime,clock,ownerId:'timed-worker',lateGraceMs:300_000});
  scheduler.schedule({routineId:'timed-local',...(mode.startsWith('inline-')?{scheduleText:'오늘 오전 9시 1분'}:{scheduledAt:iso(due)}),missionRequest:{objective:(mode==='inline-source-time'?'오늘 오전 9시 1분에 ':mode==='inline-source-mismatch'?'오늘 오전 9시 2분에 ':'')+"'result.txt' 파일을 만들어줘",successCriteria:[{criterionId:'exact',statement:'fixed result text',verificationSpec:{version:1,kind:'text.equals',path:'result.txt',equals:content}}],authorization:{mode:'supervised',grants:['read_only','local_reversible']}}});
  const early=await scheduler.tick();assert.equal(early.processed.length,0);assert.equal(runtime.missionRuntime.missions.size,0);
  if(mode==='direct-run-forged-metadata'){
   const created=runtime.missionRuntime.createMission(routineMissionRequest(store.get('timed-local')));
   const rejected=await runtime.missionRuntime.runMission(created.missionId);
   assert.equal(rejected.error.code,'A_ROUTINE_TEMPORAL_CONTEXT_REQUIRED');assert.equal(existsSync(target),false);
  }
  const adapter=runtime.pcAgent.registry.get('filesystem.createTextFile'),execute=adapter.execute.bind(adapter),shadow=adapter.shadow.bind(adapter);
  adapter.execute=async(...args)=>{const result=await execute(...args);adapterCalls++;return result;};
  adapter.shadow=async(...args)=>{
   const result=await shadow(...args);shadowCalls++;
   if(shadowCalls===2){
   if(mode==='late-shadow')now=due+300_001;
   if(mode==='clock-back-shadow')now=due-1;
   if(mode==='same-owner-new-attempt')assert.ok(store.claimRecovery('timed-local',{expectedOwnerId:'timed-worker',ownerId:'timed-worker',nowIso:iso(now)}));
   if(mode==='changed-request-shadow')assert.ok(store.transitionDispatch('timed-local',{expectedOwnerId:'timed-worker',expectedAttempts:1,status:'dispatching',patch:{missionRequest:{...store.get('timed-local').missionRequest,objective:'changed original request'}}}));
   if(mode==='changed-mission-objective')[...runtime.missionRuntime.missions.values()][0].objective='changed Mission objective';
   if(mode==='changed-goal-revision')[...runtime.missionRuntime.missions.values()][0].goalContract.revision=2;
   }
   return result;
  };
  const complete=runtime.missionRuntime.completeMission.bind(runtime.missionRuntime);
  runtime.missionRuntime.completeMission=(mission,result)=>{
   if(mode==='late-completion')now=due+300_001;
   if(mode==='changed-claim-completion')assert.ok(store.claimRecovery('timed-local',{expectedOwnerId:'timed-worker',ownerId:'new-worker',nowIso:iso(now)}));
   if(mode==='missing-dispatch-proof')delete mission.waves[0].actions[0].scheduleTemporalVerification;
   if(mode==='changed-dispatch-proof')mission.waves[0].actions[0].scheduleTemporalVerification.scheduledFor=iso(due+1);
   return complete(mission,result);
  };
  now=due;await scheduler.tick();
  const mission=[...runtime.missionRuntime.missions.values()][0];assert.ok(mission);assert.equal(shadowCalls,mode==='inline-source-mismatch'?0:2);
  if(['on-time','inline-source-time','direct-run-forged-metadata','late-completion'].includes(mode)){
   assert.equal(adapterCalls,1);assert.equal(mission.status,'COMPLETED',JSON.stringify({status:mission.status,error:mission.lastError,observations:mission.observations,waves:mission.waves}));
   assert.equal(readFileSync(target,'utf8'),content);assert.equal(store.get('timed-local').status,'completed');
   const proof=mission.completion.scheduleTiming;assert.equal(proof.dispatchTimingVerified,true);assert.equal(proof.verifiedDispatchCount,1);assert.equal(proof.completionDeadlineVerified,false);
   assert.equal(proof.checkedAt,iso(now));assert.equal(proof.scheduledFor,iso(due));
  }else if(['changed-claim-completion','missing-dispatch-proof','changed-dispatch-proof'].includes(mode)){
   assert.equal(adapterCalls,1);assert.equal(readFileSync(target,'utf8'),content);assert.notEqual(mission.status,'COMPLETED');
   assert.equal(mission.stopReason,'routine-temporal-completion-unverified');
   assert.equal(store.get('timed-local').ownerId,mode==='changed-claim-completion'?'new-worker':'timed-worker');
   assert.equal(store.get('timed-local').status,mode==='changed-claim-completion'?'dispatching':'blocked');
  }else{
   assert.equal(adapterCalls,0);assert.equal(existsSync(target),false);assert.notEqual(mission.status,'COMPLETED');
  }
  const persisted=new SqliteMissionStore({operationsStore:operations}).load().find(m=>m.missionId===mission.missionId);
  assert.equal(persisted.status,mission.status);
  if(mission.status==='COMPLETED')assert.deepEqual(persisted.completion.scheduleTiming,mission.completion.scheduleTiming);
  console.log(JSON.stringify({actualCoreEBG:true,actualSQLite:true,mode,adapterCalls,shadowCalls,missionStatus:mission.status,routineStatus:store.get('timed-local').status,scheduledFor:iso(due),finishedClock:iso(now),scheduleTiming:mission.completion?.scheduleTiming??null}));
 }finally{
  await runtime?.missionRuntime.requestShutdown({reason:'isolated-cleanup'});runtime?.coreFacade.cognition.close();runtime?.growthRuntime.ingestor.store.close();operations?.close();
  assert.ok(resolve(root).startsWith(resolve(tmpdir())+'\\'));assert.ok(basename(root).startsWith('jarvis-routine-time-'));rmSync(root,{recursive:true,force:true});
 }
});


