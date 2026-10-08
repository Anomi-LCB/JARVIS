import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {PersonalMandateBudget} from '../packages/core/src/personal-operations/mandate-budget.js';
import {MissionBudgetGate} from '../packages/core/src/personal-operations/mission-budget-gate.js';
import {SqliteMissionStore} from '../packages/core/src/mission/sqlite-mission-store.js';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {MissionGrant} from '../packages/core/src/mission/mission-runtime.js';
import {SqliteMemoryStore} from '../apps/growth-memory/src/db/sqlite-store.js';
import {fork} from 'node:child_process';
import {once} from 'node:events';
const dates={validFrom:'2020-01-01T00:00:00Z',expiresAt:'2099-01-01T00:00:00Z'};
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'jarvis-atomic-quota-')),db=join(root,'ops.sqlite'),operations=new PersonalOperationsStore({dbPath:db}),budget=new PersonalMandateBudget(operations),gate=new MissionBudgetGate({store:operations,budget}),store=new SqliteMissionStore({operationsStore:operations});
 t.after(()=>operations.close());return {root,db,operations,budget,gate,store};
}
test('the former separate transaction sequence leaves a held count when snapshot saving fails',t=>{
 const f=fixture(t),quota=f.gate.createQuota({...dates,maxCalls:2}),mission={missionId:'before-control',status:'CREATED',executionMandateId:quota.mandate.id};
 f.store.save([mission]);f.gate.beforeRun(mission);
 assert.throws(()=>f.store.save([mission],{expectedRevision:0}),/REVISION_CONFLICT/);
 assert.equal(f.budget.summary(quota.mandate.id).usedOrHeldCalls,1);assert.equal(f.store.missionQuotaBinding(mission.missionId),null);
});
for(const boundary of ['before-snapshot','after-snapshot','after-commit'])test(`actual process kill at quota ${boundary} preserves one atomic outcome`,{timeout:15000},async t=>{
 const f=fixture(t),quota=f.gate.createQuota({...dates,maxCalls:2}),mission={missionId:'kill-boundary',status:'CREATED',executionMandateId:quota.mandate.id};f.store.save([mission]);
 const child=fork(new URL('./fixtures/mission-quota-boundary.mjs',import.meta.url),[f.db,boundary],{windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const end=once(child,'exit');child.kill('SIGKILL');await end;}});
 const [message]=await once(child,'message');assert.notEqual(message.pid,process.pid);
 const ended=once(child,'exit');child.kill('SIGKILL');await ended;
 const other=new PersonalOperationsStore({dbPath:f.db});try{
  const reopened=new SqliteMissionStore({operationsStore:other}),binding=reopened.missionQuotaBinding(mission.missionId),reservations=other.db.prepare('SELECT * FROM personal_budget_reservations').all();
  assert.equal(reservations.length,boundary==='after-commit'?1:0);assert.equal(Boolean(binding),boundary==='after-commit');
  assert.equal(reopened.metadata().revision,boundary==='after-commit'?2:1);
  if(binding)assert.equal(binding.reservation_id,reservations[0].id);
  console.log(JSON.stringify({boundary,killedPid:message.pid,reservations:reservations.length,bindingPreserved:Boolean(binding),actualSqlite:true}));
 }finally{other.close();}
});
test('failed snapshot CAS rolls back count reservation and binding; one retry commits all three',t=>{
 const f=fixture(t),quota=f.gate.createQuota({...dates,maxCalls:2}),mission={missionId:'atomic',status:'CREATED',executionMandateId:quota.mandate.id};
 f.store.save([mission]);
 assert.throws(()=>f.store.saveWithMissionQuota([mission],{missionId:'atomic',phase:'begin',expectedRevision:0}),/REVISION_CONFLICT/);
 assert.equal(f.gate.reservation(mission),undefined);assert.equal(f.store.missionQuotaBinding('atomic'),null);assert.equal(f.budget.summary(quota.mandate.id).usedOrHeldCalls,0);
 f.gate.beforeRun(mission,{missionStore:f.store,missions:[mission]});
 assert.equal(f.store.missionQuotaBinding('atomic').reservation_id,f.gate.reservation(mission).id);
 assert.equal(f.budget.get(f.gate.reservation(mission).id).state,'in_flight');assert.equal(f.budget.summary(quota.mandate.id).usedOrHeldCalls,1);
});
test('quota settlement and snapshot CAS roll back together and do not grant write or provider authority',t=>{
 const f=fixture(t),quota=f.gate.createQuota({...dates,maxCalls:2}),mission={missionId:'settlement',status:'CREATED',executionMandateId:quota.mandate.id};
 f.store.save([mission]);f.gate.beforeRun(mission,{missionStore:f.store,missions:[mission]});
 const completed={...mission,status:'COMPLETED',completion:{status:'verified'}};
 assert.throws(()=>f.store.saveWithMissionQuota([completed],{missionId:mission.missionId,phase:'finish',expectedRevision:0}),/REVISION_CONFLICT/);
 const reservation=f.gate.reservation(mission);assert.equal(f.budget.get(reservation.id).state,'in_flight');assert.equal(f.store.load()[0].status,'CREATED');
 f.gate.afterRun(completed,{missionStore:f.store,missions:[completed]});assert.equal(f.store.load()[0].status,'COMPLETED');
 assert.equal(f.budget.get(reservation.id).state,'settled');assert.equal(f.budget.get(reservation.id).providerChargeVerified,false);
});
test('bound effects share the Mission count reservation and revoked mandate cannot claim them',t=>{
 const f=fixture(t),quota=f.gate.createQuota({...dates,maxCalls:2}),mission={missionId:'effect-owner',status:'CREATED',executionMandateId:quota.mandate.id};
 f.store.save([mission]);f.gate.beforeRun(mission,{missionStore:f.store,missions:[mission]});
 const effect={effectId:'effect-a',operationId:'operation-a',missionId:mission.missionId,request:{toolName:'filesystem.createTextFile',arguments:{path:'a.txt',content:'synthetic'}},providerIdempotencyKey:'operation-a'};
 f.store.save([mission],{effects:[effect]});assert.equal(f.store.getEffect('effect-a').mission_run_reservation_id,f.gate.reservation(mission).id);
 f.operations.revokeMandate(quota.mandate.id);assert.throws(()=>f.store.claimEffect({effectId:'effect-a',ownerId:'worker'}),/MANDATE_CHANGED/);
 assert.equal(f.store.getEffect('effect-a').state,'prepared');assert.equal(f.store.pendingEffects().length,1);
 assert.throws(()=>f.store.save([mission],{effects:[{...effect,effectId:'effect-b',operationId:'operation-b'}]}),/MANDATE_CHANGED/);
 assert.equal(f.store.pendingEffects().length,1);
});
test('terminal legacy quota is adopted without inventing authority and survives reopening',t=>{
 const f=fixture(t),quota=f.gate.createQuota({...dates,maxCalls:2}),mission={missionId:'legacy',status:'CREATED',executionMandateId:quota.mandate.id};
 f.gate.beforeRun(mission);const completed={...mission,status:'COMPLETED',completion:{status:'verified'}};
 f.store.save([completed]);f.gate.afterRun(completed,{missionStore:f.store,missions:[completed]});
 assert.equal(f.store.missionQuotaBinding('legacy').mandate_revision,'');assert.equal(f.budget.get(f.gate.reservation(mission).id).state,'settled');
 assert.throws(()=>f.store.save([]),/QUOTA_BINDING_CONFLICT/);
 const other=new PersonalOperationsStore({dbPath:f.db});try{
  const reopened=new SqliteMissionStore({operationsStore:other});assert.equal(reopened.load()[0].status,'COMPLETED');
  assert.equal(reopened.missionQuotaBinding('legacy').reservation_id,f.gate.reservation(mission).id);
 }finally{other.close();}
});
test('a snapshot bound to another mandate and a foreign operations DB never consume a count',t=>{
 const f=fixture(t),quota=f.gate.createQuota({...dates,maxCalls:2}),mission={missionId:'bound',status:'CREATED',executionMandateId:quota.mandate.id};
 f.store.save([mission]);f.gate.beforeRun(mission,{missionStore:f.store,missions:[mission]});
 assert.throws(()=>f.store.save([{...mission,executionMandateId:'other'}]),/QUOTA_BINDING_CONFLICT/);
 const other=new PersonalOperationsStore({dbPath:join(f.root,'other.sqlite')});try{
  assert.throws(()=>f.gate.beforeRun(mission,{missionStore:new SqliteMissionStore({operationsStore:other}),missions:[mission]}),/STORE_MISMATCH/);
 }finally{other.close();}
 assert.equal(f.budget.summary(quota.mandate.id).usedOrHeldCalls,1);
});
test('actual Core/E/B/G/F two-file Mission shares one durable count and replay creates no new effects',async t=>{
 const f=fixture(t),quota=f.gate.createQuota({...dates,maxCalls:1});
 const env={JARVIS_TEST_MODE:'1',JARVIS_MISSION_EXECUTIVE:'0',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'};
 const options={allowedRoots:[f.root],auditRoot:join(f.root,'audit'),cwd:()=>f.root,env,taskEnv:env,workerDaemonEnabled:false,bridgeRealExecution:true};
 const memoryStore=new SqliteMemoryStore({dbPath:join(f.root,'growth.sqlite'),reviewDir:join(f.root,'reviews'),backupDir:join(f.root,'backups')});t.after(()=>memoryStore.close());
 const planner={async planNextWave(context){
  if(context.observations.filter(item=>item.outcome==='success').length===2)return {decision:'complete',actions:[],criteriaAssessment:context.mission.successCriteria.map(c=>({criterionId:c.criterionId,status:'satisfied',evidenceActionIds:context.observations.map(o=>o.actionId)}))};
  return {decision:'continue',actions:['첫째','둘째'].map((label,i)=>({id:`write${i}`,command:`${label} 메모 파일을 만들어줘. 내용은 ${label}`,expectedToolName:'filesystem.createTextFile',arguments:{path:join(f.root,label+'.txt'),content:label},dependencies:i?['write0']:[],requirementIds:[context.mission.goalContract.requirements[i]?.requirementId??context.mission.goalContract.requirements[0].requirementId]}))};
 }};
 const runtime=createAgRuntime({...options,missionStore:f.store,memoryStore,missionPlanner:planner});runtime.missionRuntime.executionBudget=f.gate;
 t.after(()=>runtime.close?.());
 const owner=runtime.personalOwnerSession.activate({durationMinutes:15,requestedBy:'atomic-quota-test'});
 const created=runtime.missionRuntime.createMission({objective:"'첫째.txt'를 저장해; '둘째.txt'를 저장해",
  successCriteria:[{criterionId:'one',statement:'첫째 파일의 실제 내용 확인',verificationSpec:{version:1,kind:'text.equals',path:'첫째.txt',equals:'첫째'}},{criterionId:'two',statement:'둘째 파일의 실제 내용 확인',verificationSpec:{version:1,kind:'text.equals',path:'둘째.txt',equals:'둘째'}}],
  authorization:{mode:'trusted_session',grants:[MissionGrant.READ_ONLY,MissionGrant.LOCAL_REVERSIBLE],ownerSessionId:owner.session.sessionId},executionMandateId:quota.mandate.id});
 const result=await runtime.missionRuntime.runMission(created.missionId);assert.equal(result.status,'COMPLETED',JSON.stringify(result));
 const effects=f.operations.db.prepare('SELECT * FROM mission_effects').all();assert.equal(effects.length,2);
 assert.equal(new Set(effects.map(e=>e.mission_run_reservation_id)).size,1);assert.ok(effects.every(e=>e.state==='succeeded'));
 for(const label of ['첫째','둘째'])assert.equal(readFileSync(join(f.root,label+'.txt'),'utf8').trim(),label);
 const reservation=f.gate.reservation(result);assert.equal(f.budget.get(reservation.id).state,'settled');assert.equal(f.budget.summary(quota.mandate.id).usedOrHeldCalls,1);
 const revision=f.store.metadata().revision;await runtime.missionRuntime.runMission(result.missionId);assert.equal(f.store.metadata().revision,revision);
 assert.equal(f.operations.db.prepare('SELECT COUNT(*) AS n FROM mission_effects').get().n,2);
 assert.equal(f.store.pendingEffects().length,0);assert.equal(f.store.pendingFollowups().length,0);
 console.log(JSON.stringify({actualCoreEBGF:true,files:2,effects:2,countReservations:1,providerChargeVerified:false}));
});
