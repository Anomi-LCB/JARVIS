import test from 'node:test';
import assert from 'node:assert/strict';
import {generateLocalSourceSummary} from '../packages/core/src/mission/local-source-summary.js';
const input=source=>({source,questions:{value:'재고 정정 후 현재 숫자'},valueFormats:{value:'digits'},sourceFields:{value:{label:'재고',kind:'corrected-integer',unit:'개'}}});
test('current field follows an explicit continuous correction chain with source evidence',async()=>{
 const source='재고는 12개이다.\n재고 정정: 12개 → 9개.\n재고 정정: 9개 → 2개.';
 const result=await generateLocalSourceSummary(input(source),{});
 assert.equal(result.output.facts.value,'2');assert.equal(result.output.evidence.value,source.slice(0,-1));assert.equal(result.providerCalls,0);
});
test('unchanged current field needs no correction',async()=>{
 assert.equal((await generateLocalSourceSummary(input('재고는 12개이다.'),{})).output.facts.value,'12');
});
test('broken chains, unit changes, repeated bases, attributed corrections and unknown revisions reject',async()=>{
 for(const source of [
 '재고는 12개이다. 재고 정정: 11개 → 2개.',
 '재고는 12개이다. 재고 정정: 12개 → 2상자.',
 '재고는 12개이다. 재고는 2개이다.',
 '재고는 12개이다. 업체 주장: 재고 정정: 12개 → 2개.',
 '재고는 12개이다. 재고 정정: 미정.',
 '재고는 12개이다. 재고 정정(취소): 12개 → 2개.',
 '재고는 12개이었다.',
 '재고는 12개이다. 재고 정정: 12개 → 2개. 재고 정정: 12개 → 4개.'
 ])await assert.rejects(generateLocalSourceSummary(input(source),{}));
});
test('quoted revisions are excluded from the current source contract',async()=>{
 const result=await generateLocalSourceSummary(input('재고는 12개이다.\n"재고 정정: 12개 → 999개."\n재고 정정: 12개 → 2개.'),{});
 assert.equal(result.output.facts.value,'2');
});
