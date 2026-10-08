import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,basename} from 'node:path';
import {createGoalContract} from '../packages/core/src/mission/goal-contract.js';
import {assessMissionRequirementCoverage} from '../packages/core/src/mission/mission-requirement-coverage.js';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {MissionGrant} from '../packages/core/src/mission/mission-runtime.js';
const writeProfile={toolName:'filesystem.createTextFile',readOnly:false,mutatesSystem:true,externalNetwork:false,externalTransfer:false,executionClass:'local_reversible'};
const readProfile={toolName:'filesystem.readText',readOnly:true,contractReadOnly:true,mutatesSystem:false,externalNetwork:false,externalTransfer:false,executionClass:'read_only'};
function fixture(objective){
 const goalContract=createGoalContract({objective,referenceTime:'2026-10-07T00:00:00Z'});
 const action={actionId:'write',expectedToolName:'filesystem.createTextFile',actualToolName:'filesystem.createTextFile',arguments:{path:resolve('report.txt'),content:'unexpected early write'},requirementIds:goalContract.requirements.map(r=>r.requirementId),constraintRequirementIds:[],dependencies:[]};
 const wave={actions:[action]},mission={objective,goalContract,waves:[wave],observations:[],constraints:[],workspaceRoot:process.cwd()};
 return {mission,wave,action};
}
for(const prefix of ['내일 오후 3시에','2026-10-08T15:00:00+09:00에','2026-02-30 오전 2시에','회의 끝난 뒤','5영업일 이내','2026-10-07T15:00:00+09:60까지'])test('local write cannot ignore temporal condition '+prefix,()=>{
 const f=fixture(`${prefix} 'report.txt'를 저장해`);
 const result=assessMissionRequirementCoverage({...f,profile:writeProfile});
 assert.equal(result.allowed,false);assert.ok(result.reasons.some(r=>/^goal-time-/u.test(r.code)),JSON.stringify(result));
 // Planner or old persisted metadata cannot erase timing in the actual source.
 f.mission.goalContract.times=[];
 const hidden=assessMissionRequirementCoverage({...f,profile:writeProfile});
 assert.equal(hidden.allowed,false);assert.ok(hidden.reasons.some(r=>/^goal-time-/u.test(r.code)));
});
test('time-looking quoted filename remains data and unrelated read can continue',()=>{
 const literal=fixture("'2026-10-08T15:00:00Z.txt'를 저장해");
 assert.equal(assessMissionRequirementCoverage({...literal,profile:writeProfile}).allowed,true);
 const timed=fixture("내일 오후 3시에 'report.txt'를 저장해");
 timed.action.actualToolName='filesystem.readText';timed.action.expectedToolName='filesystem.readText';
 assert.equal(assessMissionRequirementCoverage({...timed,profile:readProfile}).allowed,true);
});
for(const prefix of ['내일 오후 3시에','2026-10-08T15:00:00+09:00에','2026-02-30 오전 2시에'])test('actual Mission stops timed local mutation before B '+prefix,async()=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-timed-write-'));let runtime,workerCalls=0;
 try{
  const target=join(root,'report.txt');await writeFile(target,'preserved original');
  const objective=`${prefix} 'report.txt'를 저장해`;
  const planner={async planNextWave(context){return {decision:'continue',actions:[{id:'write',title:'timed test write',command:'report 메모 파일을 만들어줘. 내용은 premature',expectedToolName:'filesystem.createTextFile',arguments:{path:target,content:'premature'},requirementIds:context.mission.goalContract.requirements.map(r=>r.requirementId),dependencies:[]}],criteriaAssessment:[]};}};
  runtime=createAgRuntime({allowedRoots:[root],auditRoot:join(root,'audit'),missionStorePath:join(root,'missions.json'),env:{JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'},missionPlanner:planner,workerDaemonEnabled:false,clock:()=>new Date('2026-10-07T00:00:00Z')});
  const original=runtime.orchestrationWorker.runTask.bind(runtime.orchestrationWorker);
  runtime.orchestrationWorker.runTask=async(...args)=>{workerCalls++;return original(...args);};
  const created=runtime.missionRuntime.createMission({objective,authorization:{grants:[MissionGrant.READ_ONLY,MissionGrant.LOCAL_REVERSIBLE]}});
  const result=await runtime.missionRuntime.runMission(created.missionId,{maxWaves:1});
  assert.notEqual(result.status,'COMPLETED');assert.equal(workerCalls,0);
  assert.equal(await readFile(target,'utf8'),'preserved original');
  const action=runtime.missionRuntime.missions.get(created.missionId).waves.flatMap(w=>w.actions)[0];
  assert.equal(action.requirementCoverage.allowed,false);assert.ok(action.requirementCoverage.reasons.some(r=>/^goal-time-/u.test(r.code)),JSON.stringify(action.requirementCoverage));
  console.log(JSON.stringify({actualMission:true,prefix,workerCalls,originalPreserved:true,scheduledExecutionVerified:false}));
 }finally{
  runtime?.coreFacade.cognition.close();assert.ok(resolve(root).startsWith(resolve(tmpdir())+'\\'));assert.ok(basename(root).startsWith('jarvis-timed-write-'));await rm(root,{recursive:true,force:true});
 }
});
for(const mode of ['untimed-write','read-before-timed-write'])test('actual positive local work remains available '+mode,async()=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-time-positive-'));let runtime,workerCalls=0;
 try{
  const source=join(root,'source.txt'),target=join(root,'report.txt');await writeFile(source,'fixed source');
  const objective=mode==='untimed-write'?"'report.txt' 파일을 만들어줘":"'source.txt'를 읽어; 내일 오후 3시에 'report.txt'를 저장해";
  const planner={async planNextWave(context){
   const requirements=context.mission.goalContract.requirements;
   const actions=[];
   if(mode==='read-before-timed-write')actions.push({id:'read',title:'independent source read',command:'source.txt 내용을 읽어줘',expectedToolName:'filesystem.readText',arguments:{path:source},requirementIds:[requirements[0].requirementId],dependencies:[]});
   actions.push({id:'write',title:'local file creation',command:'report 메모 파일을 만들어줘. 내용은 fixed result',expectedToolName:'filesystem.createTextFile',arguments:{path:target,content:'fixed result'},requirementIds:[requirements.at(-1).requirementId],dependencies:mode==='untimed-write'?[]:['read']});
   return {decision:'continue',actions,criteriaAssessment:[]};
  }};
  runtime=createAgRuntime({allowedRoots:[root],auditRoot:join(root,'audit'),missionStorePath:join(root,'missions.json'),env:{JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'},missionPlanner:planner,workerDaemonEnabled:false,clock:()=>new Date('2026-10-07T00:00:00Z')});
  const original=runtime.orchestrationWorker.runTask.bind(runtime.orchestrationWorker);
  runtime.orchestrationWorker.runTask=async(...args)=>{workerCalls++;return original(...args);};
  const criteria=mode==='untimed-write'?[{criterionId:'fixed-content',statement:'fixed file content',verificationSpec:{version:1,kind:'text.equals',path:'report.txt',equals:'fixed result'}}]:[];
  const m=runtime.missionRuntime.createMission({objective,successCriteria:criteria,authorization:{grants:[MissionGrant.READ_ONLY,MissionGrant.LOCAL_REVERSIBLE]}});
  const result=await runtime.missionRuntime.runMission(m.missionId,{maxWaves:1});
  assert.equal(workerCalls,1);
  if(mode==='untimed-write'){
   assert.equal(result.status,'COMPLETED',JSON.stringify({status:result.status,reason:result.stopReason,observations:result.observations}));
   assert.equal(await readFile(target,'utf8'),'fixed result');
  }else{
   assert.notEqual(result.status,'COMPLETED');await assert.rejects(readFile(target),{code:'ENOENT'});
   assert.ok(result.observations.some(o=>o.toolName==='filesystem.readText'&&o.outcome==='success'&&o.verification?.status==='passed'));
  }
  assert.equal(await readFile(source,'utf8'),'fixed source');
  console.log(JSON.stringify({actualCoreEBG:true,mode,workerCalls,writeCompleted:mode==='untimed-write',timedWriteDispatched:false}));
 }finally{
  runtime?.coreFacade.cognition.close();assert.ok(resolve(root).startsWith(resolve(tmpdir())+'\\'));assert.ok(basename(root).startsWith('jarvis-time-positive-'));await rm(root,{recursive:true,force:true});
 }
});
