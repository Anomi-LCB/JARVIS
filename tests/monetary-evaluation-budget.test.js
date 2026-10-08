import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {PersistentEvaluationBudget} from '../packages/core/src/capabilities/persistent-evaluation-budget.js';
import {createContainerCapabilityPackageEvaluator} from '../packages/core/src/capabilities/container-capability-package-evaluator.js';
const hash=v=>createHash('sha256').update(v).digest('hex');
const canonical=v=>Array.isArray(v)?`[${v.map(canonical).join(',')}]`:v&&typeof v==='object'?`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`:JSON.stringify(v);
const cases=[{id:'one',method:'execute',args:{},packet:{},expected:42}],suiteSha256=hash(canonical(cases));
const artifactSource='export function createAdapter(){return {execute(){return 42}}}';
const input={stageId:'first',artifactSource,artifactSha256:hash(artifactSource),packageDigest:'a'.repeat(64),toolName:'synthetic.execute',manifest:{packageId:'test.money',version:'1'}};
function fixture(t){const root=mkdtempSync(join(tmpdir(),'jarvis-evaluation-money-')),stores=[];
 const open=()=>{const s=new PersonalOperationsStore({dbPath:join(root,'budget.sqlite')});stores.push(s);return s;};const store=open();
 const mandate=PersistentEvaluationBudget.createMonetaryQuota({store,validFrom:'2020-01-01T00:00:00Z',expiresAt:'2099-01-01T00:00:00Z',maxCalls:5,totalMinor:150,maxCostMinor:100});
 const budget=(s=store,policy={maxCostMinor:100,costPolicyId:'synthetic-rate-v1'})=>new PersistentEvaluationBudget({store:s,mandateId:mandate.id,suiteSha256,monetaryPolicy:policy});
 t.after(()=>{stores.forEach(s=>s.close());rmSync(root,{recursive:true,force:true});});return{store,open,budget,mandate,dbPath:join(root,'budget.sqlite')};}
const mock=async()=>({status:'completed',actualContainerExecution:true,enforcementVerified:true,stdout:'JARVIS_PACKAGE_RESULT:[{"id":"one","actual":42}]',durationMs:1,restrictions:{},limitations:['synthetic accounting contract only']});
const observation=amountMinor=>({currency:'KRW',amountMinor,evidenceRef:'synthetic-provider-receipt'});
const evaluator=(budget,patch={})=>createContainerCapabilityPackageEvaluator({persistentBudget:budget,casesForPackage:async()=>({suiteId:'fixed',cases}),executeContainer:mock,observeEvaluationCost:async()=>observation(60),...patch});
test('reserves ceiling, atomically settles observed amount and retains money cap across restart',async t=>{
 const f=fixture(t),budget=f.budget();let calls=0;
 const evaluate=evaluator(budget,{executeContainer:async()=>{calls++;assert.equal(budget.status().usedOrHeldMinor,100);return mock();}});
 const first=await evaluate({...input,maxCostMinor:0,actualCost:0});assert.equal(first.status,'passed');assert.equal(budget.status().usedOrHeldMinor,60);assert.equal(budget.status().remainingMinor,90);
 const next=evaluator(f.budget(f.open()),{executeContainer:async()=>{calls++;return mock();}});assert.equal((await next(input)).evaluationReplay.executedNow,false);
 await assert.rejects(next({...input,stageId:'second'}),{code:'A_BUDGET_LIMIT_EXCEEDED'});assert.equal(calls,1);
 assert.equal(f.store.db.prepare('SELECT actual_minor FROM personal_budget_reservations').get().actual_minor,60);
 assert.throws(()=>f.budget(f.open(),{maxCostMinor:100,costPolicyId:'cheaper-rate'}),{code:'A_EVALUATION_PERSISTENT_POLICY_IMMUTABLE'});
});
test('unknown or excess charges remain held and cannot become zero-cost passing evidence',async t=>{
 for(const value of [null,observation(101),observation(-1),observation(NaN),{...observation(1),currency:'USD'}]){
  const f=fixture(t),budget=f.budget();await assert.rejects(evaluator(budget,{observeEvaluationCost:async()=>value})(input),e=>['A_EVALUATION_COST_UNMEASURED','A_EVALUATION_COST_EXCEEDS_RESERVATION'].includes(e.code));
  assert.equal(budget.status().usedOrHeldMinor,100);assert.equal(f.store.db.prepare('SELECT state,actual_minor FROM personal_budget_reservations').get().state,'uncertain');
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM capability_evaluation_receipts').get().n,0);
  await assert.rejects(evaluator(f.budget(f.open()))(input),{code:'A_EVALUATION_RECONCILIATION_REQUIRED'});
 }
});
test('cost observer is required before any execution and concurrent connections share monetary reservation',async t=>{
 const f=fixture(t),budget=f.budget();assert.throws(()=>evaluator(budget,{observeEvaluationCost:null}),{code:'A_EVALUATION_COST_OBSERVER_REQUIRED'});
 let release,calls=0;const running=evaluator(budget,{casesForPackage:()=>new Promise(r=>release=r),executeContainer:async()=>{calls++;return mock();}})(input);
 await assert.rejects(evaluator(f.budget(f.open()))({...input,stageId:'second'}),{code:'A_BUDGET_LIMIT_EXCEEDED'});
 await new Promise(r=>setImmediate(r));release({suiteId:'fixed',cases});await running;assert.equal(calls,1);
});
test('actual offline container evaluation uses host charge evidence, never candidate cost claims',async t=>{
 const f=fixture(t);let seen;const evaluate=evaluator(f.budget(),{executeContainer:undefined,observeEvaluationCost:async(context)=>{seen=context;return observation(30);}});
 // Undefined selects the real pinned offline container default.
 const result=await evaluate(input);assert.equal(result.actualIsolatedExecution,true);assert.equal(result.status,'passed');assert.equal(seen.costPolicyId,'synthetic-rate-v1');assert.equal(f.budget().status().usedOrHeldMinor,30);
 assert.equal(result.receipt.costObservation.evidenceRef,'synthetic-provider-receipt');t.diagnostic('Real container execution; cost observations are synthetic contract evidence, no paid call or real charge.');
});
test('four actual OS processes cannot reserve money past the persisted ceiling',async t=>{
 const f=fixture(t);f.budget();
 const code=`import {PersonalOperationsStore} from './packages/core/src/personal-operations/operations-store.js';import {PersistentEvaluationBudget} from './packages/core/src/capabilities/persistent-evaluation-budget.js';const store=new PersonalOperationsStore({dbPath:process.argv[1]});try{const b=new PersistentEvaluationBudget({store,mandateId:process.argv[2],suiteSha256:process.argv[3],monetaryPolicy:{maxCostMinor:100,costPolicyId:'synthetic-rate-v1'}});b.start({...JSON.parse(process.argv[4]),stageId:process.argv[5]},15000);console.log('reserved');}catch(e){console.log(e.code);}finally{store.close();}`;
 const run=promisify(execFile),results=await Promise.all(Array.from({length:4},(_,i)=>run(process.execPath,['--input-type=module','-e',code,f.dbPath,f.mandate.id,suiteSha256,JSON.stringify(input),`money-process-${i}`],{windowsHide:true})));
 assert.equal(results.filter(r=>r.stdout.trim()==='reserved').length,1);assert.equal(results.filter(r=>r.stdout.trim()==='A_BUDGET_LIMIT_EXCEEDED').length,3);assert.equal(f.budget().status().usedOrHeldMinor,100);
});
