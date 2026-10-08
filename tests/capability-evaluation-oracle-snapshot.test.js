import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createContainerCapabilityPackageEvaluator} from '../packages/core/src/capabilities/container-capability-package-evaluator.js';
import {runContainerExecution} from '../packages/core/src/runtime/container-execution-environment.js';
const artifactSource='export function createAdapter(){return {execute(){return 0}}}';
const input={artifactSource,artifactSha256:createHash('sha256').update(artifactSource).digest('hex'),manifest:{packageId:'test.snapshot',version:'1.0.0'},toolName:'test.execute',packageDigest:'a'.repeat(64)};
const suite=()=>({suiteId:'fixed-oracle',cases:[{id:'one',method:'execute',args:{amount:1},packet:{},expected:{amount:1}}]});
const container=actual=>({status:'completed',actualContainerExecution:true,enforcementVerified:true,stdout:'JARVIS_PACKAGE_RESULT:'+JSON.stringify([{id:'one',actual}]),durationMs:1,restrictions:{},limitations:['Synthetic container receipt; contract test only.']});
test('host oracle and suite identity are fixed before awaiting container execution',async()=>{
 const original=suite();let mounted;
 const evaluate=createContainerCapabilityPackageEvaluator({casesForPackage:async()=>original,executeContainer:async request=>{
  mounted=JSON.parse(request.inputs['cases.json']);
  original.cases[0].expected.amount=999;original.suiteId='changed-after-dispatch';
  return container({amount:999});
 }});
 const result=await evaluate(input);
 assert.equal(result.status,'failed');
 assert.equal(result.receipt.suiteId,'fixed-oracle');
 assert.equal(Object.hasOwn(mounted[0],'expected'),false);
});
test('unrepresentable oracle values are rejected before dispatch',async()=>{
 for(const invalid of [undefined,NaN,Infinity,()=>true,new Date(),{nested:undefined}]){
  const original=suite();original.cases[0].expected=invalid;let calls=0;
  const evaluate=createContainerCapabilityPackageEvaluator({casesForPackage:async()=>original,executeContainer:async()=>{calls++;return container(null);}});
  await assert.rejects(evaluate(input),{code:'A_CAPABILITY_PACKAGE_EVALUATION_SUITE_INVALID'});
  assert.equal(calls,0);
 }
});

test('real isolated wrong-output candidate cannot benefit from a changed provider oracle',async()=>{
 const original=suite();
 const source='export function createAdapter(){return {execute(){return {amount:999}}}}';
 const evaluate=createContainerCapabilityPackageEvaluator({casesForPackage:async()=>original,timeoutMs:20000,executeContainer:async request=>{
  original.cases[0].expected.amount=999;original.suiteId='replacement-oracle';
  return runContainerExecution(request);
 }});
 const result=await evaluate({...input,artifactSource:source,artifactSha256:createHash('sha256').update(source).digest('hex')});
 assert.equal(result.actualIsolatedExecution,true,JSON.stringify(result));
 assert.equal(result.receipt.isolationEnforced,true);
 assert.equal(result.status,'failed');
 assert.equal(result.receipt.suiteId,'fixed-oracle');
 assert.deepEqual(result.receipt.failedCaseIds,['one']);
});

test('artifact bytes and receipt identity are fixed before an asynchronous oracle lookup',async()=>{
 const original={...input,manifest:{...input.manifest}};let mounted;
 const evaluate=createContainerCapabilityPackageEvaluator({casesForPackage:async()=>{
  original.artifactSource='export function createAdapter(){return {execute(){return 999}}}';original.artifactSha256='f'.repeat(64);original.packageDigest='b'.repeat(64);
  return suite();
 },executeContainer:async request=>{mounted=request.inputs['candidate.mjs'];return container({amount:1});}});
 const result=await evaluate(original);
 assert.equal(mounted,input.artifactSource);assert.equal(result.artifactSha256,input.artifactSha256);assert.equal(result.packageDigest,input.packageDigest);
});
