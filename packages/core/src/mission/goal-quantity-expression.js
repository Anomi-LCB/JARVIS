import {createHash} from 'node:crypto';
import {parseGoalScaledInteger} from './goal-money-expression.js';

// Exact micro-units keep decimal SI quantities out of floating-point arithmetic.
// These are source facts, not authorization, medical advice or proof of delivery.
const units={
 kg:['microgram',1000000000n],g:['microgram',1000000n],mg:['microgram',1000n],ug:['microgram',1n],'μg':['microgram',1n],
 킬로그램:['microgram',1000000000n],그램:['microgram',1000000n],밀리그램:['microgram',1000n],
 L:['microliter',1000000n],l:['microliter',1000000n],'ℓ':['microliter',1000000n],mL:['microliter',1000n],ml:['microliter',1000n],
 리터:['microliter',1000000n],밀리리터:['microliter',1000n],
 m:['micrometer',1000000n],cm:['micrometer',10000n],mm:['micrometer',1000n],km:['micrometer',1000000000n],
 미터:['micrometer',1000000n],센티미터:['micrometer',10000n],밀리미터:['micrometer',1000n],
 ...Object.fromEntries(['개','명','장','건','회','대','페이지','병','권','부','묶음','세트'].map(unit=>[unit,[unit,1n]])),
 인:['명',1n],쪽:['페이지',1n]
};
const words={한:'1',두:'2',세:'3',네:'4',다섯:'5',여섯:'6',일곱:'7',여덟:'8',아홉:'9',열:'10',하나:'1',둘:'2',셋:'3'};
const comparison={이하:'lte',미만:'lt',이상:'gte',초과:'gt'};
const unitPattern=Object.keys(units).sort((a,b)=>b.length-a.length).join('|');
// A list separator before masked quoted labels is not a number prefix. Keep
// internal malformed commas in a candidate so they still fail as a whole.
const numeric='[+\\-−0-9.eE/×*^%:조억만천백십][+\\-−0-9.,eE/×*^%:조억만천백십]*(?:\\s+[+\\-−0-9.,eE/×*^%:조억만천백십]+)*';
const number=`(?:${numeric}|${Object.keys(words).sort((a,b)=>b.length-a.length).join('|')})`;
// Consume each complete number candidate first. Including the unit in this
// regex would retry every suffix of long space-separated non-quantity input.
const pattern=new RegExp(`(?<![\\p{L}\\p{N}.,+\\-−/~～–×*^%:])(?:(최대|최소|정확히)\\s*)?(${number})(?:\\s*[~～–]\\s*(${number}(?:\\s*[~～–]\\s*${number})*))?`,'gu');
const suffixPattern=new RegExp(`^\\s*(${unitPattern})(?=$|\\s|[,.!?;:)]|이하|미만|이상|초과|씩|당|을|를|에|의|만|로|으로|과|와|분량)(?:\\s*(이하|미만|이상|초과))?(?:\\s*(씩|당))?`,'u');

export function extractGoalQuantities(source,masked){
 if(typeof source!=='string'||typeof masked!=='string'||source.length!==masked.length)throw new Error('A_GOAL_QUANTITY_SOURCE_INVALID');
 return [...masked.matchAll(pattern)].flatMap(match=>{
  const suffix=suffixPattern.exec(masked.slice(match.index+match[0].length));if(!suffix)return [];
  const [baseUnit,scale]=units[suffix[1]],start=match.index,end=start+match[0].length+suffix[0].length;
  const low=parseGoalScaledInteger(words[match[2]]??match[2],scale);
  const high=match[3]===undefined?null:parseGoalScaledInteger(words[match[3]]??match[3],scale);
  const prefix=({최대:'lte',최소:'gte',정확히:'eq'})[match[1]],postfix=comparison[suffix[2]];
  const comparator=match[3]!==undefined?'range':postfix??prefix??'eq';
  const valid=low!==null&&(match[3]===undefined||high!==null&&low<=high)
   &&(!prefix||!postfix||prefix===postfix)&&(!(match[3]!==undefined)||!prefix&&!postfix);
  const text=source.slice(start,end);
  return [{quantityId:`quantity_${createHash('sha256').update(JSON.stringify({start,end,text})).digest('hex').slice(0,24)}`,
   text,sourceSpan:{start,end},unit:suffix[1],baseUnit,baseUnits:valid&&match[3]===undefined?low:null,
   range:valid&&match[3]!==undefined?{minBaseUnits:low,maxBaseUnits:high}:null,comparator,
   distribution:suffix[3]==='씩'?'per-item':suffix[3]==='당'?'per-unit':null,status:valid?'parsed':'unresolved'}];
 });
}

/** Compare independently observed integer micro-units. This does not attest provenance. */
export function evaluateGoalQuantityConstraints(contract,measurements){
 const facts=contract?.quantities;
 if(!Array.isArray(facts)||!Array.isArray(measurements)||measurements.length>1000)throw new Error('A_GOAL_QUANTITY_MEASUREMENTS_INVALID');
 const byId=new Map();
 for(const item of measurements){
  if(!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).some(k=>!['quantityId','baseUnit','baseUnits'].includes(k))
   ||typeof item.quantityId!=='string'||typeof item.baseUnit!=='string'||!Number.isSafeInteger(item.baseUnits)||item.baseUnits<0
   ||byId.has(item.quantityId)||!facts.some(f=>f.quantityId===item.quantityId))throw new Error('A_GOAL_QUANTITY_MEASUREMENTS_INVALID');
  byId.set(item.quantityId,item);
 }
 const checks=facts.map(fact=>{
  const observed=byId.get(fact.quantityId);let reason=null,passed=false;
  if(fact.status!=='parsed')reason='source-quantity-unresolved';
  else if(fact.distribution)reason='quantity-distribution-binding-required';
  else if(!observed)reason='quantity-measurement-missing';
  else if(observed.baseUnit!==fact.baseUnit)reason='quantity-unit-mismatch';
  else{
   const value=BigInt(observed.baseUnits),expected=fact.baseUnits===null?null:BigInt(fact.baseUnits);
   passed=fact.comparator==='range'?value>=BigInt(fact.range.minBaseUnits)&&value<=BigInt(fact.range.maxBaseUnits)
    :fact.comparator==='eq'?value===expected:fact.comparator==='lte'?value<=expected:fact.comparator==='lt'?value<expected
     :fact.comparator==='gte'?value>=expected:fact.comparator==='gt'?value>expected:false;
   if(!passed)reason='quantity-condition-not-met';
  }
  return {quantityId:fact.quantityId,passed,reason};
 });
 return {applicable:facts.length>0,passed:facts.length?checks.every(c=>c.passed):null,checks,executionAuthorized:false,measurementProvenanceVerified:false};
}
