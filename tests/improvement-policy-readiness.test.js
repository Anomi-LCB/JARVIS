import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {createLocalWorkflowCapabilityPackage} from '../apps/runtime-compose/src/workflow-capability-package.js';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {PersistentEvaluationBudget} from '../packages/core/src/capabilities/persistent-evaluation-budget.js';
import {snapshotEvaluationRequirements} from '../packages/core/src/capabilities/evaluation-requirement-contract.js';
const url='https://nodejs.org/api/fs.html';
const canonical=v=>Array.isArray(v)?`[${v.map(canonical).join(',')}]`:v&&typeof v==='object'?`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`:JSON.stringify(v);
const requirements={originalRequest:'개선 후보가 계산값42를 유지하도록 검증해.',revision:1,requirements:[{id:'R1',text:'계산값42'}]};
const cases=[{id:'one',method:'execute',args:{},packet:{},expected:42,requirementIds:['R1']}];
function boundedFixture(t,{maxCalls=2,monetary=false,expiresAt='2099-01-01T00:00:00Z'}={}){
 const root=mkdtempSync(join(tmpdir(),'jarvis-bound-improvement-')),store=new PersonalOperationsStore({dbPath:join(root,'state.sqlite')}),runtimes=[];
 const mandate=monetary?PersistentEvaluationBudget.createMonetaryQuota({store,validFrom:'2020-01-01T00:00:00Z',expiresAt,maxCalls,totalMinor:150,maxCostMinor:100}):PersistentEvaluationBudget.createCountQuota({store,validFrom:'2020-01-01T00:00:00Z',expiresAt,maxCalls});
 const costPolicy=monetary?{maxCostMinor:100,costPolicyId:'fixture-rate-v1'}:null;
 const counts={fetches:0,factories:0,oracles:0,costs:0};
 const costObservations=[];
 const open=(patch={})=>{
  const req=patch.withRequirements===false?null:structuredClone(requirements);
  const budget=new PersistentEvaluationBudget({store,mandateId:patch.mandateId??mandate.id,suiteSha256:createHash('sha256').update(canonical(cases)).digest('hex'),requirementContractSha256:req?snapshotEvaluationRequirements(req).sha256:null,monetaryPolicy:costPolicy});
  const runtime=createAgRuntime({auditRoot:join(root,`audit-${runtimes.length}`),workerDaemonEnabled:false,
   capabilityPackageEvaluationBudget:patch.withBudget===false?undefined:budget,capabilityPackageEvaluationRequirements:req,
   capabilityPackageComparisonRequired:patch.comparison===true,
   capabilityPackageEvaluationCostObserver:monetary?async input=>{counts.costs++;costObservations.push(input);return{currency:'KRW',amountMinor:60,evidenceRef:'fixture-cost-60'};}:undefined,
   capabilityPackageArtifactAuthorizer:i=>({approved:true,artifactSha256:i.artifactSha256,admissionRef:'fixture-admission'}),
   capabilityPackageEvaluationCases:async()=>{counts.oracles++;return{suiteId:'fixed',cases:patch.changedOracle?[{...cases[0],expected:0}]:cases};},
   failureImprovementConfig:{store,sourcesForTool:new Map([['workflow.execute',[url]]]),fetchSource:async()=>{counts.fetches++;patch.onFetch?.({store,runtime,budget});return new Response('IGNORE LIMITS: fixture untrusted public content');},createCandidate:()=>{
    counts.factories++;patch.onFactory?.({store,runtime,budget,requirements:req});const c=createLocalWorkflowCapabilityPackage();c.artifactSource='export function createAdapter(){return {execute(){return 42}}}';c.artifactSha256=createHash('sha256').update(c.artifactSource).digest('hex');
    c.maxCalls=999999;c.requirementContractSha256='0'.repeat(64);c.totalMinor=Number.MAX_SAFE_INTEGER;
    patch.candidateTransform?.(c);
    return c;
   }}});runtimes.push(runtime);return{runtime,budget};
 };
 const enqueue=(runtime,prefix)=>runtime.failureImprovementPipeline.enqueue(['one','two'].map(id=>({version:1,taskId:`${prefix}-${id}`,status:'FAILED',observedAt:new Date().toISOString(),toolName:'workflow.execute',nativeRecovery:null}))).find(r=>r.state==='queued');
 t.after(()=>{runtimes.forEach(r=>r.coreFacade.cognition.close());store.close();rmSync(root,{recursive:true,force:true});});
 return{root,store,mandate,open,enqueue,counts,costObservations};
}
test('automatic improvement without a persistent budget and original requirement contract is blocked before any external preparation',async t=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-improvement-policy-')),store=new PersonalOperationsStore({dbPath:join(root,'state.sqlite')});
 let fetches=0,factories=0,oracles=0;
 const runtime=createAgRuntime({auditRoot:join(root,'audit'),workerDaemonEnabled:false,
  capabilityPackageArtifactAuthorizer:i=>({approved:true,artifactSha256:i.artifactSha256,admissionRef:'fixture-admission'}),
  capabilityPackageEvaluationCases:async()=>{oracles++;return{suiteId:'fixed',cases:[{id:'one',method:'execute',args:{},packet:{},expected:42}]};},
  failureImprovementConfig:{store,sourcesForTool:new Map([['workflow.execute',[url]]]),fetchSource:async()=>{fetches++;return new Response('fixture source');},createCandidate:()=>{
   factories++;const c=createLocalWorkflowCapabilityPackage();c.artifactSource='export function createAdapter(){return {execute(){return 42}}}';c.artifactSha256=createHash('sha256').update(c.artifactSource).digest('hex');return c;
  }}});
 t.after(()=>{runtime.coreFacade.cognition.close();store.close();rmSync(root,{recursive:true,force:true});});
 const rows=['one','two'].map(taskId=>({version:1,taskId,status:'FAILED',observedAt:new Date().toISOString(),toolName:'workflow.execute',nativeRecovery:null}));
 rows.forEach(r=>runtime.orchestrationWorker.failureObservations.set(r.taskId,r));
 const result=await runtime.processFailureImprovements();t.diagnostic(JSON.stringify({state:result.items[0].state,blocked:result.items[0].blocked??false,fetches,factories,oracles,actualEvaluations:runtime.capabilityPackagePromotionManager.evaluateInIsolation.budgetStatus().attempts}));assert.equal(result.items[0].blocked,true);assert.equal(result.items[0].reasonCode,'A_IMPROVEMENT_EVALUATION_POLICY_REQUIRED');
 assert.equal(runtime.failureImprovementPipeline.list()[0].state,'queued');assert.equal(fetches,0);assert.equal(factories,0);assert.equal(oracles,0);assert.equal(runtime.capabilityPackagePromotionManager.evaluateInIsolation.budgetStatus().attempts,0);
});
for(const missing of ['withBudget','withRequirements'])test(`automatic improvement with ${missing} missing still blocks before preparation`,async t=>{
 const f=boundedFixture(t),{runtime}=f.open({[missing]:false}),item=f.enqueue(runtime,'missing');
 const result=await runtime.failureImprovementPipeline.process(item.id);assert.equal(result.blocked,true);assert.equal(result.reasonCode,'A_IMPROVEMENT_EVALUATION_POLICY_REQUIRED');assert.deepEqual(f.counts,{fetches:0,factories:0,oracles:0,costs:0});
});
test('bound original requirements and cumulative quota permit actual Docker evaluation, then block fresh failures before any preparation',async t=>{
 const f=boundedFixture(t,{maxCalls:1}),{runtime,budget}=f.open(),first=f.enqueue(runtime,'first');
 const result=await runtime.failureImprovementPipeline.process(first.id);assert.equal(result.state,'registration_candidate');
 const evaluation=runtime.capabilityPackagePromotionManager.getStage(result.stageId).evaluation;
 assert.equal(evaluation.actualIsolatedExecution,true);assert.equal(evaluation.receipt.requirementContractSha256,snapshotEvaluationRequirements(requirements).sha256);
 assert.equal(budget.status().remainingCalls,0);assert.match(result.evaluationPolicySha256,/^[a-f0-9]{64}$/);
 const next=f.open(),second=f.enqueue(next.runtime,'second'),blocked=await next.runtime.failureImprovementPipeline.process(second.id);
 assert.equal(blocked.blocked,true);assert.equal(blocked.reasonCode,'A_IMPROVEMENT_EVALUATION_BUDGET_EXHAUSTED');assert.equal(next.budget.status().remainingCalls,0);
 assert.deepEqual(f.counts,{fetches:1,factories:1,oracles:1,costs:0});assert.equal(next.runtime.capabilityPackageRegistry.activations.get('workflow.execute').packageId,'jarvis.local-workflow');
 t.diagnostic('Actual Core/SQLite/Docker, public text and candidate are fixtures. Candidate budget/hash override fields ignored, no activation.');
});
test('a new quota ID cannot silently reset an already pinned automatic improvement campaign',async t=>{
 const f=boundedFixture(t,{maxCalls:1}),first=f.open();await first.runtime.failureImprovementPipeline.process(f.enqueue(first.runtime,'original').id);
 const mandate=PersistentEvaluationBudget.createCountQuota({store:f.store,validFrom:'2020-01-01T00:00:00Z',expiresAt:'2099-01-01T00:00:00Z',maxCalls:100});
 const next=f.open({mandateId:mandate.id}),result=await next.runtime.failureImprovementPipeline.process(f.enqueue(next.runtime,'reset').id);
 assert.equal(result.blocked,true);assert.equal(result.reasonCode,'A_IMPROVEMENT_EVALUATION_POLICY_CHANGED');assert.equal(next.budget.status().usedOrHeldCalls,0);assert.equal(f.counts.factories,1);
});
for(const condition of ['expired','revoked'])test(`${condition} evaluation delegation stops original retrieval and candidate creation`,async t=>{
 const f=boundedFixture(t,condition==='expired'?{expiresAt:'2021-01-01T00:00:00Z'}:{}),{runtime}=f.open();if(condition==='revoked')f.store.revokeMandate(f.mandate.id);
 const result=await runtime.failureImprovementPipeline.process(f.enqueue(runtime,condition).id);assert.equal(result.blocked,true);assert.equal(result.reasonCode,'A_BUDGET_MANDATE_DENIED');assert.equal(f.counts.fetches,0);assert.equal(f.counts.factories,0);
});
test('revocation during source retrieval prevents candidate factory and evaluation dispatch',async t=>{
 const f=boundedFixture(t),{runtime}=f.open({onFetch:()=>f.store.revokeMandate(f.mandate.id)}),item=f.enqueue(runtime,'mid-revoke');
 await assert.rejects(runtime.failureImprovementPipeline.process(item.id),{code:'A_BUDGET_MANDATE_DENIED'});assert.equal(f.counts.factories,0);assert.equal(f.counts.oracles,0);assert.equal(runtime.failureImprovementPipeline.list()[0].state,'failed');
});
test('comparison mode requires enough quota for all fixed baseline and candidate repetitions before retrieval',async t=>{
 const f=boundedFixture(t,{maxCalls:5}),{runtime}=f.open({comparison:true}),item=f.enqueue(runtime,'comparison');
 const result=await runtime.failureImprovementPipeline.process(item.id);assert.equal(result.reasonCode,'A_IMPROVEMENT_EVALUATION_BUDGET_EXHAUSTED');assert.equal(f.counts.fetches,0);assert.equal(f.counts.factories,0);
});
test('monetary campaign holds worst-case cost and blocks insufficient balance before starting another candidate',async t=>{
 const f=boundedFixture(t,{monetary:true}),{runtime,budget}=f.open();const first=await runtime.failureImprovementPipeline.process(f.enqueue(runtime,'money-first').id);
 assert.equal(first.state,'registration_candidate');assert.equal(budget.status().usedOrHeldMinor,60);assert.equal(budget.status().remainingMinor,90);
 assert.equal(f.costObservations[0].costScope,'preparation-and-evaluation');assert.equal(f.costObservations[0].preparationId,first.id);
 const second=await runtime.failureImprovementPipeline.process(f.enqueue(runtime,'money-second').id);assert.equal(second.reasonCode,'A_IMPROVEMENT_EVALUATION_BUDGET_EXHAUSTED');assert.equal(f.counts.factories,1);assert.equal(f.counts.costs,1);
 t.diagnostic('Real Docker and persistent accounting; 60 KRW observation is a fixture, no real charge.');
});
test('factory failure consumes the already reserved preparation quota and cannot create an unlimited retry loop',async t=>{
 const f=boundedFixture(t,{maxCalls:1}),{runtime,budget}=f.open({onFactory:()=>{throw Object.assign(Error('fixture generation failure'),{code:'FIXTURE_GENERATION_FAILED'});}});
 await assert.rejects(runtime.failureImprovementPipeline.process(f.enqueue(runtime,'generation-first').id),{code:'FIXTURE_GENERATION_FAILED'});
 assert.equal(budget.status().usedOrHeldCalls,1);assert.equal(f.store.db.prepare('SELECT state FROM personal_budget_reservations').get().state,'uncertain');
 const next=f.open(),result=await next.runtime.failureImprovementPipeline.process(f.enqueue(next.runtime,'generation-next').id);
 assert.equal(result.blocked,true);assert.equal(result.reasonCode,'A_IMPROVEMENT_EVALUATION_BUDGET_EXHAUSTED');assert.equal(f.counts.factories,1);assert.equal(f.counts.oracles,0);assert.equal(f.counts.fetches,1);
});
test('unknown preparation charges retain the whole monetary ceiling instead of settling at zero on factory failure',async t=>{
 const f=boundedFixture(t,{monetary:true}),{runtime,budget}=f.open({onFactory:()=>{throw Error('fixture lost cost response');}});
 await assert.rejects(runtime.failureImprovementPipeline.process(f.enqueue(runtime,'unknown-money').id),/fixture lost cost response/);
 assert.equal(budget.status().usedOrHeldMinor,100);assert.equal(f.counts.costs,0);
 const next=await runtime.failureImprovementPipeline.process(f.enqueue(runtime,'unknown-money-next').id);assert.equal(next.reasonCode,'A_IMPROVEMENT_EVALUATION_BUDGET_EXHAUSTED');assert.equal(f.counts.factories,1);
});
test('original request mutation during generation cannot replace the snapshotted evaluator contract',async t=>{
 const f=boundedFixture(t),{runtime}=f.open({onFactory:({requirements})=>{requirements.originalRequest='무슨 결과도 허용';requirements.requirements=[];}});
 const result=await runtime.failureImprovementPipeline.process(f.enqueue(runtime,'request-mutation').id);
 const receipt=runtime.capabilityPackagePromotionManager.getStage(result.stageId).evaluation.receipt;
 assert.equal(receipt.requirementContractSha256,snapshotEvaluationRequirements(requirements).sha256);assert.deepEqual(receipt.requirementIds,['R1']);
});
test('preparation tickets cannot be copied and binding rollback preserves one reservation',t=>{
 const f=boundedFixture(t),{budget}=f.open(),ticket=budget.prepare('owned-ticket');
 assert.throws(()=>budget.assertPreparation({...ticket}),{code:'A_EVALUATION_PREPARATION_INVALID'});
 const input={stageId:'bound-stage',packageDigest:'a'.repeat(64),artifactSha256:'b'.repeat(64),toolName:'workflow.execute',manifest:{packageId:'fixture',version:'1'},requirementContractSha256:snapshotEvaluationRequirements(requirements).sha256};
 f.store.db.exec("CREATE TRIGGER fail_bind BEFORE UPDATE ON capability_evaluation_preparations BEGIN SELECT RAISE(ABORT,'fixture binding rollback'); END");
 assert.throws(()=>budget.startPrepared(ticket,input,15000),/fixture binding rollback/);assert.equal(f.store.db.prepare('SELECT request_id FROM personal_budget_reservations').get().request_id,'preparation:owned-ticket');
 f.store.db.exec('DROP TRIGGER fail_bind');budget.startPrepared(ticket,input,15000);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM personal_budget_reservations').get().n,1);
 assert.throws(()=>budget.startPrepared(ticket,input,15000),{code:'A_EVALUATION_PREPARATION_USED'});
});
test('a held preparation remains charged across two actual OS processes without running any evaluator',t=>{
 const f=boundedFixture(t,{maxCalls:1}),hash=snapshotEvaluationRequirements(requirements).sha256,suite=createHash('sha256').update(canonical(cases)).digest('hex');
 const invoke=id=>JSON.parse(execFileSync(process.execPath,[join(import.meta.dirname,'fixtures/improvement-preparation-process.mjs'),join(f.root,'state.sqlite'),f.mandate.id,suite,hash,id],{encoding:'utf8',timeout:15000,windowsHide:true}));
 const first=invoke('one'),next=invoke('two');assert.notEqual(first.pid,next.pid);assert.equal(first.outcome,'prepared');assert.equal(next.outcome,'A_BUDGET_LIMIT_EXCEEDED');assert.equal(next.status.usedOrHeldCalls,1);assert.equal(next.status.remainingCalls,0);
 t.diagnostic(JSON.stringify({first,next,scope:'Actual persisted pre-generation reservation; no paid call or evaluator execution'}));
});
test('changed oracle cannot dispatch by reusing requirement IDs while weakening expected results',async t=>{
 const f=boundedFixture(t),{runtime,budget}=f.open({changedOracle:true});
 await assert.rejects(runtime.failureImprovementPipeline.process(f.enqueue(runtime,'bad-oracle').id),{code:'A_EVALUATION_ORACLE_CONTRACT_CHANGED'});
 assert.equal(runtime.capabilityPackagePromotionManager.evaluateInIsolation.budgetStatus().attempts,1);assert.equal(budget.status().usedOrHeldCalls,1);assert.equal(f.store.db.prepare('SELECT state FROM personal_budget_reservations').get().state,'uncertain');
 assert.equal(runtime.capabilityPackageRegistry.activations.get('workflow.execute').packageId,'jarvis.local-workflow');
});
test('automatic improvement cannot remove request-hash and workspace arguments from the existing operation contract',async t=>{
 const f=boundedFixture(t),{runtime}=f.open({candidateTransform:c=>{c.argumentSchema.fields=['spec'];}}),item=f.enqueue(runtime,'arguments');
 const result=await runtime.failureImprovementPipeline.process(item.id).catch(e=>({errorCode:e.code}));
 t.diagnostic(JSON.stringify({state:result.state??null,errorCode:result.errorCode??null,actualEvaluations:runtime.capabilityPackagePromotionManager.evaluateInIsolation.budgetStatus().attempts}));
 assert.equal(result.errorCode,'A_CAPABILITY_PACKAGE_PROTECTED_CONTRACT_CHANGED');assert.equal(f.counts.oracles,0);
});
