import test from 'node:test';
import assert from 'node:assert/strict';
import {generateLocalSourceSummary,inspectLocalSummary,localSummarySchema} from '../packages/core/src/mission/local-source-summary.js';
const input={source:'실제 입금액은 0원이다. 환불 예정액은 70000원이다.',questions:{received:'실제 입금액 숫자만'},valueFormats:{received:'digits'}};
const correct={facts:{received:'0'},evidence:{received:'실제 입금액은 0원이다.'}};
const generated=output=>({output,latencyMs:12,usage:{inputTokens:10,outputTokens:5},providerCalls:2,localModel:{digest:'fixture'},executionAuthorized:false});
test('invalid prose values and combined noncontiguous quotes are rejected',()=>{
 assert.equal(inspectLocalSummary(input,{...correct,facts:{received:'0원'}}).valid,false);
 assert.equal(inspectLocalSummary(input,{...correct,evidence:{received:'실제 입금액은 0원이다. 예정액 70000원이다.'}}).valid,false);
 assert.equal(localSummarySchema(input).properties.facts.properties.received.pattern,'^[0-9]+$');
});
test('bounded repair includes only validation issues, counts all attempts and never grants semantic authority',async()=>{
 const prompts=[];const provider={async generateStructured(request){prompts.push(request.prompt);return generated(prompts.length===1?{...correct,facts:{received:'0원'}}:correct);}};
 const result=await generateLocalSourceSummary(input,{provider});assert.equal(prompts.length,2);
 assert.ok(prompts[1].includes('received:value-format-invalid'));assert.equal(result.attempts.length,2);
 assert.equal(result.providerCalls,4);assert.equal(result.usage.totalTokens,30);assert.equal(result.latencyMs,24);
 assert.equal(result.semanticAccuracyVerified,false);assert.equal(result.executionAuthorized,false);
});
test('persistent invalid output is never silently accepted and cannot trigger unlimited repairs',async()=>{
 let calls=0;const provider={async generateStructured(){calls++;return generated({...correct,facts:{received:'0원'}});}};
 await assert.rejects(generateLocalSourceSummary(input,{provider}),e=>e.code==='A_SOURCE_SUMMARY_OUTPUT_REJECTED'&&e.attempts.length===2);assert.equal(calls,2);
});
test('impossible dates, source phrase invention, unsafe keys and missing formats reject',()=>{
 assert.equal(inspectLocalSummary({source:'2026-02-30',questions:{date:'날짜'},valueFormats:{date:'iso-date'}},{facts:{date:'2026-02-30'},evidence:{date:'2026-02-30'}}).valid,false);
 assert.equal(inspectLocalSummary({...input,valueFormats:{received:'source-phrase'}},{...correct,facts:{received:'입금완료'}}).valid,false);
 assert.throws(()=>localSummarySchema({...input,valueFormats:{}}));
 assert.throws(()=>localSummarySchema({questions:{constructor:'값'},valueFormats:{constructor:'digits'}}));
});
test('cancellation and provider failure propagate without covert retry',async()=>{
 const controller=new AbortController();controller.abort();let calls=0;
 await assert.rejects(generateLocalSourceSummary(input,{signal:controller.signal,provider:{async generateStructured({signal}){calls++;assert.equal(signal.aborted,true);throw Object.assign(new Error('cancel'),{code:'ABORT_ERR'});}}}),{code:'ABORT_ERR'});assert.equal(calls,1);
});
