import test from 'node:test';
import assert from 'node:assert/strict';
import {createOllamaLocalModelProvider} from '../packages/core/src/mission/ollama-local-model-provider.js';
import {generateLocalSourceSummary} from '../packages/core/src/mission/local-source-summary.js';
import {runLocalSummaryMission} from '../scripts/local-summary-mission-pilot.mjs';
import {runLocalSummaryQuality} from '../scripts/local-summary-quality.mjs';
import {localModelFailureObservation,summarizeLocalAttempts} from '../packages/core/src/mission/local-model-observation.js';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
const input={source:'실제 입금액은 0원이다.',questions:{received:'실제 입금액 숫자만'},valueFormats:{received:'digits'}};
const schema={type:'object'};
const local={name:'gemma3:latest',digest:'a'.repeat(64),size:1000};
test('transport cause is bounded to known codes and excludes raw error prose',async()=>{
 for(const code of ['UND_ERR_HEADERS_TIMEOUT','ECONNRESET','PRIVATE_CAUSE_SECRET']){
  const provider=createOllamaLocalModelProvider({model:'gemma3:latest',fetchImpl:async()=>{throw Object.assign(new Error('PRIVATE_ERROR_SECRET'),{cause:{code}});}});
  await assert.rejects(provider.generateStructured({prompt:'Synthetic',schema}),error=>{
   assert.equal(error.diagnostics.transportCode,code==='PRIVATE_CAUSE_SECRET'?undefined:code);
   assert.equal(JSON.stringify(error.diagnostics).includes('SECRET'),false);return true;
  });
 }
});
test('truncated generation preserves bounded reason, exact usage and request attempts without raw text',async()=>{
 let calls=0;
 const provider=createOllamaLocalModelProvider({model:'gemma3:latest',fetchImpl:async()=>++calls===1?Response.json({models:[local]}):Response.json({model:'gemma3:latest',response:'SECRET_PARTIAL',done:true,done_reason:'length',prompt_eval_count:34,eval_count:384})});
 await assert.rejects(provider.generateStructured({prompt:'SECRET_PROMPT',schema}),error=>{
  assert.equal(error.code,'A_LOCAL_MODEL_RESPONSE_INCOMPLETE');
  assert.equal(error.diagnostics.providerCalls,2);assert.equal(error.diagnostics.doneReason,'length');
  assert.deepEqual(error.diagnostics.usage,{inputTokens:34,outputTokens:384,totalTokens:418});
  assert.equal(error.diagnostics.stage,'generation-response');
  assert.equal(JSON.stringify(error.diagnostics).includes('SECRET'),false);return true;
 });
});
test('catalog rejection and HTTP failure record actual request counts and do not invent tokens',async()=>{
 const missing=createOllamaLocalModelProvider({model:'gemma3:latest',fetchImpl:async()=>Response.json({models:[]})});
 await assert.rejects(missing.generateStructured({prompt:'x',schema}),e=>e.code==='A_LOCAL_MODEL_NOT_INSTALLED'&&e.diagnostics.providerCalls===1&&e.diagnostics.stage==='catalog-response'&&e.diagnostics.usage===null);
 let calls=0;
 const http=createOllamaLocalModelProvider({model:'gemma3:latest',fetchImpl:async()=>++calls===1?Response.json({models:[local]}):new Response('SECRET_SERVER_ERROR',{status:503})});
 await assert.rejects(http.generateStructured({prompt:'x',schema}),e=>e.code==='A_LOCAL_MODEL_HTTP_ERROR'&&e.diagnostics.providerCalls===2&&e.diagnostics.httpStatus===503&&e.diagnostics.usage===null&&!JSON.stringify(e.diagnostics).includes('SECRET'));
});
test('pre-cancelled requests perform no network call and real abort timeout reports an attempted call',async()=>{
 const controller=new AbortController();controller.abort();let calls=0;
 const cancelled=createOllamaLocalModelProvider({model:'gemma3:latest',fetchImpl:async()=>{calls++;return Response.json({models:[]});}});
 await assert.rejects(cancelled.generateStructured({prompt:'x',schema,signal:controller.signal}),e=>e.code==='ABORT_ERR'&&e.diagnostics.providerCalls===0);assert.equal(calls,0);
 const timeout=createOllamaLocalModelProvider({model:'gemma3:latest',timeoutMs:100,fetchImpl:async(_url,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('SECRET_TIMEOUT')),{once:true}))});
 await assert.rejects(timeout.generateStructured({prompt:'x',schema}),e=>e.code==='ETIMEDOUT'&&e.diagnostics.stage==='catalog-request'&&e.diagnostics.providerCalls===1&&e.diagnostics.usage===null);
});
test('missing or invalid measurement remains unknown, partial tokens remain partial, and raw diagnostics are dropped',async()=>{
 const provider={async generateStructured(){throw Object.assign(new Error('SECRET'),{code:'SECRET_FROM_PROVIDER',diagnostics:{stage:'SECRET'}});}};
 await assert.rejects(generateLocalSourceSummary(input,{provider}),e=>e.code==='A_SOURCE_SUMMARY_PROVIDER_FAILED'&&e.providerCalls===null&&e.usage===null&&e.attempts[0].diagnostics===null&&!JSON.stringify(e.attempts).includes('SECRET'));
 const safe=localModelFailureObservation({version:'local-model-failure-v1',stage:'SECRET',providerCalls:-1,latencyMs:Infinity,usage:{inputTokens:4,private:'SECRET'},doneReason:'SECRET',httpStatus:999,private:'SECRET'});
 assert.equal(safe.stage,null);assert.equal(safe.providerCalls,null);assert.deepEqual(safe.usage,{inputTokens:4});assert.equal(JSON.stringify(safe).includes('SECRET'),false);
 assert.equal(summarizeLocalAttempts([{usage:safe.usage,providerCalls:null,latencyMs:null}]).usage,null);
});
test('quality campaign persists failed model attempts and retains all failed cases in the denominator',async()=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-failure-quality-'));
 try{
  const provider={async generateStructured(){throw Object.assign(new Error('SECRET'),{code:'A_LOCAL_MODEL_RESPONSE_INCOMPLETE',diagnostics:{version:'local-model-failure-v1',stage:'generation-response',providerCalls:2,latencyMs:20,doneReason:'length',usage:{inputTokens:10,outputTokens:384},httpStatus:200}});}};
  const report=await runLocalSummaryQuality({outputRoot:root,provider});
  assert.equal(report.total,6);assert.equal(report.failed,6);assert.equal(report.passed,0);assert.equal(report.providerCalls,12);assert.equal(report.casesWithUnknownProviderCalls,0);
  const saved=JSON.parse(await readFile(join(root,'attribution.json'),'utf8'));
  assert.equal(saved.attempts.length,1);assert.equal(saved.attempts[0].diagnostics.doneReason,'length');assert.equal(saved.providerCalls,2);assert.equal(saved.usage.totalTokens,394);
  assert.equal(JSON.stringify(report).includes('SECRET'),false);
 }finally{assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));await rm(root,{recursive:true,force:true});}
});
test('a provider failure on repair retains the first rejection and a failed second attempt',async()=>{
 let calls=0;
 const provider={async generateStructured(){
  if(++calls===1)return {output:{facts:{received:'SECRET_DRAFT'},evidence:{received:input.source}},latencyMs:12,usage:{inputTokens:10,outputTokens:5},providerCalls:2};
  throw Object.assign(new Error('SECRET'),{code:'ETIMEDOUT',diagnostics:{version:'local-model-failure-v1',stage:'generation-request',providerCalls:2,latencyMs:100,usage:null,doneReason:null,httpStatus:null,private:'SECRET'}});
 }};
 await assert.rejects(generateLocalSourceSummary(input,{provider}),error=>{
  assert.equal(error.code,'ETIMEDOUT');assert.equal(error.attempts.length,2);
  assert.equal(error.attempts[0].validation.valid,false);assert.equal(error.attempts[1].status,'failed');
  assert.equal(error.providerCalls,4);assert.equal(error.usage,null);
  assert.equal(JSON.stringify(error.attempts).includes('SECRET'),false);return true;
 });assert.equal(calls,2);
});
test('actual Mission records failed model diagnostics and creates no result file',async()=>{
 const item={id:'failure-observation',...input,expected:{received:'0'}};
 const provider={async generateStructured(){throw Object.assign(new Error('SECRET'),{code:'A_LOCAL_MODEL_RESPONSE_INCOMPLETE',diagnostics:{version:'local-model-failure-v1',stage:'generation-response',providerCalls:2,latencyMs:30,doneReason:'length',usage:{inputTokens:10,outputTokens:384,totalTokens:394},httpStatus:200}});}};
 const report=await runLocalSummaryMission({item,provider});
 assert.notEqual(report.status,'COMPLETED');assert.equal(report.output,null);
 assert.equal(report.modelFailure.attempts.length,1);assert.equal(report.modelFailure.providerCalls,2);
 assert.equal(report.modelFailure.attempts[0].diagnostics.doneReason,'length');
 assert.equal(JSON.stringify(report).includes('SECRET'),false);
 console.log(JSON.stringify({localFailureMissionEvidence:{status:report.status,output:report.output,modelFailure:report.modelFailure}}));
});
