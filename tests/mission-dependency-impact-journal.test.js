import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {SqliteMissionStore} from '../packages/core/src/mission/sqlite-mission-store.js';
import {MissionExecutionAuthority} from '../packages/core/src/mission/mission-execution-authority.js';
import {MissionBudgetGate} from '../packages/core/src/personal-operations/mission-budget-gate.js';
import {PersonalMandateBudget} from '../packages/core/src/personal-operations/mandate-budget.js';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {createCoreServer} from '../packages/core/src/main.mjs';
import {listenOnFetchSafePort} from '../packages/shared/src/http.js';
import {missionMoneyDependencyImpact} from '../packages/core/src/mission/mission-money-dependency.js';
import {createGoalContract} from '../packages/core/src/mission/goal-contract.js';
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'jarvis-impact-journal-'));let now=Date.parse('2026-10-07T00:00:00Z');
 const operations=new PersonalOperationsStore({dbPath:join(root,'ops.sqlite'),clock:()=>new Date(now)}),store=new SqliteMissionStore({operationsStore:operations});
 const authority=new MissionExecutionAuthority({store,ttlMs:1000});authority.activate({expectedToken:store.coreAuthorityStatus().token,heartbeat:false});
 const r=createAgRuntime({missionStore:store,missionExecutionAuthority:authority,allowedRoots:[root],auditRoot:join(root,'audit'),clock:()=>new Date(now),workerDaemonEnabled:false,env:{JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'}});
 const budget=new PersonalMandateBudget(operations),quota=new MissionBudgetGate({store:operations,budget});r.missionRuntime.executionBudget=quota;
 t.after(async()=>{authority.stopHeartbeat();r.coreFacade.cognition.close();operations.close();await rm(root,{recursive:true,force:true});});
 return {operations,store,authority,r,budget,quota,advance:ms=>now+=ms,create:extra=>r.missionRuntime.createMission({objective:'작업 폴더 파일 목록 확인',successCriteria:['목록 확인'],...extra})};
}
test('durable impact baseline and shared quota transition are atomic and deduplicated',async t=>{
 const f=await fixture(t),q=f.quota.createQuota({validFrom:'2026-01-01T00:00:00Z',expiresAt:'2027-01-01T00:00:00Z',maxCalls:1});
 const a=f.create({executionMandateId:q.mandate.id}),b=f.create({executionMandateId:q.mandate.id}),c=f.create();const runtime=f.r.missionRuntime;
 assert.equal(runtime.reconcileDependencyImpacts().baselines,3);assert.equal(runtime.dependencyImpactEvents().items.length,0);
 const before=JSON.stringify([...runtime.missions.values()]);f.budget.reserve({mandateId:q.mandate.id,requestId:'mission:'+a.missionId,request:f.quota.request()});
 const change=runtime.reconcileDependencyImpacts();assert.equal(change.changed,2);assert.equal(change.effectsDispatched,0);assert.equal(change.notificationsSent,0);
 const affected=change.events.find(e=>e.missionId===b.missionId);assert.ok(affected.current.reasons.includes('call-budget-exhausted'));
 assert.equal(change.events.some(e=>e.missionId===c.missionId),false);
 assert.equal(runtime.reconcileDependencyImpacts().changed,0);assert.equal(runtime.dependencyImpactEvents().items.length,2);
 assert.equal(JSON.stringify([...runtime.missions.values()]),before);assert.equal(JSON.stringify(change).includes('objective'),false);
});
test('event insertion failure rolls back heads, and retry records each transition once',async t=>{
 const f=await fixture(t),a=f.create(),runtime=f.r.missionRuntime;runtime.reconcileDependencyImpacts();
 runtime.missions.get(a.missionId).budgets.maxActions=0;runtime.persist('synthetic-impact-change');
 const before=f.store.db.prepare('SELECT * FROM mission_dependency_impact_heads').get();
 f.store.db.exec("CREATE TRIGGER fail_impact BEFORE INSERT ON mission_dependency_impact_events BEGIN SELECT RAISE(ABORT,'synthetic-event-failure'); END");
 assert.throws(()=>runtime.reconcileDependencyImpacts(),/synthetic-event-failure/);
 assert.deepEqual(f.store.db.prepare('SELECT * FROM mission_dependency_impact_heads').get(),before);assert.equal(runtime.dependencyImpactEvents().items.length,0);
 f.store.db.exec('DROP TRIGGER fail_impact');assert.equal(runtime.reconcileDependencyImpacts().changed,1);assert.equal(runtime.reconcileDependencyImpacts().changed,0);
});
test('expired/recovery-only authority and stale Core snapshot cannot append impact events',async t=>{
 const f=await fixture(t),runtime=f.r.missionRuntime;f.create();runtime.reconcileDependencyImpacts();
 f.store.db.prepare('UPDATE mission_sqlite_snapshot SET revision=revision+1').run();assert.throws(()=>runtime.reconcileDependencyImpacts(),/CORE_SNAPSHOT_STALE/);
 f.store.load();f.authority.recoveryOnly=true;assert.throws(()=>runtime.reconcileDependencyImpacts(),/RECOVERY_ONLY/);f.authority.recoveryOnly=false;
 f.advance(1001);assert.throws(()=>runtime.reconcileDependencyImpacts(),/STALE_FENCE/);assert.equal(runtime.dependencyImpactEvents().items.length,0);
});
test('actual Core OS kill/restart preserves journal and never repeats the same dependency event',async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-impact-journal-process-')),children=new Set();
 t.after(async()=>{for(const c of children)if(c.exitCode===null&&c.signalCode===null){const done=once(c,'exit');c.kill('SIGKILL');await done;}await rm(root,{recursive:true,force:true});});
 const run=async mode=>{
  const c=fork(new URL('./fixtures/mission-impact-journal-child.mjs',import.meta.url),[root,mode],{windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});children.add(c);let stderr='';c.stderr.on('data',b=>stderr+=b);
  const result=await new Promise((accept,reject)=>{const timer=setTimeout(()=>reject(Error('child timeout '+stderr)),15000);
   c.once('message',m=>{clearTimeout(timer);m.type==='error'?reject(Error(m.stack)):accept(m);});c.once('exit',code=>{clearTimeout(timer);reject(Error('child exit '+code+' '+stderr));});});
  const exited=once(c,'exit');c.kill('SIGKILL');await exited;children.delete(c);return result;
 };
 const first=await run('baseline'),changed=await run('change'),resumed=await run('resume');
 assert.equal(first.result.baselines,2);assert.equal(first.history.items.length,0);assert.equal(changed.result.changed,2);assert.equal(resumed.result.changed,0);
 assert.deepEqual(resumed.history.items,changed.history.items);assert.notEqual(first.pid,changed.pid);assert.notEqual(changed.pid,resumed.pid);
 assert.equal(resumed.result.effectsDispatched,0);t.diagnostic(JSON.stringify({corePids:[first.pid,changed.pid,resumed.pid],events:2,repeated:0,actualOsKill:true}));
});
test('ADMIN reconciliation HTTP does not accept supplied events or expose corrupted history',async t=>{
 const f=await fixture(t);const a=f.create();const server=createCoreServer(f.r.coreFacade,{missionRuntime:f.r.missionRuntime,adminToken:'synthetic-impact-history-admin'});
 await listenOnFetchSafePort(server);t.after(()=>new Promise(done=>server.close(done)));
 const root=`http://127.0.0.1:${server.address().port}`,headers={authorization:'Bearer synthetic-impact-history-admin','content-type':'application/json'};
 const post=(body={})=>fetch(root+'/missions/dependency-impact-reconciliation',{method:'POST',headers,body:JSON.stringify(body)});
 assert.equal((await fetch(root+'/missions/dependency-impact-events')).status,401);assert.equal((await post({events:[{status:'current'}]})).status,400);
 assert.equal((await post()).status,200);f.r.missionRuntime.missions.get(a.missionId).budgets.maxActions=0;f.r.missionRuntime.persist('changed');
 const changed=await (await post()).json();assert.equal(changed.changed,1);
 const history=await (await fetch(root+'/missions/dependency-impact-events',{headers})).json();assert.equal(history.items.length,1);
 assert.equal((await fetch(root+'/missions/dependency-impact-events?after=1',{headers})).status,200);
 assert.equal((await fetch(root+'/missions/dependency-impact-events?limit=101',{headers})).status,400);
 f.store.db.prepare("UPDATE mission_dependency_impact_events SET body='{}'").run();
 const corrupt=await fetch(root+'/missions/dependency-impact-events',{headers});assert.equal(corrupt.status,503);assert.equal((await corrupt.json()).error.code,'A_MISSION_IMPACT_HISTORY_CORRUPTED');
});
function moneyFixture(f,currency='KRW'){
 const mandate=f.operations.createMandate({action:'travel.quote',target:'provider:synthetic',currency,maxAmountMinor:10000,validFrom:'2026-01-01T00:00:00Z',expiresAt:'2027-01-01T00:00:00Z'});
 f.budget.configure({mandateId:mandate.id,totalMinor:10000,maxCalls:10});
 const request={action:'travel.quote',target:'provider:synthetic',currency,amountMinor:7000};
 return {mandate,request,link:{dependencyId:'estimate',mandateId:mandate.id,requestId:'first',request,expectedRevision:0}};
}
test('money dependency projects shared held/settled funds without double-charging its own request',async t=>{
 const f=await fixture(t),m=moneyFixture(f),a=f.create(),b=f.create(),r=f.r.missionRuntime;
 r.setMoneyDependency(a.missionId,m.link);r.setMoneyDependency(b.missionId,{...m.link,requestId:'second'});
 assert.equal(r.dependencyImpact(a.missionId).budget.money[0].status,'current');r.reconcileDependencyImpacts();
 const reservation=f.budget.reserve({mandateId:m.mandate.id,requestId:'first',request:m.request});
 const own=r.dependencyImpact(a.missionId).budget.money[0],other=r.dependencyImpact(b.missionId).budget.money[0];
 assert.equal(own.availableForThisRequestMinor,10000);assert.equal(own.remainingMinor,3000);assert.equal(own.status,'current');
 assert.ok(other.reasons.includes('money-budget-exhausted'));assert.equal(r.reconcileDependencyImpacts().changed,2);
 f.budget.begin(reservation.id);f.budget.uncertain(reservation.id);
 assert.ok(r.dependencyImpact(a.missionId).reasons.includes('money-reservation-reconciliation-required'));
 f.budget.settle({id:reservation.id,actualMinor:4000,receiptRef:'synthetic-provider-reconciliation'});
 const settled=r.dependencyImpact(a.missionId).budget.money[0];assert.equal(settled.accountedActualMinor,4000);assert.equal(settled.providerChargeVerified,false);assert.equal(settled.reservationState,'settled');
 assert.ok(settled.reasons.includes('money-reservation-closed'));assert.equal(r.dependencyImpact(b.missionId).budget.money[0].remainingMinor,6000);
 assert.equal(f.budget.summary(m.mandate.id).usedOrHeldCalls,1);
});
test('unmeasured money is unknown, currency/revocation mismatches are explicit and link CAS never reserves',async t=>{
 const f=await fixture(t),m=moneyFixture(f,'USD'),a=f.create(),r=f.r.missionRuntime;
 r.setMoneyDependency(a.missionId,{...m.link,request:{...m.request,amountMinor:null}});
 const unknown=r.dependencyImpact(a.missionId);assert.equal(unknown.budget.money[0].declaredMinor,null);assert.equal(unknown.budget.money[0].status,'unknown');assert.ok(unknown.unknownReasons.includes('money-amount-unmeasured'));
 assert.throws(()=>r.setMoneyDependency(a.missionId,m.link),/REVISION_CONFLICT/);
 r.setMoneyDependency(a.missionId,{...m.link,expectedRevision:1,request:{...m.request,currency:'KRW'}});
 assert.ok(r.dependencyImpact(a.missionId).reasons.includes('money-currency-mismatch'));
 f.operations.revokeMandate(m.mandate.id);assert.ok(r.dependencyImpact(a.missionId).reasons.includes('money-revoked'));
 assert.equal(f.budget.summary(m.mandate.id).usedOrHeldCalls,0);
 for(const invalid of [-1,0.1,Number.MAX_SAFE_INTEGER+1,undefined])assert.throws(()=>r.setMoneyDependency(a.missionId,{...m.link,expectedRevision:2,request:{...m.request,amountMinor:invalid}}),/INPUT_INVALID/);
});
test('reservation request/fingerprint mismatch and corrupt money links remain non-current',async t=>{
 const f=await fixture(t),m=moneyFixture(f),a=f.create(),r=f.r.missionRuntime;
 r.setMoneyDependency(a.missionId,{...m.link,intentFingerprint:'a'.repeat(64)});
 f.budget.reserve({mandateId:m.mandate.id,requestId:'first',request:m.request,intentFingerprint:'b'.repeat(64)});
 assert.ok(r.dependencyImpact(a.missionId).reasons.includes('money-reservation-request-mismatch'));
 f.store.db.prepare("UPDATE mission_money_dependencies SET body='{}'").run();
 assert.equal(r.dependencyImpact(a.missionId).budget.money[0].status,'unknown');
});
test('actual ADMIN money dependency HTTP rejects untrusted fields and reports current money impact',async t=>{
 const f=await fixture(t),m=moneyFixture(f),a=f.create(),r=f.r.missionRuntime;
 const server=createCoreServer(f.r.coreFacade,{missionRuntime:r,adminToken:'synthetic-money-dependency-admin'});await listenOnFetchSafePort(server);t.after(()=>new Promise(done=>server.close(done)));
 const root=`http://127.0.0.1:${server.address().port}`,url=root+'/missions/'+a.missionId+'/money-dependencies',headers={authorization:'Bearer synthetic-money-dependency-admin','content-type':'application/json'};
 assert.equal((await fetch(url,{method:'PUT',body:JSON.stringify(m.link)})).status,401);
 assert.equal((await fetch(url,{method:'PUT',headers,body:JSON.stringify({...m.link,execute:true})})).status,400);
 assert.equal((await fetch(url,{method:'PUT',headers,body:JSON.stringify(m.link)})).status,200);
 assert.equal((await fetch(url,{method:'PUT',headers,body:JSON.stringify(m.link)})).status,409);
 const impact=await (await fetch(root+'/missions/'+a.missionId+'/dependency-impact',{headers})).json();assert.equal(impact.budget.money[0].declaredMinor,7000);assert.equal(impact.budget.money[0].providerChargeVerified,false);
 assert.equal(f.budget.summary(m.mandate.id).usedOrHeldCalls,0);
});

for(const [label,objective,currency,value,reason] of [
 ['under', '총액 1만원 이하로 준비해','KRW',7000,null],
 ['inclusive', '총액 1만원 이하로 준비해','KRW',10000,null],
 ['over', '총액 7000원 이하로 준비해','KRW',7001,'money-source-limit-exceeded'],
 ['strict', '총비용 7000원 미만으로 준비해','KRW',7000,'money-source-limit-exceeded'],
 ['minimum-inclusive', '총액 7000원 이상으로 준비해','KRW',7000,null],
 ['minimum-under', '총액 7000원 이상으로 준비해','KRW',6999,'money-source-minimum-not-met'],
 ['minimum-strict', '총액 7000원 초과로 준비해','KRW',7000,'money-source-minimum-not-met'],
 ['minimum-over', '총액 USD 70.00 초과로 준비해','USD',7001,null],
 ['foreign', '총액 USD 70.00 이하로 준비해','USD',7000,null],
 ['currency', '총액 USD 70.00 이하로 준비해','KRW',7000,'money-source-currency-mismatch'],
 ['ambiguous', '총액 $70 이하로 준비해','KRW',7000,'money-source-amount-unresolved'],
 ['scope', '상품 가격 7000원 이하로 준비해','KRW',7000,'money-source-scope-unresolved'],
 ['multiple', '건당 총액 7000원 이하; 누적 총액 1만원 이하','KRW',7000,'money-source-scope-unresolved'],
 ['single-cumulative', '누적 총액 7000원 이하로 준비해','KRW',7000,'money-source-scope-unresolved'],
 ['single-per-item', '건당 총액 7000원 이하로 준비해','KRW',7000,'money-source-scope-unresolved'],
 ['no-comparator', '총액 7000원으로 준비해','KRW',7000,'money-source-scope-unresolved']
])test(`original total-money dependency: ${label}`,async t=>{
 const f=await fixture(t),m=moneyFixture(f,currency),a=f.create({objective}),r=f.r.missionRuntime;
 r.setMoneyDependency(a.missionId,{...m.link,request:{...m.request,amountMinor:value}});
 const impact=r.dependencyImpact(a.missionId).budget.money[0];
 assert.equal(impact.status,reason?'requires-review':'current',JSON.stringify(impact));
 assert.equal(impact.sourceMoney.passed,!reason);assert.equal(impact.sourceMoney.executionAuthority,false);
 if(reason)assert.ok(impact.reasons.includes(reason),JSON.stringify(impact));
 assert.equal(impact.providerChargeVerified,false);assert.equal(f.budget.summary(m.mandate.id).usedOrHeldCalls,0);
});

test('money source binding survives SQL reload but cached amount edits and objective corrections do not bypass it',async t=>{
 const f=await fixture(t),m=moneyFixture(f),a=f.create({objective:'총액 6000원 이하로 준비해'}),r=f.r.missionRuntime;
 r.setMoneyDependency(a.missionId,m.link);
 r.missions.get(a.missionId).goalContract.amounts[0].minorUnits=999999;
 assert.ok(r.dependencyImpact(a.missionId).reasons.includes('money-source-limit-exceeded'));
 r.persist('synthetic-cached-amount-edit');
 const reloadedStore=new SqliteMissionStore({operationsStore:f.operations}),reloaded=reloadedStore.load();
 assert.equal(reloaded.find(x=>x.missionId===a.missionId).objective,'총액 6000원 이하로 준비해');
 assert.ok(missionMoneyDependencyImpact({store:reloadedStore,missions:new Map(reloaded.map(x=>[x.missionId,x]))},a.missionId)[0].reasons.includes('money-source-limit-exceeded'));
 r.missions.get(a.missionId).objective='총액 1만원 이하로 준비해';
 assert.ok(r.dependencyImpact(a.missionId).reasons.includes('money-source-binding-changed'));
 r.missions.get(a.missionId).objective='준비 문서를 저장해';
 r.missions.get(a.missionId).goalContract=createGoalContract({objective:'준비 문서를 저장해'});
 assert.ok(r.dependencyImpact(a.missionId).reasons.includes('money-source-binding-changed'));
 assert.equal(f.budget.summary(m.mandate.id).usedOrHeldCalls,0);
});

test('ADMIN source-money projection and durable change event preserve an over-ceiling quote without dispatching it',async t=>{
 const f=await fixture(t),m=moneyFixture(f),a=f.create({objective:'준비 자료를 확인해; 총액 7000원 이하로 준비해'}),r=f.r.missionRuntime;
 const server=createCoreServer(f.r.coreFacade,{missionRuntime:r,adminToken:'synthetic-source-money'});
 await listenOnFetchSafePort(server);t.after(()=>new Promise(done=>server.close(done)));
 const base=`http://127.0.0.1:${server.address().port}/missions/${a.missionId}`,headers={authorization:'Bearer synthetic-source-money','content-type':'application/json'};
 const put=input=>fetch(base+'/money-dependencies',{method:'PUT',headers,body:JSON.stringify(input)});
 assert.equal((await put(m.link)).status,200);r.reconcileDependencyImpacts();
 assert.equal((await put({...m.link,expectedRevision:1,request:{...m.request,amountMinor:7001}})).status,200);
 const impact=await(await fetch(base+'/dependency-impact',{headers})).json();
 assert.equal(impact.budget.money[0].declaredMinor,7001);
 assert.equal(impact.budget.money[0].sourceMoney.ceilingMinor,7000);
 assert.ok(impact.reasons.includes('money-source-limit-exceeded'));
 assert.equal(r.reconcileDependencyImpacts().changed,1);assert.equal(r.reconcileDependencyImpacts().changed,0);
 assert.equal(r.dependencyImpactEvents().items.length,1);
 assert.equal(f.budget.summary(m.mandate.id).usedOrHeldCalls,0);
 assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM mission_effects').get().n,0);
});

test('ADMIN HTTP lower-bound comparisons persist, survive reload and never create reservations or effects',async t=>{
 const f=await fixture(t),m=moneyFixture(f,'USD'),r=f.r.missionRuntime;
 const server=createCoreServer(f.r.coreFacade,{missionRuntime:r,adminToken:'synthetic-lower-bound'});
 await listenOnFetchSafePort(server);t.after(()=>new Promise(done=>server.close(done)));
 const base=`http://127.0.0.1:${server.address().port}`,headers={authorization:'Bearer synthetic-lower-bound','content-type':'application/json'},rows=[];
 for(const [suffix,expected] of [['이상',[false,true,true]],['초과',[false,false,true]]]){
  const created=f.create({objective:`총액 USD 70.00 ${suffix}으로 준비해`});
  const url=base+'/missions/'+created.missionId;
  let revision=0;
  assert.equal((await fetch(url+'/money-dependencies',{method:'PUT',body:JSON.stringify(m.link)})).status,401);
  for(const [index,value] of [6999,7000,7001].entries()){
   const body={...m.link,requestId:suffix+'-read-only',expectedRevision:revision++,request:{...m.request,amountMinor:value}};
   assert.equal((await fetch(url+'/money-dependencies',{method:'PUT',headers,body:JSON.stringify(body)})).status,200);
   const impact=await(await fetch(url+'/dependency-impact',{headers})).json(),money=impact.budget.money[0];
   assert.equal(money.sourceMoney.passed,expected[index],JSON.stringify(money));
   assert.equal(money.sourceMoney.floorMinor,7000);assert.equal(money.sourceMoney.ceilingMinor,undefined);
   assert.equal(money.sourceMoney.executionAuthority,false);assert.equal(money.providerChargeVerified,false);
   rows.push({suffix,value,expected:expected[index],actual:money.sourceMoney.passed,status:money.status,comparison:money.sourceMoney});
  }
  const reloadedStore=new SqliteMissionStore({operationsStore:f.operations}),saved=reloadedStore.load();
  const current=missionMoneyDependencyImpact({store:reloadedStore,missions:new Map(saved.map(x=>[x.missionId,x]))},created.missionId);
  assert.equal(current[0].sourceMoney.passed,true);
  r.missions.get(created.missionId).goalContract.revision++;
  assert.ok((await(await fetch(url+'/dependency-impact',{headers})).json()).reasons.includes('money-source-binding-changed'));
 }
 assert.equal(f.budget.summary(m.mandate.id).usedOrHeldCalls,0);
 assert.equal(f.operations.db.prepare('SELECT count(*) AS n FROM personal_budget_reservations').get().n,0);
 assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM mission_effects').get().n,0);
 console.log(JSON.stringify({lowerBoundHttpEvidence:{observedAt:new Date().toISOString(),rows,actualCoreHTTP:true,actualSQL:true,reloaded:true,anonymousRejected:true,changedRevisionRejected:true,reservations:0,effects:0,executionAuthority:false,actualCost:null}}));
});
