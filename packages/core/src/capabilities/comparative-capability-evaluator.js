import {createHash} from 'node:crypto';
const hash=value=>createHash('sha256').update(value).digest('hex');
const fail=code=>{throw Object.assign(new Error(code),{code});};
const quantile=(values,q)=>[...values].sort((a,b)=>a-b)[Math.max(0,Math.ceil(values.length*q)-1)];
const canonical=v=>Array.isArray(v)?`[${v.map(canonical).join(',')}]`:v&&typeof v==='object'?`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`:JSON.stringify(v);
function compareRun(before,after,reference){
 const contract=JSON.stringify({suiteSha256:before.receipt.suiteSha256,resultContract:before.receipt.resultContract??null,requirementHash:before.receipt.requirementContractSha256??null,
  cases:before.receipt.caseResults.map(c=>({id:c.id,expectedSha256:c.expectedSha256}))});
 const candidateContract=JSON.stringify({suiteSha256:after.receipt.suiteSha256,resultContract:after.receipt.resultContract??null,requirementHash:after.receipt.requirementContractSha256??null,
  cases:after.receipt.caseResults.map(c=>({id:c.id,expectedSha256:c.expectedSha256}))});
 if((reference!==null&&reference!==contract)||candidateContract!==contract)fail('A_COMPARISON_ORACLE_CHANGED');
 const previous=new Map(before.receipt.caseResults.map(c=>[c.id,c]));
 return{reference:contract,run:{baseline:before,candidate:after,
  gainedCaseIds:after.receipt.caseResults.filter(c=>c.passed===true&&previous.get(c.id)?.passed!==true).map(c=>c.id),
  regressedCaseIds:after.receipt.caseResults.filter(c=>previous.get(c.id)?.passed===true&&c.passed!==true).map(c=>c.id)}};
}
function statistics(runs,side){
 const receipts=runs.map(r=>r[side].receipt),times=receipts.map(r=>r.evaluationTiming.elapsedMs),costs=receipts.map(r=>r.costObservation?.currency==='KRW'?r.costObservation.amountMinor:null);
 const totalCost=costs.every(c=>Number.isSafeInteger(c)&&c>=0)?costs.reduce((a,b)=>a+b,0):null;
 return{runs:receipts.length,failedRuns:runs.filter(r=>r[side].status==='failed').length,p50Ms:quantile(times,.5),p95Ms:quantile(times,.95),
  observedCostMinor:Number.isSafeInteger(totalCost)?totalCost:null,costCurrency:Number.isSafeInteger(totalCost)?'KRW':null,evaluationCalls:receipts.length};
}
function aggregate(input,baseline,runs,lastCandidate,repeats,minimumAdditionalPasses,totalElapsedMs,acceptanceBounds){
 const qualityImproved=runs.every(r=>r.candidate.status==='passed'&&r.regressedCaseIds.length===0&&r.gainedCaseIds.length>=minimumAdditionalPasses);
 const candidateStats=statistics(runs,'candidate'),reasons=[];
 if(Object.hasOwn(acceptanceBounds,'maxP95Ms')&&candidateStats.p95Ms>acceptanceBounds.maxP95Ms)reasons.push('candidate-latency-bound-exceeded');
 if(Object.hasOwn(acceptanceBounds,'maxObservedCostMinor')){
  if(candidateStats.observedCostMinor===null)reasons.push('candidate-cost-unmeasured');
  else if(candidateStats.observedCostMinor>acceptanceBounds.maxObservedCostMinor)reasons.push('candidate-cost-bound-exceeded');
 }
 const improved=qualityImproved&&reasons.length===0;
 const comparison={schemaVersion:'a-capability-comparison-v1',activePackageDigest:baseline.packageDigest,baselineArtifactSha256:baseline.artifactSha256,
  candidateArtifactSha256:input.artifactSha256,repeats,minimumAdditionalPasses,improved,baseline:statistics(runs,'baseline'),candidate:statistics(runs,'candidate'),
  totalElapsedMs,runs,executionAuthority:false,limitations:['Fixed host oracle comparison; not general semantic quality or competition ranking.'],
  ...(Object.keys(acceptanceBounds).length?{acceptanceBounds,qualityImproved,acceptance:{passed:reasons.length===0,reasons,
   scope:'candidate repeated isolated-evaluation time and total observed KRW cost; not deployed-agent latency or cost'}}:{})};
 const receipt={...lastCandidate.receipt,status:improved?'passed':'failed',comparison};
 return{...lastCandidate,status:improved?'passed':'failed',receipt,evidenceRef:`sha256:${hash(JSON.stringify(receipt))}`};
}
function measurement(result,expected){
 const receipt=result?.receipt;
 if(result?.actualIsolatedExecution!==true||receipt?.isolationEnforced!==true||!['passed','failed'].includes(result.status)
  ||result.packageDigest!==expected.packageDigest||result.artifactSha256!==expected.artifactSha256
  ||receipt.packageDigest!==expected.packageDigest||receipt.artifactSha256!==expected.artifactSha256
  ||!Array.isArray(receipt.caseResults)||!receipt.caseResults.length||!Number.isFinite(receipt.evaluationTiming?.elapsedMs)||receipt.evaluationTiming.elapsedMs<0)fail('A_COMPARISON_OBSERVATION_INVALID');
 const ids=new Set();
 if(!/^[a-f0-9]{64}$/.test(receipt.suiteSha256??'')||receipt.caseResults.length>100||receipt.caseResults.some(c=>{
  if(typeof c.id!=='string'||!c.id||ids.has(c.id)||typeof c.passed!=='boolean'||!/^[a-f0-9]{64}$/.test(c.expectedSha256??''))return true;ids.add(c.id);return false;
 })||(result.status==='passed')!==receipt.caseResults.every(c=>c.passed))fail('A_COMPARISON_OBSERVATION_INVALID');
 return {status:result.status,evidenceRef:result.evidenceRef,receipt};
}
export function normalizeComparisonAcceptanceBounds(acceptanceBounds={}){
 if(!acceptanceBounds||typeof acceptanceBounds!=='object'||Array.isArray(acceptanceBounds)
  ||Object.keys(acceptanceBounds).some(k=>!['maxP95Ms','maxObservedCostMinor'].includes(k))
  ||Object.hasOwn(acceptanceBounds,'maxP95Ms')&&(!Number.isFinite(acceptanceBounds.maxP95Ms)||acceptanceBounds.maxP95Ms<0)
  ||Object.hasOwn(acceptanceBounds,'maxObservedCostMinor')&&(!Number.isSafeInteger(acceptanceBounds.maxObservedCostMinor)||acceptanceBounds.maxObservedCostMinor<0))fail('A_COMPARISON_BOUNDS_INVALID');
 return Object.freeze(Object.fromEntries(['maxP95Ms','maxObservedCostMinor'].filter(k=>Object.hasOwn(acceptanceBounds,k)).map(k=>[k,acceptanceBounds[k]])));
}
/** Same host oracle and active source, independently executed. Never changes permissions or activates a candidate. */
export function createComparativeCapabilityEvaluator({evaluateInIsolation,registry,repeats=3,minimumAdditionalPasses=1,acceptanceBounds={}}){
 if(typeof evaluateInIsolation!=='function'||!registry?.activations||!registry?.packages||!Number.isSafeInteger(repeats)||repeats<3||repeats>10
  ||!Number.isSafeInteger(minimumAdditionalPasses)||minimumAdditionalPasses<1)fail('A_COMPARISON_CONFIG_INVALID');
 acceptanceBounds=normalizeComparisonAcceptanceBounds(acceptanceBounds);
 const comparisonPolicy=Object.freeze({repeats,minimumAdditionalPasses,...(Object.keys(acceptanceBounds).length?{acceptanceBounds}:{})});
 const context=rawInput=>{
  const input=structuredClone(rawInput);
  if(typeof input.stageId!=='string'||!/^[a-zA-Z0-9_.-]{1,80}$/.test(input.stageId))fail('A_COMPARISON_STAGE_INVALID');
  const active=registry.activations.get(input.toolName),definition=active&&registry.packages.get(active.packageId)?._definition;
  if(!active||typeof definition?.artifactSource!=='string'||hash(definition.artifactSource)!==definition.artifactSha256)fail('A_COMPARISON_ACTIVE_SOURCE_UNAVAILABLE');
  const activeDigest=active.packageDigest;
  const baseline={toolName:input.toolName,packageDigest:activeDigest,artifactSource:definition.artifactSource,artifactSha256:definition.artifactSha256,
   manifest:{packageId:definition.packageId,version:definition.version}};
  const assertActive=()=>{
   const current=registry.packages.get(active.packageId)?._definition;
   if(registry.activations.get(input.toolName)?.packageDigest!==activeDigest||current?.artifactSource!==baseline.artifactSource||current?.artifactSha256!==baseline.artifactSha256)fail('A_COMPARISON_ACTIVE_VERSION_CHANGED');
  };
  return{input,baseline,assertActive};
 };
 const evaluate=async rawInput=>{
  const {input,baseline,assertActive}=context(rawInput),startedAt=performance.now();
  const runs=[];let reference=null,lastCandidate;
  for(let i=0;i<repeats;i++){
   assertActive();
   // Alternate order to reduce a consistent warm-up advantage.
   let before,after;
   const runBaseline=async()=>{assertActive();const result=measurement(await evaluateInIsolation({...baseline,stageId:`${input.stageId}-b${i}`}),baseline);assertActive();return result;};
   const runCandidate=async()=>{assertActive();lastCandidate=await evaluateInIsolation({...input,stageId:`${input.stageId}-c${i}`});assertActive();return measurement(lastCandidate,input);};
   if(i%2){after=await runCandidate();before=await runBaseline();}else{before=await runBaseline();after=await runCandidate();}
   assertActive();
   const compared=compareRun(before,after,reference);reference=compared.reference;runs.push(compared.run);
  }
  const result=aggregate(input,baseline,runs,lastCandidate,repeats,minimumAdditionalPasses,performance.now()-startedAt,acceptanceBounds);
  evaluateInIsolation.recordComparison?.(input,comparisonPolicy,result);assertActive();return result;
 };
 if(typeof evaluateInIsolation.restoreCompleted==='function'&&typeof evaluateInIsolation.readComparison==='function')Object.defineProperty(evaluate,'restoreCompleted',{value:rawInput=>{
  const {input,baseline,assertActive}=context(rawInput),saved=evaluateInIsolation.readComparison(input,comparisonPolicy);
  const stored=saved.result,comparison=stored?.receipt?.comparison;
  if(!comparison||!Number.isFinite(comparison.totalElapsedMs)||comparison.totalElapsedMs<0||comparison.runs?.length!==repeats)fail('A_COMPARISON_RECEIPT_INVALID');
  const runs=[];let reference=null,lastCandidate;
  for(let i=0;i<repeats;i++){
   assertActive();
   const before=measurement(evaluateInIsolation.restoreCompleted({...baseline,stageId:`${input.stageId}-b${i}`}),baseline);
   lastCandidate=evaluateInIsolation.restoreCompleted({...input,stageId:`${input.stageId}-c${i}`});
   const after=measurement(lastCandidate,input),compared=compareRun(before,after,reference);reference=compared.reference;runs.push(compared.run);
   if(canonical(compared.run)!==canonical(comparison.runs[i]))fail('A_COMPARISON_RECEIPT_INVALID');
  }
  assertActive();const result=aggregate(input,baseline,runs,lastCandidate,repeats,minimumAdditionalPasses,comparison.totalElapsedMs,acceptanceBounds);
  if(stored.status!==result.status||stored.actualIsolatedExecution!==true||stored.packageDigest!==input.packageDigest||stored.artifactSha256!==input.artifactSha256
    ||stored.evidenceRef!==result.evidenceRef||canonical(stored.receipt)!==canonical(result.receipt))fail('A_COMPARISON_RECEIPT_INVALID');
  return{...result,evaluationReplay:{executedNow:false,meaning:'historical-isolated-comparison',recordedAt:saved.recordedAt}};
 }});
 for(const name of ['budgetStatus','persistentBudgetStatus'])if(typeof evaluateInIsolation[name]==='function')Object.defineProperty(evaluate,name,{value:()=>evaluateInIsolation[name]()});
 if(typeof evaluateInIsolation.improvementPolicy==='function')Object.defineProperty(evaluate,'improvementPolicy',{value:()=>{
  const policy=evaluateInIsolation.improvementPolicy();return policy?{...policy,comparison:comparisonPolicy}:null;
 }});
 if(typeof evaluateInIsolation.prepareImprovement==='function'){
  Object.defineProperty(evaluate,'prepareImprovement',{value:id=>evaluateInIsolation.prepareImprovement(id)});
  Object.defineProperty(evaluate,'attachImprovementPreparation',{value:(stageId,ticket)=>evaluateInIsolation.attachImprovementPreparation(`${stageId}-c0`,ticket)});
  Object.defineProperty(evaluate,'abandonImprovementPreparation',{value:ticket=>evaluateInIsolation.abandonImprovementPreparation(ticket)});
 }
 return evaluate;
}
