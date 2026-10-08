import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyFieldSummaryResultAsync} from '../packages/core/src/mission/field-summary-async.js';
const input={objective:'unsupported',statement:'unsupported',allowedRoots:[],observations:[]};
test('worker admission is bounded and capacity returns after termination',async()=>{
 const a=verifyFieldSummaryResultAsync(input),b=verifyFieldSummaryResultAsync(input);
 const busy=await verifyFieldSummaryResultAsync(input);
 assert.deepEqual(busy.reasons,['field-summary-verifier-busy']);
 await Promise.all([a,b]);
 const recovered=await verifyFieldSummaryResultAsync(input);
 assert.equal(recovered.applicable,false);
});
test('worker timeout fails closed and releases capacity',async()=>{
 const result=await verifyFieldSummaryResultAsync(input,{timeoutMs:10});
 assert.equal(result.passed,false);
 assert.deepEqual(result.reasons,['field-summary-verifier-timeout']);
 assert.equal((await verifyFieldSummaryResultAsync(input)).applicable,false);
});
test('invalid worker budgets are rejected before starting work',()=>{
 for(const timeoutMs of [0,9,30001,Infinity,1.5])assert.throws(()=>verifyFieldSummaryResultAsync(input,{timeoutMs}),TypeError);
});
test('main event loop remains available while worker verification is pending',async()=>{
 let settled=false;
 const pending=verifyFieldSummaryResultAsync(input).then(r=>{settled=true;return r;});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(settled,false);
 assert.equal((await pending).applicable,false);
});
