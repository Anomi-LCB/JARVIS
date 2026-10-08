import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {SqliteMissionStore} from '../packages/core/src/mission/sqlite-mission-store.js';
import {MissionExecutionAuthority} from '../packages/core/src/mission/mission-execution-authority.js';
import {MissionCommerceSourceGate} from '../packages/core/src/mission/mission-commerce-source-gate.js';
import {CommerceOrderCoordinator} from '../packages/core/src/personal-operations/commerce-order-coordinator.js';
import {createGoalContract} from '../packages/core/src/mission/goal-contract.js';
import {createCoreServer} from '../packages/core/src/main.mjs';
import {listenOnFetchSafePort} from '../packages/shared/src/http.js';

function fixture(t,objective='총액 100원 이하로 주문을 준비해'){
 const root=mkdtempSync(join(tmpdir(),'jarvis-commerce-source-'));let time=Date.now();
 const operations=new PersonalOperationsStore({dbPath:join(root,'ops.sqlite'),clock:()=>new Date(time)});
 const store=new SqliteMissionStore({operationsStore:operations}),authority=new MissionExecutionAuthority({store});
 authority.activate({expectedToken:store.coreAuthorityStatus().token,heartbeat:false});
 const runtime=createAgRuntime({missionStore:store,missionExecutionAuthority:authority,allowedRoots:[root],auditRoot:join(root,'audit'),workerDaemonEnabled:false,
  env:{JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'}}).missionRuntime;
 const created=runtime.createMission({objective,successCriteria:['결과 확인']}),mission=runtime.missions.get(created.missionId);
 const order={active:true,revision:'1',providerId:'synthetic',binding:{endpoint:'isolated:synthetic',version:'1'},checkoutId:'checkout',
  expiresAt:'2099-01-01T00:00:00Z',quoteEvidenceSha256:'c'.repeat(64),request:{action:'commerce.order',target:'provider:synthetic',currency:'KRW',amountMinor:100},
  expected:{orderId:'order',currency:'KRW',totalMinor:100}};
 let calls=0,lookups=0;
 const adapter={providerId:'synthetic',binding:order.binding,supportsBeforeCommit:true,
  complete:async({beforeCommit})=>{assert.equal(await beforeCommit(),true);calls++;return {};},lookup:async()=>{lookups++;return {};}};
 const gate=new MissionCommerceSourceGate({runtime,operationsStore:operations});
 const options={missionSourceGate:gate,adapter,resolveOrder:()=>structuredClone(order),authorize:()=>true,
  verifyReceipt:()=>({verified:true,checkoutId:'checkout',orderId:'order',currency:'KRW',totalMinor:100,receiptRef:'synthetic-receipt',evidenceSha256:'a'.repeat(64)})};
 const coordinator=new CommerceOrderCoordinator(operations,options);
 const mandate=operations.createMandate({action:'commerce.order',target:'provider:synthetic',currency:'KRW',maxAmountMinor:1000,
  validFrom:'2020-01-01T00:00:00Z',expiresAt:'2099-01-01T00:00:00Z'});
 coordinator.budget.configure({mandateId:mandate.id,totalMinor:2000,maxCalls:20});
 const input={mandateId:mandate.id,requestId:'source-request',checkoutId:'checkout',missionId:created.missionId};
 t.after(()=>{authority.stopHeartbeat();runtime.coreFacade.cognition.close();operations.close();assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));rmSync(root,{recursive:true,force:true});});
 return {operations,store,authority,runtime,mission,order,adapter,options,coordinator,mandate,input,calls:()=>calls,lookups:()=>lookups,advance:ms=>time+=ms};
}

test('real SQL Mission total binds reviewed order and receipt; replay cannot remove or replace its Mission',async t=>{
 const f=fixture(t),a=await f.coordinator.prepare(f.input);
 assert.equal(a.missionSourceBound,true);assert.equal(a.executionAuthority,false);
 assert.equal((await f.coordinator.prepare(f.input)).reservationId,a.reservationId);
 const result=await f.coordinator.dispatch(a.reservationId);assert.equal(result.receiptVerified,true);
 assert.equal(result.fundsSettlementObserved,false);assert.equal(f.calls(),1);
 await assert.rejects(f.coordinator.prepare({...f.input,missionId:undefined}));
 await assert.rejects(f.coordinator.dispatch(a.reservationId),/NO_REDISPATCH/);
 assert.notEqual(f.mission.status,'COMPLETED');
});

for(const objective of ['총액 99원 이하로 준비해','총비용 100원 미만으로 준비해','총액 USD 100 이하로 준비해',
 '총액 $100 이하로 준비해','건당 총액 100원 이하로 준비해','총액 100원 이하; 누적 200원 이하','결과를 준비해',
 '총액 100원 이상으로 준비해','총액 99원 초과로 준비해'])
 test(`source limit unavailable/over-bound never reserves or dispatches: ${objective}`,async t=>{
  const f=fixture(t,objective);await assert.rejects(f.coordinator.prepare(f.input),/LIMIT_UNVERIFIED/);
  assert.equal(f.calls(),0);assert.equal(f.coordinator.budget.summary(f.mandate.id).usedOrHeldCalls,0);
 });

for(const mode of ['objective','revision','cancelled','expired-authority','stale-core','uninstalled-gate','unsupported-adapter','binding-tamper'])
 test(`bound order stops before commit after ${mode}`,async t=>{
  const f=fixture(t),a=await f.coordinator.prepare(f.input);
  if(mode==='objective'){f.mission.objective='총액 1000원 이하로 준비해';f.mission.goalContract=createGoalContract({objective:f.mission.objective});}
  if(mode==='revision')f.mission.goalContract.revision++;
  if(mode==='cancelled')f.mission.status='CANCELLED';
  if(mode==='expired-authority')f.advance(30001);
  if(mode==='stale-core')f.store.db.prepare('UPDATE mission_sqlite_snapshot SET revision=revision+1').run();
  if(mode==='uninstalled-gate')f.coordinator.missionSourceGate=null;
  if(mode==='unsupported-adapter')f.adapter.supportsBeforeCommit=false;
  if(mode==='binding-tamper')f.operations.db.prepare('UPDATE personal_commerce_orders SET mission_source_json=NULL').run();
  await assert.rejects(f.coordinator.dispatch(a.reservationId));assert.equal(f.calls(),0);
  assert.equal(f.coordinator.budget.get(a.reservationId).state,'reserved');
 });

test('source correction while async policy awaits prevents dispatch, and final adapter fence catches later changes',async t=>{
 for(const phase of ['policy','adapter']){
  const f=fixture(t),a=await f.coordinator.prepare(f.input);
  if(phase==='policy')f.coordinator.authorize=async()=>{f.mission.goalContract.revision++;return true;};
  else f.adapter.complete=async({beforeCommit})=>{await Promise.resolve();f.mission.goalContract.revision++;await beforeCommit();throw Error('must not commit');};
  await assert.rejects(f.coordinator.dispatch(a.reservationId));assert.equal(f.calls(),0);
  assert.equal(f.coordinator.budget.get(a.reservationId).state,phase==='adapter'?'uncertain':'reserved');
 }
});

test('after response loss source revocation stops new commits but preserves historical receipt lookup',async t=>{
 const f=fixture(t),a=await f.coordinator.prepare(f.input);let committed=0;
 f.adapter.complete=async({beforeCommit})=>{await beforeCommit();committed++;throw Error('synthetic-response-loss');};
 await assert.rejects(f.coordinator.dispatch(a.reservationId),/UNCERTAIN/);
 f.mission.status='CANCELLED';f.operations.revokeMandate(f.mandate.id);
 const reloaded=new CommerceOrderCoordinator(f.operations,{...f.options,missionSourceGate:null});
 await assert.rejects(reloaded.dispatch(a.reservationId),/NO_REDISPATCH/);
 assert.equal((await reloaded.reconcile(a.reservationId)).receiptVerified,true);
 assert.equal(committed,1);assert.equal(f.lookups(),1);
 assert.equal(f.mission.status,'CANCELLED');
});

test('ADMIN HTTP accepts only Mission ID, never a caller-supplied source proof or fence',async t=>{
 const f=fixture(t),server=createCoreServer(undefined,{adminToken:'synthetic-source-orders',commerceOrderCoordinator:f.coordinator});
 await listenOnFetchSafePort(server);t.after(()=>new Promise(done=>server.close(done)));
 const base=`http://127.0.0.1:${server.address().port}/commerce/orders`,headers={authorization:'Bearer synthetic-source-orders','content-type':'application/json'};
 const post=(method,input)=>fetch(base+'/'+method,{method:'POST',headers,body:JSON.stringify(input)});
 assert.equal((await post('prepare',{...f.input,sourceBinding:{passed:true}})).status,400);
 const response=await post('prepare',f.input);assert.equal(response.status,200);
 const a=await response.json();assert.equal(a.missionSourceBound,true);
 assert.equal((await post('dispatch',{reservationId:a.reservationId,beforeCommit:true})).status,400);
 assert.equal((await post('dispatch',{reservationId:a.reservationId})).status,200);assert.equal(f.calls(),1);
});
