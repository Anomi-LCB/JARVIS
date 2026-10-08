import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {GrowthRuntime} from '../apps/growth-memory/src/growth-runtime.js';
import {SqliteMemoryStore} from '../apps/growth-memory/src/db/sqlite-store.js';
import {assertComparisonOutputPath} from './recovery-comparison.mjs';
const SUITE='tests/fixtures/long-term-memory-comparison-v1.json';
const FROZEN='fddb40d53847987bc239b173f2f615093ae261b75ad2ea2d9378f856e34f11d0';
const sources=[SUITE,'scripts/long-term-memory-comparison.mjs','packages/core/src/core-facade.js','apps/growth-memory/src/growth-runtime.js','apps/growth-memory/src/db/sqlite-store.js'];
const hashes=()=>sources.map(path=>({path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex')}));
const percentile=(values,p)=>[...values].sort((a,b)=>a-b)[Math.max(0,Math.ceil(values.length*p)-1)]??null;
export async function runLongTermMemoryComparison({repetitions=3}={}){
 if(!Number.isInteger(repetitions)||repetitions<1||repetitions>3)throw new Error('INVALID_REPETITIONS');
 const before=hashes(),bytes=readFileSync(SUITE);if(createHash('sha256').update(bytes).digest('hex')!==FROZEN)throw new Error('FIXED_ORACLE_CHANGED');
 const suite=JSON.parse(bytes),runs=[];
 for(const item of suite.cases)for(let repetition=1;repetition<=repetitions;repetition++)for(const enabled of (repetition%2 ? [false,true]:[true,false])){
  const root=mkdtempSync(join(tmpdir(),'jarvis-memory-paired-'));let store,runtime;
  try{
   writeFileSync(join(root,suite.fileName),suite.fileContent);
   store=new SqliteMemoryStore({dbPath:join(root,'growth.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')});
   const env={JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'};
   const seed=new GrowthRuntime({memoryStore:store,auditRoot:join(root,'seed-audit')});
   const scope={userId:'synthetic-owner',workspaceRoot:item.seed==='other-workspace'?join(root,'other-workspace'):root,conversationId:'session-a'};
   if(item.seed!=='empty'){
    for(let i=0;i<3;i++)seed.ingestor.ingest({eventId:`source-${i}`,taskId:`source-task-${i}`,eventType:'approval.edited',source:{module:'CORE',memoryScope:scope},payload:{editRequest:suite.sourceStatement},learningFlags:{canBeUsedForPreference:true},trustBoundary:{userProvided:true}});
    if(item.seed!=='unconfirmed'){
     const candidate=seed.query('파일',{scope}).find(v=>v.hypothesisId&&!v.preferenceId);if(!candidate)throw new Error('CANDIDATE_SETUP_FAILED');
     const confirmation=seed.decidePreference({hypothesisId:candidate.hypothesisId});if(!confirmation.success)throw new Error('CONFIRM_SETUP_FAILED');
     const id=confirmation.item.preferenceId;
     const first=seed.updatePreference(id,{expectedRevision:1,patch:{statement:'파일 목록은 표로 정리한다.'}});if(!first.success)throw new Error('REVISION_SETUP_FAILED');
     if(item.seed==='corrected')seed.updatePreference(id,{expectedRevision:2,patch:{statement:'파일 목록은 상세한 문장으로 정리한다.'}});
     if(item.seed==='withdrawn')seed.decideHygiene({targetId:'source-0',action:'delete',generateReport:false});
    }
   }
   runtime=createAgRuntime({memoryStore:store,allowedRoots:[root],auditRoot:join(root,'audit'),env,taskEnv:env,personalContextProvider:()=>null,workerDaemonEnabled:false});
   const started=performance.now();
   const task=runtime.coreFacade.createTask(suite.command,{userId:item.owner,metadata:{conversationId:item.conversation,longTermMemory:enabled,doNotRemember:true}});
   const planMs=performance.now()-started;
   const run=await runtime.orchestrationWorker.runTask(task.taskId,{deviceId:'synthetic-memory-comparison'});
   const durationMs=performance.now()-started;
   const hints=task.planningContext?.confirmedPreferenceHints??[];
   const recall=task.memoryContext.filter(v=>v.preferenceId&&v.memoryType==='confirmed_preference');
   const expected=enabled?item.expectedStatement:null;
   const correctHint=expected===null ? hints.length===0&&recall.length===0 : hints.length===1&&hints[0].statement===expected&&hints[0].revision===item.expectedRevision&&recall.some(v=>v.statement===expected);
   const fileObserved=JSON.stringify(run.execution?.executionResult??{}).includes(suite.fileName);

   const oracle={correctHint,longTermOffEmpty:enabled||(!task.planningContext&&!task.memoryContext.length&&!task.plan.cognitiveContext),
    originalRequestPreserved:task.request.command.rawText===suite.command,expectedTool:task.plan.action.toolName==='filesystem.listFiles',
    sourceUnchanged:readFileSync(join(root,suite.fileName),'utf8')===suite.fileContent,
    actualExecutionVerified:run.success===true&&run.executionVerification?.status==='passed',fileObserved};
   runs.push({caseId:item.id,repetition,longTermMemory:enabled,status:Object.values(oracle).every(Boolean)?'passed':'failed',oracle,
    hintStatements:hints.map(v=>v.statement),hintRevisions:hints.map(v=>v.revision),durationMs,planMs,
    modelCalls:0,toolCalls:run.success?1:null,retries:null,userQuestions:null,userApprovals:null,cost:{status:'unmeasured',amount:null},
    policy:{tool:task.plan.action.toolName,decision:task.policy?.decision??null,riskTier:task.plan.action.riskTier??null}});
  }catch(error){runs.push({caseId:item.id,repetition,longTermMemory:enabled,status:'failed',errorCode:error?.code??error?.message??'EVALUATION_FAILED',cost:{status:'unmeasured',amount:null}});}
  finally{runtime?.coreFacade.cognition?.close();store?.close();rmSync(root,{recursive:true,force:true});}
 }
 const summaries=[false,true].map(enabled=>{const selected=runs.filter(v=>v.longTermMemory===enabled),durations=selected.map(v=>v.durationMs).filter(Number.isFinite);return {longTermMemory:enabled,total:selected.length,passed:selected.filter(v=>v.status==='passed').length,failed:selected.filter(v=>v.status!=='passed').length,
  p50Ms:percentile(durations,.5),p95Ms:percentile(durations,.95),cost:{status:'unmeasured',amount:null}};});
 const paired=suite.cases.map(item=>{const selected=runs.filter(v=>v.caseId===item.id);const on=selected.filter(v=>v.longTermMemory),off=selected.filter(v=>!v.longTermMemory);return {caseId:item.id,
  oraclePassed:selected.every(v=>v.status==='passed'),policyEqual:on.every((v,i)=>JSON.stringify(v.policy)===JSON.stringify(off[i]?.policy)),
  outputEffect:'not_measured_for_content_quality_read_only_listing',recallExpected:item.expectedStatement!==null};});
 const sourcesUnchanged=JSON.stringify(before)===JSON.stringify(hashes());
 return {version:'long-term-memory-comparison-v1',observedAt:new Date().toISOString(),suiteSha256:FROZEN,sourceFiles:before,sourcesUnchanged,
  mode:'isolated-real-Core-policy-PC-filesystem-verification-SQLite-no-external-model',repetitions,summaries,paired,runs,
  passed:sourcesUnchanged&&runs.every(v=>v.status==='passed')&&paired.every(v=>v.policyEqual),
  limits:['Read-only deterministic listing;no evidence of improved generated content or external LLM quality.','Scope/correction/withdrawal recall compared;not general intelligence or all memory interfaces.','Timing excludes seed/setup;small synthetic sample,not production p95.','Unknown retries/questions/approvals and cost retained as unmeasured.','Storage opt-out is separate from long-term recall switch;conversation references and execution context remain.']};
}
if(import.meta.url===pathToFileURL(resolve(process.argv[1]??'')).href){
 const output=process.argv[2];if(!output)throw new Error('OUTPUT_REQUIRED');
 assertComparisonOutputPath(output,{suitePath:resolve(SUITE),sourcePaths:sources.map(path=>resolve(path))});
 const report=await runLongTermMemoryComparison();mkdirSync(dirname(resolve(output)),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({passed:report.passed,summaries:report.summaries,total:report.runs.length,output}));if(!report.passed)process.exitCode=1;
}
