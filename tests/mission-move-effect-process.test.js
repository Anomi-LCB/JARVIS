import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,existsSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
for(const boundary of ['prepared','b-receipt','receipt-persisted','partial','changed','authority','late-target'])test(`actual move effect process recovery: ${boundary}`,async t=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-move-process-')),children=new Set();
 t.after(async()=>{for(const c of children)if(c.exitCode===null&&c.signalCode===null){const end=once(c,'exit');c.kill('SIGKILL');await end;}rmSync(root,{recursive:true,force:true});});
 const calls=()=>existsSync(join(root,'calls.jsonl'))?readFileSync(join(root,'calls.jsonl'),'utf8').trim().split('\n').length:0;
 const launch=async mode=>{const c=fork(new URL('./fixtures/move-effect-process-child.mjs',import.meta.url),[root,mode],{windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});children.add(c);let stderr='';c.stderr.on('data',v=>stderr+=v);
  const next=()=>new Promise((resolve,reject)=>{const cleanup=()=>{clearTimeout(timer);c.off('message',message);c.off('exit',exit);};const message=v=>{cleanup();v.type==='error'?reject(Error(v.message+'\n'+v.stack)):resolve(v);};const exit=code=>{cleanup();reject(Error(`child exited ${code}: ${stderr}`));};const timer=setTimeout(()=>{cleanup();reject(Error('move boundary timeout: '+stderr));},25000);c.once('message',message);c.once('exit',exit);});
  assert.equal((await next()).type,'ready');return {run(){const reply=next();c.send('run');return reply;},async kill(){const end=once(c,'exit');c.kill('SIGKILL');await end;children.delete(c);}};};
 const initial=await launch(boundary==='changed'?'b-receipt':boundary),stopped=await initial.run();await initial.kill();
 if(boundary==='authority'){assert.equal(stopped.status,'COMPLETED');assert.equal(stopped.effect.state,'succeeded');assert.equal(stopped.bClaims,0);assert.deepEqual(stopped.files,[{source:false,target:true},{source:false,target:true}]);return;}
 const before=calls(),resumed=await(await launch(boundary==='changed'?'resume-changed':'resume')).run();
 if(['partial','changed','late-target'].includes(boundary)){
  assert.notEqual(resumed.status,'COMPLETED');assert.equal(calls(),before);assert.equal(resumed.effect.state,'uncertain');
  if(boundary==='partial')assert.deepEqual(resumed.files,[{source:false,target:true},{source:true,target:false}]);
  if(boundary==='late-target'){
   assert.deepEqual(resumed.files,[{source:false,target:true},{source:true,target:true}]);
   assert.equal(readFileSync(join(root,'workspace/target2.txt'),'utf8'),'late user file');
   assert.equal(resumed.bFailures.length,1);assert.equal(resumed.bFailures[0].uncertain,true);
   assert.equal(resumed.bFailures[0].changedItems.length,1);assert.equal(resumed.bFailures[0].outputPaths.length,1);
  }
 }else{
  assert.equal(resumed.status,'COMPLETED',JSON.stringify(resumed.recovery));assert.equal(calls(),1);
  assert.equal(resumed.effect.state,'succeeded');assert.equal(resumed.effect.operation_id,resumed.effect.provider_idempotency_key);
  assert.equal(resumed.bClaims,0,'completed original B receipt must release all source and destination claims');
  assert.deepEqual(resumed.keys,[resumed.effect.operation_id]);assert.ok(resumed.effect.receipt.evidenceId);
  assert.deepEqual(resumed.files,[{source:false,target:true},{source:false,target:true}]);
  assert.equal(resumed.effect.operation_id,stopped.operationId);assert.equal(resumed.effect.effect_id,stopped.effectId);
  const repeated=await(await launch('resume')).run();assert.equal(repeated.status,'COMPLETED');assert.equal(calls(),1);assert.deepEqual(repeated.effect.receipt,resumed.effect.receipt);
 }
 t.diagnostic(JSON.stringify({boundary,initialPid:stopped.pid,resumedPid:resumed.pid,status:resumed.status,completedAdapterReturns:calls(),effectState:resumed.effect.state}));
});
