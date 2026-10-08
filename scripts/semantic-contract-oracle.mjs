import {isDeepStrictEqual} from 'node:util';

// Additional independently annotated facts, never supplied to the tested engine.
// The dimension owns its path: a money check cannot stand in for authority.
const paths={
 amount:/^\/amounts(?:\/\d+(?:\/(?:text|currency|minorUnits|comparator|status|sourceSpan)(?:\/(?:start|end))?)?)?$/u,
 time:/^\/times(?:\/\d+(?:\/(?:kind|text|date|localTime|instant|offset|timeZone|status|durationMs|referenceTime|deadlineAt|resolutionIssue|sourceSpan)(?:\/(?:start|end))?)?)?$/u,
 quantity:/^\/quantities(?:\/\d+(?:\/(?:text|unit|baseUnit|baseUnits|comparator|range|distribution|status|sourceSpan)(?:\/(?:start|end|minBaseUnits|maxBaseUnits))?)?)?$/u,
 condition:/^\/requirements\/\d+\/interpretation\/unresolvedConditions(?:\/\d+(?:\/(?:text|status|sourceSpan)(?:\/(?:start|end))?)?)?$/u,
 dependency:/^\/requirements\/\d+\/dependsOn$/u,
 authority:/^\/executionAuthorized$/u,
 outcome:/^\/successCriteria(?:\/\d+(?:\/(?:statement|verificationSpec))?)?$/u
};
export const additionalSemanticDimensions=Object.freeze(Object.keys(paths));

function jsonValue(value,depth=0){
 if(depth>20)return false;
 if(value===null||typeof value==='string'||typeof value==='boolean')return true;
 if(typeof value==='number')return Number.isFinite(value);
 if(Array.isArray(value))return value.every(v=>jsonValue(v,depth+1));
 if(value&&Object.getPrototypeOf(value)===Object.prototype)return Object.entries(value)
  .every(([k,v])=>!['__proto__','constructor','prototype'].includes(k)&&jsonValue(v,depth+1));
 return false;
}
export function validateSemanticAssertions(item){
 if(item.semanticAssertions===undefined)return;
 if(!Array.isArray(item.semanticAssertions)||item.semanticAssertions.length>256)throw new Error('EVALUATION_SEMANTIC_ANNOTATION_INVALID');
 const ids=new Set();
 for(const a of item.semanticAssertions){
  const span=a?.sourceSpan;
  if(!a||typeof a.id!=='string'||!a.id||ids.has(a.id)||!Object.hasOwn(paths,a.dimension)||!paths[a.dimension].test(a.path)
   ||!['equals','absent'].includes(a.operator)||!span||!Number.isSafeInteger(span.start)||!Number.isSafeInteger(span.end)
   ||span.start<0||span.end<=span.start||span.end>item.command.length
   ||(a.operator==='equals'&&(!Object.hasOwn(a,'expected')||!jsonValue(a.expected)))
   ||(a.operator==='absent'&&Object.hasOwn(a,'expected')))
   throw new Error('EVALUATION_SEMANTIC_ANNOTATION_INVALID');
  ids.add(a.id);
 }
}
function lookup(contract,path){
 let value=contract;
 for(const key of path.slice(1).split('/')){
  if(value===null||typeof value!=='object'||!Object.hasOwn(value,key))return {present:false};
  value=value[key];
 }
 return {present:true,value};
}
export function evaluateSemanticAssertions(item,contract,{engineFailed=false}={}){
 return (item.semanticAssertions??[]).map(a=>{
  const observed=lookup(contract,a.path);
  return {id:a.id,dimension:a.dimension,path:a.path,sourceSpan:a.sourceSpan,operator:a.operator,
   ...(Object.hasOwn(a,'expected')?{expected:a.expected}:{}),observedPresent:observed.present,
   ...(observed.present?{observed:observed.value}:{}),
   passed:!engineFailed&&(a.operator==='absent'?!observed.present:observed.present&&isDeepStrictEqual(observed.value,a.expected))};
 });
}
