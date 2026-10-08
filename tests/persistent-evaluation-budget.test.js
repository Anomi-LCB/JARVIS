import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PersonalOperationsStore } from '../packages/core/src/personal-operations/operations-store.js';
import { PersistentEvaluationBudget } from '../packages/core/src/capabilities/persistent-evaluation-budget.js';
import { createContainerCapabilityPackageEvaluator } from '../packages/core/src/capabilities/container-capability-package-evaluator.js';
const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = v => Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v);
const cases = [{ id:'one', method:'execute', args:{}, packet:{}, expected:42 }];
const suiteSha256 = hash(canonical(cases));
const artifactSource = 'export function createAdapter(){return {execute(){return 42}}}';
const input = { stageId:'first', artifactSource, artifactSha256:hash(artifactSource), packageDigest:'a'.repeat(64), toolName:'synthetic.execute', manifest:{packageId:'test.persist',version:'1'} };
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(),'jarvis-eval-quota-')), dbPath=join(root,'db.sqlite'), stores=[];
  const open=()=>{ const store=new PersonalOperationsStore({dbPath}); stores.push(store); return store; };
  const store=open(), mandate=PersistentEvaluationBudget.createCountQuota({store,validFrom:'2020-01-01T00:00:00Z',expiresAt:'2099-01-01T00:00:00Z',maxCalls:1});
  const budget=s=>new PersistentEvaluationBudget({store:s,mandateId:mandate.id,suiteSha256});
  t.after(()=>{for(const s of stores)s.close();rmSync(root,{recursive:true,force:true});});
  return {store,open,budget,dbPath,mandateId:mandate.id};
}
const mock = async()=>({status:'completed',actualContainerExecution:true,enforcementVerified:true,stdout:'JARVIS_PACKAGE_RESULT:[{"id":"one","actual":42}]',durationMs:1,restrictions:{},limitations:['contract fixture']});
const evaluator=(budget,patch={})=>createContainerCapabilityPackageEvaluator({persistentBudget:budget,casesForPackage:async()=>({suiteId:'fixed',cases}),executeContainer:mock,...patch});
test('historical receipt from an old result channel cannot be replayed or restored after SQLite reopen',async t=>{
 const f=fixture(t);await evaluator(f.budget(f.store))(input);
 const row=f.store.db.prepare('SELECT * FROM capability_evaluation_receipts').get();
 const legacy=JSON.parse(row.result_json);delete legacy.receipt.resultChannelVersion;
 const bytes=JSON.stringify(legacy),digest=hash(bytes);
 f.store.db.prepare('UPDATE capability_evaluation_receipts SET result_json=?,result_sha256=? WHERE reservation_id=?').run(bytes,digest,row.reservation_id);
 f.store.db.prepare('UPDATE personal_budget_reservations SET receipt_ref=? WHERE id=?').run(`sha256:${digest}`,row.reservation_id);
 let dispatches=0;const next=evaluator(f.budget(f.open()),{executeContainer:async()=>{dispatches++;return mock();}});
 await assert.rejects(next(input),{code:'A_EVALUATION_RESULT_CHANNEL_REEVALUATION_REQUIRED'});
 assert.throws(()=>next.restoreCompleted(input),{code:'A_EVALUATION_RESULT_CHANNEL_REEVALUATION_REQUIRED'});
 assert.equal(dispatches,0);assert.equal(next.persistentBudgetStatus().remainingCalls,0);
});
test('new evaluator and SQLite connection retain quota and replay only historical evidence',async t=>{
  const f=fixture(t); let calls=0;
  assert.equal((await evaluator(f.budget(f.store),{executeContainer:async()=>{calls++;return mock();}})(input)).status,'passed');
  const next=evaluator(f.budget(f.open()),{executeContainer:async()=>{calls++;return mock();}});
  const cached=await next(input);assert.equal(cached.evaluationReplay.executedNow,false);assert.equal(calls,1);
  await assert.rejects(next({...input,stageId:'second'}),{code:'A_BUDGET_LIMIT_EXCEEDED'});
  await assert.rejects(next({...input,packageDigest:'b'.repeat(64)}),{code:'A_BUDGET_REQUEST_CONFLICT'});
  assert.equal(next.persistentBudgetStatus().remainingCalls,0);assert.equal(next.persistentBudgetStatus().actualCost,null);
  assert.throws(()=>new PersistentEvaluationBudget({store:f.store,mandateId:f.mandateId,suiteSha256:'b'.repeat(64)}),{code:'A_EVALUATION_PERSISTENT_POLICY_IMMUTABLE'});
});
test('two independent connections cannot dispatch concurrent attempts beyond quota',async t=>{
  const f=fixture(t);let release,calls=0;
  const first=evaluator(f.budget(f.store),{casesForPackage:()=>new Promise(r=>release=r),executeContainer:async()=>{calls++;return mock();}})(input);
  const next=evaluator(f.budget(f.open()));
  await assert.rejects(next({...input,stageId:'second'}),{code:'A_BUDGET_LIMIT_EXCEEDED'});
  await assert.rejects(next(input),{code:'A_EVALUATION_RECONCILIATION_REQUIRED'});
  release({suiteId:'fixed',cases});await first;assert.equal(calls,1);
});
test('oracle failure remains uncertain across reconnection and is never automatically retried',async t=>{
  const f=fixture(t);await assert.rejects(evaluator(f.budget(f.store),{casesForPackage:async()=>{throw Error('unavailable');}})(input),/unavailable/);
  await assert.rejects(evaluator(f.budget(f.open()))(input),{code:'A_EVALUATION_RECONCILIATION_REQUIRED'});
});
test('changed oracle and revocation stop dispatch; revocation after execution stops settlement',async t=>{
  const f=fixture(t);let calls=0;
  await assert.rejects(evaluator(f.budget(f.store),{casesForPackage:async()=>({suiteId:'changed',cases:[{...cases[0],expected:43}]}),executeContainer:async()=>{calls++;return mock();}})(input),{code:'A_EVALUATION_ORACLE_CONTRACT_CHANGED'});assert.equal(calls,0);
  const g=fixture(t);await assert.rejects(evaluator(g.budget(g.store),{executeContainer:async()=>{g.store.revokeMandate(g.mandateId);return mock();}})(input),{code:'A_BUDGET_MANDATE_DENIED'});
  assert.equal(g.store.db.prepare('SELECT count(*) AS n FROM capability_evaluation_receipts').get().n,0);
});
test('receipt transaction rollback retains held attempt without false historical completion',async t=>{
  const f=fixture(t),budget=f.budget(f.store),ticket=budget.start(input,15000);
  assert.throws(()=>budget.finish(ticket,{status:'passed',packageDigest:input.packageDigest,artifactSha256:input.artifactSha256,receipt:{suiteSha256}},()=>{throw Error('deadline');}),/deadline/);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM capability_evaluation_receipts').get().n,0);
  assert.throws(()=>f.budget(f.open()).start(input,15000),{code:'A_EVALUATION_RECONCILIATION_REQUIRED'});
});
test('four actual OS processes cannot oversubscribe one persisted evaluation quota',async t=>{
  const f=fixture(t);f.budget(f.store);
  const code=`import {PersonalOperationsStore} from './packages/core/src/personal-operations/operations-store.js';import {PersistentEvaluationBudget} from './packages/core/src/capabilities/persistent-evaluation-budget.js';const store=new PersonalOperationsStore({dbPath:process.argv[1]});try{const b=new PersistentEvaluationBudget({store,mandateId:process.argv[2],suiteSha256:process.argv[3]});b.start({...JSON.parse(process.argv[4]),stageId:process.argv[5]},15000);console.log('reserved');}catch(e){console.log(e.code);}finally{store.close();}`;
  const run=promisify(execFile),results=await Promise.all(Array.from({length:4},(_,i)=>run(process.execPath,['--input-type=module','-e',code,f.dbPath,f.mandateId,suiteSha256,JSON.stringify(input),`process-${i}`],{windowsHide:true})));
  assert.equal(results.filter(r=>r.stdout.trim()==='reserved').length,1);
  assert.equal(results.filter(r=>r.stdout.trim()==='A_BUDGET_LIMIT_EXCEEDED').length,3);
});
test('actual isolated container execution settles once and recreated evaluator cannot repeat it',async t=>{
  const f=fixture(t);const evaluate=createContainerCapabilityPackageEvaluator({persistentBudget:f.budget(f.store),casesForPackage:async()=>({suiteId:'fixed',cases})});
  const result=await evaluate(input);assert.equal(result.status,'passed');assert.equal(result.actualIsolatedExecution,true);
  const next=createContainerCapabilityPackageEvaluator({persistentBudget:f.budget(f.open()),casesForPackage:async()=>{throw Error('replay must not query');}});
  assert.equal((await next(input)).evaluationReplay.executedNow,false);
  await assert.rejects(next({...input,stageId:'new'}),{code:'A_BUDGET_LIMIT_EXCEEDED'});
});
