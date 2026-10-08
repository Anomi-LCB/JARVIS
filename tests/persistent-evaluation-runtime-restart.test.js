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
const canonical = v => Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v);
const cases=[{id:'one',method:'execute',args:{},packet:{},expected:42}];
const suiteSha256=createHash('sha256').update(canonical(cases)).digest('hex');
const child=`import {createHash} from 'node:crypto';
import {createAgRuntime} from './apps/runtime-compose/src/create-runtime.js';
import {createLocalWorkflowCapabilityPackage} from './apps/runtime-compose/src/workflow-capability-package.js';
import {PersonalOperationsStore} from './packages/core/src/personal-operations/operations-store.js';
import {PersistentEvaluationBudget} from './packages/core/src/capabilities/persistent-evaluation-budget.js';
const store=new PersonalOperationsStore({dbPath:process.argv[1]});
const monetary=process.argv[5]==='money';
const budget=new PersistentEvaluationBudget({store,mandateId:process.argv[2],suiteSha256:process.argv[3],maxTimeoutMs:20000,...(monetary?{monetaryPolicy:{maxCostMinor:100,costPolicyId:'synthetic-core-rate-v1'}}:{})});
let oracles=0,costObservations=0;
const runtime=createAgRuntime({capabilityPackageEvaluationBudget:budget,capabilityPackageEvaluationTimeoutMs:20000,
 ...(monetary?{capabilityPackageEvaluationCostObserver:async()=>{costObservations++;return {currency:'KRW',amountMinor:60,evidenceRef:'synthetic-core-accounting-receipt'};}}:{}),
 capabilityPackageArtifactAuthorizer:i=>({approved:true,artifactSha256:i.artifactSha256,admissionRef:'synthetic:restart-test'}),
 capabilityPackageEvaluationCases:async()=>{oracles++;return {suiteId:'restart-fixed',cases:JSON.parse(process.argv[4])};}});
try {
 const active=runtime.capabilityPackageRegistry.activations.get('workflow.execute').packageDigest;
 const candidate=createLocalWorkflowCapabilityPackage();candidate.packageId='synthetic.restart';candidate.version='1.9.0';
 candidate.skill={...candidate.skill,skillId:'synthetic_restart',version:candidate.version};
 candidate.artifactSource='export function createAdapter(){return {execute(){return 42}}}';
 candidate.artifactSha256=createHash('sha256').update(candidate.artifactSource).digest('hex');
 const staged=runtime.capabilityPackagePromotionManager.stage(candidate);
 let outcome,isolation=false;
 try {const result=await runtime.capabilityPackagePromotionManager.evaluate(staged.stageId);outcome=result.evaluation.status;isolation=result.evaluation.receipt.isolationEnforced;}
 catch(e){outcome=e.code??e.message;}
 console.log(JSON.stringify({outcome,isolation,oracles,costObservations,pid:process.pid,stageId:staged.stageId,activeUnchanged:runtime.capabilityPackageRegistry.activations.get('workflow.execute').packageDigest===active,
  budget:runtime.capabilityPackagePromotionManager.evaluateInIsolation.persistentBudgetStatus()}));
}finally{runtime.coreFacade.cognition.close();store.close();}`;
test('two successive actual Core OS processes retain evaluation quota and active package',async t=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-core-eval-restart-')),dbPath=join(root,'quota.sqlite');
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const store=new PersonalOperationsStore({dbPath});
 const mandate=PersistentEvaluationBudget.createCountQuota({store,validFrom:'2020-01-01T00:00:00Z',expiresAt:'2099-01-01T00:00:00Z',maxCalls:1});store.close();
 const run=promisify(execFile),args=['--input-type=module','-e',child,dbPath,mandate.id,suiteSha256,JSON.stringify(cases)];
 const first=JSON.parse((await run(process.execPath,args,{windowsHide:true,timeout:60000})).stdout.trim());
 assert.equal(first.outcome,'passed');assert.equal(first.isolation,true);assert.equal(first.oracles,1);assert.equal(first.activeUnchanged,true);
 const second=JSON.parse((await run(process.execPath,args,{windowsHide:true,timeout:60000})).stdout.trim());
 t.diagnostic(JSON.stringify({first,second}));
 assert.equal(second.outcome,'A_BUDGET_LIMIT_EXCEEDED');assert.equal(second.oracles,0);assert.equal(second.activeUnchanged,true);
 assert.notEqual(first.stageId,second.stageId);assert.equal(second.budget.remainingCalls,0);assert.equal(second.budget.actualCost,null);
 const reopened=new PersonalOperationsStore({dbPath});try{
  assert.equal(reopened.db.prepare('SELECT count(*) AS n FROM capability_evaluation_receipts').get().n,1);
  assert.equal(reopened.db.prepare("SELECT count(*) AS n FROM personal_budget_reservations WHERE state='settled'").get().n,1);
 }finally{reopened.close();}
});

test('default Core monetary evaluation reservation survives actual OS restart before any new oracle or dispatch',async t=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-core-eval-money-')),dbPath=join(root,'quota.sqlite');t.after(()=>rmSync(root,{recursive:true,force:true}));
 const store=new PersonalOperationsStore({dbPath});const mandate=PersistentEvaluationBudget.createMonetaryQuota({store,validFrom:'2020-01-01T00:00:00Z',expiresAt:'2099-01-01T00:00:00Z',maxCalls:5,totalMinor:150,maxCostMinor:100});store.close();
 const run=promisify(execFile),args=['--input-type=module','-e',child,dbPath,mandate.id,suiteSha256,JSON.stringify(cases),'money'];
 const first=JSON.parse((await run(process.execPath,args,{windowsHide:true,timeout:60000})).stdout.trim());assert.equal(first.outcome,'passed');assert.equal(first.isolation,true);assert.equal(first.costObservations,1);assert.equal(first.budget.usedOrHeldMinor,60);
 const second=JSON.parse((await run(process.execPath,args,{windowsHide:true,timeout:60000})).stdout.trim());assert.notEqual(first.pid,second.pid);assert.equal(second.outcome,'A_BUDGET_LIMIT_EXCEEDED');assert.equal(second.oracles,0);assert.equal(second.costObservations,0);assert.equal(second.activeUnchanged,true);assert.equal(second.budget.remainingMinor,90);
 const reopened=new PersonalOperationsStore({dbPath});try{assert.equal(reopened.db.prepare('SELECT count(*) AS n FROM capability_evaluation_receipts').get().n,1);assert.equal(reopened.db.prepare('SELECT actual_minor FROM personal_budget_reservations').get().actual_minor,60);}finally{reopened.close();}
 t.diagnostic(JSON.stringify({first,second,costMeaning:'synthetic charge observation; real Core and Docker execution; no paid call'}));
});
