import {createGoalContract} from '../packages/core/src/mission/goal-contract.js';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {validateSemanticAssertions,evaluateSemanticAssertions,additionalSemanticDimensions} from './semantic-contract-oracle.mjs';

const actions=new Set(['read','list','save','send','delete','change','summarize','unsupported']);
const trimmed=text=>text.trim().replace(/[.!。！？]+$/u,'').trim();
export function validateSemanticGoldReview(corpus, review) {
 const modelAuthored=corpus?.version?.startsWith('separate-model-semantic-holdout-')
  ||corpus?.authoring?.kind==='model';
 if(!modelAuthored)return;
 const digest=createHash('sha256').update(JSON.stringify(corpus)).digest('hex');
 if(!review||review.version!=='semantic-gold-review-v1'||review.corpusDigest!==digest
  ||review.status!=='approved'||typeof review.reviewer!=='string'||!review.reviewer.trim()
  ||!['human-review','separate-model-review'].includes(review.method)
  ||!Number.isFinite(Date.parse(review.observedAt))||!Array.isArray(review.cases)
  ||review.cases.length!==corpus.cases?.length)throw new Error('EVALUATION_GOLD_REVIEW_REQUIRED');
 const ids=new Set();
 for(const row of review.cases){
  if(!row||ids.has(row.id)||row.status!=='approved'||typeof row.rationale!=='string'||!row.rationale.trim()
   ||!corpus.cases.some(c=>c.id===row.id))throw new Error('EVALUATION_GOLD_REVIEW_REQUIRED');
  ids.add(row.id);
 }
 // This validates an explicit review record, not reviewer expertise or independence.
 // A caller's assertion alone never upgrades the result to an expert evaluation.
}
function validateEngineContract(contract){
 if(!contract||typeof contract!=='object'||!Array.isArray(contract.requirements)
  ||!contract.requirements.every(r=>r&&typeof r==='object'&&typeof r.text==='string'
   &&r.interpretation&&typeof r.interpretation==='object'&&!Array.isArray(r.interpretation))){
  throw new Error('EVALUATION_ENGINE_CONTRACT_INVALID');
 }
}
export function evaluateSemanticCorpus(corpus,{engine=createGoalContract,goldReview}={}){
 if(!Array.isArray(corpus?.cases)||!corpus.cases.length)throw new Error('EVALUATION_CASES_REQUIRED');
 validateSemanticGoldReview(corpus,goldReview);
 const ids=new Set(),rows=[];
 for(const item of corpus.cases){
  if(typeof item.id!=='string'||ids.has(item.id)||typeof item.command!=='string'||!Array.isArray(item.requirements)||!item.requirements.length)throw new Error('EVALUATION_CASE_INVALID');ids.add(item.id);
  validateSemanticAssertions(item);
  let previousEnd=0;
  for(const r of item.requirements){
   const span=r.sourceSpan;
   if(!span||!Number.isSafeInteger(span.start)||!Number.isSafeInteger(span.end)||span.start<previousEnd||span.end<=span.start||span.end>item.command.length
    ||item.command.slice(span.start,span.end)!==r.text||!actions.has(r.action)||typeof r.target!=='string'||!['required','prohibited'].includes(r.polarity))throw new Error('EVALUATION_ANNOTATION_INVALID');
   previousEnd=span.end;
  }
  const start=performance.now();let contract,error;
  // Only the command goes to the tested engine. No gold labels or author context.
  try{
   contract=engine({objective:item.command,referenceTime:'2026-10-07T00:00:00Z',timeZone:'Asia/Seoul'});
   validateEngineContract(contract);
  }catch(e){error=e?.code??e?.message??'EVALUATION_ENGINE_FAILED';contract=undefined;}
  const consumed=new Set(),requirements=item.requirements.map(gold=>{
   const index=contract?.requirements.findIndex((r,i)=>!consumed.has(i)&&trimmed(r.text)===trimmed(gold.text));
   const actual=index>=0?contract.requirements[index]:null;if(actual)consumed.add(index);
   const observed=actual?.interpretation;
   const atomicMatched=!!actual,polarityMatched=observed?.polarity===gold.polarity;
   const actionMatched=gold.action==='unsupported'?observed?.status==='unresolved'&&observed.action===null:observed?.action===gold.action;
   const interpretationMatched=gold.action==='unsupported'?observed?.status==='unresolved':observed?.status==='recognized';
   const targetMatched=gold.target===''?observed?.target===null:observed?.target===gold.target;
   return {gold,actual:actual??null,atomicMatched,actionMatched,targetMatched,polarityMatched,interpretationMatched,
    preserved:atomicMatched&&actionMatched&&targetMatched&&polarityMatched&&interpretationMatched};
  });
  const semanticAssertions=evaluateSemanticAssertions(item,contract,{engineFailed:error!==undefined});
  rows.push({id:item.id,domain:item.domain,command:item.command,error:error??null,elapsedMs:performance.now()-start,
   requirements,semanticAssertions,extraRequirements:(contract?.requirements??[]).filter((_,i)=>!consumed.has(i)),productExecuted:false,executionAuthorized:false});
 }
 const total=rows.reduce((n,r)=>n+r.requirements.length,0),preserved=rows.reduce((n,r)=>n+r.requirements.filter(x=>x.preserved).length,0);
 const extraRequirements=rows.reduce((n,r)=>n+r.extraRequirements.length,0);
 const emittedRequirements=rows.reduce((n,r)=>n+r.requirements.filter(x=>x.actual!==null).length+r.extraRequirements.length,0);
 const fullyPreservedCases=rows.filter(r=>!r.error&&r.extraRequirements.length===0&&r.requirements.every(x=>x.preserved)&&r.semanticAssertions.every(a=>a.passed)).length;
 const assertionResults=rows.flatMap(r=>r.semanticAssertions);
 const additionalSemantics=additionalSemanticDimensions.map(dimension=>{
  const entries=assertionResults.filter(a=>a.dimension===dimension);
  return {dimension,assertions:entries.length,passed:entries.filter(a=>a.passed).length,
   measuredCases:rows.filter(r=>r.semanticAssertions.some(a=>a.dimension===dimension)).length,
   unmeasuredCases:rows.filter(r=>!r.semanticAssertions.some(a=>a.dimension===dimension)).length};
 });
 return {version:'strict-semantic-requirement-evaluation-v3',observedAt:new Date().toISOString(),cases:rows.length,requirements:total,preserved,
  preservationRate:preserved/total,extraRequirements,emittedRequirements,requirementPrecision:emittedRequirements?preserved/emittedRequirements:0,
  fullyPreservedCases,strictCasePassRate:fullyPreservedCases/rows.length,fullSemanticCriteriaMet:false,
  evaluatedDimensions:['atomic-source','action','target','polarity','interpretation-status'],
  additionalSemantics,semanticAssertionCount:assertionResults.length,semanticAssertionsPassed:assertionResults.filter(a=>a.passed).length,
  unevaluatedDimensions:additionalSemantics.filter(d=>d.unmeasuredCases>0).map(d=>d.dimension),
  parseFailures:rows.filter(r=>r.error).length,rows,productExecuted:false,externalCalls:0,actualCost:null,
  limitations:['Atomic semantics and explicit additional annotations only; full V3-024 criteria are not established','Additional assertion coverage counts are not proof of complete or correct gold annotations','Preservation rate is atomic recall; extras and additional assertion failures must also be assessed','No live tool execution or user completion measurement','Unresolved commands are not automatically scored as semantically correct','Separate-model annotations are not human expert ground truth','Source text preservation alone is not semantic preservation','Elapsed time measures contract interpretation only']};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const [corpusPath,freezePath,output,reviewPath]=process.argv.slice(2);if(!corpusPath||!freezePath||!output)throw new Error('corpus freeze output [review] required');
 const bytes=readFileSync(corpusPath),freeze=JSON.parse(readFileSync(freezePath,'utf8'));
 const sha256=createHash('sha256').update(bytes).digest('hex');if(sha256!==freeze.sha256||freeze.beforeProductEvaluation!==true)throw new Error('FROZEN_CORPUS_REQUIRED');
 const goldReview=reviewPath?JSON.parse(readFileSync(reviewPath,'utf8')):undefined;
 const report={...evaluateSemanticCorpus(JSON.parse(bytes),{goldReview}),corpusSha256:sha256,humanExpertReview:false,
  goldReviewRecord:goldReview?{method:goldReview.method,reviewer:goldReview.reviewer,observedAt:goldReview.observedAt,recordVerified:true,expertiseVerified:false,independenceVerified:false}:null};
 writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({cases:report.cases,requirements:report.requirements,preserved:report.preserved,preservationRate:report.preservationRate,requirementPrecision:report.requirementPrecision,extraRequirements:report.extraRequirements,fullyPreservedCases:report.fullyPreservedCases,strictCasePassRate:report.strictCasePassRate,fullSemanticCriteriaMet:report.fullSemanticCriteriaMet,output}));
}
