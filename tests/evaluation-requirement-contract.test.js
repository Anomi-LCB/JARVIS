import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {snapshotEvaluationRequirements} from '../packages/core/src/capabilities/evaluation-requirement-contract.js';
import {createContainerCapabilityPackageEvaluator} from '../packages/core/src/capabilities/container-capability-package-evaluator.js';
import {PersistentEvaluationBudget} from '../packages/core/src/capabilities/persistent-evaluation-budget.js';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {createLocalWorkflowCapabilityPackage} from '../apps/runtime-compose/src/workflow-capability-package.js';
const original=()=>({originalRequest:'계산 결과42를 유지하고 원본 변경 없이 검증해.',revision:1,requirements:[{id:'R1',text:'계산값42'},{id:'R2',text:'원본 보존'}]});
const artifactSource='export function createAdapter(){return {execute(){return 42}}}';
const input={stageId:'requirements',artifactSource,artifactSha256:createHash('sha256').update(artifactSource).digest('hex'),packageDigest:'a'.repeat(64),toolName:'test.calculate',manifest:{packageId:'test.requirements',version:'1'}};
const cases=[{id:'one',method:'execute',args:{},packet:{},expected:42,requirementIds:['R1','R2']}];
const canonical=v=>Array.isArray(v)?`[${v.map(canonical).join(',')}]`:v&&typeof v==='object'?`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`:JSON.stringify(v);
const mock=async()=>({status:'completed',actualContainerExecution:true,enforcementVerified:true,stdout:'JARVIS_PACKAGE_RESULT:[{"id":"one","actual":42}]',durationMs:1,restrictions:{},limitations:['contract fixture only']});
test('host requirements are snapshotted before oracle callbacks and candidate overrides are ignored',async()=>{
 const contract=original(),expected=snapshotEvaluationRequirements(contract);let dispatches=0;
 const evaluate=createContainerCapabilityPackageEvaluator({requirementContract:contract,casesForPackage:async()=>{contract.originalRequest='없애';contract.requirements.pop();return {suiteId:'fixed',cases};},executeContainer:async()=>{dispatches++;return mock();}});
 contract.requirements[0].text='어떤 값도 허용';
 const result=await evaluate({...input,requirementContract:original(),requirementContractSha256:'f'.repeat(64)});
 assert.equal(result.receipt.requirementContractSha256,expected.sha256);assert.deepEqual(result.receipt.requirementIds,['R1','R2']);assert.equal(dispatches,1);
});
test('missing or unknown requirement mappings block execution instead of silently narrowing the evaluation',async()=>{
 for(const [ids,code] of [[['R1'],'A_EVALUATION_REQUIREMENTS_MISSING'],[['R1','R3'],'A_EVALUATION_REQUIREMENT_COVERAGE_INVALID'],[undefined,'A_EVALUATION_REQUIREMENT_COVERAGE_INVALID']]){
  const item={...cases[0]};if(ids===undefined)delete item.requirementIds;else item.requirementIds=ids;
  let calls=0;const evaluate=createContainerCapabilityPackageEvaluator({requirementContract:original(),casesForPackage:async()=>({suiteId:'fixed',cases:[item]}),executeContainer:async()=>{calls++;return mock();}});
  await assert.rejects(evaluate(input),{code});assert.equal(calls,0);
 }
});
test('invalid duplicate requirement IDs are rejected before any evaluation',()=>{
 const c=original();c.requirements.push({...c.requirements[0]});assert.throws(()=>snapshotEvaluationRequirements(c),{code:'A_EVALUATION_REQUIREMENT_CONTRACT_INVALID'});
});
test('actual container receipt pins original requirements and persisted policy rejects weakening after reconnect',async t=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-requirement-pin-')),dbPath=join(root,'budget.sqlite'),stores=[];
 t.after(()=>{stores.forEach(s=>s.close());rmSync(root,{recursive:true,force:true});});
 const open=()=>{const s=new PersonalOperationsStore({dbPath});stores.push(s);return s;},store=open(),contract=original();
 const mandate=PersistentEvaluationBudget.createCountQuota({store,validFrom:'2020-01-01T00:00:00Z',expiresAt:'2099-01-01T00:00:00Z',maxCalls:1});
 const policy={mandateId:mandate.id,suiteSha256:createHash('sha256').update(canonical(cases)).digest('hex'),requirementContractSha256:snapshotEvaluationRequirements(contract).sha256};
 const budget=new PersistentEvaluationBudget({...policy,store});
 const evaluate=createContainerCapabilityPackageEvaluator({persistentBudget:budget,requirementContract:contract,casesForPackage:async()=>({suiteId:'fixed',cases})});
 const result=await evaluate(input);assert.equal(result.status,'passed');assert.equal(result.actualIsolatedExecution,true);assert.equal(result.receipt.requirementContractSha256,policy.requirementContractSha256);
 const reopened=open();assert.throws(()=>new PersistentEvaluationBudget({...policy,store:reopened,requirementContractSha256:null}),{code:'A_EVALUATION_PERSISTENT_POLICY_IMMUTABLE'});
 const cached=await createContainerCapabilityPackageEvaluator({persistentBudget:new PersistentEvaluationBudget({...policy,store:reopened}),requirementContract:original(),casesForPackage:async()=>{throw Error('no new oracle');}})(input);
 assert.equal(cached.evaluationReplay.executedNow,false);assert.equal(cached.receipt.requirementContractSha256,policy.requirementContractSha256);
 await assert.rejects(createContainerCapabilityPackageEvaluator({persistentBudget:budget,requirementContract:null,casesForPackage:async()=>({suiteId:'fixed',cases})})(input),{code:'A_EVALUATION_REQUIREMENT_CONTRACT_CHANGED'});
});
test('default Core forwards immutable host requirements and blocks an incomplete oracle before actual evaluation',async()=>{
 const contract=original(),expectedHash=snapshotEvaluationRequirements(contract).sha256;let complete=false;
 const runtime=createAgRuntime({capabilityPackageEvaluationRequirements:contract,
  capabilityPackageArtifactAuthorizer:i=>({approved:true,artifactSha256:i.artifactSha256,admissionRef:'synthetic:requirements'}),
  capabilityPackageEvaluationCases:async()=>({suiteId:'fixed',cases:[{...cases[0],requirementIds:complete?['R1','R2']:['R1']}]})});
 try{
  const active=runtime.capabilityPackageRegistry.activations.get('workflow.execute').packageDigest;
  const candidate=createLocalWorkflowCapabilityPackage();candidate.packageId='synthetic.requirements';candidate.version='1.8.0';candidate.skill={...candidate.skill,skillId:'synthetic_requirements',version:candidate.version};candidate.artifactSource=artifactSource;candidate.artifactSha256=input.artifactSha256;
  const staged=runtime.capabilityPackagePromotionManager.stage(candidate);
  contract.requirements.pop();contract.originalRequest='수정';
  await assert.rejects(runtime.capabilityPackagePromotionManager.evaluate(staged.stageId),{code:'A_EVALUATION_REQUIREMENTS_MISSING'});
  complete=true;const result=await runtime.capabilityPackagePromotionManager.evaluate(staged.stageId);
  assert.equal(result.evaluation.status,'passed');assert.equal(result.evaluation.actualIsolatedExecution,true);
  assert.equal(result.evaluation.receipt.requirementContractSha256,expectedHash);
  assert.equal(runtime.capabilityPackageRegistry.activations.get('workflow.execute').packageDigest,active);
 }finally{runtime.coreFacade.cognition.close();}
});
