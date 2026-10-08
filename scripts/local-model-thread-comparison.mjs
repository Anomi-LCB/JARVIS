import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {runLocalSummaryMission} from './local-summary-mission-pilot.mjs';
import {createOllamaLocalModelProvider} from '../packages/core/src/mission/ollama-local-model-provider.js';

export const threadComparisonSchedule=Object.freeze([
  {caseId:'attribution',threads:3},{caseId:'attribution',threads:6},
  {caseId:'attribution',threads:6},{caseId:'attribution',threads:3},
  {caseId:'uncertainty',threads:3},{caseId:'uncertainty',threads:6}
].map(Object.freeze));

export function summarizeThreadComparison(runs){
  const profiles=[3,6].map(threads=>{
    const entries=runs.filter(r=>r.threads===threads);
    const passed=entries.filter(r=>r.report?.status==='COMPLETED'&&r.report.outputMatchesIndependentOracle===true&&r.report.actions?.length===5&&r.report.actions.every(a=>a.status==='succeeded')&&r.report.observations?.length===5&&r.report.observations.every(o=>o.outcome==='success'&&o.verificationStatus==='passed'));
    return {threads,total:entries.length,passed:passed.length,failed:entries.length-passed.length,
      samples:entries.map(r=>({caseId:r.caseId,status:r.report?.status??'FAILED',totalMs:r.report?.totalMs??null,runtimeTiming:r.report?.model?.runtimeTiming??null,providerCalls:r.report?.model?.providerCalls??r.report?.modelFailure?.providerCalls??null,costUsd:null}))};
  });
  return {profiles,total:runs.length,passed:profiles.reduce((n,p)=>n+p.passed,0),
    allScheduledRunsPresent:runs.length===threadComparisonSchedule.length&&runs.every((r,i)=>r.caseId===threadComparisonSchedule[i].caseId&&r.threads===threadComparisonSchedule[i].threads),
    performancePromotionAllowed:false,costMeasurement:'unmeasured',originalAcceptancePromoted:false};
}

export async function runThreadComparison({outputRoot,run=runLocalSummaryMission}={}){
  if(typeof outputRoot!=='string'||!outputRoot)throw new Error('Output directory required');
  await mkdir(outputRoot,{recursive:false});
  const corpusBytes=await readFile(new URL('../tests/fixtures/local-summary-quality-v2.json',import.meta.url));
  const corpus=JSON.parse(corpusBytes);
  const runs=[];
  for(const [index,slot] of threadComparisonSchedule.entries()){
    const item=corpus.cases.find(c=>c.id===slot.caseId);
    if(!item)throw new Error('Fixed case missing');
    const path=join(outputRoot,`run-${index+1}-${slot.caseId}-t${slot.threads}`);
    const started=performance.now();
    let report;
    try{report=await run({item,outputRoot:path,provider:createOllamaLocalModelProvider({model:'gemma3:latest',timeoutMs:120000,numThreads:slot.threads})});}
    catch(error){report={status:'FAILED',errorCode:typeof error?.code==='string'?error.code:'COMPARISON_RUN_FAILED',totalMs:performance.now()-started,outputMatchesIndependentOracle:false};await mkdir(path,{recursive:true});await writeFile(join(path,'failure.json'),JSON.stringify(report,null,2),{flag:'wx'});}
    runs.push({...slot,reportPath:path,report});
    console.log(JSON.stringify({index:index+1,...slot,status:report.status,oracle:report.outputMatchesIndependentOracle,totalMs:report.totalMs}));
    await writeFile(join(outputRoot,`checkpoint-${index+1}.json`),JSON.stringify(runs,null,2),{flag:'wx'});
  }
  const result={version:'local-model-thread-comparison-v1',observedAt:new Date().toISOString(),corpusSha256:createHash('sha256').update(corpusBytes).digest('hex'),
    schedule:threadComparisonSchedule,loadingConditions:'sequential shared server; first run may be cold; later runs may reuse model/prompt caches; timing is observational, not randomized causal comparison',
    ...summarizeThreadComparison(runs),runs};
  await writeFile(join(outputRoot,'comparison.json'),JSON.stringify(result,null,2),{flag:'wx'});
  return result;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const result=await runThreadComparison({outputRoot:process.argv[2]});
  if(result.passed!==result.total||!result.allScheduledRunsPresent)process.exitCode=1;
}
