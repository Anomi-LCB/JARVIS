import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,existsSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep,basename} from 'node:path';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {SqliteMissionStore} from '../packages/core/src/mission/sqlite-mission-store.js';
import {SqliteMemoryStore} from '../apps/growth-memory/src/db/sqlite-store.js';
const deadline=Date.parse('2026-10-07T00:06:00.000Z'),iso=ms=>new Date(ms).toISOString();
for(const mode of ['within','exact-boundary','expired','shadow-expired','completion-expired','completion-clock-back','dependency-late','proof-missing','source-changed','extra-time','invalid-offset','relative-today','relative-tomorrow','relative-expired','duration-within','duration-expired','duration-completion-expired','duration-zero','duration-fraction','duration-compound','duration-leading-fraction'])test('actual Mission completion deadline '+mode,async()=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-deadline-')),workspace=join(root,'workspace');mkdirSync(workspace);
 let now=deadline-60_000,operations,runtime,memory,adapterCalls=0;
 try{
  const clock=()=>new Date(now),target=join(workspace,'result.txt'),content='fixed deadline result';
  operations=new PersonalOperationsStore({dbPath:join(root,'operations.sqlite'),clock});
  memory=new SqliteMemoryStore({dbPath:join(root,'growth.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups'),clock});
  runtime=createAgRuntime({allowedRoots:[workspace],auditRoot:join(root,'audit'),clock,missionStore:new SqliteMissionStore({operationsStore:operations}),memoryStore:memory,workerDaemonEnabled:false,
   env:{JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'},
   missionPlanner:{async planNextWave(context){const success=context.observations.filter(o=>o.outcome==='success');if(success.length)return {decision:'complete',actions:[],criteriaAssessment:context.mission.successCriteria.map(c=>({criterionId:c.criterionId,status:'satisfied',evidenceActionIds:success.map(o=>o.actionId)}))};return {decision:'continue',actions:[{id:'write',command:'result 텍스트 파일을 만들어줘',expectedToolName:'filesystem.createTextFile',arguments:{path:target,content},dependencies:[],requirementIds:[context.mission.goalContract.requirements[0].requirementId]}]};}}});
  const expectedDeadline=mode.startsWith('duration-')?now+(mode==='duration-compound'?90_000:30_000):mode==='relative-tomorrow'?deadline+86400000:deadline;
  const prefix=mode.startsWith('duration-')?(mode==='duration-compound'?'지금부터 1분 30초 이내':mode==='duration-leading-fraction'?'.5시간 이내':mode==='duration-zero'?'0초 이내':mode==='duration-fraction'?'0.5시간 이내':'지금부터 30초 이내'):mode.startsWith('relative-')?(mode==='relative-tomorrow'?'내일':'오늘')+' 오전 9시 6분':mode==='invalid-offset'?'2026-10-07T09:06:00+09:60':iso(deadline);
  const objective=prefix+(mode.startsWith('duration-')?' ':'까지 ')+(mode==='extra-time'?'내일 오전 9시에 ':'')+"'result.txt' 파일을 만들어줘";
  const created=runtime.missionRuntime.createMission({objective,successCriteria:[{criterionId:'fixed',statement:'fixed content',verificationSpec:{version:1,kind:'text.equals',path:'result.txt',equals:content}}],authorization:{mode:'supervised',grants:['read_only','local_reversible']}});
  // Keep the independent effect lease alive long enough to reach the injected
  // completion clock rollback; lease expiry has its own existing regressions.
  if(mode==='completion-clock-back')runtime.missionRuntime.effectCoordinator.leaseTtlMs=120_000;
  const adapter=runtime.pcAgent.registry.get('filesystem.createTextFile'),execute=adapter.execute.bind(adapter),shadow=adapter.shadow.bind(adapter);let shadowCalls=0;
  adapter.execute=async(...args)=>{const result=await execute(...args);adapterCalls++;return result;};
  adapter.shadow=async(...args)=>{const result=await shadow(...args);if(++shadowCalls===2){if(mode==='shadow-expired')now=deadline+1;if(mode==='completion-clock-back')now=deadline-30_000;}return result;};
  const complete=runtime.missionRuntime.completeMission.bind(runtime.missionRuntime);
  runtime.missionRuntime.completeMission=(mission,result)=>{
   if(mode==='completion-expired')now=deadline+1;
   if(mode==='duration-completion-expired')now=expectedDeadline+1;
   if(mode==='completion-clock-back')now=deadline-60_000;
   if(mode==='dependency-late')runtime.missionRuntime.personalDependencyGuard={assertCurrentMission(){now=deadline+1;}};
   if(mode==='proof-missing')delete mission.waves[0].actions[0].deadlineTemporalVerification;
   if(mode==='source-changed')mission.objective=iso(deadline+60_000)+"까지 'result.txt' 파일을 만들어줘";
   return complete(mission,result);
  };
  if(mode==='exact-boundary')now=deadline;
  if(mode==='expired'||mode==='relative-expired')now=deadline+1;
  if(mode==='duration-expired')now=expectedDeadline+1;
  const result=await runtime.missionRuntime.runMission(created.missionId);
  const mission=runtime.missionRuntime.missions.get(created.missionId);
  if(['within','exact-boundary','relative-today','relative-tomorrow','duration-within','duration-compound'].includes(mode)){
   assert.equal(result.status,'COMPLETED',JSON.stringify({status:result.status,reason:result.stopReason,error:result.lastError}));
   assert.equal(adapterCalls,1);assert.equal(readFileSync(target,'utf8'),content);
   assert.equal(mission.completion.deadlineTiming.completionDeadlineVerified,true);assert.equal(mission.completion.deadlineTiming.deadlineAt,iso(expectedDeadline));
   assert.equal(mission.completion.deadlineTiming.checkedAt,iso(now));
  }else if(['duration-completion-expired','completion-expired','completion-clock-back','dependency-late','proof-missing','source-changed'].includes(mode)){
   assert.equal(adapterCalls,1);assert.equal(readFileSync(target,'utf8'),content);assert.notEqual(result.status,'COMPLETED');
   assert.equal(mission.stopReason,'completion-deadline-unverified');
  }else{assert.equal(adapterCalls,0);assert.equal(existsSync(target),false);assert.notEqual(result.status,'COMPLETED');}
  const saved=new SqliteMissionStore({operationsStore:operations}).load().find(m=>m.missionId===created.missionId);
  assert.equal(saved.status,mission.status);if(mission.completion)assert.deepEqual(saved.completion.deadlineTiming,mission.completion.deadlineTiming);
  console.log(JSON.stringify({actualCoreEBG:true,actualSQL:true,mode,adapterCalls,status:mission.status,deadlineProof:mission.completion?.deadlineTiming??null,stopReason:mission.stopReason}));
 }finally{
  await runtime?.missionRuntime.requestShutdown({reason:'isolated-deadline-cleanup'});runtime?.coreFacade.cognition.close();memory?.close();operations?.close();
  assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep)&&basename(root).startsWith('jarvis-deadline-'));rmSync(root,{recursive:true,force:true});
 }
});
