import {SqliteMissionStore} from './sqlite-mission-store.js';
import {MissionExecutionAuthority} from './mission-execution-authority.js';
import {normalizeMandateRequestScope} from '../personal-operations/mandate-scope.js';
import {dependencyImpactDigest} from './dependency-impact-digest.js';
import {createGoalContract} from './goal-contract.js';
import {compareGoalAmount} from './goal-money-expression.js';
const fail=code=>{throw Object.assign(new Error(code),{code});};
const id=(v,max=200)=>typeof v==='string'&&v.trim()===v&&v.length>0&&v.length<=max&&!/[\u0000-\u001f]/u.test(v);
const amount=v=>Number.isSafeInteger(v)&&v>=0;
const fields=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>keys.includes(k));
const table='mission_money_dependencies';
export function sourceBinding(mission){
 return {objectiveSha256:dependencyImpactDigest(mission.objective),goalRevision:mission.goalContract?.revision??null,
  moneyConstraintRequired:createGoalContract({objective:mission.objective}).amounts.length>0};
}
// This projection compares an explicitly named single total predicate only. It
// does not prove the quoted price, authorize a transaction, or infer which of
// multiple per-item/cumulative/foreign-currency facts belongs to this request.
export function sourceMoney(mission,body){
 const base={version:'a-mission-source-total-money-v1',executionAuthority:false,providerChargeVerified:false};
 let contract;
 try{contract=createGoalContract({objective:mission.objective});}catch{return {...base,required:true,passed:false,reasons:['money-source-binding-unavailable']};}
 const oldAmounts=mission.goalContract?.amounts??[];
 if(!contract.amounts.length&&!oldAmounts.length&&!body.sourceBinding?.moneyConstraintRequired)return {...base,required:false,passed:true,reasons:[]};
 if(mission.goalContract?.objective!==mission.objective||!body.sourceBinding
  ||dependencyImpactDigest(body.sourceBinding)!==dependencyImpactDigest(sourceBinding(mission)))
  return {...base,required:true,passed:false,reasons:['money-source-binding-changed']};
 const amounts=contract.amounts;
 if(amounts.some(a=>a.status!=='parsed'))return {...base,required:true,passed:false,reasons:['money-source-amount-unresolved']};
 const a=amounts[0];
 const prefix=a?mission.objective.slice(0,a.sourceSpan.start).split(/[;；\n]/u).at(-1):'';
 if(amounts.length!==1||!['lte','lt','gte','gt'].includes(a?.comparator)||!/^\s*(?:총액|총비용)\s*$/u.test(prefix))
  return {...base,required:true,passed:false,reasons:['money-source-scope-unresolved']};
 const reasons=[];
 const comparison=compareGoalAmount(a,{currency:body.request?.currency,minorUnits:body.request?.amountMinor});
 if(!comparison.passed)reasons.push(comparison.reason==='amount-condition-not-met'
  ?(['lte','lt'].includes(a.comparator)?'money-source-limit-exceeded':'money-source-minimum-not-met')
  :'money-source-'+comparison.reason);
 const upperBound=['lte','lt'].includes(a.comparator);
 return {...base,required:true,passed:!reasons.length,reasons,currency:a.currency,boundaryMinor:a.minorUnits,
  ...(upperBound?{ceilingMinor:a.minorUnits}:{floorMinor:a.minorUnits}),
  comparator:a.comparator,declaredMinor:body.request?.amountMinor??null,sourceObjectiveSha256:body.sourceBinding.objectiveSha256,
  goalRevision:body.sourceBinding.goalRevision,quoteAndReceiptBindingVerified:false};
}
export function setMissionMoneyDependency(runtime,missionId,input){
 const store=runtime.store,authority=runtime.executionAuthority;
 if(!(store instanceof SqliteMissionStore)||!(authority instanceof MissionExecutionAuthority)||authority.store!==store)fail('A_MISSION_MONEY_AUTHORITY_REQUIRED');
 if(!runtime.missions.has(missionId))fail('A_MISSION_NOT_FOUND');
 if(!fields(input,['dependencyId','mandateId','requestId','request','intentFingerprint','expectedRevision'])
  ||![input.dependencyId,input.requestId].every(v=>id(v))||!id(input.mandateId,100)||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0
  ||!fields(input.request,['action','target','currency','amountMinor','accountRef','dataRefs','mandateRevision'])
  ||!id(input.request.action,100)||!id(input.request.target,300)||!/^[A-Z]{3}$/u.test(input.request.currency??'')
  ||(input.request.amountMinor!==null&&!amount(input.request.amountMinor))
  ||(input.intentFingerprint!==undefined&&!/^[a-f0-9]{64}$/u.test(input.intentFingerprint)))fail('A_MISSION_MONEY_INPUT_INVALID');
 const body={mandateId:input.mandateId,requestId:input.requestId,request:{action:input.request.action,target:input.request.target,currency:input.request.currency,amountMinor:input.request.amountMinor,...normalizeMandateRequestScope(input.request)},...(input.intentFingerprint?{intentFingerprint:input.intentFingerprint}:{}),sourceBinding:sourceBinding(runtime.missions.get(missionId))};
 authority.assertActive();
 return store._transaction(()=>{
  const now=store._now();store._assertFence(authority.lease,now);
  if(store._snapshot().revision!==store.revision)fail('A_MISSION_MONEY_CORE_STALE');
  store.db.exec(`CREATE TABLE IF NOT EXISTS ${table}(mission_id TEXT NOT NULL,dependency_id TEXT NOT NULL,revision INTEGER NOT NULL,body TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(mission_id,dependency_id))`);
  const previous=store.db.prepare(`SELECT revision FROM ${table} WHERE mission_id=? AND dependency_id=?`).get(missionId,input.dependencyId);
  if((previous?.revision??0)!==input.expectedRevision)fail('A_MISSION_MONEY_REVISION_CONFLICT');
  const revision=input.expectedRevision+1;
  store.db.prepare(`INSERT INTO ${table} VALUES(?,?,?,?,?) ON CONFLICT(mission_id,dependency_id) DO UPDATE SET revision=excluded.revision,body=excluded.body,digest=excluded.digest`).run(missionId,input.dependencyId,revision,JSON.stringify(body),dependencyImpactDigest(body));
  return {missionId,dependencyId:input.dependencyId,revision,executionAuthority:false,reservationsCreated:0};
 });
}
export function missionMoneyDependencyImpact(runtime,missionId){
 if(!(runtime.store instanceof SqliteMissionStore))return [];
 const store=runtime.store,db=store.db;
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))return [];
 return db.prepare(`SELECT * FROM ${table} WHERE mission_id=? ORDER BY dependency_id`).all(missionId).map(link=>{
  const base={dependencyId:link.dependency_id,revision:link.revision,executionAuthority:false,providerChargeVerified:false,costMeaning:'declared-minor-unit-accounting-not-provider-verification'};
  try{
   const body=JSON.parse(link.body);if(dependencyImpactDigest(body)!==link.digest)fail('corrupt');
   const {request,mandateId,requestId}=body,source=sourceMoney(runtime.missions.get(missionId),body),reasons=[...source.reasons];
   if(request.amountMinor===null)return {...base,sourceMoney:source,currency:request.currency,declaredMinor:null,status:'unknown',reasons:[...new Set([...source.reasons,'money-amount-unmeasured'])]};
   if(!amount(request.amountMinor))fail('invalid');
   const evaluation=store.operationsStore.evaluateMandate(mandateId,request);reasons.push(...evaluation.reasons.map(r=>'money-'+r));
   const summary=store.budget.summary(mandateId);
   for(const key of ['totalMinor','usedOrHeldMinor','remainingMinor','maxCalls','usedOrHeldCalls','remainingCalls'])if(!amount(summary[key]))fail('invalid-summary');
   const reservation=db.prepare('SELECT * FROM personal_budget_reservations WHERE mandate_id=? AND request_id=?').get(mandateId,requestId);
   let availableMinor=summary.remainingMinor,availableCalls=summary.remainingCalls,state=null,actualMinor=null;
   if(reservation){
    const expected={...request,...(body.intentFingerprint?{intentFingerprint:body.intentFingerprint}:{})};
    if(dependencyImpactDigest(JSON.parse(reservation.request_json))!==dependencyImpactDigest(expected))reasons.push('money-reservation-request-mismatch');
    state=reservation.state;
    if(state==='uncertain')reasons.push('money-reservation-reconciliation-required');
    if(['settled','released'].includes(state))reasons.push('money-reservation-closed');
    if(['reserved','in_flight','uncertain'].includes(state)){if(!amount(reservation.amount_minor))fail('invalid-reservation');availableMinor+=reservation.amount_minor;availableCalls++;}
    actualMinor=reservation.actual_minor;
    if(state==='settled'&&!amount(actualMinor))fail('invalid-settlement');
   }
   if(!amount(availableMinor)||!amount(availableCalls))fail('unsafe-total');
   if(request.amountMinor>availableMinor)reasons.push('money-budget-exhausted');if(availableCalls<1)reasons.push('money-call-budget-exhausted');
   return {...base,sourceMoney:source,currency:request.currency,declaredMinor:request.amountMinor,status:reasons.length?'requires-review':'current',reasons:[...new Set(reasons)],
    remainingMinor:summary.remainingMinor,availableForThisRequestMinor:availableMinor,usedOrHeldMinor:summary.usedOrHeldMinor,
    reservationState:state,accountedActualMinor:actualMinor};
  }catch{return {...base,status:'unknown',reasons:['money-budget-observation-unavailable'],declaredMinor:null};}
 });
}
