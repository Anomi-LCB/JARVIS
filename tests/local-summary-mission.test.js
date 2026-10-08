import test from 'node:test';
import assert from 'node:assert/strict';
import {runLocalSummaryMission} from '../scripts/local-summary-mission-pilot.mjs';
const item={id:'fixture',source:'실제 입금액은 0원이다. 예정액은 70000원이다.',questions:{received:'실제 입금액 숫자만'},valueFormats:{received:'digits'},expected:{received:'0'}};
for(const [value,status] of [['0','COMPLETED'],['70000','BLOCKED']])test('actual source/model draft/E/B/G pipeline '+value,async()=>{
 let calls=0;
 const provider={async generateStructured({prompt}){calls++;assert.ok(prompt.includes(item.source));return {output:{facts:{received:value},evidence:{received:value==='0'?'실제 입금액은 0원이다.':'예정액은 70000원이다.'}},latencyMs:1,providerCalls:2,usage:{inputTokens:10,outputTokens:5},model:'synthetic-fixture'};}};
 const report=await runLocalSummaryMission({item,provider});assert.equal(calls,value==='0'?1:2,JSON.stringify(report));
 assert.equal(report.status,status,JSON.stringify(report));assert.equal(report.outputMatchesIndependentOracle,value==='0');
 assert.equal(report.actions.filter(a=>a.status==='succeeded').length,value==='0'?5:2);assert.equal(report.arbitraryProseQualityVerified,false);
 if(value!=='0'){assert.equal(report.output,null);assert.equal(report.modelFailure.code,'A_SOURCE_SUMMARY_OUTPUT_REJECTED');}
});
test('persistent invalid draft retains both failures and produces no file effect',async()=>{
 let calls=0;const report=await runLocalSummaryMission({item,provider:{async generateStructured(){calls++;return {output:{facts:{received:'0원'},evidence:{received:item.source}},latencyMs:1,providerCalls:2,usage:null};}}});
 assert.equal(calls,2);assert.equal(report.status,'BLOCKED');assert.equal(report.output,null);
 assert.equal(report.modelFailure.code,'A_SOURCE_SUMMARY_OUTPUT_REJECTED');assert.equal(report.modelFailure.attempts.length,2);
 assert.equal(report.actions.length,2);
});
