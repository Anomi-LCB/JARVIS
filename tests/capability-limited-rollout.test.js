import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {buildWorkflowEvaluationArtifact,loadBuiltWorkflowCapability,identifyBuiltWorkflowCapability} from '../packages/core/src/capabilities/workflow-artifact-builder.js';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {CapabilityLimitedRollout} from '../packages/core/src/capabilities/capability-limited-rollout.js';
import {RuntimeTrustKernel} from '../packages/core/src/security/runtime-trust-kernel.js';
import {createContainerCapabilityPackageEvaluator} from '../packages/core/src/capabilities/container-capability-package-evaluator.js';
import {createComparativeCapabilityEvaluator} from '../packages/core/src/capabilities/comparative-capability-evaluator.js';
const sha=v=>createHash('sha256').update(v).digest('hex');
const spec=(id,path='result.json')=>({schemaVersion:'jarvis-local-workflow-v1',workflowId:id,nodes:[{id:'sort',op:'data.sort',args:{items:[{price:'2,000'},{price:'950'}],by:[{field:'price',numeric:true,numericFormat:'grouped-decimal'}]}},
 {id:'write',op:'write.json',dependsOn:['sort'],args:{path,value:{$ref:{nodeId:'sort'}}}}]});
async function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'jarvis-limited-')),store=new PersonalOperationsStore({dbPath:join(root,'rollouts.sqlite')});
 const build=p=>buildWorkflowEvaluationArtifact({projectRoot:p,esbuildPath:resolve('artifacts/evaluation-build-tools-20261006/node_modules/esbuild/lib/main.js'),mode:'runtime'});
 const prior=await loadBuiltWorkflowCapability(await build(resolve('artifacts/grouped-number-baseline-20261007')));
 const current=await loadBuiltWorkflowCapability(await build(process.cwd()));
 const candidate=identifyBuiltWorkflowCapability(current,{packageId:'jarvis.limited-actual',version:'1.15.0',skillId:'limited_actual'},prior);
 const text=JSON.stringify({items:[{price:'950'},{price:'2,000'}],rows:[{price:'950'},{price:'2,000'}],count:2},null,2)+'\n';
 const trustKernel=new RuntimeTrustKernel({testMode:false,statePath:join(root,'audit/trust-state.json'),keyPath:join(root,'audit/trust-key.json'),auditPath:join(root,'audit/trust-audit.jsonl')});
 const runtime=createAgRuntime({trustKernel,auditRoot:join(root,'audit'),allowedRoots:[join(root,'workspace')],workerDaemonEnabled:false,workflowCapabilityDefinition:prior,capabilityRolloutStore:store,
  capabilityPackageComparisonRequired:true,capabilityPackageEvaluationResultContract:'local-workflow-files-v1',capabilityPackageEvaluationTimeoutMs:20000,
  capabilityPackageArtifactAuthorizer:i=>({approved:i.artifactSource===candidate.artifactSource&&i.createAdapter===candidate.createAdapter&&i.verifyEvidence===candidate.verifyEvidence,artifactSha256:i.artifactSha256,admissionRef:`reviewed:${candidate.artifactSha256}`}),
  capabilityPackageEvaluationCases:async()=>({suiteId:'rollout-fixed-real-v1',cases:[{id:'grouped',method:'execute',args:{spec:spec('evaluation')},packet:{},
   expected:{status:'success',nodeCount:2,receiptCount:2,files:[{name:'result.json',text,sha256:sha(text),size:Buffer.byteLength(text)}]}}]}),
  env:{JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'}});
 t.after(()=>{runtime.coreFacade.cognition.close();store.close();rmSync(root,{recursive:true,force:true});});
 mkdirSync(runtime.coreFacade.workspaceRoot,{recursive:true});
 const policy=()=>({workspaceRoot:runtime.coreFacade.workspaceRoot,specPath:'limited.workflow.json',maxCalls:1,minimumPassed:1,expiresAt:'2099-01-01T00:00:00Z',
  verifyOutcome:result=>JSON.parse(readFileSync(join(runtime.coreFacade.workspaceRoot,'result.json'),'utf8')).items[0].price==='950'});
 writeFileSync(join(runtime.coreFacade.workspaceRoot,'limited.workflow.json'),JSON.stringify(spec('limited')));
 const stage=runtime.capabilityPackagePromotionManager.stage(candidate);await runtime.capabilityPackagePromotionManager.evaluate(stage.stageId);
 const context={ownerSessionId:runtime.personalOwnerSession.activate({grants:['high_impact']}).session.sessionId,deviceId:'test',remoteAddress:'127.0.0.1'};
 await runtime.capabilityPackagePromotionManager.review(stage.stageId,context);
 const controller=runtime.capabilityLimitedRollout;
 const run=async(name,output)=>{const m=runtime.missionRuntime.createMission({objective:`${name}.workflow.json에 정의된 검증 워크플로를 실행하고 ${output}을 생성해.`,authorization:{grants:['read_only','local_reversible']},
  successCriteria:[{statement:'첫 가격',verificationSpec:{version:1,kind:'json.value',path:output,pointer:'/items/0/price',equals:'950'}}]});return runtime.missionRuntime.runMission(m.missionId);};
 return {root,runtime,store,controller,policy,stage,context,run,candidate,prior};
}
test('real fixed comparison -> scoped B/G candidate -> global expansion -> previous code rollback',async t=>{
 const f=await fixture(t),baseline=f.runtime.capabilityPackageRegistry.activations.get('workflow.execute').packageDigest;
 const trial=await f.controller.begin(f.stage.stageId,f.policy());
 writeFileSync(join(f.runtime.coreFacade.workspaceRoot,'outside.workflow.json'),JSON.stringify(spec('outside','outside.json')));
 const outside=await f.run('outside','outside.json');assert.notEqual(outside.status,'COMPLETED');assert.equal(f.controller.status(trial.id).used,0);
 const result=await f.run('limited','result.json');t.diagnostic(JSON.stringify({missionStatus:result.status,stopReason:result.stopReason,trial:f.controller.status(trial.id)}));
 assert.equal(result.status,'COMPLETED');assert.equal(f.controller.status(trial.id).passed,1);
 assert.ok([...f.runtime.pcAgent.results.values()].some(r=>r.status==='COMPLETED'&&r.executionResult?.executionCodeVersion===f.stage.packageDigest));
 assert.equal(f.runtime.pcAgent.registry.selectExecution('workflow.execute',{packetId:'over-limit',action:{arguments:{specPath:join(f.runtime.coreFacade.workspaceRoot,'limited.workflow.json')}}},{dryRun:false}),null);
 assert.equal(f.runtime.capabilityPackageRegistry.activations.get('workflow.execute').packageDigest,baseline);
 await assert.rejects(f.controller.begin(f.stage.stageId,f.policy()));
 const expanded=await f.controller.expand(trial.id);assert.equal(expanded.status,'expanded');
 assert.equal(f.runtime.capabilityPackageRegistry.activations.get('workflow.execute').packageDigest,f.stage.packageDigest);
 const broad=await f.run('outside','outside.json');assert.equal(broad.status,'COMPLETED');
 const reverted=await f.controller.regress(trial.id,f.context);assert.equal(reverted.status,'rolled_back');
 assert.equal(f.runtime.capabilityPackageRegistry.activations.get('workflow.execute').packageDigest,baseline);
 t.diagnostic(JSON.stringify({actualDocker:6,limitedMission:result.status,broadMission:broad.status,restoredPriorDigest:true,regressionSignal:'host-injected',externalEffects:0}));
});
test('changed spec is blocked before candidate use and owner revocation prevents expansion',async t=>{
 const f=await fixture(t),trial=await f.controller.begin(f.stage.stageId,f.policy());
 writeFileSync(join(f.runtime.coreFacade.workspaceRoot,'limited.workflow.json'),JSON.stringify(spec('changed')));
 const result=await f.run('limited','result.json');assert.notEqual(result.status,'COMPLETED');assert.equal(f.controller.status(trial.id).used,0);
 f.runtime.personalOwnerSession.revoke({reason:'test'});await assert.rejects(f.controller.expand(trial.id));
});
test('independent postcondition mismatch suspends limited candidate and preserves effect evidence',async t=>{
 const f=await fixture(t),baseline=f.runtime.capabilityPackageRegistry.activations.get('workflow.execute').packageDigest;
 const trial=await f.controller.begin(f.stage.stageId,{...f.policy(),verifyOutcome:()=>false});
 const result=await f.run('limited','result.json');assert.notEqual(result.status,'COMPLETED');
 assert.equal(f.controller.status(trial.id).status,'suspended');assert.equal(f.controller.status(trial.id).passed,0);
 assert.equal(f.controller.status(trial.id).used,1);assert.equal(f.runtime.capabilityPackageRegistry.activations.get('workflow.execute').packageDigest,baseline);
 assert.equal(JSON.parse(readFileSync(join(f.runtime.coreFacade.workspaceRoot,'result.json'),'utf8')).items[0].price,'950');
 await assert.rejects(f.controller.expand(trial.id));
 const reloaded=new CapabilityLimitedRollout({store:f.store,promotionManager:f.runtime.capabilityPackagePromotionManager,adapterRegistry:f.runtime.pcAgent.registry});
 assert.equal(reloaded.status(trial.id).executionRouteLoaded,false);assert.equal(reloaded.status(trial.id).used,1);
});
test('fresh owner revocation after successful limited execution blocks broad activation',async t=>{
 const f=await fixture(t),baseline=f.runtime.capabilityPackageRegistry.activations.get('workflow.execute').packageDigest;
 const trial=await f.controller.begin(f.stage.stageId,f.policy());assert.equal((await f.run('limited','result.json')).status,'COMPLETED');
 f.runtime.personalOwnerSession.revoke({reason:'revoked-after-limited'});
 await assert.rejects(f.controller.expand(trial.id),{code:'A_CAPABILITY_PACKAGE_REVIEW_AUTHORIZATION_EXPIRED'});
 assert.equal(f.runtime.capabilityPackageRegistry.activations.get('workflow.execute').packageDigest,baseline);
});
test('expanded regression blocks the tool until renewed owner rollback; cold guard restores no authority',async t=>{
 const f=await fixture(t),baseline=f.runtime.capabilityPackageRegistry.activations.get('workflow.execute').packageDigest;
 const trial=await f.controller.begin(f.stage.stageId,f.policy());assert.equal((await f.run('limited','result.json')).status,'COMPLETED');
 await f.controller.expand(trial.id);
 const coldRegistry={executionSelectors:new Map()};new CapabilityLimitedRollout({store:f.store,promotionManager:f.runtime.capabilityPackagePromotionManager,adapterRegistry:coldRegistry});
 assert.throws(()=>coldRegistry.executionSelectors.get('workflow.execute')(),{code:'A_ROLLOUT_RECOVERY_REQUIRED'});
 f.runtime.personalOwnerSession.revoke({reason:'before-regression'});await assert.rejects(f.controller.regress(trial.id,f.context));
 assert.throws(()=>f.runtime.pcAgent.registry.selectExecution('workflow.execute',{action:{arguments:{}}},{dryRun:false}),{code:'A_ROLLOUT_RECOVERY_REQUIRED'});
 const renewed={...f.context,ownerSessionId:f.runtime.personalOwnerSession.activate({grants:['high_impact']}).session.sessionId};
 assert.equal((await f.controller.regress(trial.id,renewed)).status,'rolled_back');
 assert.equal(f.runtime.capabilityPackageRegistry.activations.get('workflow.execute').packageDigest,baseline);
 assert.equal((await f.controller.regress(trial.id,renewed)).status,'rolled_back');
});
test('lost rollout finalization reconciles signed promotion without reactivation and requires rollback',async t=>{
 const f=await fixture(t),baseline=f.runtime.capabilityPackageRegistry.activations.get('workflow.execute').packageDigest;
 const trial=await f.controller.begin(f.stage.stageId,f.policy());assert.equal((await f.run('limited','result.json')).status,'COMPLETED');
 f.store.db.exec("CREATE TRIGGER lose_expansion BEFORE UPDATE ON capability_limited_rollouts WHEN NEW.status='expanded' BEGIN SELECT RAISE(ABORT,'injected expansion receipt loss'); END");
 await assert.rejects(f.controller.expand(trial.id),/injected expansion receipt loss/);f.store.db.exec('DROP TRIGGER lose_expansion');
 assert.equal(f.controller.status(trial.id).status,'expanding');assert.equal(f.runtime.capabilityPackageRegistry.activations.get('workflow.execute').packageDigest,f.stage.packageDigest);
 const coldRegistry={executionSelectors:new Map()};new CapabilityLimitedRollout({store:f.store,promotionManager:f.runtime.capabilityPackagePromotionManager,adapterRegistry:coldRegistry});
 assert.throws(()=>coldRegistry.executionSelectors.get('workflow.execute')(),{code:'A_ROLLOUT_RECOVERY_REQUIRED'});
 const recovered=f.controller.recoverExpansion(trial.id);assert.equal(recovered.status,'suspended');assert.equal(recovered.activationReplayed,false);assert.equal(recovered.ownerAuthorizationRestored,false);
 assert.equal((await f.controller.regress(trial.id,f.context)).status,'rolled_back');assert.equal(f.runtime.capabilityPackageRegistry.activations.get('workflow.execute').packageDigest,baseline);
});

for(const revoked of [false,true])test(`expanded independent regression is detected at B and ${revoked?'revoked rollback authority blocks further use':'current authority restores prior code automatically'}`,async t=>{
 const f=await fixture(t),baseline=f.runtime.capabilityPackageRegistry.activations.get('workflow.execute').packageDigest;
 let observations=0;
 const trial=await f.controller.begin(f.stage.stageId,{...f.policy(),autoRollbackOnRegression:true,
  verifyOutcome:result=>{assert.equal(f.policy().verifyOutcome(result),true);return ++observations===1;}});
 assert.equal((await f.run('limited','result.json')).status,'COMPLETED');await f.controller.expand(trial.id);
 // Remove only the fixture output so this is a new actual publication, not a
 // deterministic overwrite refusal. The second oracle disagreement is injected.
 rmSync(join(f.runtime.coreFacade.workspaceRoot,'result.json'));
 if(revoked)f.runtime.personalOwnerSession.revoke({reason:'expanded-observation-test'});
 const result=await f.run('limited','result.json');assert.notEqual(result.status,'COMPLETED');
 assert.equal(observations,2);assert.equal(f.controller.status(trial.id).used,1);
 assert.equal(JSON.parse(readFileSync(join(f.runtime.coreFacade.workspaceRoot,'result.json'),'utf8')).items[0].price,'950');
 const execution=[...f.runtime.pcAgent.results.values()].map(r=>r.executionResult).find(r=>r?.rolloutRecovery);
 assert.ok(execution,'B keeps the independent failure and recovery receipt');
 if(!revoked){assert.equal(f.controller.status(trial.id).status,'rolled_back');assert.equal(execution.rolloutRecovery.status,'rolled_back');
  assert.equal(f.runtime.capabilityPackageRegistry.activations.get('workflow.execute').packageDigest,baseline);}
 else{assert.equal(f.controller.status(trial.id).status,'suspended');assert.equal(execution.rolloutRecovery.status,'blocked');
  assert.equal(execution.rolloutRecovery.errorCode,'A_CAPABILITY_PACKAGE_REVIEW_AUTHORIZATION_EXPIRED');
  assert.throws(()=>f.runtime.pcAgent.registry.selectExecution('workflow.execute',{action:{arguments:{}}},{dryRun:false}),{code:'A_ROLLOUT_RECOVERY_REQUIRED'});}
});

test('actual live baseline observation -> immutable request Docker comparison -> limited -> expanded -> automatic regression rollback',async t=>{
 const f=await fixture(t),baseline=f.runtime.capabilityPackageRegistry.activations.get('workflow.execute').packageDigest;
 let postconditions=0,observedRequest;
 const trial=await f.controller.begin(f.stage.stageId,{...f.policy(),phase:'observing',autoRollbackOnRegression:true,
  verifyOutcome:result=>{assert.equal(f.policy().verifyOutcome(result),true);return ++postconditions===1;},
  observeRequest:async request=>{
   observedRequest=request;assert.equal(Object.isFrozen(request.spec.nodes[0].args.items),true);
   const text=JSON.stringify({items:[{price:'950'},{price:'2,000'}],rows:[{price:'950'},{price:'2,000'}],count:2},null,2)+'\n';
   const isolated=createContainerCapabilityPackageEvaluator({maxEvaluations:6,timeoutMs:20000,resultContract:'local-workflow-files-v1',
    casesForPackage:async()=>({suiteId:'actual-observed-request-v1',cases:[{id:'captured',method:'execute',args:{spec:request.spec},packet:{},
     expected:{status:'success',nodeCount:2,receiptCount:2,files:[{name:'result.json',text,sha256:sha(text),size:Buffer.byteLength(text)}]}}]})});
   const compare=createComparativeCapabilityEvaluator({evaluateInIsolation:isolated,registry:f.runtime.capabilityPackageRegistry});
   const measured=await compare({stageId:'observation-'+request.packetId.replace(/[^a-zA-Z0-9_.-]/g,'').slice(-40),toolName:'workflow.execute',
    packageDigest:request.candidateDigest,artifactSha256:request.artifactSha256,artifactSource:f.candidate.artifactSource,
    manifest:{packageId:f.candidate.packageId,version:f.candidate.version}});
   return {...measured,packetId:request.packetId,specSha256:request.specSha256,baselineDigest:request.baselineDigest};
  }});
 assert.throws(()=>f.controller.startLimited(trial.id),{code:'A_ROLLOUT_OBSERVATION_REQUIRED'});
 const shadow=await f.run('limited','result.json');assert.notEqual(shadow.status,'COMPLETED');
 assert.equal(f.controller.status(trial.id).observations,1);assert.equal(f.controller.status(trial.id).used,0);
 assert.equal(f.runtime.capabilityPackageRegistry.activations.get('workflow.execute').packageDigest,baseline);
 assert.equal(existsSync(join(f.runtime.coreFacade.workspaceRoot,'result.json')),false,'candidate published only inside container');
 const observation=[...f.runtime.pcAgent.results.values()].find(r=>r.executionResult?.rolloutObservation);
 assert.equal(observation.executionResult.executionCodeVersion,baseline);assert.equal(observation.executionResult.rolloutObservation.candidateActivated,false);
 assert.equal(observedRequest.specSha256,sha(readFileSync(join(f.runtime.coreFacade.workspaceRoot,'limited.workflow.json'))));
 assert.equal(f.runtime.pcAgent.registry.selectExecution('workflow.execute',{packetId:'observation-budget-overflow',action:{arguments:{specPath:join(f.runtime.coreFacade.workspaceRoot,'limited.workflow.json')}}},{dryRun:false}),null);
 const reopened=new CapabilityLimitedRollout({store:f.store,promotionManager:f.runtime.capabilityPackagePromotionManager,adapterRegistry:f.runtime.pcAgent.registry});
 assert.equal(reopened.status(trial.id).observations,1);assert.equal(reopened.status(trial.id).executionRouteLoaded,false);
 assert.throws(()=>reopened.startLimited(trial.id),{code:'A_ROLLOUT_OBSERVATION_REQUIRED'});
 assert.equal(f.controller.startLimited(trial.id).status,'limited');assert.equal((await f.run('limited','result.json')).status,'COMPLETED');
 await f.controller.expand(trial.id);rmSync(join(f.runtime.coreFacade.workspaceRoot,'result.json'));
 assert.notEqual((await f.run('limited','result.json')).status,'COMPLETED');assert.equal(f.controller.status(trial.id).status,'rolled_back');
 assert.equal(f.runtime.capabilityPackageRegistry.activations.get('workflow.execute').packageDigest,baseline);
 t.diagnostic(JSON.stringify({observationCandidateActivated:false,liveBaselineFailed:true,isolatedObservationRuns:6,limitedPassed:true,
  expandedObserved:true,automaticRollback:true,actualObservationSqlRows:1,externalUserEffects:0}));
});

test('unbound shadow receipt cannot authorize limited application and does not replace baseline result',async t=>{
 const f=await fixture(t),baseline=f.runtime.capabilityPackageRegistry.activations.get('workflow.execute').packageDigest;
 const trial=await f.controller.begin(f.stage.stageId,{...f.policy(),phase:'observing',observeRequest:async()=>({actualIsolatedExecution:true,receipt:{isolationEnforced:true}})});
 const result=await f.run('limited','result.json');assert.notEqual(result.status,'COMPLETED');
 assert.equal(f.controller.status(trial.id).failedObservations,1);assert.equal(f.controller.status(trial.id).observations,0);
 assert.throws(()=>f.controller.startLimited(trial.id),{code:'A_ROLLOUT_OBSERVATION_REQUIRED'});
 assert.equal(f.runtime.capabilityPackageRegistry.activations.get('workflow.execute').packageDigest,baseline);
 assert.equal(existsSync(join(f.runtime.coreFacade.workspaceRoot,'result.json')),false);
});

test('unresponsive observation receives abort and cannot hold the live B result indefinitely',async t=>{
 const f=await fixture(t);let aborted=false;
 const trial=await f.controller.begin(f.stage.stageId,{...f.policy(),phase:'observing',observationTimeoutMs:100,
  observeRequest:async(request,{signal})=>{signal.addEventListener('abort',()=>{aborted=true;},{once:true});return new Promise(()=>{});}});
 const started=performance.now(),result=await f.run('limited','result.json');
 assert.ok(performance.now()-started<5000);assert.notEqual(result.status,'COMPLETED');assert.equal(aborted,true);
 assert.equal(f.controller.status(trial.id).failedObservations,1);
 const execution=[...f.runtime.pcAgent.results.values()].find(r=>r.executionResult?.rolloutObservation);
 assert.equal(execution.executionResult.rolloutObservation.errorCode,'A_ROLLOUT_OBSERVATION_TIMEOUT');
 assert.throws(()=>f.controller.startLimited(trial.id),{code:'A_ROLLOUT_OBSERVATION_REQUIRED'});
});
