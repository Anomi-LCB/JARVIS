import test from 'node:test';
import assert from 'node:assert/strict';
import {WindowsDesktopControlToolAdapter} from '../apps/pc-agent/src/windows-desktop-control.js';
import {ClaudeCliTaskPlanner} from '../packages/core/src/planning/claude-cli-task-planner.js';
const base=()=>({target:{processId:123},operations:[{op:'invoke',selector:{automationId:'Save'}}],verification:[{type:'elementNameEquals',selector:{automationId:'Status'},expected:'Saved'}]});
for(const mode of ['operations-overflow','verification-overflow','missing-operation','unknown-operation','missing-verification','unknown-verification','value-overflow','expected-overflow','launch-arguments-overflow','selector-overflow','selector-index-overflow']){
 test(`${mode}: never execute a silently shortened desktop request`,async()=>{
  let calls=0;const adapter=new WindowsDesktopControlToolAdapter({hostPlatform:'win32',runner:request=>{calls++;return {status:'success',verification:{passed:true},operations:request.operations.map(o=>({op:o.op,status:'completed'}))};}});
  const args=base();
  if(mode==='operations-overflow')args.operations=Array.from({length:17},()=>args.operations[0]);
  if(mode==='verification-overflow')args.verification=Array.from({length:13},()=>args.verification[0]);
  if(mode==='missing-operation')args.operations.push(null);
  if(mode==='unknown-operation')args.operations.push({op:'coordinateClick',x:42,y:12});
  if(mode==='missing-verification')args.verification.push(null);
  if(mode==='unknown-verification')args.verification.push({type:'saveSucceeded',expected:true});
  if(mode==='value-overflow')args.operations=[{op:'setValue',selector:{automationId:'Edit'},value:'x'.repeat(8001)}];
  if(mode==='expected-overflow')args.verification[0].expected='x'.repeat(8001);
  if(mode==='launch-arguments-overflow')args.operations=[{op:'launch',filePath:'notepad.exe',arguments:Array(17).fill('synthetic')}];
  if(mode==='selector-overflow')args.operations[0].selector.automationId='x'.repeat(241);
  if(mode==='selector-index-overflow')args.operations[0].selector.index=101;
  assert.equal(new ClaudeCliTaskPlanner().sanitizeDesktopControlPlan(args),null,'planning must not erase the violation before the executor sees it');
  const shadow=await adapter.shadow(args),result=await adapter.execute(args);
  assert.equal(result.status,'blocked');assert.equal(calls,0);assert.ok(shadow.warnings.length>0);
 });
}
test('full supported boundary keeps all 16 actions and 12 checks',async()=>{
 let request;const adapter=new WindowsDesktopControlToolAdapter({hostPlatform:'win32',runner:r=>{request=r;return {status:'success',verification:{passed:true},operations:r.operations.map(o=>({op:o.op,status:'completed'}))};}});
 const args=base();args.operations=Array.from({length:16},()=>args.operations[0]);args.verification=Array.from({length:12},()=>args.verification[0]);
 assert.equal(new ClaudeCliTaskPlanner().sanitizeDesktopControlPlan(args).operations.length,16);
 const result=await adapter.execute(args);assert.equal(result.status,'success');assert.equal(request.operations.length,16);assert.equal(request.verification.length,12);
});
