import test from 'node:test';
import assert from 'node:assert/strict';
import {generateLocalSourceSummary} from '../packages/core/src/mission/local-source-summary.js';
const input={source:'견적 금액은 450000원이다. 실제 지출액은 0원이다. 승인 여부: 미승인. 공급 업체는 다음 주를 예상하지만 확정일은 제시하지 않았다.',
 questions:{paid:'실제 지출액 숫자만',approval:'승인 여부',delivery:'확정일'},valueFormats:{paid:'digits',approval:'source-phrase',delivery:'iso-date-or-unknown'},
 sourceFields:{paid:{label:'실제 지출액',kind:'integer',unit:'원'},approval:{label:'승인 여부',kind:'enum',choices:['승인','미승인','미정']},delivery:{label:'확정일',kind:'unknown-date'}}};
test('explicit typed fields preserve actual zero rather than an unpaid quote with no model call',async()=>{
 const result=await generateLocalSourceSummary(input,{provider:{generateStructured(){throw new Error('Model must not be called');}}});
 assert.deepEqual(result.output.facts,{paid:'0',approval:'미승인',delivery:'미정'});
 assert.equal(result.providerCalls,0);assert.equal(result.provider,'deterministic-source-fields');assert.equal(result.semanticAccuracyVerified,false);
 assert.ok(result.output.evidence.paid.includes('실제 지출액은 0원'));assert.equal(input.source.includes(result.output.evidence.delivery),true);
});
test('conflicting corrections and unsupported value under the same label cannot choose an old match',async()=>{
 for(const suffix of [' 실제 지출액은 5원이다.',' 실제 지출액은 미정이다.',' 확정일은 2026-10-08이다.']){
  await assert.rejects(generateLocalSourceSummary({...input,source:input.source+suffix},{}),{code:'A_SOURCE_FIELDS_AMBIGUOUS'});
 }
});
test('negated, quoted, wrong unit, absent and mismatched explicit contracts reject rather than infer',async()=>{
 for(const source of [input.source.replace('실제 지출액은 0원이다.','실제 지출액은 0원이 아니다.'),input.source.replace('실제 지출액은 0원이다.','실제 지출액은 0만원이다.'),input.source.replace('실제 지출액은 0원이다.',"'실제 지출액은 0원이다.'"),input.source.replace('실제 지출액은 0원이다.','')]){
  await assert.rejects(generateLocalSourceSummary({...input,source},{}),{code:'A_SOURCE_FIELDS_NOT_EXPLICIT'});
 }
 await assert.rejects(generateLocalSourceSummary({...input,valueFormats:{...input.valueFormats,paid:'source-phrase'}},{}),{code:'A_SOURCE_FIELDS_FORMAT_MISMATCH'});
 await assert.rejects(generateLocalSourceSummary({...input,sourceFields:{paid:input.sourceFields.paid}},{}),{code:'A_SOURCE_FIELDS_INCOMPLETE'});
});
test('spaced quotation and conditional statements cannot supply asserted facts',async()=>{
 for(const replacement of ["' 실제 지출액은 0원이다. '",'만약 실제 지출액은 0원이다.','업체는 실제 지출액은 0원이다.']){
  await assert.rejects(generateLocalSourceSummary({...input,source:input.source.replace('실제 지출액은 0원이다.',replacement)},{}),{code:'A_SOURCE_FIELDS_NOT_EXPLICIT'});
 }
});
test('many quoted examples cannot override the one asserted field',async()=>{
 const source=("' 실제 지출액은 999원이다. '\n").repeat(600)+'실제 지출액은 0원이다.';
 const result=await generateLocalSourceSummary({source,questions:{value:'실제 지출액'},valueFormats:{value:'digits'},sourceFields:{value:{label:'실제 지출액',kind:'integer',unit:'원'}}},{});
 assert.equal(result.output.facts.value,'0');assert.equal(result.output.evidence.value,'실제 지출액은 0원이다');
});

test('structured newline fields preserve values while wrapped negation and duplicates fail',async()=>{
 for(const newline of ['\n','\r\n']){
  const source=['실제 지출액: 0원','승인 여부: 미승인','확정일: 미정',''].join(newline);
  assert.deepEqual((await generateLocalSourceSummary({...input,source},{})).output.facts,{paid:'0',approval:'미승인',delivery:'미정'});
  await assert.rejects(generateLocalSourceSummary({...input,source:source+'실제 지출액: 99원'},{}),{code:'A_SOURCE_FIELDS_AMBIGUOUS'});
 }
 for(const source of ['실제 지출액: 0원\n이 아니다.\n승인 여부: 미승인.\n확정일: 미정.',
  '실제 지출액: 0원이 아니다\n승인 여부: 미승인\n확정일: 미정',
  '실제 지출액: 0만원\n승인 여부: 미승인\n확정일: 미정'])await assert.rejects(generateLocalSourceSummary({...input,source},{}),{code:'A_SOURCE_FIELDS_NOT_EXPLICIT'});
});
