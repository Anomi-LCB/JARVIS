import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createOllamaLocalModelProvider} from '../packages/core/src/mission/ollama-local-model-provider.js';
import {runLocalSummaryMission} from './local-summary-mission-pilot.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
export function evaluateSummary(item,output){
  const ids=Object.keys(item.questions);
  const exactKeys=value=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===ids.length&&ids.every(id=>Object.hasOwn(value,id));
  const shape=output&&Object.keys(output).length===2&&exactKeys(output.facts)&&exactKeys(output.evidence);
  const requirements=ids.map(id=>({id,factPreserved:shape&&output.facts[id]===item.expected[id],
    exactEvidence:shape&&typeof output.evidence[id]==='string'&&output.evidence[id].length>0&&item.source.includes(output.evidence[id]),
    directFactEvidence:shape&&Array.isArray(item.evidenceAnchors?.[id])&&item.evidenceAnchors[id].length>0
      &&item.evidenceAnchors[id].every(anchor=>typeof anchor==='string'&&anchor.length>0&&item.source.includes(anchor)
        &&typeof output.evidence[id]==='string'&&output.evidence[id].includes(anchor))}));
  return {shapeValid:!!shape,requirements,passed:!!shape&&requirements.every(r=>r.factPreserved&&r.exactEvidence&&r.directFactEvidence),
    scope:'fixed-independent-fact-oracle-and-source-quote',arbitraryProseQualityVerified:false};
}
export async function runLocalSummaryQuality({outputRoot,model='gemma3:latest',provider=null}={}){
  if(!outputRoot)throw new Error('A unique evidence directory is required');
  const bytes=await readFile(new URL('../tests/fixtures/local-summary-quality-v2.json',import.meta.url));
  const corpus=JSON.parse(bytes);const root=resolve(outputRoot);await mkdir(root,{recursive:true});
  const engine=provider??createOllamaLocalModelProvider({model,timeoutMs:120000});
  const results=[];const start=performance.now();
  for(const item of corpus.cases){
    const startedAt=new Date().toISOString(),t=performance.now();let row;
    try{
      const mission=await runLocalSummaryMission({item,provider:engine});
      const generated=mission.model;
      if(!generated)throw Object.assign(new Error('No validated model output'),{code:mission.modelFailure?.code??'LOCAL_MISSION_MODEL_OUTPUT_UNAVAILABLE',mission,attempts:mission.modelFailure?.attempts??[]});
      const evaluation=evaluateSummary(item,generated.output);
      row={id:item.id,split:item.split,startedAt,finishedAt:new Date().toISOString(),status:'executed',
        output:generated.output,evaluation:{...evaluation,passed:evaluation.passed&&mission.status==='COMPLETED'&&mission.outputMatchesIndependentOracle},latencyMs:mission.totalMs,
        usage:generated.usage,costUsd:null,costMeasurement:'unmeasured',providerCalls:generated.providerCalls,
        localModel:generated.localModel,model:generated.model,attempts:generated.attempts,
        semanticAccuracyVerified:false,mission};
    }catch(error){row={id:item.id,split:item.split,startedAt,finishedAt:new Date().toISOString(),status:'failed',
      errorCode:error.code??'LOCAL_EVALUATION_ERROR',attempts:error.attempts??[],mission:error.mission??null,
      providerCalls:error.mission?.modelFailure?.providerCalls??null,usage:error.mission?.modelFailure?.usage??null,
      latencyMs:performance.now()-t,costUsd:null,costMeasurement:'unmeasured',evaluation:{passed:false}};}
    results.push(row);await writeFile(join(root,item.id+'.json'),JSON.stringify(row,null,2)+'\n',{flag:'wx'});
    console.log(JSON.stringify({case:item.id,split:item.split,status:row.status,passed:row.evaluation.passed,latencyMs:Math.round(row.latencyMs)}));
  }
  const times=results.map(r=>r.latencyMs).sort((a,b)=>a-b),quantile=p=>times[Math.max(0,Math.ceil(times.length*p)-1)]??null;
  const report={version:'local-summary-quality-v2',observedAt:new Date().toISOString(),corpusSha256:hash(bytes),
    corpusPath:'tests/fixtures/local-summary-quality-v2.json',model,results,total:results.length,
    passed:results.filter(r=>r.evaluation.passed).length,failed:results.filter(r=>!r.evaluation.passed).length,
    requirementTotal:corpus.cases.reduce((n,c)=>n+Object.keys(c.questions).length,0),
    requirementsPreserved:results.flatMap(r=>r.evaluation.requirements??[]).filter(r=>r.factPreserved).length,
    p50Ms:quantile(.5),p95Ms:quantile(.95),totalMs:performance.now()-start,
    providerCalls:results.every(r=>Number.isSafeInteger(r.providerCalls)&&r.providerCalls>=0)?results.reduce((n,r)=>n+r.providerCalls,0):null,
    casesWithUnknownProviderCalls:results.filter(r=>!Number.isSafeInteger(r.providerCalls)||r.providerCalls<0).length,
    costUsd:null,costMeasurement:'unmeasured',externalPaidCalls:0,modelPulls:0,outboundMessages:0,
    arbitraryProseQualityVerified:false,originalAcceptancePromoted:false,
    splitLimitations:'Original holdout cases were exposed by baseline execution; this is a regression recheck, not a fresh blind holdout.'};
  await writeFile(join(root,'evaluation.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const root=process.argv[2];const report=await runLocalSummaryQuality({outputRoot:root});
  console.log(JSON.stringify({total:report.total,passed:report.passed,failed:report.failed,requirementsPreserved:report.requirementsPreserved,p50Ms:report.p50Ms,p95Ms:report.p95Ms}));
  if(report.failed)process.exitCode=1;
}
