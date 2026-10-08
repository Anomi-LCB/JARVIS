import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {createAgRuntime} from '../../apps/runtime-compose/src/create-runtime.js';
import {RuntimeTrustKernel} from '../../packages/core/src/security/runtime-trust-kernel.js';
import {buildWorkflowEvaluationArtifact,loadBuiltWorkflowCapability,identifyBuiltWorkflowCapability} from '../../packages/core/src/capabilities/workflow-artifact-builder.js';
const [mode,root]=process.argv.slice(2),sha=v=>createHash('sha256').update(v).digest('hex');
const build=projectRoot=>buildWorkflowEvaluationArtifact({projectRoot,esbuildPath:resolve('artifacts/evaluation-build-tools-20261006/node_modules/esbuild/lib/main.js'),mode:'runtime'});
const prior=await loadBuiltWorkflowCapability(await build(resolve('artifacts/grouped-number-baseline-20261007')));
const next=await loadBuiltWorkflowCapability(await build(process.cwd()));
const promoted=identifyBuiltWorkflowCapability(next,{packageId:'jarvis.recoverable-promoted',version:'1.13.0',skillId:'recoverable_promoted'},prior);
const trustKernel=new RuntimeTrustKernel({testMode:false,statePath:join(root,'audit/trust-state.json'),keyPath:join(root,'audit/trust-key.json'),auditPath:join(root,'audit/trust-audit.jsonl')});
const runtime=createAgRuntime({trustKernel,auditRoot:join(root,'audit'),allowedRoots:[join(root,'workspace')],workerDaemonEnabled:false,
 workflowCapabilityDefinition:mode==='write'?prior:promoted,capabilityPackageEvaluationResultContract:'local-workflow-files-v1',
 capabilityPackageArtifactAuthorizer:i=>({approved:[prior,promoted].some(d=>i.artifactSource===d.artifactSource&&i.artifactSha256===d.artifactSha256&&i.createAdapter===d.createAdapter&&i.verifyEvidence===d.verifyEvidence),
  artifactSha256:i.artifactSha256,admissionRef:`reviewed-loaded:${i.artifactSha256}`}),
 capabilityPackageEvaluationCases:async()=>({suiteId:'rollback-real-files-v1',cases:[{id:'file',method:'execute',args:{spec:{schemaVersion:'jarvis-local-workflow-v1',workflowId:'file',nodes:[{id:'write',op:'write.text',args:{path:'out.txt',text:'실제 복원 검사'}}]}},packet:{},
  expected:{status:'success',nodeCount:1,receiptCount:1,files:[{name:'out.txt',text:'실제 복원 검사',sha256:sha('실제 복원 검사'),size:Buffer.byteLength('실제 복원 검사')}]}}]}),
 env:{JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'}});
try{
 const manager=runtime.capabilityPackagePromotionManager;
 const owner=()=>({ownerSessionId:runtime.personalOwnerSession.activate({grants:['high_impact']}).session.sessionId,deviceId:'fixture-device',remoteAddress:'127.0.0.1'});
 let output;
 if(mode==='write'){
  const priorDigest=runtime.capabilityPackageRegistry.activations.get('workflow.execute').packageDigest;
  const stage=manager.stage(promoted);await manager.evaluate(stage.stageId);await manager.review(stage.stageId,owner());
  const result=await manager.promote(stage.stageId);writeFileSync(join(root,'promotion.json'),JSON.stringify({rollbackId:result.rollbackId,priorDigest,promotedDigest:result.packageDigest}));
  output={status:result.status,rollbackId:result.rollbackId,priorDigest,promotedDigest:result.packageDigest,evaluations:manager.evaluateInIsolation.budgetStatus().attempts};
 }else{
  const stored=JSON.parse(readFileSync(join(root,'promotion.json'),'utf8'));
  let recovery,withoutOwner,rolled,errorCode;
  try{
   recovery=manager.restoreRollback(stored.rollbackId,mode==='tampered'?{...prior,version:'99.0.0'}:prior,promoted);
   try{await manager.rollback(stored.rollbackId);}catch(e){withoutOwner=e.code;}
   if(mode==='superseded')manager.journal.append('rollback_committed',{rollbackId:stored.rollbackId,rollbackDigest:stored.priorDigest});
   if(mode==='authorization-race'){
    const authorize=manager.authorizeReview;
    manager.authorizeReview=async input=>{const decision=await authorize(input);manager.journal.append('rollback_committed',{rollbackId:stored.rollbackId,rollbackDigest:stored.priorDigest});return decision;};
   }
   if(mode!=='restore-only')rolled=await manager.rollback(stored.rollbackId,owner());
  }catch(e){errorCode=e.code??e.message;}
  let mission;
  if(rolled){mkdirSync(runtime.coreFacade.workspaceRoot,{recursive:true});writeFileSync(join(runtime.coreFacade.workspaceRoot,'restore.workflow.json'),JSON.stringify({schemaVersion:'jarvis-local-workflow-v1',workflowId:'restored',nodes:[{id:'write',op:'write.text',args:{path:'restored.txt',text:'이전 버전 실행'}}]}));
   const m=runtime.missionRuntime.createMission({objective:'restore.workflow.json에 정의된 검증 워크플로를 실행하고 restored.txt를 생성해.',authorization:{grants:['read_only','local_reversible']},successCriteria:[{statement:'이전 코드 기록',verificationSpec:{version:1,kind:'text.equals',path:'restored.txt',equals:'이전 버전 실행'}}]});
   mission=await runtime.missionRuntime.runMission(m.missionId);
  }
  output={recovery,withoutOwner,rolled,errorCode,mission,missionStatus:mission?.status,activeDigest:runtime.capabilityPackageRegistry.activations.get('workflow.execute').packageDigest,
   evaluations:manager.evaluateInIsolation.budgetStatus().attempts};
 }
 console.log(JSON.stringify({pid:process.pid,...output,journal:manager.status().lifecycleJournal}));
}finally{runtime.coreFacade.cognition.close();}
