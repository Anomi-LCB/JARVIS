import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createContainerCapabilityPackageEvaluator} from '../packages/core/src/capabilities/container-capability-package-evaluator.js';
import {runContainerExecution} from '../packages/core/src/runtime/container-execution-environment.js';
const artifactSource='export function createAdapter(){return {execute(){return null}}}';
const input={artifactSource,artifactSha256:createHash('sha256').update(artifactSource).digest('hex'),manifest:{packageId:'test.results',version:'1.0.0'},toolName:'test.execute',packageDigest:'a'.repeat(64)};
const evaluate=raw=>createContainerCapabilityPackageEvaluator({casesForPackage:async()=>({suiteId:'fixed',cases:[{id:'one',method:'execute',args:{},packet:{},expected:null}]}),executeContainer:async()=>({status:'completed',actualContainerExecution:true,enforcementVerified:true,stdout:raw,durationMs:1,restrictions:{},limitations:['Synthetic receipt; result parser test only.']})})(input);
for(const [name,raw]of [
 ['overflow number','[{"id":"one","actual":1e999}]'],
 ['duplicate case','[{"id":"one","actual":null},{"id":"one","actual":null}]'],
 ['unknown case','[{"id":"unknown","actual":null}]'],
 ['missing case','[]'],
 ['unexpected row field','[{"id":"one","actual":null,"approved":true}]'],
 ['malformed JSON','[']
])test('candidate result rejects '+name,async()=>{
 await assert.rejects(evaluate('JARVIS_PACKAGE_RESULT:'+raw),{code:'A_CAPABILITY_PACKAGE_EVALUATION_RESULT_INVALID'});
});
test('exact finite result remains accepted',async()=>{
 assert.equal((await evaluate('JARVIS_PACKAGE_RESULT:[{"id":"one","actual":null}]')).status,'passed');
});
test('real isolated candidate cannot forge a null oracle match with overflow output',async()=>{
 const source=`process.stdout.write('JARVIS_PACKAGE_RESULT:[{"id":"one","actual":1e999}]\\n');process.exit(0);`;
 let receipt;
 const evaluateReal=createContainerCapabilityPackageEvaluator({
  casesForPackage:async()=>({suiteId:'fixed',cases:[{id:'one',method:'execute',args:{},packet:{},expected:null}]}),
  executeContainer:async request=>{receipt=await runContainerExecution(request);return receipt;},timeoutMs:20000
 });
 await assert.rejects(evaluateReal({...input,artifactSource:source,artifactSha256:createHash('sha256').update(source).digest('hex')}),{code:'A_CAPABILITY_PACKAGE_EVALUATION_RESULT_INVALID'});
 assert.equal(receipt.actualContainerExecution,true);
 assert.equal(receipt.enforcementVerified,true);
});

test('real candidate cannot forge completion through the worker parent port without running an adapter',async()=>{
 const source=`import {parentPort} from 'node:worker_threads';parentPort.postMessage([{id:'one',actual:null}]);process.exit(0);`;
 let receipt;
 const evaluateReal=createContainerCapabilityPackageEvaluator({
  casesForPackage:async()=>({suiteId:'fixed-private-result',cases:[{id:'one',method:'execute',args:{},packet:{},expected:null}]}),
  executeContainer:async request=>{receipt=await runContainerExecution(request);return receipt;},timeoutMs:20000
 });
 await assert.rejects(evaluateReal({...input,artifactSource:source,artifactSha256:createHash('sha256').update(source).digest('hex')}),{code:'A_CAPABILITY_PACKAGE_EVALUATION_RESULT_INVALID'});
 assert.equal(receipt.actualContainerExecution,true);assert.equal(receipt.enforcementVerified,true);
});
for(const [name,source] of [
 ['JSON encoder',`JSON.stringify=()=> 'null';export function createAdapter(){return {execute(){return 999}}}`],
 ['array append',`const push=Array.prototype.push;Array.prototype.push=function(row){return push.call(this,row?.id?{id:row.id,actual:null}:row)};export function createAdapter(){return {execute(){return 999}}}`]
])test('candidate mutation of '+name+' cannot turn a wrong result into an oracle match',async()=>{
 const evaluateReal=createContainerCapabilityPackageEvaluator({casesForPackage:async()=>({suiteId:'fixed-intrinsics',cases:[{id:'one',method:'execute',args:{},packet:{},expected:null}]}),timeoutMs:20000});
 const result=await evaluateReal({...input,artifactSource:source,artifactSha256:createHash('sha256').update(source).digest('hex')});
 assert.equal(result.actualIsolatedExecution,true);assert.equal(result.status,'failed');assert.deepEqual(result.receipt.failedCaseIds,['one']);
});
