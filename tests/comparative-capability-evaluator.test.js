import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createComparativeCapabilityEvaluator} from '../packages/core/src/capabilities/comparative-capability-evaluator.js';
import {createContainerCapabilityPackageEvaluator} from '../packages/core/src/capabilities/container-capability-package-evaluator.js';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {createLocalWorkflowCapabilityPackage} from '../apps/runtime-compose/src/workflow-capability-package.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PersistentEvaluationBudget} from '../packages/core/src/capabilities/persistent-evaluation-budget.js';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {snapshotEvaluationRequirements} from '../packages/core/src/capabilities/evaluation-requirement-contract.js';
const hash=v=>createHash('sha256').update(v).digest('hex');
const baselineSource='export function createAdapter(){return {execute(args){return args.value===42?42:0}}}';
const candidateSource='export function createAdapter(){return {execute(args){return args.value}}}';
function fixture(){const active={packageId:'baseline',packageDigest:'a'.repeat(64)};return{registry:{activations:new Map([['synthetic.execute',active]]),packages:new Map([['baseline',{_definition:{packageId:'baseline',version:'1',artifactSource:baselineSource,artifactSha256:hash(baselineSource)}}]])},input:{stageId:'synthetic-comparison',toolName:'synthetic.execute',packageDigest:'b'.repeat(64),artifactSource:candidateSource,artifactSha256:hash(candidateSource),manifest:{packageId:'candidate',version:'2'}}};}
function result(input,passed=[true,true],patch={}){return{status:passed.every(Boolean)?'passed':'failed',actualIsolatedExecution:true,packageDigest:input.packageDigest,artifactSha256:input.artifactSha256,evidenceRef:'synthetic-evaluation',receipt:{packageDigest:input.packageDigest,artifactSha256:input.artifactSha256,isolationEnforced:true,suiteSha256:'c'.repeat(64),requirementContractSha256:'d'.repeat(64),evaluationTiming:{elapsedMs:5},caseResults:passed.map((p,i)=>({id:`case${i}`,expectedSha256:String(i).repeat(64),passed:p})),...patch}};}
const canonical=v=>Array.isArray(v)?`[${v.map(canonical).join(',')}]`:v&&typeof v==='object'?`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`:JSON.stringify(v);
function persistentFixture(t){
 const root=mkdtempSync(join(tmpdir(),'jarvis-comparison-receipt-')),store=new PersonalOperationsStore({dbPath:join(root,'state.sqlite')}),f=fixture();
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const cases=[42,7].map((value,i)=>({id:`case${i}`,method:'execute',args:{value},packet:{},expected:value,requirementIds:['R1']}));
 const requirements={originalRequest:'두 계산 결과를 유지해.',revision:1,requirements:[{id:'R1',text:'42와7 유지'}]};
 const mandate=PersistentEvaluationBudget.createCountQuota({store,maxCalls:6,validFrom:'2020-01-01T00:00:00Z',expiresAt:'2099-01-01T00:00:00Z'});
 const policy={store,mandateId:mandate.id,suiteSha256:hash(canonical(cases)),requirementContractSha256:snapshotEvaluationRequirements(requirements).sha256};
 let dispatches=0,oracles=0;
 const open=(configuration={})=>{
  const budget=new PersistentEvaluationBudget(policy),underlying=createContainerCapabilityPackageEvaluator({persistentBudget:budget,requirementContract:requirements,
   casesForPackage:async()=>{oracles++;return{suiteId:'fixed',cases};},executeContainer:async request=>{
    dispatches++;const baseline=request.inputs['candidate.mjs']===baselineSource;
    const stdout='JARVIS_PACKAGE_RESULT:'+JSON.stringify(cases.map(c=>({id:c.id,actual:baseline&&c.args.value!==42?0:c.args.value})));
    return{status:'completed',actualContainerExecution:true,enforcementVerified:true,durationMs:1,restrictions:{},limitations:['Synthetic execution fixture, not OS isolation proof'],
     stdout,stdoutSha256:hash(stdout)};
   }});
  return{budget,evaluate:createComparativeCapabilityEvaluator({...f,evaluateInIsolation:underlying,...configuration})};
 };
 return{...f,store,mandate,open,counts:()=>({dispatches,oracles})};
}

test('persistent comparison reconstructs a passing aggregate from all six receipts without new quota or oracle calls',async t=>{
 const f=persistentFixture(t),first=f.open(),result=await first.evaluate(f.input);assert.equal(result.status,'passed');
 f.store.revokeMandate(f.mandate.id);const next=f.open(),restored=next.evaluate.restoreCompleted(f.input);
 assert.equal(restored.evidenceRef,result.evidenceRef);assert.deepEqual(restored.receipt,result.receipt);
 assert.equal(restored.evaluationReplay.executedNow,false);assert.equal(restored.evaluationReplay.meaning,'historical-isolated-comparison');
 assert.equal(next.budget.status().remainingCalls,0);assert.deepEqual(f.counts(),{dispatches:6,oracles:6});
 t.diagnostic('Real SQLite accounting/reconstruction, synthetic container transport only. Actual Docker/OS recovery is tested separately.');
});
for(const mutation of ['missing-aggregate','aggregate-checksum','missing-leaf','aggregate-gains','aggregate-statistics','new-threshold'])test(`comparison restoration rejects ${mutation} without executing again`,async t=>{
 const f=persistentFixture(t);await f.open().evaluate(f.input);
 let code;
 if(mutation==='missing-aggregate'){f.store.db.exec('DELETE FROM capability_comparison_receipts');code='A_COMPARISON_RECEIPT_UNAVAILABLE';}
 if(mutation==='aggregate-checksum'){f.store.db.exec("UPDATE capability_comparison_receipts SET result_json='{}'");code='A_COMPARISON_RECEIPT_UNAVAILABLE';}
 if(mutation==='missing-leaf'){f.store.db.exec('DELETE FROM capability_evaluation_receipts WHERE reservation_id=(SELECT reservation_id FROM capability_evaluation_receipts LIMIT 1)');code='A_EVALUATION_RECEIPT_UNAVAILABLE';}
 if(['aggregate-gains','aggregate-statistics'].includes(mutation)){
  const row=f.store.db.prepare('SELECT result_json FROM capability_comparison_receipts').get(),result=JSON.parse(row.result_json);
  if(mutation==='aggregate-gains')result.receipt.comparison.runs[0].gainedCaseIds=[];
  else result.receipt.comparison.baseline.p95Ms=0;
  result.evidenceRef=`sha256:${hash(JSON.stringify(result.receipt))}`;const json=JSON.stringify(result);
  f.store.db.prepare('UPDATE capability_comparison_receipts SET result_json=?,result_sha256=?').run(json,hash(json));code='A_COMPARISON_RECEIPT_INVALID';
 }
 if(mutation==='new-threshold')code='A_COMPARISON_RECEIPT_UNAVAILABLE';
 const next=f.open(mutation==='new-threshold'?{minimumAdditionalPasses:2}:{});
 assert.throws(()=>next.evaluate.restoreCompleted(f.input),{code});assert.deepEqual(f.counts(),{dispatches:6,oracles:6});assert.equal(next.budget.status().remainingCalls,0);
});

test('changed active baseline prevents historical comparison restoration',async t=>{
 const f=persistentFixture(t);await f.open().evaluate(f.input);f.registry.activations.get('synthetic.execute').packageDigest='e'.repeat(64);
 assert.throws(()=>f.open().evaluate.restoreCompleted(f.input),{code:'A_EVALUATION_RECEIPT_CONFLICT'});assert.deepEqual(f.counts(),{dispatches:6,oracles:6});
});
test('same fixed oracle proves repeated quality gain with no per-case regression; unknown costs stay null',async()=>{
 const f=fixture(),order=[];const evaluate=createComparativeCapabilityEvaluator({...f,evaluateInIsolation:async input=>{order.push(input.stageId);return result(input,input.manifest.packageId==='baseline'?[true,false]:[true,true]);}});
 const output=await evaluate({...f.input,minimumAdditionalPasses:0});assert.equal(output.status,'passed');assert.equal(output.receipt.comparison.repeats,3);assert.equal(output.receipt.comparison.baseline.failedRuns,3);assert.equal(output.receipt.comparison.candidate.failedRuns,0);assert.equal(output.receipt.comparison.baseline.observedCostMinor,null);
 assert.equal(order.length,6);assert.deepEqual(order.map(id=>id.at(-2)),['b','c','c','b','b','c']);
});
test('equal scores and loss of any previously passing requirement are not improvements',async()=>{
 for(const after of [[true,false],[false,true]]){const f=fixture();const evaluate=createComparativeCapabilityEvaluator({...f,evaluateInIsolation:async input=>result(input,input.manifest.packageId==='baseline'?[true,false]:after)});assert.equal((await evaluate(f.input)).status,'failed');}
});
for(const condition of ['latency','cost','unmeasured-cost'])test(`quality gain does not bypass configured ${condition} acceptance bound`,async()=>{
 const f=fixture(),acceptanceBounds=condition==='latency'?{maxP95Ms:10}:{maxObservedCostMinor:20};
 const evaluate=createComparativeCapabilityEvaluator({...f,acceptanceBounds,evaluateInIsolation:async input=>{
  const baseline=input.manifest.packageId==='baseline';
  return result(input,baseline?[true,false]:[true,true],{evaluationTiming:{elapsedMs:baseline?5:condition==='latency'?100:5},
   ...(condition==='unmeasured-cost'?{}:{costObservation:{currency:'KRW',amountMinor:baseline?1:10}})});
 }});
 const output=await evaluate({...f.input,acceptanceBounds:{maxP95Ms:10000,maxObservedCostMinor:100000}});
 assert.equal(output.status,'failed');assert.equal(output.receipt.comparison.improved,false);
 assert.equal(output.receipt.comparison.qualityImproved,true);assert.equal(output.receipt.comparison.acceptance.passed,false);
 assert.deepEqual(output.receipt.comparison.acceptanceBounds,acceptanceBounds);
});
test('measured quality gain inside configured bounds remains eligible',async()=>{
 const f=fixture(),bounds={maxP95Ms:10,maxObservedCostMinor:30};
 const evaluate=createComparativeCapabilityEvaluator({...f,acceptanceBounds:bounds,evaluateInIsolation:async input=>result(input,input.manifest.packageId==='baseline'?[true,false]:[true,true],{costObservation:{currency:'KRW',amountMinor:10}})});
 bounds.maxP95Ms=0;
 const output=await evaluate(f.input);assert.equal(output.status,'passed');assert.equal(output.receipt.comparison.acceptance.passed,true);
 assert.equal(output.receipt.comparison.acceptanceBounds.maxP95Ms,10);assert.equal(output.receipt.comparison.candidate.observedCostMinor,30);
});
test('invalid or unknown comparison acceptance bounds are rejected before evaluation',()=>{
 for(const acceptanceBounds of [null,[],{maxP95Ms:-1},{maxP95Ms:Infinity},{maxObservedCostMinor:1.1},{maxObservedCostMinor:-1},{allowUnknownCost:true}]){
  assert.throws(()=>createComparativeCapabilityEvaluator({...fixture(),acceptanceBounds,evaluateInIsolation:async()=>{throw Error('must not evaluate');}}),{code:'A_COMPARISON_BOUNDS_INVALID'});
 }
});
test('persistent comparison binds configured bounds and will not restore with widened limits',async t=>{
 const f=persistentFixture(t),first=f.open({acceptanceBounds:{maxP95Ms:1000}});const result=await first.evaluate(f.input);
 assert.equal(result.status,'passed');const restored=f.open({acceptanceBounds:{maxP95Ms:1000}}).evaluate.restoreCompleted(f.input);assert.equal(restored.status,'passed');
 assert.throws(()=>f.open({acceptanceBounds:{maxP95Ms:2000}}).evaluate.restoreCompleted(f.input),{code:'A_COMPARISON_RECEIPT_UNAVAILABLE'});
 assert.deepEqual(f.counts(),{dispatches:6,oracles:6});
});
test('candidate-dependent and repeat-dependent oracle changes invalidate the comparison',async()=>{
 const f=fixture();let calls=0;const evaluate=createComparativeCapabilityEvaluator({...f,evaluateInIsolation:async input=>{calls++;return result(input,[true,true],{suiteSha256:calls===1?'a'.repeat(64):'b'.repeat(64)});}});await assert.rejects(evaluate(f.input),{code:'A_COMPARISON_ORACLE_CHANGED'});
});
test('result projection changes invalidate comparison even when case expectations stay identical',async()=>{
 const f=fixture();let calls=0;const evaluate=createComparativeCapabilityEvaluator({...f,evaluateInIsolation:async input=>result(input,[true,true],{resultContract:++calls===1?'contract-a':'contract-b'})});
 await assert.rejects(evaluate(f.input),{code:'A_COMPARISON_ORACLE_CHANGED'});
});
test('malformed case receipts cannot fabricate quality gains',async()=>{
 for(const change of [r=>r.receipt.caseResults.push({...r.receipt.caseResults[0]}),r=>r.receipt.caseResults[0].passed='true',r=>r.receipt.caseResults[0].expectedSha256='invalid',r=>r.status='failed']){
  const f=fixture();const evaluate=createComparativeCapabilityEvaluator({...f,evaluateInIsolation:async input=>{const r=result(input);change(r);return r;}});await assert.rejects(evaluate(f.input),{code:'A_COMPARISON_OBSERVATION_INVALID'});
 }
});
test('active version changes and absent exact baseline source stop comparison rather than fabricate a baseline',async()=>{
 const f=fixture();let calls=0;const evaluate=createComparativeCapabilityEvaluator({...f,evaluateInIsolation:async input=>{calls++;f.registry.activations.get('synthetic.execute').packageDigest='e'.repeat(64);return result(input);}});await assert.rejects(evaluate(f.input),{code:'A_COMPARISON_ACTIVE_VERSION_CHANGED'});assert.equal(calls,1);
 const g=fixture();delete g.registry.packages.get('baseline')._definition.artifactSource;const blocked=createComparativeCapabilityEvaluator({...g,evaluateInIsolation:async()=>{throw Error('must not run');}});await assert.rejects(blocked(g.input),{code:'A_COMPARISON_ACTIVE_SOURCE_UNAVAILABLE'});
});
test('real pinned Docker runs baseline and candidate three times with independent expected values',async t=>{
 const f=fixture(),cases=[{id:'preserve',method:'execute',args:{value:42},packet:{},expected:42},{id:'repair',method:'execute',args:{value:7},packet:{},expected:7}];
 const underlying=createContainerCapabilityPackageEvaluator({casesForPackage:async()=>({suiteId:'fixed-original-value',cases}),maxEvaluations:6});
 const evaluate=createComparativeCapabilityEvaluator({...f,evaluateInIsolation:underlying}),output=await evaluate(f.input);
 assert.equal(output.status,'passed');assert.equal(output.receipt.comparison.baseline.failedRuns,3);assert.equal(output.receipt.comparison.candidate.failedRuns,0);assert.equal(underlying.budgetStatus().attempts,6);
 assert.deepEqual(output.receipt.comparison.runs.map(r=>r.gainedCaseIds),[['repair'],['repair'],['repair']]);assert.equal(output.receipt.comparison.candidate.observedCostMinor,null);
 t.diagnostic(JSON.stringify({comparison:output.receipt.comparison,scope:'Synthetic value adapter baseline and repair; actual Docker, no full JARVIS workflow upgrade claim'}));
});
test('real pinned Docker quality gain is withheld when the configured latency bound is exceeded',async t=>{
 const f=fixture(),cases=[{id:'preserve',method:'execute',args:{value:42},packet:{},expected:42},{id:'repair',method:'execute',args:{value:7},packet:{},expected:7}];
 const underlying=createContainerCapabilityPackageEvaluator({casesForPackage:async()=>({suiteId:'fixed-latency-rejection',cases}),maxEvaluations:6});
 const evaluate=createComparativeCapabilityEvaluator({...f,evaluateInIsolation:underlying,acceptanceBounds:{maxP95Ms:0}}),output=await evaluate(f.input);
 assert.equal(output.status,'failed');assert.equal(output.receipt.comparison.qualityImproved,true);
 assert.deepEqual(output.receipt.comparison.acceptance.reasons,['candidate-latency-bound-exceeded']);
 assert.ok(output.receipt.comparison.candidate.p95Ms>0);assert.equal(output.receipt.comparison.candidate.observedCostMinor,null);
 assert.equal(underlying.budgetStatus().attempts,6);assert.equal(f.registry.activations.get('synthetic.execute').packageId,'baseline');
 t.diagnostic(JSON.stringify({actualDocker:6,qualityImproved:true,accepted:false,p95Ms:output.receipt.comparison.candidate.p95Ms,limitMs:0,
  scope:'Deliberate zero-ms negative control; not a product speed target or financial cost measurement'}));
});
test('Core composition exposes immutable comparison bounds in the protected improvement policy',async t=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-comparison-core-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const underlying=async()=>{throw Error('no evaluation requested');};underlying.improvementPolicy=()=>({version:'synthetic-policy'});
 const runtime=createAgRuntime({allowedRoots:[root],auditRoot:join(root,'audit'),cognitionStorePath:join(root,'cognition.sqlite'),workerDaemonEnabled:false,
  env:{JARVIS_TEST_MODE:'1'},capabilityPackageEvaluator:underlying,capabilityPackageComparisonRequired:true,capabilityPackageComparisonBounds:{maxP95Ms:500,maxObservedCostMinor:100}});
 try{assert.deepEqual(runtime.capabilityPackagePromotionManager.evaluateInIsolation.improvementPolicy().comparison.acceptanceBounds,{maxP95Ms:500,maxObservedCostMinor:100});}
 finally{runtime.coreFacade.cognition.close();}
});
test('default Core routes required comparison and blocks a built-in baseline whose standalone source is not admitted',async()=>{
 const runtime=createAgRuntime({capabilityPackageComparisonRequired:true,capabilityPackageArtifactAuthorizer:i=>({approved:true,artifactSha256:i.artifactSha256,admissionRef:'synthetic-host-admission'}),capabilityPackageEvaluationCases:async()=>{throw Error('no baseline, must not query');}});
 try{const candidate=createLocalWorkflowCapabilityPackage();candidate.packageId='synthetic.comparison';candidate.version='1.2.0';candidate.skill={...candidate.skill,version:candidate.version,skillId:'synthetic_comparison'};candidate.artifactSource=candidateSource;candidate.artifactSha256=hash(candidateSource);
 const staged=runtime.capabilityPackagePromotionManager.stage(candidate);await assert.rejects(runtime.capabilityPackagePromotionManager.evaluate(staged.stageId),{code:'A_COMPARISON_ACTIVE_SOURCE_UNAVAILABLE'});
 assert.equal(runtime.capabilityPackagePromotionManager.evaluateInIsolation.budgetStatus().attempts,0);
 }finally{runtime.coreFacade.cognition.close();}
});
