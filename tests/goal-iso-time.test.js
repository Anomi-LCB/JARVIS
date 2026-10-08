import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,basename} from 'node:path';
import {createGoalContract,checkGoalPlanCoverage} from '../packages/core/src/mission/goal-contract.js';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {assessMissionRequirementCoverage} from '../packages/core/src/mission/mission-requirement-coverage.js';
const valid=[
 ['2026-10-07T10:30:00+09:00','2026-10-07T01:30:00.000Z','+09:00'],
 ['2026-10-07T10:30:00Z','2026-10-07T10:30:00.000Z','Z'],
 ['2026-10-07T00:15:00+05:45','2026-10-06T18:30:00.000Z','+05:45'],
 ['2026-10-07T23:30:00-03:30','2026-10-08T03:00:00.000Z','-03:30'],
 ['2026-10-07T10:30+00:00','2026-10-07T10:30:00.000Z','+00:00'],
 ['2026-11-01T01:30:00-04:00','2026-11-01T05:30:00.000Z','-04:00'],
 ['2026-11-01T01:30:00-05:00','2026-11-01T06:30:00.000Z','-05:00'],
 ['2024-02-29T23:59:59.123Z','2024-02-29T23:59:59.123Z','Z']
];
for(const [timestamp,instant,offset] of valid)test('preserve exact timestamp '+timestamp,()=>{
 const objective=`📚 ${timestamp}까지 'report.txt'를 저장해`;
 const contract=createGoalContract({objective,timeZone:'America/New_York'});
 assert.equal(contract.times.length,1);const time=contract.times[0];
 assert.equal(time.kind,'date-time');assert.equal(time.status,'parsed-instant');assert.equal(time.instant,instant);
 assert.equal(time.offset,offset);assert.equal(time.timeZone,null);assert.equal(time.text,timestamp);
 assert.equal(objective.slice(time.sourceSpan.start,time.sourceSpan.end),timestamp);
});
for(const timestamp of ['2026-02-30T12:00:00Z','2026-10-07T24:00:00Z','2026-10-07T12:60:00Z','2026-10-07T12:00:60Z','2026-10-07T12:00:00+24:00','2026-10-07T12:00:00+09:60','2026-10-07T12:00:00.1234Z','2026-10-07T12:00:00','2026-10-07T12:00:00-00:00','2026-10-07T12:00:00UTC','2026-10-07T'])test('invalid or ambiguous timestamp remains whole '+timestamp,()=>{
 const objective=`${timestamp}에 'report.txt'를 보내`;
 const contract=createGoalContract({objective});
 assert.equal(contract.times.length,1);assert.equal(contract.times[0].text,timestamp);
 assert.equal(contract.times[0].status,'unresolved');assert.equal(contract.times[0].instant,null);
 assert.equal(checkGoalPlanCoverage(contract,[]).canDispatchExternalEffects,false);
});
test('terminal punctuation is not swallowed into the timestamp',()=>{
 const c=createGoalContract({objective:"'report.txt'를 저장해. 기한은 2026-10-07T10:30:00Z. 원본은 삭제하지 마."});
 assert.equal(c.times.length,1);assert.equal(c.times[0].text,'2026-10-07T10:30:00Z');assert.equal(c.times[0].instant,'2026-10-07T10:30:00.000Z');
});
test('invalid offset is visible to the existing external dispatch guard',()=>{
 const objective="2026-10-07T10:30:00+09:60에 'report.txt'를 보내";
 const goalContract=createGoalContract({objective});
 const action={actionId:'send',expectedToolName:'email.send',actualToolName:'email.send',arguments:{},requirementIds:goalContract.requirements.map(r=>r.requirementId),constraintRequirementIds:[],dependencies:[]};
 const wave={actions:[action]},mission={objective,goalContract,waves:[wave],observations:[],constraints:[],workspaceRoot:process.cwd()};
 const assessed=assessMissionRequirementCoverage({mission,wave,action,profile:{toolName:'email.send',externalTransfer:true,externalNetwork:true,readOnly:false,executionClass:'external_commit'},phase:'dispatch'});
 assert.equal(assessed.allowed,false);assert.ok(assessed.reasons.some(r=>r.code==='goal-time-unresolved'));
});
test('quoted timestamp data stays literal and ordinary local time still uses requested zone',()=>{
 const c=createGoalContract({objective:"'2026-10-07T12:00:00Z.txt'를 읽어; 2026-10-07 오후 3시 'report.txt'를 저장해",timeZone:'Asia/Seoul'});
 assert.deepEqual(c.times.map(t=>[t.text,t.kind,t.status]),[['2026-10-07','date','parsed-date'],['오후 3시','time-of-day','parsed-time']]);
});
test('real Mission persists and passes original explicit offset to planner without authorizing execution',async()=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-iso-goal-'));const runtimes=[];let received;
 try{
  const options={allowedRoots:[root],auditRoot:join(root,'audit'),missionStorePath:join(root,'missions.json'),workerDaemonEnabled:false,env:{},missionPlanner:{async planNextWave(context){received=context.mission.goalContract;return {decision:'blocked',blockedReason:'no scheduled provider configured',actions:[],criteriaAssessment:[]};}}};
  const first=createAgRuntime(options);runtimes.push(first);
  const objective="2026-10-07T10:30:00+09:00까지 'report.txt'를 저장해";
  const created=first.missionRuntime.createMission({objective});assert.equal(created.success,true);
  const second=createAgRuntime(options);runtimes.push(second);
  assert.deepEqual(second.missionRuntime.getMission(created.missionId).goalContract,created.goalContract);
  const result=await second.missionRuntime.runMission(created.missionId);assert.notEqual(result.status,'COMPLETED');
  assert.equal(received.times[0].instant,'2026-10-07T01:30:00.000Z');assert.equal(received.times[0].offset,'+09:00');
  assert.equal(received.executionAuthorized,false);
  console.log(JSON.stringify({actualMissionPersistence:true,actualPlannerHandoff:true,explicitOffsetPreserved:true,effectsExecuted:0,schedulingEnabled:false}));
 }finally{
  for(const runtime of runtimes)runtime.coreFacade.cognition.close();
  assert.ok(resolve(root).startsWith(resolve(tmpdir())+'\\'));assert.ok(basename(root).startsWith('jarvis-iso-goal-'));
  await rm(root,{recursive:true,force:true});
 }
});
