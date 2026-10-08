import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectLocalSummary,generateLocalSourceSummary} from '../packages/core/src/mission/local-source-summary.js';
const input={source:'견적액은 450000원이다. 실제 지출액은 0원이다.',questions:{paid:'실제 지출액 숫자만'},valueFormats:{paid:'digits'}};
test('actual wrong quote/value pair is rejected before artifact publication',async()=>{
  const wrong={facts:{paid:'450000'},evidence:{paid:'실제 지출액은 0원이다.'}};
  assert.deepEqual(inspectLocalSummary(input,wrong).errors,['paid:numeric-evidence-mismatch','paid:source-question-value-mismatch']);
  let calls=0;
  const result=await generateLocalSourceSummary(input,{provider:{async generateStructured(){calls++;return {output:calls===1?wrong:{facts:{paid:'0'},evidence:wrong.evidence},providerCalls:1};}}});
  assert.equal(calls,2);assert.equal(result.output.facts.paid,'0');assert.equal(result.semanticAccuracyVerified,false);
});
test('invented calendar date cannot be justified by an uncertain delivery quote',()=>{
  const source='납품 확정일은 제시하지 않았다.';
  const dateInput={source,questions:{date:'확정 날짜'},valueFormats:{date:'iso-date-or-unknown'}};
  assert.deepEqual(inspectLocalSummary(dateInput,{facts:{date:'2024-07-03'},evidence:{date:source}}).errors,['date:date-evidence-mismatch']);
  for(const quote of ['회의는 2026년 10월 8일이다.','회의 날짜: 2026-10-08.']){
    assert.equal(inspectLocalSummary({...dateInput,source:quote},{facts:{date:'2026-10-08'},evidence:{date:quote}}).valid,true);
  }
});
test('whole integer support excludes substrings, decimals and negative quantities',()=>{
  for(const source of ['수량은 30개다.','수량은 3.5개다.','수량은 -3개다.']){
    const check=inspectLocalSummary({...input,source},{facts:{paid:'3'},evidence:{paid:source}});
    assert.equal(check.valid,false,source);
  }
  const source='가격은 450,000원이다.';
  // Numeric formatting alone can support this price; it cannot answer a paid-expense question.
  assert.equal(inspectLocalSummary({...input,source},{facts:{paid:'450000'},evidence:{paid:source}}).valid,false);
  assert.equal(inspectLocalSummary({...input,source,questions:{paid:'가격 숫자만'}},{facts:{paid:'450000'},evidence:{paid:source}}).valid,true);
});
