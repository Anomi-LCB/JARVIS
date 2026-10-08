import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {indexMemorySources,memoryProvenance,preferenceSourcesMatch} from '../apps/growth-memory/src/memory-provenance.js';
import {assertComparisonOutputPath} from './recovery-comparison.mjs';

const sources=['scripts/memory-source-index-comparison.mjs','apps/growth-memory/src/memory-provenance.js','apps/growth-memory/src/growth-runtime.js'];
const hashes=()=>sources.map(path=>({path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex')}));
const p=(values,q)=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*q)-1];
export function compareMemorySourceIndex(){
 const before=hashes(),cases=[];
 const scope={userId:'synthetic-owner',workspaceRoot:resolve('synthetic-benchmark-only'),conversationId:'synthetic-session'};
 for(const [eventCount,preferenceCount] of [[100,25],[5000,250],[20000,1000]]){
  const events=Array.from({length:eventCount},(_,i)=>({eventId:`e${i}`,source:{memoryScope:scope},trustBoundary:{userProvided:true},createdAt:'2026-10-03T00:00:00.000Z',learningFlags:{doNotRemember:i%17===0}}));
  const preferences=Array.from({length:preferenceCount},(_,i)=>({preferenceId:`p${i}`,scopePolicy:{userScope:scope.userId,workspaceScope:scope.workspaceRoot,conversationScope:scope.conversationId},
   evidenceEventIds:[i%19===0?'missing':`e${eventCount-1-i}`]}));
  const expected=preferences.map((_,i)=>i%19!==0&&(eventCount-1-i)%17!==0);
  const runs=[];
  for(let repetition=1;repetition<=5;repetition++)for(const indexed of repetition%2?[false,true]:[true,false]){
   const start=performance.now(),snapshot=indexed?indexMemorySources(events):events;
   const observed=preferences.map(pref=>({allowed:preferenceSourcesMatch(pref,snapshot,scope),provenance:memoryProvenance(pref,snapshot)}));
   const durationMs=performance.now()-start;
   const passed=observed.every((item,i)=>item.allowed===expected[i]&&item.provenance.executionAuthority===false
    &&item.provenance.missingSourceCount===(i%19===0?1:0));
   runs.push({repetition,indexed,durationMs,passed,resultSha256:createHash('sha256').update(JSON.stringify(observed)).digest('hex')});
  }
  const summaries=[false,true].map(indexed=>{const durations=runs.filter(r=>r.indexed===indexed).map(r=>r.durationMs);return {indexed,p50Ms:p(durations,.5),p95Ms:p(durations,.95)};});
  cases.push({eventCount,preferenceCount,runs,summaries,outputEqual:new Set(runs.map(r=>r.resultSha256)).size===1});
 }
 const stable=JSON.stringify(before)===JSON.stringify(hashes());
 return {observedAt:new Date().toISOString(),mode:'isolated-source-lookup-component-comparison',sourceFiles:before,sourcesUnchanged:stable,cases,
  passed:stable&&cases.every(c=>c.outputEqual&&c.runs.every(r=>r.passed)),cost:{status:'unmeasured',amount:null},
  limits:['Index construction included;no persistent cache.','Compares actual legacy array lookup with indexed lookup using identical snapshots.','Synthetic source lookup only;not whole request p95 or generated content quality.','No external model or production memory used;no claim of universal semantic accuracy.']};
}
if(import.meta.url===pathToFileURL(resolve(process.argv[1]??'')).href){
 const output=process.argv[2];if(!output)throw new Error('OUTPUT_REQUIRED');
 assertComparisonOutputPath(output,{suitePath:resolve(sources[0]),sourcePaths:sources.map(p=>resolve(p))});
 const report=compareMemorySourceIndex();writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({passed:report.passed,cases:report.cases.map(({eventCount,preferenceCount,summaries})=>({eventCount,preferenceCount,summaries}))}));if(!report.passed)process.exitCode=1;
}
