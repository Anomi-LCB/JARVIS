const fail=code=>{throw Object.assign(new Error(code),{code});};
const gcd=(a,b)=>{a=a<0n?-a:a;while(b){const r=a%b;a=b;b=r;}return a;};
function fraction(n,d){if(d===0n)fail('WORKFLOW_CHANGE_ZERO_BASE');if(d<0n){n=-n;d=-d;}const g=gcd(n,d);return {n:n/g,d:d/g};}
function decimal(value){
 if(typeof value!=='string'||value.length>100||! /^-?(?:0|[1-9][0-9]{0,79})(?:\.[0-9]{1,18})?$/u.test(value))fail('WORKFLOW_CHANGE_NUMBER_INVALID');
 const [whole,part='']=value.split('.');return fraction(BigInt(whole+part),10n**BigInt(part.length));
}
const subtract=(a,b)=>fraction(a.n*b.d-b.n*a.d,a.d*b.d);
const divide=(a,b)=>fraction(a.n*b.d,a.d*b.n);
const times100=a=>fraction(a.n*100n,a.d);
const absolute=a=>({n:a.n<0n?-a.n:a.n,d:a.d});
const label=(value,max)=>typeof value==='string'&&!!value.trim()&&value.length<=max&&!/[\u0000-\u001f\u007f]/u.test(value);
function display(a){const sign=a.n<0n?'-':'',n=a.n<0n?-a.n:a.n,scale=1000000n;
 const rounded=(n*scale*2n+a.d)/(a.d*2n),whole=rounded/scale,part=(rounded%scale).toString().padStart(6,'0').replace(/0+$/u,'');
 return (rounded===0n?'':sign)+whole.toString()+(part?'.'+part:'');}
function operand(record,claim=false){
 const binding=record?.fieldProvenance?.value,value=record?.facts?.value,quote=record?.evidence?.value;
 if(!binding||binding.basis!==(claim?'source-claim':'source-declaration')||binding.independentlyVerified!==false
  ||!label(binding.unit,12)||!label(binding.sourceLabel,80)||(claim&&!label(binding.claimedBy,80))
  ||typeof quote!=='string'||!quote||quote.length>400||!/^[a-f0-9]{64}$/u.test(record.sourceSha256??''))fail('WORKFLOW_CHANGE_PROVENANCE_REQUIRED');
 if(claim&&binding.unit!=='%')fail('WORKFLOW_CHANGE_UNIT_MISMATCH');
 return {value,number:decimal(value),unit:binding.unit,evidence:quote,sourceSha256:record.sourceSha256,sourceLabel:binding.sourceLabel,
  ...(claim?{claimedBy:binding.claimedBy}:{}),basis:binding.basis,independentlyVerified:false};
}
/** Exact arithmetic consistency of supplied source records; never source truth. */
export function compareSourceChange(args){
 if(!args||Object.keys(args).some(k=>!['before','after','claim','metric','tolerancePercentPoints'].includes(k)))fail('WORKFLOW_CHANGE_INPUT_INVALID');
 const before=operand(args.before),after=operand(args.after),claim=operand(args.claim,true);
 if(before.unit!==after.unit)fail('WORKFLOW_CHANGE_UNIT_MISMATCH');
 if(before.number.n<=0n||after.number.n<0n)fail('WORKFLOW_CHANGE_POSITIVE_VALUES_REQUIRED');
 const tolerance=decimal(args.tolerancePercentPoints??'0');
 if(tolerance.n<0n||tolerance.n>100n*tolerance.d)fail('WORKFLOW_CHANGE_TOLERANCE_INVALID');
 let actual;
 if(args.metric==='increase-percent')actual=times100(divide(subtract(after.number,before.number),before.number));
 else if(args.metric==='decrease-percent')actual=times100(divide(subtract(before.number,after.number),before.number));
 else if(args.metric==='inverse-increase-percent'){
  if(!['초','분','시간','밀리초','ms','s','sec','min','h','second','seconds'].includes(before.unit))fail('WORKFLOW_CHANGE_DURATION_UNIT_REQUIRED');
  if(after.number.n===0n)fail('WORKFLOW_CHANGE_ZERO_BASE');
  actual=times100(divide(subtract(before.number,after.number),after.number));
 }
 else fail('WORKFLOW_CHANGE_METRIC_REQUIRED');
 const difference=subtract(claim.number,actual),error=absolute(difference);
 const consistent=error.n*tolerance.d<=tolerance.n*error.d;
 const publicOperand=({number,...data})=>data;
 return {schemaVersion:'source-change-comparison-v1',metric:args.metric,unit:before.unit,
  inputs:{before:publicOperand(before),after:publicOperand(after),claim:publicOperand(claim)},
  calculatedPercent:{numerator:actual.n.toString(),denominator:actual.d.toString(),approximate:display(actual)},
  claimDifferencePercentPoints:{numerator:difference.n.toString(),denominator:difference.d.toString(),approximate:display(difference)},
  tolerancePercentPoints:args.tolerancePercentPoints??'0',claimConsistentWithInputs:consistent,
  verdict:consistent?'자료 값과 일치':difference.n>0n?'자료 값보다 큰 주장':'자료 값보다 작은 주장',
  verificationScope:'supplied-source-values-arithmetic-only',
  ...(args.metric==='inverse-increase-percent'?{assumptions:['equal-workload'],equalWorkloadVerified:false}:{}),
  inputsIndependentlyVerified:false,executionAuthority:false};
}
