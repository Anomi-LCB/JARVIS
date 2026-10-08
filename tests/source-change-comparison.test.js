import test from 'node:test';
import assert from 'node:assert/strict';
import {compareSourceChange} from '../apps/pc-agent/src/adapters/workflow/change-comparison.js';
const record=(value,unit='초',claim=false)=>({facts:{value},evidence:{value:'합성 입력의 명시적 수치'},sourceSha256:'a'.repeat(64),fieldProvenance:{value:{basis:claim?'source-claim':'source-declaration',sourceLabel:'시험 값',unit,...(claim?{claimedBy:'시험 업체'}:{}),independentlyVerified:false}}});
const args=(before,after,claim,metric='decrease-percent',tolerancePercentPoints='0')=>({before:record(before),after:record(after),claim:record(claim,'%',true),metric,tolerancePercentPoints});
test('duration reduction and inverse throughput increase are distinct and exact',()=>{
 const reduction=compareSourceChange(args('100','80','20'));
 const throughput=compareSourceChange(args('100','80','20','inverse-increase-percent'));
 assert.equal(reduction.claimConsistentWithInputs,true);assert.equal(reduction.calculatedPercent.numerator,'20');
 assert.equal(throughput.claimConsistentWithInputs,false);assert.equal(throughput.calculatedPercent.numerator,'25');
 assert.equal(throughput.verdict,'자료 값보다 작은 주장');assert.equal(throughput.inputsIndependentlyVerified,false);
 assert.deepEqual(throughput.assumptions,['equal-workload']);assert.equal(throughput.equalWorkloadVerified,false);
});
test('inverse throughput rejects equal non-duration units instead of implying a speed measurement',()=>{
 const input=args('100','80','25','inverse-increase-percent');
 input.before.fieldProvenance.value.unit='kg';input.after.fieldProvenance.value.unit='kg';
 assert.throws(()=>compareSourceChange(input),{code:'WORKFLOW_CHANGE_DURATION_UNIT_REQUIRED'});
});
test('regression is reported as negative improvement instead of confirming a positive claim',()=>{
 const result=compareSourceChange(args('8','9','30'));
 assert.deepEqual(result.calculatedPercent,{numerator:'-25',denominator:'2',approximate:'-12.5'});
 assert.equal(result.claimDifferencePercentPoints.approximate,'42.5');assert.equal(result.claimConsistentWithInputs,false);
 assert.equal(result.verdict,'자료 값보다 큰 주장');assert.equal(result.executionAuthority,false);
});
test('decimal values and tolerance are compared as exact fractions',()=>{
 assert.equal(compareSourceChange(args('0.3','0.2','33','decrease-percent','0.333333')).claimConsistentWithInputs,false);
 assert.equal(compareSourceChange(args('0.3','0.2','33','decrease-percent','0.333334')).claimConsistentWithInputs,true);
 assert.equal(compareSourceChange(args('0.2','0.3','50','increase-percent')).claimConsistentWithInputs,true);
});
test('integers above Number precision and displayed rounding do not produce false agreement',()=>{
 const result=compareSourceChange(args('9007199254740993','9007199254740992','0'));
 assert.equal(result.calculatedPercent.approximate,'0');assert.notEqual(result.calculatedPercent.numerator,'0');
 assert.equal(result.claimConsistentWithInputs,false);
});
test('unit, basis, missing provenance, numeric ambiguity and nonpositive baselines fail closed',()=>{
 for(const mutate of [a=>a.after.fieldProvenance.value.unit='ms',a=>a.claim.fieldProvenance.value.unit='초',
  a=>a.before.fieldProvenance.value.basis='verified-fact',a=>a.before.fieldProvenance.value.independentlyVerified=true,
  a=>delete a.before.sourceSha256,a=>a.metric='improvement',a=>a.before.facts.value='0',a=>a.after.facts.value='-1',
  a=>a.before.facts.value=9007199254740993,a=>a.before.facts.value='1e3',a=>a.before.facts.value='12초',
  a=>a.tolerancePercentPoints='-1',a=>a.tolerancePercentPoints='101',a=>a.executionAuthority=true]){
  const input=args('100','80','20');mutate(input);assert.throws(()=>compareSourceChange(input));
 }
});
test('exact equality at the allowed percentage-point boundary is accepted',()=>{
 assert.equal(compareSourceChange(args('100','80','21','decrease-percent','1')).claimConsistentWithInputs,true);
 assert.equal(compareSourceChange(args('100','80','21.0000001','decrease-percent','1')).claimConsistentWithInputs,false);
});
test('a reduction to zero is valid while inverse throughput from zero duration is undefined',()=>{
 const reduction=compareSourceChange(args('8','0','100'));
 assert.equal(reduction.claimConsistentWithInputs,true);assert.equal(reduction.calculatedPercent.numerator,'100');
 assert.equal(compareSourceChange(args('8','0','-100','increase-percent')).claimConsistentWithInputs,true);
 assert.throws(()=>compareSourceChange(args('8','0','100','inverse-increase-percent')),{code:'WORKFLOW_CHANGE_ZERO_BASE'});
});
