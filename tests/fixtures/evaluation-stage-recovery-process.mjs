import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {createAgRuntime} from '../../apps/runtime-compose/src/create-runtime.js';
import {createLocalWorkflowCapabilityPackage} from '../../apps/runtime-compose/src/workflow-capability-package.js';
import {PersonalOperationsStore} from '../../packages/core/src/personal-operations/operations-store.js';
import {PersistentEvaluationBudget} from '../../packages/core/src/capabilities/persistent-evaluation-budget.js';
import {RuntimeTrustKernel} from '../../packages/core/src/security/runtime-trust-kernel.js';
import {buildWorkflowEvaluationArtifact,loadBuiltWorkflowCapability} from '../../packages/core/src/capabilities/workflow-artifact-builder.js';
import {cases as workflowCases,requirements as workflowRequirements,calculationRequirements} from './evaluation-recovery-workflow-cases.mjs';
import {snapshotEvaluationRequirements} from '../../packages/core/src/capabilities/evaluation-requirement-contract.js';
const [mode,root,mandateId,suiteSha256,outcome='passed']=process.argv.slice(2),store=new PersonalOperationsStore({dbPath:join(root,'state.sqlite')});
const real=outcome.startsWith('real'),comparison=outcome==='real-comparison';
const requirements=real?workflowRequirements:calculationRequirements;
const budget=new PersistentEvaluationBudget({store,mandateId,suiteSha256,maxTimeoutMs:20000,requirementContractSha256:snapshotEvaluationRequirements(requirements).sha256});
const trustKernel=new RuntimeTrustKernel({testMode:false,statePath:join(root,'audit/trust-state.json'),keyPath:join(root,'audit/trust-key.json'),auditPath:join(root,'audit/trust-audit.jsonl')});
let factories=0,fetches=0,oracles=0;
const bundled=real?await loadBuiltWorkflowCapability(await buildWorkflowEvaluationArtifact({projectRoot:process.cwd(),esbuildPath:'artifacts/evaluation-build-tools-20261006/node_modules/esbuild/lib/main.js',mode:'runtime'})):null;
const definition=()=>{
 if(bundled)return{...bundled,packageId:'jarvis.recovery-workflow',version:'1.11.0',skill:{...bundled.skill,skillId:'recovery_workflow',version:'1.11.0'}};
 const c=createLocalWorkflowCapabilityPackage();c.packageId='synthetic.recovered-stage';c.version='1.10.0';c.skill={...c.skill,skillId:'synthetic_recovered_stage',version:c.version};c.artifactSource=`export function createAdapter(){return {execute(){return ${outcome==='failed'?0:42}}}}`;c.artifactSha256=createHash('sha256').update(c.artifactSource).digest('hex');if(mode==='widen')c.skill.capability.allowedModes.push('unrestricted');return c;
};
const pending=mode==='write'?null:JSON.parse(store.db.prepare('SELECT body FROM failure_improvement_queue').get().body);
const runtime=createAgRuntime({trustKernel,auditRoot:join(root,'audit'),allowedRoots:[join(root,'workspace')],workerDaemonEnabled:false,
 ...(bundled?{workflowCapabilityDefinition:bundled,capabilityPackageEvaluationResultContract:'local-workflow-files-v1'}:{}),
 ...(pending?{capabilityPackageRecoveryDefinitions:new Map([[pending.stageId,definition()]])}:{}),
 capabilityPackageEvaluationBudget:budget,capabilityPackageEvaluationTimeoutMs:20000,capabilityPackageEvaluationRequirements:requirements,capabilityPackageComparisonRequired:comparison,
 capabilityPackageArtifactAuthorizer:i=>({approved:!bundled||(i.artifactSource===bundled.artifactSource&&i.createAdapter===bundled.createAdapter&&i.verifyEvidence===bundled.verifyEvidence&&i.artifactSha256===bundled.artifactSha256),artifactSha256:i.artifactSha256,admissionRef:mode==='bad-admission'?'changed-host-admission':bundled?`local-bundle:${bundled.artifactSha256}`:'fixture-host-admission-v1'}),
 capabilityPackageReviewAuthorizer:i=>({approved:true,reviewerId:'fixture-approved-owner',packageDigest:i.packageDigest,artifactSha256:i.artifactSha256}),
 capabilityPackageEvaluationCases:async()=>{oracles++;return{suiteId:'stage-recovery-fixed',cases:bundled?workflowCases:[{id:'one',method:'execute',args:{},packet:{},expected:42,requirementIds:['R1']}]};},
 failureImprovementConfig:{store,sourcesForTool:new Map([['workflow.execute',['https://nodejs.org/api/fs.html']]]),
 fetchSource:async()=>{fetches++;return new Response('fixture public source');},createCandidate:()=>{factories++;return definition();}},
 env:{JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'}});
try{
 let restore=null,errorCode=null,promoteCode=null;
 if(mode==='write'){
  const observations=['one','two'].map(taskId=>({version:1,taskId,status:'FAILED',observedAt:new Date().toISOString(),toolName:'workflow.execute',nativeRecovery:null}));
  const [item]=runtime.failureImprovementPipeline.enqueue(observations);
  store.db.exec("CREATE TRIGGER interrupted_finalization BEFORE UPDATE ON failure_improvement_queue WHEN NEW.state IN ('registration_candidate','failed') BEGIN SELECT RAISE(ABORT,'fixture finalization interrupted'); END");
  try{await runtime.failureImprovementPipeline.process(item.id);}catch(e){if(!/fixture finalization interrupted/.test(e.message))throw e;}
  store.db.exec('DROP TRIGGER interrupted_finalization');
  if(outcome==='reviewed')await runtime.capabilityPackagePromotionManager.review(runtime.failureImprovementPipeline.list()[0].stageId);
 }else{
  const [item]=runtime.failureImprovementPipeline.list();
  if(mode==='incomplete')runtime.capabilityPackagePromotionManager.journal.append('evaluation_started',{stageId:item.stageId,packageDigest:item.packageDigest,artifactSha256:item.artifactSha256});
  try{
   const result=await runtime.processFailureImprovements();
   restore=result.restorations[0]??runtime.capabilityPackagePromotionManager.restoreStage(item.stageId,definition());
  }catch(e){errorCode=e.code??e.message;}
  if(restore){
   try{await runtime.capabilityPackagePromotionManager.promote(item.stageId);}catch(e){promoteCode=e.code;}
   await runtime.processFailureImprovements();
  }
 }
 const [item]=runtime.failureImprovementPipeline.list();
 const stage=mode==='write'?runtime.capabilityPackagePromotionManager.getStage(item.stageId):null;
 console.log(JSON.stringify({pid:process.pid,item,restore,errorCode,promoteCode,factories,fetches,oracles,
  comparison:stage?.evaluation?.receipt?.comparison??null,preparations:store.db.prepare('SELECT preparation_id,bound_stage_id FROM capability_evaluation_preparations').all(),
  evaluationCalls:runtime.capabilityPackagePromotionManager.evaluateInIsolation.budgetStatus().attempts,budget:budget.status(),
  activePackageId:runtime.capabilityPackageRegistry.activations.get('workflow.execute').packageId,
  journal:runtime.capabilityPackagePromotionManager.status().lifecycleJournal}));
}finally{runtime.coreFacade.cognition.close();store.close();}
