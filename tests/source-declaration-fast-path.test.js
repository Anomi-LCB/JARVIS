import assert from 'node:assert/strict';
import test from 'node:test';
import {generateLocalSourceSummary} from '../packages/core/src/mission/local-source-summary.js';
import {LocalWorkflowToolAdapter} from '../apps/pc-agent/src/adapters/workflow/local-workflow-adapter.js';
const cases=[
 ['실제 지출액 숫자만','실제 지출액은 37원이다.','digits','37'],
 ['실제 납부 금액을 숫자만','실제 납부는 400원이다.','digits','400'],
 ['실제 입금액 숫자만','실제 입금액은 0원이다.','digits','0'],
 ['실제 지급액 숫자만','실제 지급 금액은 999원이다.','digits','999'],
 ['실제 결제액 숫자만','실제 결제는 10원이다.','digits','10'],
 ['최종 확인 결과를 원문 표현으로','최종 확인 결과는 미검증이다.','verification-status','미검증'],
 ['최종 검증 상태를 원문 표현으로','최종 검증 상태는 검증됨이다.','source-phrase','검증됨'],
 ['계약 확정 상태를 원문 단어로','계약 확정은 보류다.','source-phrase','보류'],
 ['승인 상태를 원문 단어로','승인은 미승인이다.','source-phrase','미승인'],
 ['설문 응답자 수만 숫자로','이 중 설문 응답자는 5명이다.','digits','5'],
 ['최종 참석자 수를 숫자만','최종 정정: 참석자는 17명이다.','digits','17'],
 ['최종 참가자 수를 숫자만','최종 정정된 참가자는 8명이다.','digits','8']
];
for(const [question,source,format,value] of cases)test('no model approximation for explicit source: '+question,async()=>{
 const result=await generateLocalSourceSummary({source,questions:{value:question},valueFormats:{value:format}},
  {preferSourceDeclarations:true,provider:{async generateStructured(){assert.fail('No model call expected');}}});
 assert.equal(result.output.facts.value,value);assert.equal(result.providerCalls,0);assert.equal(result.validation.valid,true);
 assert.equal(result.semanticAccuracyVerified,false);assert.equal(result.executionAuthorized,false);
 assert.equal(result.fieldProvenance.value.independentlyVerified,false);
});
for(const source of ['실제 지출은 0원이다. 실제 지출액은 10원이다.','실제 지출은 0원이 아니다.',
 '만약 실제 지출은 0원이다.','업체 주장: 실제 지출은 0원이다.',"예시: ‘실제 지출은 0원이다.’",
 '실제 지출은 0만원이다.','실제 지출은 미정이다.','실제 지출은 0원이다. 실제 지출은 20원으로 정정한다.'])
test('cannot promote ambiguous/unsupported declaration: '+source,async()=>{
 let calls=0;
 await assert.rejects(generateLocalSourceSummary({source,questions:{paid:'실제 지출액 숫자만'},valueFormats:{paid:'digits'}},
  {preferSourceDeclarations:true,provider:{async generateStructured(){calls++;return {output:{facts:{paid:'0'},evidence:{paid:source}},providerCalls:1};}}}),
  {code:'A_SOURCE_SUMMARY_OUTPUT_REJECTED'});
 assert.equal(calls,2);
});
test('one unknown field keeps the full model contract; no partial silent completion',async()=>{
 let calls=0;const source='실제 지출은 0원이다. 장소는 북관이다.';
 const result=await generateLocalSourceSummary({source,questions:{paid:'실제 지출액 숫자만',place:'장소'},valueFormats:{paid:'digits',place:'source-phrase'}},
  {preferSourceDeclarations:true,provider:{async generateStructured(){calls++;return {output:{facts:{paid:'0',place:'북관'},evidence:{paid:source,place:source}},providerCalls:1};}}});
 assert.equal(calls,1);assert.equal(result.output.facts.place,'북관');
});
test('cancellation prevents deterministic return',async()=>{
 const signal=AbortSignal.abort();
 await assert.rejects(generateLocalSourceSummary({source:'실제 지출은 0원이다.',questions:{paid:'실제 지출액 숫자만'},valueFormats:{paid:'digits'}},
  {preferSourceDeclarations:true,signal}),{code:'ABORT_ERR'});
});
test('PC workflow extraction uses the same declaration contract and preserves provenance',async()=>{
 const adapter=new LocalWorkflowToolAdapter();
 const result=await adapter.runOperation('text.extractFields',{text:'실제 지출액은 0원이다.',questions:{paid:'실제 지출액 숫자만'},valueFormats:{paid:'digits'}},{},{});
 assert.deepEqual(result.facts,{paid:'0'});assert.equal(result.fieldProvenance.paid.basis,'source-declaration');
 assert.equal(result.semanticAccuracyVerified,false);assert.match(result.sourceSha256,/^[a-f0-9]{64}$/u);
});
