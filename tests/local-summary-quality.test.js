import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateSummary} from '../scripts/local-summary-quality.mjs';

import {localSummaryPrompt} from '../packages/core/src/mission/local-source-summary.js';
const item={source:'입금액은 0원이다. 환불 예정액은 70000원이다.',questions:{received:'실제 입금액 숫자만'},expected:{received:'0'},evidenceAnchors:{received:['입금액은 0원이다.']}};
test('independent expected answers never enter model prompt',()=>{
 const prompt=localSummaryPrompt({...item,valueFormats:{received:'digits'},expected:{received:'SECRET_ORACLE'},evidenceAnchors:{received:['SECRET_PROOF']}});
 assert.equal(prompt.includes('SECRET_ORACLE'),false);assert.equal(prompt.includes('SECRET_PROOF'),false);
});
test('source-verbatim but unrelated evidence cannot pass independent fact grounding',()=>{
 const output={facts:{received:'0'},evidence:{received:'환불 예정액은 70000원이다.'}};
 assert.equal(evaluateSummary(item,output).passed,false);
});
test('changed facts, invented evidence, missing and extra fields are rejected',()=>{
 for(const output of [
  {facts:{received:'70000'},evidence:{received:item.source}},
  {facts:{received:'0'},evidence:{received:'입금됐다.'}},
  {facts:{},evidence:{received:item.source}},
  {facts:{received:'0',extra:'1'},evidence:{received:item.source}},
  {facts:{received:'0'},evidence:{received:item.source},extra:true},null])assert.equal(evaluateSummary(item,output).passed,false);
});
test('correct exact answer and direct source evidence pass only bounded oracle scope',()=>{
 const result=evaluateSummary(item,{facts:{received:'0'},evidence:{received:'입금액은 0원이다.'}});
 assert.equal(result.passed,true);assert.equal(result.arbitraryProseQualityVerified,false);
});
