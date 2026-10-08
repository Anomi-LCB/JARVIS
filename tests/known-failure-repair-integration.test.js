import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {buildWorkflowEvaluationArtifact,loadBuiltWorkflowCapability} from '../packages/core/src/capabilities/workflow-artifact-builder.js';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {PersistentEvaluationBudget} from '../packages/core/src/capabilities/persistent-evaluation-budget.js';
import {snapshotEvaluationRequirements} from '../packages/core/src/capabilities/evaluation-requirement-contract.js';
import {createEvidenceBoundRepairFactory} from '../packages/core/src/capabilities/evidence-bound-repair-factory.js';
const canonical=v=>Array.isArray(v)?`[${v.map(canonical).join(',')}]`:v&&typeof v==='object'?`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`:JSON.stringify(v);
const sha=v=>createHash('sha256').update(v).digest('hex');
const url='https://unicode.org/reports/tr35/tr35-numbers.html';
function spec(id,op,args){return {schemaVersion:'jarvis-local-workflow-v1',workflowId:id,nodes:[{id:'calculate',op,args},
 {id:'publish',op:'write.json',dependsOn:['calculate'],args:{path:`${id}.json`,value:{$ref:{nodeId:'calculate'}}}}]};}
const sorted=[{price:'950'},{price:'2,000'},{price:'10,000'}];
function output(items,name){const text=JSON.stringify({items,rows:items,count:items.length},null,2)+'\n';return {status:'success',nodeCount:2,receiptCount:2,
 files:[{name,text,sha256:sha(text),size:Buffer.byteLength(text)}]};}
const requirements={originalRequest:'명시한 세자리 쉼표 숫자로 정렬·필터링하고 원문은 보존해. 모호한 숫자·미지원 형식·작업 공간 밖 쓰기는 거부해.',revision:1,
 requirements:[{id:'R1',text:'명시된 쉼표 숫자 정렬'},{id:'R2',text:'쉼표 기준 필터'},{id:'R3',text:'모호성/미지원/공간밖 쓰기 차단'}]};
const sortSpec=spec('sort','data.sort',{items:[sorted[1],sorted[0],sorted[2]],by:[{field:'price',numeric:true,numericFormat:'grouped-decimal'}]});
const cases=[{id:'grouped-sort',method:'execute',args:{spec:sortSpec},packet:{},expected:output(sorted,'sort.json'),requirementIds:['R1']},
 {id:'grouped-filter',method:'execute',args:{spec:spec('filter','data.filter',{items:sorted,where:{field:'price',numeric:true,numericFormat:'grouped-decimal',operator:'gte',value:'2,000'}})},packet:{},expected:output(sorted.slice(1),'filter.json'),requirementIds:['R2']},
 ...['1,00','1.234,56','1,000원'].map((price,i)=>({id:`bad-${i}`,method:'execute',args:{spec:spec(`bad-${i}`,'data.sort',{items:[{price}],by:[{field:'price',numeric:true,numericFormat:'grouped-decimal'}]})},packet:{},expected:{status:'failed',errorCode:'WORKFLOW_NUMBER_INVALID'},requirementIds:['R3']})),
 {id:'unknown-format',method:'execute',args:{spec:spec('unknown','data.sort',{items:[],by:[{field:'price',numeric:true,numericFormat:'unknown'}]})},packet:{},expected:{status:'failed',errorCode:'WORKFLOW_NUMBER_FORMAT_UNSUPPORTED'},requirementIds:['R3']},
 {id:'outside-root',method:'execute',args:{spec:{schemaVersion:'jarvis-local-workflow-v1',workflowId:'outside',nodes:[{id:'write',op:'write.text',args:{path:'../forbidden.txt',text:'denied'}}]}},packet:{},expected:{status:'blocked',errorCode:'WORKFLOW_PATH_OUTSIDE_ALLOWED_ROOT'},requirementIds:['R3']}];
test('actual repeated B numeric failures -> live official source -> cause-bound real repair -> Docker 3x comparison -> registration only',async t=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-known-repair-')),store=new PersonalOperationsStore({dbPath:join(root,'db.sqlite')});
 let runtime;t.after(()=>{runtime?.coreFacade.cognition.close();store.close();rmSync(root,{recursive:true,force:true});});
 const build=projectRoot=>buildWorkflowEvaluationArtifact({projectRoot,esbuildPath:resolve('artifacts/evaluation-build-tools-20261006/node_modules/esbuild/lib/main.js'),mode:'runtime'});
 const beforeArtifact=await build(resolve('artifacts/grouped-number-baseline-20261007')),afterArtifact=await build(process.cwd());
 assert.equal(beforeArtifact.artifactSha256,JSON.parse(readFileSync('artifacts/grouped-number-workflow-20261007-baseline.json','utf8')).artifact.artifactSha256);
 assert.notEqual(beforeArtifact.artifactSha256,afterArtifact.artifactSha256);
 const before=await loadBuiltWorkflowCapability(beforeArtifact),after=await loadBuiltWorkflowCapability(afterArtifact);
 const candidate={...after,verifyEvidence:before.verifyEvidence,packageId:'jarvis.grouped-number-repair',version:'1.12.0',skill:{...after.skill,skillId:'grouped_number_repair',version:'1.12.0'}};
 const mandate=PersistentEvaluationBudget.createCountQuota({store,validFrom:'2020-01-01T00:00:00Z',expiresAt:'2099-01-01T00:00:00Z',maxCalls:6});
 const budget=new PersistentEvaluationBudget({store,mandateId:mandate.id,suiteSha256:sha(canonical(cases)),
  requirementContractSha256:snapshotEvaluationRequirements(requirements).sha256,maxTimeoutMs:20000});
 let recipe;const factory=(...args)=>recipe(...args);Object.defineProperty(factory,'diagnosisFor',{value:def=>recipe?.diagnosisFor(def)??null});
 runtime=createAgRuntime({allowedRoots:[join(root,'workspace')],auditRoot:join(root,'audit'),workerDaemonEnabled:false,workflowCapabilityDefinition:before,
  capabilityPackageEvaluationBudget:budget,capabilityPackageEvaluationRequirements:requirements,capabilityPackageComparisonRequired:true,
  capabilityPackageEvaluationResultContract:'local-workflow-files-v1',capabilityPackageEvaluationTimeoutMs:20000,
  capabilityPackageArtifactAuthorizer:i=>({approved:i.artifactSource===candidate.artifactSource&&i.createAdapter===candidate.createAdapter&&i.verifyEvidence===candidate.verifyEvidence,
   artifactSha256:i.artifactSha256,admissionRef:`reviewed-repair:${candidate.artifactSha256}`}),
  capabilityPackageEvaluationCases:async()=>({suiteId:'grouped-number-fixed-v1',cases}),
  failureImprovementConfig:{store,sourcesForTool:new Map([['workflow.execute',[url]]]),createCandidate:factory},
  env:{JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'}});
 const active=runtime.capabilityPackageRegistry.activations.get('workflow.execute').packageDigest;
 recipe=createEvidenceBoundRepairFactory([{toolName:'workflow.execute',failureCode:'WORKFLOW_NUMBER_INVALID',executionCodeVersion:active,
  sourceUrls:[url],reproducerEvidenceSha256:sha(readFileSync('artifacts/grouped-number-workflow-20261007-before-confirmed.txt')),buildCandidate:()=>candidate}]);
 mkdirSync(runtime.coreFacade.workspaceRoot,{recursive:true});
 for(const id of ['one','two']) {
  writeFileSync(join(runtime.coreFacade.workspaceRoot,`${id}.workflow.json`),JSON.stringify({...sortSpec,workflowId:id}));
  const m=runtime.missionRuntime.createMission({objective:`${id}.workflow.json에 정의된 검증 워크플로를 실행하고 sort.json을 생성해.`,
   authorization:{grants:['read_only','local_reversible']},successCriteria:[{statement:'정렬첫값',verificationSpec:{version:1,kind:'json.value',path:'sort.json',pointer:'/items/0/price',equals:'950'}}]});
  const result=await runtime.missionRuntime.runMission(m.missionId);assert.notEqual(result.status,'COMPLETED');
 }
 const observations=[...runtime.orchestrationWorker.failureObservations.values()];
 assert.equal(observations.length,2);assert.ok(observations.every(v=>v.failureCode==='WORKFLOW_NUMBER_INVALID'&&v.executionCodeVersion===active));
 let result;try{result=await runtime.processFailureImprovements();}catch(error){
  const failedItems=runtime.failureImprovementPipeline.list();t.diagnostic(JSON.stringify({failedItems,stages:failedItems.map(i=>i.stageId?runtime.capabilityPackagePromotionManager.getStage(i.stageId):null)}));throw error;
 }assert.equal(result.items[0].state,'registration_candidate');
 const row=result.items[0],stage=runtime.capabilityPackagePromotionManager.getStage(row.stageId),comparison=stage.evaluation.receipt.comparison;
 assert.equal(comparison.improved,true);assert.ok(comparison.runs.every(r=>r.regressedCaseIds.length===0&&r.gainedCaseIds.length>=3));
 assert.equal(row.repairDiagnosis.baselinePackageDigest,active);assert.equal(row.repairDiagnosis.independentlyImproved,false);
 assert.equal(runtime.capabilityPackageRegistry.activations.get('workflow.execute').packageDigest,active);
 assert.equal(runtime.capabilityPackagePromotionManager.evaluateInIsolation.budgetStatus().attempts,6);
 await assert.rejects(runtime.capabilityPackagePromotionManager.promote(row.stageId));
 assert.equal(runtime.orchestrationWorker.failureObservations.size,2);
 t.diagnostic(JSON.stringify({observedAt:new Date().toISOString(),actualCoreFailures:2,injectedAdapterErrors:0,
  officialSource:row.sources[0],baselineSourceManifestSha256:beforeArtifact.sourceManifestSha256,
  candidateSourceManifestSha256:afterArtifact.sourceManifestSha256,repairDiagnosis:row.repairDiagnosis,
  comparison,registeredCandidateOnly:true,externalUserActions:0,cost:'unmeasured'}));
});
