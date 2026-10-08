import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {LocalWorkflowToolAdapter} from '../apps/pc-agent/src/adapters/workflow/local-workflow-adapter.js';
async function run(t,op,args) {
 const root=mkdtempSync(join(tmpdir(),'jarvis-grouped-number-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const a=new LocalWorkflowToolAdapter({allowedRoots:[root]});
 const result=await a.execute({workspaceRoot:root,spec:{schemaVersion:'jarvis-local-workflow-v1',workflowId:'grouped-number',
  nodes:[{id:'calculate',op,args},{id:'publish',op:'write.json',dependsOn:['calculate'],args:{path:'result.json',value:{$ref:{nodeId:'calculate'}}}}]}},{taskId:'grouped-number'});
 return {result,value:result.status==='success'?JSON.parse(readFileSync(join(root,'result.json'),'utf8')):null};
}
test('explicit grouped decimal sorts actual formatted amounts and preserves original strings',async t=>{
 const {result,value}=await run(t,'data.sort',{items:[{price:'2,000'},{price:'950'},{price:'10,000'}],
  by:[{field:'price',numeric:true,numericFormat:'grouped-decimal'}]});
 assert.equal(result.status,'success');assert.deepEqual(value.items.map(v=>v.price),['950','2,000','10,000']);
});
test('explicit grouped decimal filter compares a formatted threshold',async t=>{
 const {result,value}=await run(t,'data.filter',{items:[{price:'900'},{price:'1,500'},{price:'2,000'}],
  where:{field:'price',numeric:true,numericFormat:'grouped-decimal',operator:'gte',value:'1,500'}});
 assert.equal(result.status,'success');assert.deepEqual(value.items.map(v=>v.price),['1,500','2,000']);
});
for(const invalid of ['1,00','1.234,56','1,000원','',null,true,'9,007,199,254,740,992'])
 test(`malformed or ambiguous grouped decimal is blocked: ${JSON.stringify(invalid)}`,async t=>{
  const {result}=await run(t,'data.sort',{items:[{price:invalid},{price:'1,000'}],by:[{field:'price',numeric:true,numericFormat:'grouped-decimal'}]});
  assert.equal(result.status,'failed');assert.equal(result.error.code,'WORKFLOW_NUMBER_INVALID');
 });
test('default decimal does not silently reinterpret comma amounts',async t=>{
 const {result}=await run(t,'data.sort',{items:[{price:'1,000'}],by:[{field:'price',numeric:true}]});
 assert.equal(result.status,'failed');assert.equal(result.error.code,'WORKFLOW_NUMBER_INVALID');
});
test('unsupported numeric format is blocked even for an empty sort',async t=>{
 const {result}=await run(t,'data.sort',{items:[],by:[{field:'price',numeric:true,numericFormat:'unknown'}]});
 assert.equal(result.status,'failed');assert.equal(result.error.code,'WORKFLOW_NUMBER_FORMAT_UNSUPPORTED');
});
test('empty and short-circuited filters still validate all explicit numeric formats',async t=>{
 for(const items of [[],[{price:'1,000'}]]) {
  const {result}=await run(t,'data.filter',{items,where:{any:[{field:'price',operator:'exists'},
   {field:'price',numeric:true,numericFormat:'unknown',operator:'gte',value:'1'}]}});
  assert.equal(result.status,'failed');assert.equal(result.error.code,'WORKFLOW_NUMBER_FORMAT_UNSUPPORTED');
 }
});
test('format cannot silently disappear when numeric comparison was not selected',async t=>{
 for(const op of ['data.sort','data.filter']) {
  const args=op==='data.sort'?{items:[],by:[{field:'price',numericFormat:'grouped-decimal'}]}
   :{items:[],where:{field:'price',numericFormat:'grouped-decimal'}};
  const {result}=await run(t,op,args);assert.equal(result.status,'failed');assert.equal(result.error.code,'WORKFLOW_NUMBER_FORMAT_REQUIRES_NUMERIC');
 }
});
