import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,existsSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
for(const scenario of [...['prepared','b-receipt','receipt-persisted','publication-prepared','publication-published'].map(boundary=>({boundary})),
 ...['revoked','revision','cancelled','token'].map(rejection=>({boundary:'publication-prepared',rejection})),
 {boundary:'publication-prepared',quota:true},{boundary:'publication-published',quota:true},
 ...['quota-revoked','quota-expired'].map(rejection=>({boundary:'publication-prepared',quota:true,rejection}))])test('actual workflow process recovery '+scenario.boundary+(scenario.quota?' with one-count quota':'')+(scenario.rejection?' rejects '+scenario.rejection:' preserves the original effect and receipt'),async t=>{
 const {boundary,rejection,quota}=scenario;
 const root=mkdtempSync(join(tmpdir(),'jarvis-workflow-effect-process-')),children=new Set();
 t.after(async()=>{for(const c of children)if(c.exitCode===null&&c.signalCode===null){const ended=once(c,'exit');c.kill('SIGKILL');await ended;}rmSync(root,{recursive:true,force:true});});
 const calls=()=>existsSync(join(root,'calls.jsonl'))?readFileSync(join(root,'calls.jsonl'),'utf8').trim().split('\n').length:0;
 const launch=async mode=>{
  const c=fork(new URL('./fixtures/workflow-cognition-process-child.mjs',import.meta.url),[root,mode],{windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});children.add(c);let stderr='';c.stderr.on('data',v=>stderr+=v);
  const next=()=>new Promise((resolve,reject)=>{const cleanup=()=>{clearTimeout(timer);c.off('message',message);c.off('exit',exit);};const message=v=>{cleanup();v.type==='error'?reject(Error(v.message+'\n'+v.stack)):resolve(v);};const exit=code=>{cleanup();reject(Error('child exited '+code+': '+stderr));};const timer=setTimeout(()=>{cleanup();reject(Error('workflow boundary timeout: '+stderr));},25000);c.once('message',message);c.once('exit',exit);});
  assert.equal((await next()).type,'ready');return {run(){const reply=next();c.send('run');return reply;},async kill(){const ended=once(c,'exit');c.kill('SIGKILL');await ended;children.delete(c);}};
 };
 const initial=await launch('effect-'+boundary+(quota?'-quota'+(rejection==='quota-expired'?'-expired':''):'')),stopped=await initial.run();assert.equal(stopped.boundary,boundary.replace('publication-',''));await initial.kill();
 assert.equal(calls(),boundary==='prepared'||boundary.startsWith('publication-')?0:1);
 // Recover an expired claim without changing the original operation or B receipt.
 const resumed=await(await launch(rejection?'effect-resume-'+rejection:quota?'effect-resume-quota':'effect-resume')).run();
 if(rejection){
  assert.notEqual(resumed.status,'COMPLETED');
  if(quota){
   assert.equal(resumed.rejection.success,false);
   assert.equal(resumed.rejection.error.code,'A_MANDATE_EXECUTION_DENIED');
   assert.equal(resumed.quotaReservations.length,1);
   assert.notEqual(resumed.quotaReservations[0].state,'settled');
  }
  const returned=existsSync(join(root,'calls.jsonl'))?readFileSync(join(root,'calls.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line)):[];
  assert.ok(returned.every(item=>item.status!=='success'));
  assert.equal(existsSync(join(root,'workspace','output.json')),false);assert.notEqual(resumed.effect.state,'succeeded');
  assert.equal(resumed.effect.operation_id,resumed.effect.provider_idempotency_key);
  t.diagnostic(JSON.stringify({boundary,rejection,initialPid:stopped.pid,resumedPid:resumed.pid,adapterReturns:returned.length,successfulAdapterReturns:0,outputAbsent:true,effectState:resumed.effect.state}));return;
 }
 assert.equal(resumed.status,'COMPLETED',JSON.stringify({status:resumed.status,recovery:resumed.recovery,lastError:resumed.lastError}));assert.equal(calls(),1);
 assert.equal(resumed.defaultWorkflowEffectsEnabled,true);
 if(quota){assert.equal(resumed.quotaReservations.length,1);assert.equal(resumed.quotaReservations[0].state,'settled');assert.equal(resumed.quota.usedOrHeldCalls,1);assert.equal(resumed.quota.remainingCalls,0);}
 assert.equal(resumed.effect.state,'succeeded');assert.equal(resumed.effect.operation_id,resumed.effect.provider_idempotency_key);
 if(boundary.startsWith('publication-')){
  assert.equal(resumed.effect.effect_id,stopped.effectId);assert.equal(resumed.effect.operation_id,stopped.operationId);
  assert.ok(resumed.effect.fence>stopped.effectFence,'recovery must replace the expired owner fence');
 }
 assert.deepEqual(resumed.bKeys,[resumed.effect.operation_id]);assert.ok(resumed.effect.receipt.evidenceId);
 const repeated=await(await launch(quota?'effect-resume-quota':'effect-resume')).run();assert.equal(repeated.status,'COMPLETED');assert.equal(calls(),1);
 if(quota)assert.deepEqual(repeated.quotaReservations,resumed.quotaReservations);
 assert.deepEqual(repeated.effect.receipt,resumed.effect.receipt);
 t.diagnostic(JSON.stringify({boundary,initialPid:stopped.pid,resumedPid:resumed.pid,repeatPid:repeated.pid,completedAdapterReturns:1,operationId:resumed.effect.operation_id}));
});
