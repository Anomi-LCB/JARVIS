import test from 'node:test';
import assert from 'node:assert/strict';
import {WindowsDesktopControlToolAdapter} from '../apps/pc-agent/src/windows-desktop-control.js';
for(const mode of ['absent','window-only','element-only','derived-overflow'])test(`${mode}: presence cannot prove desktop effect completion`,async()=>{
 let calls=0;const adapter=new WindowsDesktopControlToolAdapter({hostPlatform:'win32',runner:()=>{calls++;return {status:'success',verification:{passed:true}};}});
 const args={target:{processId:123},operations:[{op:'invoke',selector:{automationId:'Save'}}]};
 if(mode==='window-only')args.verification=[{type:'windowExists'}];
 if(mode==='element-only')args.verification=[{type:'elementExists',selector:{automationId:'Save'}}];
 if(mode==='derived-overflow')args.operations=Array.from({length:16},(_,index)=>({op:'setValue',selector:{automationId:'Field'+index},value:'v'}));
 const result=await adapter.execute(args);assert.equal(result.status,'blocked');assert.equal(calls,0);
});
test('explicit state outcome retains supported invocation',async()=>{
 const adapter=new WindowsDesktopControlToolAdapter({hostPlatform:'win32',runner:()=>({status:'success',verification:{passed:true}})});
 const result=await adapter.execute({target:{processId:123},operations:[{op:'invoke',selector:{automationId:'Save'}}],verification:[{type:'elementValueEquals',selector:{automationId:'Status'},expected:'Saved'}]});
 assert.equal(result.status,'success');
});
test('invalid enabled-state expectation is rejected before a mutation',async()=>{
 let calls=0;const adapter=new WindowsDesktopControlToolAdapter({hostPlatform:'win32',runner:()=>{calls++;return {status:'success',verification:{passed:true}};}});
 const result=await adapter.execute({target:{processId:123},operations:[{op:'invoke',selector:{automationId:'Save'}}],verification:[{type:'elementEnabled',selector:{automationId:'Save'},expected:'not-a-boolean'}]});
 assert.equal(result.status,'blocked');assert.equal(calls,0);
});
