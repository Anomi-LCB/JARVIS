import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {buildWorkflowEvaluationArtifact,loadBuiltWorkflowCapability,assertBuiltWorkflowCapability} from '../packages/core/src/capabilities/workflow-artifact-builder.js';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {createLocalWorkflowCapabilityPackage} from '../apps/runtime-compose/src/workflow-capability-package.js';
const sha=v=>createHash('sha256').update(v).digest('hex');
const options={projectRoot:process.cwd(),esbuildPath:'artifacts/evaluation-build-tools-20261006/node_modules/esbuild/lib/main.js',mode:'runtime'};
const text='동일 운영 소스 검증\n';
const spec={schemaVersion:'jarvis-local-workflow-v1',workflowId:'runtime-exact',nodes:[{id:'write',op:'write.text',args:{path:'out/result.txt',text}}]};
test('only unmodified local build objects admit exact frozen runtime package; copied and evaluation wrappers fail closed',async()=>{
 const artifact=await buildWorkflowEvaluationArtifact(options);
 await assert.rejects(loadBuiltWorkflowCapability(structuredClone(artifact)),{code:'WORKFLOW_RUNTIME_BUILD_NOT_ADMITTED'});
 const modified=await buildWorkflowEvaluationArtifact(options);modified.artifactSource+='\n';
 await assert.rejects(loadBuiltWorkflowCapability(modified),{code:'WORKFLOW_RUNTIME_BUILD_NOT_ADMITTED'});
 const wrapper=await buildWorkflowEvaluationArtifact({...options,mode:'evaluation'});
 await assert.rejects(loadBuiltWorkflowCapability(wrapper),{code:'WORKFLOW_RUNTIME_BUILD_NOT_ADMITTED'});
 const definition=await loadBuiltWorkflowCapability(artifact);
 assert.equal(assertBuiltWorkflowCapability(definition),definition);
 assert.throws(()=>assertBuiltWorkflowCapability({...definition}),{code:'WORKFLOW_RUNTIME_DEFINITION_NOT_ADMITTED'});
 assert.throws(()=>createAgRuntime({workflowCapabilityDefinition:{...definition}}),{code:'WORKFLOW_RUNTIME_DEFINITION_NOT_ADMITTED'});
 assert.throws(()=>{definition.skill.capability.externalNetwork=true;},TypeError);
 assert.equal(definition.verifierFingerprint,createLocalWorkflowCapabilityPackage().verifierFingerprint);
 const root=await mkdtemp(join(tmpdir(),'workflow-bundle-host-'));
 try {const result=await definition.createAdapter({allowedRoots:[root]}).execute({spec});assert.equal(result.status,'success');assert.equal(await readFile(join(root,'out/result.txt'),'utf8'),text);assert.equal(definition.verifyEvidence({adapterEvidence:result.evidence}).valid,true);}
 finally{await rm(root,{recursive:true,force:true});}
});
test('full Core activates exact bundled factory and evaluates actual baseline/candidate three times without claiming equal quality as improvement',async t=>{
 const artifact=await buildWorkflowEvaluationArtifact(options),definition=await loadBuiltWorkflowCapability(artifact);
 const runtime=createAgRuntime({workflowCapabilityDefinition:definition,capabilityPackageComparisonRequired:true,capabilityPackageEvaluationMaxCalls:6,
  capabilityPackageEvaluationResultContract:'local-workflow-files-v1',
  capabilityPackageArtifactAuthorizer:i=>({approved:true,artifactSha256:i.artifactSha256,admissionRef:'synthetic-host-test-admission'}),
  capabilityPackageEvaluationCases:async()=>({suiteId:'fixed-real-workflow',cases:[
   {id:'actual-file',method:'execute',args:{spec},packet:{taskId:'isolated-only'},expected:{status:'success',nodeCount:1,receiptCount:1,files:[{name:'out/result.txt',text,sha256:sha(text),size:Buffer.byteLength(text)}]}},
   {id:'outside',method:'execute',args:{spec:{...spec,workflowId:'outside',nodes:[{id:'write',op:'write.text',args:{path:'../forbidden.txt',text:'blocked'}}]}},packet:{},expected:{status:'blocked',errorCode:'WORKFLOW_PATH_OUTSIDE_ALLOWED_ROOT'}}
  ]})});
 try{
  assert.equal(runtime.capabilityPackageRegistry.packages.get('jarvis.local-workflow')._definition.artifactSha256,artifact.artifactSha256);
  const candidate={...definition,packageId:'synthetic.equal-workflow',version:'1.2.0',skill:{...definition.skill,skillId:'synthetic_equal_workflow',version:'1.2.0'}};
  const staged=runtime.capabilityPackagePromotionManager.stage(candidate);
  const original=runtime.capabilityPackagePromotionManager.evaluateInIsolation;
  await assert.rejects(runtime.capabilityPackagePromotionManager.evaluate(staged.stageId),{code:'A_CAPABILITY_PACKAGE_ISOLATION_FAILED'});
  const entry=runtime.capabilityPackagePromotionManager.getStage(staged.stageId);
  const result=entry.evaluation;
  t.diagnostic(JSON.stringify(result));
  assert.equal(result.receipt.comparison.baseline.failedRuns,0);
  assert.equal(result.receipt.comparison.candidate.failedRuns,0);
  assert.equal(result.receipt.comparison.improved,false);
  assert.equal(result.status,'failed');
  assert.equal(original.budgetStatus().attempts,6);
  await assert.rejects(runtime.capabilityPackagePromotionManager.review(staged.stageId,{}),{code:'A_CAPABILITY_PACKAGE_EVALUATION_REQUIRED'});
  assert.equal(runtime.capabilityPackageRegistry.activations.get('workflow.execute').packageId,'jarvis.local-workflow');
 }finally{runtime.coreFacade.cognition.close();}
});
test('admitted bundled adapter runs a natural-language Mission through Core policy B and G on isolated local files',async t=>{
 const root=await mkdtemp(join(tmpdir(),'workflow-bundle-mission-'));
 const artifact=await buildWorkflowEvaluationArtifact(options),definition=await loadBuiltWorkflowCapability(artifact);
 await writeFile(join(root,'input.json'),'[{"total":7}]');
 const runtime=createAgRuntime({workflowCapabilityDefinition:definition,allowedRoots:[root],cwd:()=>root,auditRoot:join(root,'audit'),
  cognitionStorePath:join(root,'cognition.sqlite'),workerDaemonEnabled:false,
  env:{JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'}});
 try{
  const mission=runtime.missionRuntime.createMission({objective:"'input.json' JSON을 '원본'으로 읽고; '원본'의 개수가 1인지 검증하고; '원본'을 'output.json' JSON으로 저장해",
   authorization:{grants:['read_only','local_reversible']},successCriteria:[{statement:'합계7',verificationSpec:{version:1,kind:'json.value',path:'output.json',pointer:'/0/total',equals:7}}]});
  const result=await runtime.missionRuntime.runMission(mission.missionId);
  t.diagnostic(JSON.stringify({status:result.status,stopReason:result.stopReason,artifactSha256:definition.artifactSha256}));
  assert.equal(result.status,'COMPLETED',JSON.stringify(result));
  assert.deepEqual(JSON.parse(await readFile(join(root,'output.json'),'utf8')),[{total:7}]);
  assert.equal(runtime.capabilityPackageRegistry.activations.get('workflow.execute').packageId,'jarvis.local-workflow');
 }finally{runtime.coreFacade.cognition.close();await rm(root,{recursive:true,force:true});}
});
