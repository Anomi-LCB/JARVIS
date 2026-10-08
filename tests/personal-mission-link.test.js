import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { createCoreServer } from '../packages/core/src/main.mjs';
import { listenOnFetchSafePort } from '../packages/shared/src/http.js';
import { PersonalOperationsStore } from '../packages/core/src/personal-operations/operations-store.js';
import { PersonalOperationsMissionLink } from '../packages/core/src/personal-operations/mission-link.js';

const request={objective:'작업 폴더 파일 목록 확인',successCriteria:['파일 목록을 검증한다']};
function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'jarvis-personal-mission-'));
  writeFileSync(join(root,'evidence.txt'),'actual local evidence');
  const store=new PersonalOperationsStore({dbPath:join(root,'ops.sqlite')});
  store.createCommitment({title:'자료 확인',dueAt:'2026-01-01T00:00:00Z',sourceRef:'user:test'});
  const id=store.tick().followUps[0].id;
  const open=()=>createAgRuntime({allowedRoots:[root],auditRoot:join(root,'audit'),cwd:()=>root,env:{},workerDaemonEnabled:false,missionStorePath:join(root,'missions.json'),missionPlanner:{async planNextWave(context){
    const success=context.observations.find(o=>o.outcome==='success');
    return success?{decision:'complete',summary:'검증 완료',actions:[],criteriaAssessment:context.mission.successCriteria.map(c=>({criterionId:c.criterionId,status:'satisfied',evidenceActionIds:[success.actionId],reason:'파일 조회 검증'}))}:{decision:'continue',summary:'파일 조회',criteriaAssessment:[],actions:[{id:'read',title:'자료 확인',command:'작업 폴더 파일 목록 보여줘',expectedToolName:'filesystem.listFiles',dependencies:[],successSignal:'목록 반환'}]};
  }}});
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  const runtime=open();return {store,id,open,runtime,link:new PersonalOperationsMissionLink({store,missionRuntime:runtime.missionRuntime})};
}
test('dispatch retries and lost binding recover the same persisted mission after runtime restart',t=>{
  const f=fixture(t),a=f.link.dispatch(f.id,request);
  assert.equal(f.link.dispatch(f.id,request).missionId,a.missionId);
  assert.throws(()=>f.link.dispatch(f.id,{...request,objective:'다른 명령'}),/CONFLICT/);
  f.store.db.prepare('UPDATE personal_mission_links SET mission_id=NULL WHERE followup_id=?').run(f.id);
  const restarted=f.open(),link=new PersonalOperationsMissionLink({store:f.store,missionRuntime:restarted.missionRuntime});
  assert.equal(link.dispatch(f.id,request).missionId,a.missionId);
  assert.equal(restarted.missionRuntime.missions.size,1);
});
test('real local execution and G verification resolve only the followup',async t=>{
  const f=fixture(t);f.link.dispatch(f.id,request);
  const result=await f.link.run(f.id);
  assert.equal(result.mission.status,'COMPLETED',JSON.stringify(result));assert.equal(result.verified,true);
  assert.equal(f.store.summary().followUps[0].state,'done');
  assert.equal(f.store.summary().commitments[0].state,'open');
});
test('cancellation and incomplete evidence cannot falsely resolve a followup',t=>{
  const f=fixture(t),mission=f.link.dispatch(f.id,request);
  assert.equal(f.link.cancel(f.id).mission.status,'CANCELLED');
  const fake=new PersonalOperationsMissionLink({store:f.store,missionRuntime:{getMission:()=>({...mission,status:'COMPLETED',completion:{status:'verified',successfulActionCount:0,criteria:[]}})}});
  assert.equal(fake.refresh(f.id).verified,false);assert.equal(f.store.summary().followUps[0].state,'pending');
  assert.throws(()=>f.link.dispatch(f.id,{...request,authorization:{grants:['all']}}),/INVALID/);
});
test('authenticated HTTP dispatch and run use the same execution path; anonymous access is denied',async t=>{
  const f=fixture(t),server=createCoreServer(f.runtime.coreFacade,{adminToken:'personal-test-token',missionRuntime:f.runtime.missionRuntime,personalOperations:f.link});
  const address=await listenOnFetchSafePort(server,{host:'127.0.0.1',port:0});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url=`http://127.0.0.1:${address.port}/personal-operations/followups/${encodeURIComponent(f.id)}`;
  assert.equal((await fetch(url+'/dispatch',{method:'POST',body:JSON.stringify(request)})).status,401);
  const post=(operation,body={})=>fetch(url+'/'+operation,{method:'POST',headers:{authorization:'Bearer personal-test-token','content-type':'application/json'},body:JSON.stringify(body)});
  const created=await post('dispatch',request);assert.equal(created.status,200);
  const cli=await new Promise(resolve=>{
    const child=spawn(process.execPath,['scripts/personal-mission.mjs','refresh',f.id],{env:{...process.env,JARVIS_CORE_URL:`http://127.0.0.1:${address.port}`,JARVIS_CORE_ADMIN_TOKEN:'personal-test-token'},windowsHide:true});
    let out='',err='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);child.on('close',code=>resolve({code,out,err}));
  });
  assert.equal(cli.code,0,cli.err);assert.equal(JSON.parse(cli.out).mission.status,'CREATED');
  const run=await post('run');assert.equal(run.status,200);assert.equal((await run.json()).verified,true);
});
test('a write proposed under read-only authorization waits for a gate and keeps the followup pending',async t=>{
  const f=fixture(t);
  f.runtime.missionRuntime.planner={async planNextWave(){return {decision:'continue',summary:'쓰기 요청',criteriaAssessment:[],actions:[{id:'write',title:'메모',command:'personal-result 메모 파일을 만들어줘. 내용은 테스트',expectedToolName:'filesystem.createTextFile',dependencies:[],successSignal:'파일 생성'}]};}};
  f.link.dispatch(f.id,request);const result=await f.link.run(f.id);
  assert.equal(result.mission.status,'WAITING_APPROVAL',JSON.stringify(result));
  assert.equal(result.verified,false);assert.equal(f.store.summary().followUps[0].state,'pending');
});

test('deadline revision invalidates linked execution and prevents stale G completion from resolving followup',async t=>{
 const f=fixture(t),mission=f.link.dispatch(f.id,request),commitment=f.store.summary().commitments[0];
 f.store.changeDeadline(commitment.id,{dueAt:'2027-01-01T00:00:00Z',expectedRevision:1,changeId:'mission-deadline-change'});
 await assert.rejects(f.link.run(f.id),/REPLAN_REQUIRED/);assert.throws(()=>f.link.dispatch(f.id,request),/REPLAN_REQUIRED/);
 const observed=f.link.refresh(f.id);assert.equal(observed.dependencyCurrent,false);assert.equal(observed.requiresReplan,true);
 const actual=await f.runtime.missionRuntime.runMission(mission.missionId);assert.equal(actual.error.code,'A_PERSONAL_LINK_DEPENDENCY_CHANGED');
 const stale=f.link.refresh(f.id);assert.equal(stale.verified,false);assert.equal(f.store.summary().followUps[0].state,'pending');
 const restarted=f.open(),link=new PersonalOperationsMissionLink({store:f.store,missionRuntime:restarted.missionRuntime});
 await assert.rejects(link.run(f.id),/REPLAN_REQUIRED/);assert.equal(link.refresh(f.id).requiresReplan,true);
});

test('replanning archives terminal links, creates one revision-specific mission and resumes after a lost binding',async t=>{
 const f=fixture(t),prior=f.link.dispatch(f.id,request),commitment=f.store.summary().commitments[0];
 f.store.changeDeadline(commitment.id,{dueAt:'2027-01-01T00:00:00Z',expectedRevision:1,changeId:'replan-change'});
 assert.throws(()=>f.link.replan(f.id,{expectedRevision:1,request}),/REVISION_CONFLICT/);
 assert.throws(()=>f.link.replan(f.id,{expectedRevision:2,request}),/PREVIOUS_NOT_TERMINAL/);
 f.link.cancel(f.id);
 const next=f.link.replan(f.id,{expectedRevision:2,request});assert.notEqual(next.missionId,prior.missionId);
 assert.equal(f.link.replan(f.id,{expectedRevision:2,request}).missionId,next.missionId);
 assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM personal_mission_link_history').get().n,1);
 assert.equal(f.runtime.missionRuntime.getMission(prior.missionId).status,'CANCELLED');assert.throws(()=>f.link.assertCurrentMission({missionId:prior.missionId}),/DEPENDENCY_CHANGED/);
 f.store.db.prepare('UPDATE personal_mission_links SET mission_id=NULL WHERE followup_id=?').run(f.id);
 const restarted=f.open(),link=new PersonalOperationsMissionLink({store:f.store,missionRuntime:restarted.missionRuntime});
 assert.equal(link.replan(f.id,{expectedRevision:2,request}).missionId,next.missionId);assert.equal(restarted.missionRuntime.missions.size,2);
 assert.equal((await link.run(f.id)).verified,true);assert.equal(f.store.summary().commitments[0].state,'open');
});


test('replan HTTP requires administrator access and creates without automatically executing',async t=>{
 const f=fixture(t);f.link.dispatch(f.id,request);const c=f.store.summary().commitments[0];
 f.store.changeDeadline(c.id,{dueAt:'2027-01-01T00:00:00Z',expectedRevision:1,changeId:'http-replan'});f.link.cancel(f.id);
 const server=createCoreServer(f.runtime.coreFacade,{adminToken:'replan-admin',adminTokens:[{token:'replan-reader',scopes:['read_diagnostics']}],missionRuntime:f.runtime.missionRuntime,personalOperations:f.link});await listenOnFetchSafePort(server,{host:'127.0.0.1',port:0});t.after(()=>new Promise(r=>server.close(r)));
 const url=`http://127.0.0.1:${server.address().port}/personal-operations/followups/${encodeURIComponent(f.id)}/replan`;
 const send=token=>fetch(url,{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify({expectedRevision:2,request})});
 assert.equal((await send()).status,401);assert.equal((await send('replan-reader')).status,403);
 const detailUrl=url.replace('/replan','');assert.equal((await fetch(detailUrl)).status,401);assert.equal((await fetch(detailUrl,{headers:{authorization:'Bearer replan-reader'}})).status,403);
 const created=await send('replan-admin');assert.equal(created.status,200);const mission=await created.json();assert.equal(mission.status,'CREATED');assert.equal(f.store.summary().followUps[0].state,'pending');
 assert.equal((await (await send('replan-admin')).json()).missionId,mission.missionId);
 const detailResponse=await fetch(detailUrl,{headers:{authorization:'Bearer replan-admin'}});assert.equal(detailResponse.status,200);assert.equal(detailResponse.headers.get('cache-control'),'no-store');const detail=await detailResponse.json();assert.equal(detail.missionId,mission.missionId);assert.equal(detail.dependencyCurrent,true);assert.match(detail.requestFingerprint,/^[a-f0-9]{64}$/);
});

test('deadline change while the real planner is waiting fences completion at refresh',async t=>{
 const f=fixture(t),original=f.runtime.missionRuntime.planner.planNextWave.bind(f.runtime.missionRuntime.planner);
 let release,entered;const waiting=new Promise(r=>{entered=r;});let held=false;
 f.runtime.missionRuntime.planner.planNextWave=async context=>{if(!held){held=true;entered();await new Promise(r=>{release=r;});}return original(context);};
 f.link.dispatch(f.id,request);const running=f.link.run(f.id);await waiting;
 const c=f.store.summary().commitments[0];f.store.changeDeadline(c.id,{dueAt:'2027-02-01T00:00:00Z',expectedRevision:1,changeId:'during-planning'});release();
 const result=await running;assert.equal(result.mission.status,'PAUSED');assert.equal(result.mission.stopReason,'personal-dependency-changed');assert.equal(f.runtime.missionRuntime.missions.get(result.mission.missionId).observations.length,0);assert.equal(result.verified,false);assert.equal(result.requiresReplan,true);assert.equal(f.store.summary().followUps[0].state,'pending');
});

test('closed commitments cannot report a linked result as currently verified',async t=>{
 const f=fixture(t);f.link.dispatch(f.id,request);assert.equal((await f.link.run(f.id)).verified,true);
 f.store.resolveCommitment(f.store.summary().commitments[0].id,'cancelled');const result=f.link.refresh(f.id);
 assert.equal(result.verified,false);assert.equal(result.dependencyCurrent,false);assert.equal(result.requiresReplan,false);
});

test('deadline changed after execution but before final planner completion cannot mark Mission completed',async t=>{
 const f=fixture(t),original=f.runtime.missionRuntime.planner.planNextWave.bind(f.runtime.missionRuntime.planner);
 f.runtime.missionRuntime.tryCompleteFromDeterministicEvidence=()=>false;
 f.runtime.missionRuntime.planner.planNextWave=async context=>{
   const plan=await original(context);
   if(plan.decision==='complete'){
     const c=f.store.summary().commitments[0];
     f.store.changeDeadline(c.id,{dueAt:'2027-04-01T00:00:00Z',expectedRevision:1,changeId:'completion-race'});
   }
   return plan;
 };
 f.link.dispatch(f.id,request);const result=await f.link.run(f.id);
 assert.equal(result.mission.status,'PAUSED');assert.equal(result.mission.stopReason,'personal-dependency-changed');
 assert.equal(result.mission.completion?.status==='verified',false);
 assert.equal(result.verified,false);assert.equal(result.requiresReplan,true);
 assert.equal(f.runtime.missionRuntime.missions.get(result.mission.missionId).observations.filter(o=>o.outcome==='success').length,1);
 const restarted=f.open();assert.equal(restarted.missionRuntime.getMission(result.mission.missionId).status,'PAUSED');
 assert.equal(f.store.summary().followUps[0].state,'pending');
});

test('commitment cancelled during final evidence verification preserves actual action but refuses completion',async t=>{
 const f=fixture(t),runtime=f.runtime.missionRuntime,original=runtime.validateCompletionWithRemoteEvidence.bind(runtime);
 runtime.tryCompleteFromDeterministicEvidence=()=>false;
 runtime.validateCompletionWithRemoteEvidence=async(...args)=>{
   const result=await original(...args);
   f.store.resolveCommitment(f.store.summary().commitments[0].id,'cancelled');
   return result;
 };
 f.link.dispatch(f.id,request);const result=await f.link.run(f.id);
 assert.equal(result.mission.status,'PAUSED');assert.equal(result.mission.lastError.code,'A_PERSONAL_LINK_DEPENDENCY_CHANGED');
 assert.equal(result.verified,false);assert.equal(result.requiresReplan,false);
 assert.equal(runtime.missions.get(result.mission.missionId).observations.filter(o=>o.outcome==='success').length,1);
});

test('deterministic completion applies the same last-moment dependency fence',async t=>{
 const f=fixture(t),runtime=f.runtime.missionRuntime,complete=runtime.completeMission.bind(runtime);
 runtime.completeMission=(mission,evidence)=>{
   const c=f.store.summary().commitments[0];
   f.store.changeDeadline(c.id,{dueAt:'2027-05-01T00:00:00Z',expectedRevision:1,changeId:'deterministic-race'});
   return complete(mission,evidence);
 };
 f.link.dispatch(f.id,request);const result=await f.link.run(f.id);
 assert.equal(result.mission.status,'PAUSED');assert.equal(result.mission.stopReason,'personal-dependency-changed');
 assert.equal(result.verified,false);assert.equal(result.mission.completion?.status==='verified',false);
 const impact=f.link.describeFollowup(f.id).dependencyImpact;
 assert.equal(impact.status,'requires-review');assert.equal(impact.completedActionCount,1);
 assert.equal(impact.requiresReplan,true);assert.equal(impact.executionAuthority,false);
});

test('deadline impact computes cumulative shift from linked revision and survives reopening without widening scope',t=>{
 const f=fixture(t),mission=f.link.dispatch(f.id,request),c=f.store.summary().commitments[0];
 const other=f.store.createCommitment({title:'다른 업무',dueAt:'2026-01-01T00:00:00Z',sourceRef:'user:other'});
 const initial=f.link.describeFollowup(f.id).dependencyImpact;
 assert.equal(initial.shiftMilliseconds,0);assert.equal(initial.status,'current');
 f.store.changeDeadline(other.id,{dueAt:'2026-02-01T00:00:00Z',expectedRevision:1,changeId:'unrelated'});
 assert.equal(f.link.describeFollowup(f.id).dependencyImpact.status,'current');
 f.store.changeDeadline(c.id,{dueAt:'2026-01-03T00:00:00Z',expectedRevision:1,changeId:'impact-later'});
 f.store.changeDeadline(c.id,{dueAt:'2025-12-31T00:00:00Z',expectedRevision:2,changeId:'impact-earlier'});
 const reopened=f.open(),link=new PersonalOperationsMissionLink({store:f.store,missionRuntime:reopened.missionRuntime});
 const impact=link.describeFollowup(f.id).dependencyImpact;
 assert.equal(impact.missionId,mission.missionId);assert.equal(impact.shiftMilliseconds,-86400000);
 assert.equal(impact.previousDueAt,'2026-01-01T00:00:00.000Z');assert.equal(impact.currentRevision,3);
 assert.equal(impact.linkedRevision,1);assert.equal(impact.scope,'explicit-linked-work-only');
 assert.equal(impact.requiresReplan,true);assert.equal(reopened.missionRuntime.getMission(mission.missionId).status,'CREATED');
 f.store.db.prepare('DELETE FROM personal_deadline_changes WHERE change_id=?').run('impact-later');
 assert.equal(link.describeFollowup(f.id).dependencyImpact.shiftMilliseconds,null);
 assert.equal(link.describeFollowup(f.id).dependencyImpact.previousDueAt,null);
});

test('unavailable dependency read at completion fails closed without exposing raw error or losing receipts',async t=>{
 const f=fixture(t),runtime=f.runtime.missionRuntime,complete=runtime.completeMission.bind(runtime);
 runtime.completeMission=(mission,evidence)=>{
   runtime.personalDependencyGuard={assertCurrentMission(){throw new Error('private-storage-path');}};
   return complete(mission,evidence);
 };
 f.link.dispatch(f.id,request);const result=await f.link.run(f.id);
 assert.equal(result.mission.status,'PAUSED');assert.equal(result.mission.lastError.code,'A_PERSONAL_DEPENDENCY_CHECK_UNAVAILABLE');
 assert.equal(JSON.stringify(result).includes('private-storage-path'),false);assert.equal(result.verified,false);
 assert.equal(runtime.missions.get(result.mission.missionId).observations.filter(o=>o.outcome==='success').length,1);
});

 test('deadline changed during effect staging stops the worker handoff',async t=>{
 const f=fixture(t),c=f.store.summary().commitments[0];f.link.dispatch(f.id,request);
 const coordinator=f.runtime.missionRuntime.effectCoordinator,original=coordinator.stage.bind(coordinator);let changed=false;
 coordinator.stage=async(...args)=>{const staged=await original(...args);if(!changed){changed=true;f.store.changeDeadline(c.id,{dueAt:'2027-03-01T00:00:00Z',expectedRevision:1,changeId:'before-handoff'});}return staged;};
 const result=await f.link.run(f.id);assert.equal(result.mission.status,'PAUSED');assert.equal(result.verified,false);assert.equal(f.runtime.missionRuntime.missions.get(result.mission.missionId).observations.length,0);
 });

test('target-bound cancellation refuses a stale mission or deadline without stopping the current plan',t=>{
 const f=fixture(t),prior=f.link.dispatch(f.id,request),c=f.store.summary().commitments[0];f.store.changeDeadline(c.id,{dueAt:'2027-01-01T00:00:00Z',expectedRevision:1,changeId:'cancel-cas'});
 assert.throws(()=>f.link.cancel(f.id,{expectedMissionId:prior.missionId,expectedRevision:1}),/CANCEL_CONFLICT/);assert.equal(f.runtime.missionRuntime.getMission(prior.missionId).status,'CREATED');
 f.link.cancel(f.id,{expectedMissionId:prior.missionId,expectedRevision:2});const next=f.link.replan(f.id,{expectedRevision:2,request});
 assert.throws(()=>f.link.cancel(f.id,{expectedMissionId:prior.missionId,expectedRevision:2}),/CANCEL_CONFLICT/);assert.equal(f.runtime.missionRuntime.getMission(next.missionId).status,'CREATED');
});
