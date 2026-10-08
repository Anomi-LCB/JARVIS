import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {PersonalMandateBudget} from '../packages/core/src/personal-operations/mandate-budget.js';
import {MissionBudgetGate} from '../packages/core/src/personal-operations/mission-budget-gate.js';
const dates={validFrom:'2020-01-01T00:00:00Z',expiresAt:'2099-01-01T00:00:00Z'};
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'jarvis-mission-quota-')),store=new PersonalOperationsStore({dbPath:join(root,'db.sqlite')}),budget=new PersonalMandateBudget(store),gate=new MissionBudgetGate({store,budget});
 const planner={async planNextWave(c){if(c.observations.some(x=>x.outcome==='success'))return {decision:'complete',summary:'검증 완료',actions:[],criteriaAssessment:c.mission.successCriteria.map(x=>({criterionId:x.criterionId,status:'satisfied',evidenceActionIds:[c.observations.find(x=>x.outcome==='success').actionId],reason:'실제 파일 목록 확인'}))};return {decision:'continue',summary:'목록 확인',criteriaAssessment:[],actions:[{id:'read',title:'목록 확인',command:'작업 폴더 파일 목록 보여줘',expectedToolName:'filesystem.listFiles',dependencies:[],successSignal:'목록 반환'}]};}};
 const make=()=>{const r=createAgRuntime({allowedRoots:[root],auditRoot:join(root,'audit'),cwd:()=>root,env:{},missionPlanner:planner,workerDaemonEnabled:false,missionStorePath:join(root,'missions.json')}).missionRuntime;r.executionBudget=gate;return r;};
 const runtime=make(),quota=gate.createQuota({...dates,maxCalls:1}),create=()=>runtime.createMission({objective:'작업 폴더 파일 목록 확인',successCriteria:['파일 목록 확인'],authorization:{grants:['read_only']},executionMandateId:quota.mandate.id});
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});return {store,budget,gate,runtime,quota,create,make,planner};
}
test('real Mission completes, settles once, rejects next goal and persists binding across reload',async t=>{
 const f=fixture(t),m=f.create();assert.ok(m.missionId,JSON.stringify(m));const result=await f.runtime.runMission(m.missionId);assert.equal(result.status,'COMPLETED',JSON.stringify(result));assert.equal(result.completion.status,'verified');
 assert.equal(f.budget.get(f.gate.reservation(m).id).state,'settled');await f.runtime.runMission(m.missionId);const restored=f.make();assert.equal(restored.getMission(m.missionId).executionMandateId,f.quota.mandate.id);await restored.runMission(m.missionId);
 assert.equal(f.budget.summary(f.quota.mandate.id).usedOrHeldCalls,1);const denied=await f.runtime.runMission(f.create().missionId);assert.match(JSON.stringify(denied),/A_MANDATE_EXECUTION_DENIED/);assert.equal(f.budget.summary(f.quota.mandate.id).usedOrHeldCalls,1);
});
test('revocation during planning stops action dispatch and keeps the held count',async t=>{
 const f=fixture(t),plan=f.planner.planNextWave;f.planner.planNextWave=async c=>{const result=await plan(c);f.store.revokeMandate(f.quota.mandate.id);return result;};
 const result=await f.runtime.runMission(f.create().missionId);assert.equal(result.status,'PAUSED');assert.equal(result.stopReason,'mandate-execution-denied');assert.equal(result.metrics.successfulActions,0);assert.equal(f.budget.summary(f.quota.mandate.id).usedOrHeldCalls,1);
});
test('missing gate fails closed for persisted bound Mission',async t=>{const f=fixture(t),m=f.create(),r=f.make();r.executionBudget=null;assert.match(JSON.stringify(await r.runMission(m.missionId)),/A_MANDATE_EXECUTION_DENIED/);assert.equal(f.budget.summary(f.quota.mandate.id).usedOrHeldCalls,0);});

test('quota revoked during effect staging blocks the worker without a completed action',async t=>{
 const f=fixture(t),coordinator=f.runtime.effectCoordinator,stage=coordinator.stage.bind(coordinator);let workerCalls=0;
 const run=f.runtime.orchestrationWorker.runTask.bind(f.runtime.orchestrationWorker);
 f.runtime.orchestrationWorker.runTask=(...args)=>{workerCalls++;return run(...args);};
 coordinator.stage=async(...args)=>{const hooks=await stage(...args);f.store.revokeMandate(f.quota.mandate.id);return hooks;};
 const result=await f.runtime.runMission(f.create().missionId);
 assert.equal(result.status,'PAUSED');assert.equal(result.stopReason,'mandate-execution-denied');assert.equal(workerCalls,0);
 assert.equal(result.metrics.successfulActions,0);assert.equal(f.budget.summary(f.quota.mandate.id).usedOrHeldCalls,1);
});
test('quota creation rolls back invalid validity and refuses financial mandate binding',t=>{const f=fixture(t),before=f.gate.list().length;assert.throws(()=>f.gate.createQuota({...dates,expiresAt:dates.validFrom,maxCalls:2}));assert.equal(f.gate.list().length,before);const m=f.store.createMandate({...dates,action:'mission.run',target:'jarvis:missions',currency:'KRW',maxAmountMinor:100});f.budget.configure({mandateId:m.id,totalMinor:100,maxCalls:1});assert.throws(()=>f.gate.validate(m.id),/COUNT_QUOTA_REQUIRED/);});

test('count quota never grants a local write approval',async t=>{
 const f=fixture(t);f.planner.planNextWave=async()=>({decision:'continue',summary:'쓰기 요청',criteriaAssessment:[],actions:[{id:'write',title:'파일 생성',command:'gated-result 메모 파일을 만들어줘. 내용은 승인 완료',expectedToolName:'filesystem.createTextFile',dependencies:[],successSignal:'파일 생성'}]});
 const result=await f.runtime.runMission(f.create().missionId);assert.equal(result.status,'WAITING_APPROVAL',JSON.stringify(result));assert.equal(result.metrics.successfulActions,0);
});
test('quota API requires authentication and persists revocation',async t=>{
 const f=fixture(t);const {createCoreServer}=await import('../packages/core/src/main.mjs');const {listenOnFetchSafePort}=await import('../packages/shared/src/http.js');
 const server=createCoreServer(undefined,{adminToken:'quota-test',missionBudgetGate:f.gate}),address=await listenOnFetchSafePort(server,{host:'127.0.0.1',port:0});t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base=`http://127.0.0.1:${address.port}/personal-mandates`,headers={authorization:'Bearer quota-test','content-type':'application/json'};assert.equal((await fetch(base)).status,401);
 const made=await fetch(base+'/create-mission-quota',{method:'POST',headers,body:JSON.stringify({...dates,maxCalls:2})});assert.equal(made.status,200);const id=(await made.json()).mandate.id;
 assert.equal((await fetch(base+'/revoke',{method:'POST',headers,body:JSON.stringify({id})})).status,200);const items=(await (await fetch(base,{headers})).json()).items;assert.equal(items.find(x=>x.id===id).revoked,true);assert.throws(()=>f.gate.validate(id),/DENIED/);
});

async function scheduledFixture(f){
 const {SqliteDurableRoutineStore}=await import('../packages/core/src/runtime/durable-routine-store.js');
 const {DurableRoutineScheduler}=await import('../packages/core/src/runtime/durable-routine-scheduler.js');
 const store=new SqliteDurableRoutineStore({operationsStore:f.store});
 const scheduler=new DurableRoutineScheduler({store,missionRuntime:f.runtime,clock:()=>new Date(f.store.now()),onNotification:()=>{}});
 const schedule=(id,mandateId=f.quota.mandate.id)=>scheduler.schedule({routineId:id,scheduledAt:f.store.now(),missionRequest:{objective:'작업 폴더 파일 목록 확인',successCriteria:['파일 목록 확인'],authorization:{grants:['read_only']},executionMandateId:mandateId}});
 return {store,scheduler,schedule};
}
test('scheduled Mission persists quota binding and exhausted quota blocks the next occurrence',async t=>{
 const f=fixture(t),s=await scheduledFixture(f);s.schedule('quota-first');await s.scheduler.tick();
 assert.equal(s.store.get('quota-first').status,'completed');assert.equal(f.runtime.getMission(s.store.get('quota-first').missionId).executionMandateId,f.quota.mandate.id);
 s.schedule('quota-second');await s.scheduler.tick();assert.notEqual(s.store.get('quota-second').status,'completed');assert.equal(f.budget.summary(f.quota.mandate.id).usedOrHeldCalls,1);
});
test('revoked or expired quota prevents a scheduled Mission from reaching its worker',async t=>{
 for(const mode of ['revoked','expired']){
  const f=fixture(t),s=await scheduledFixture(f),now=Date.now();let calls=0;
  const run=f.runtime.orchestrationWorker.runTask.bind(f.runtime.orchestrationWorker);f.runtime.orchestrationWorker.runTask=(...a)=>{calls++;return run(...a);};
  const q=mode==='expired'?f.gate.createQuota({validFrom:new Date(now-1000).toISOString(),expiresAt:new Date(now+1000).toISOString(),maxCalls:1}):f.quota;
  s.schedule('quota-'+mode,q.mandate.id);
  if(mode==='revoked')f.store.revokeMandate(q.mandate.id);else f.store.clock=()=>new Date(now+2000);
  await s.scheduler.tick();assert.equal(calls,0);assert.equal(s.store.get('quota-'+mode).status,'blocked');assert.equal(f.budget.summary(q.mandate.id).usedOrHeldCalls,0);
 }
});
test('revocation while scheduled planning runs still fences the actual action',async t=>{
 const f=fixture(t),s=await scheduledFixture(f),plan=f.planner.planNextWave;
 f.planner.planNextWave=async c=>{const result=await plan(c);f.store.revokeMandate(f.quota.mandate.id);return result;};
 s.schedule('quota-race');await s.scheduler.tick();const r=s.store.get('quota-race');assert.equal(r.status,'blocked');assert.equal(f.runtime.getMission(r.missionId).metrics.successfulActions,0);
});

test('scheduled quota API accepts existing binding and rejects missing service or invalid ID',async t=>{
 const f=fixture(t),s=await scheduledFixture(f);const {createCoreServer}=await import('../packages/core/src/main.mjs');const {listenOnFetchSafePort}=await import('../packages/shared/src/http.js');
 const server=createCoreServer(undefined,{adminToken:'routine-quota-test',routineScheduler:s.scheduler}),address=await listenOnFetchSafePort(server,{host:'127.0.0.1',port:0});t.after(()=>new Promise(r=>server.close(r)));
 const url=`http://127.0.0.1:${address.port}/routines`,headers={authorization:'Bearer routine-quota-test','content-type':'application/json'};
 const body={routineId:'http-quota',scheduledAt:f.store.now(),missionRequest:{objective:'작업 폴더 파일 목록 확인',authorization:{grants:['read_only']},executionMandateId:f.quota.mandate.id}};
 assert.equal((await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})).status,401);
 const made=await fetch(url,{method:'POST',headers,body:JSON.stringify(body)});assert.equal(made.status,201);assert.equal((await made.json()).routine.missionRequest.executionMandateId,f.quota.mandate.id);
 assert.throws(()=>s.schedule('bad',''),/Invalid Mission quota ID/);
 f.runtime.executionBudget=null;assert.throws(()=>s.schedule('missing'),/quota service is unavailable/);assert.equal(s.store.get('missing'),null);
});
test('reopened scheduled quota binding remains constrained after revocation',async t=>{
 const f=fixture(t),s=await scheduledFixture(f);s.schedule('restored-quota');
 const {DurableRoutineScheduler}=await import('../packages/core/src/runtime/durable-routine-scheduler.js');
 const restored=f.make();f.store.revokeMandate(f.quota.mandate.id);
 const scheduler=new DurableRoutineScheduler({store:s.store,missionRuntime:restored,onNotification:()=>{}});await scheduler.tick();
 assert.equal(s.store.get('restored-quota').status,'blocked');assert.equal(f.budget.summary(f.quota.mandate.id).usedOrHeldCalls,0);
});
