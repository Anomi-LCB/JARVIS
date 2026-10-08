import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,existsSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
for(const boundary of ['authority','prepared','b-receipt','receipt-persisted','published','changed','forged','revoked','scope','store-switch'])test(`actual macro control-store SQL recovery: ${boundary}`,{timeout:60000},async t=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-macro-effect-')),children=new Set();
 t.after(async()=>{for(const c of children)if(c.exitCode===null&&c.signalCode===null){const end=once(c,'exit');c.kill('SIGKILL');await end;}rmSync(root,{recursive:true,force:true});});
 const calls=()=>existsSync(join(root,'calls.jsonl'))?readFileSync(join(root,'calls.jsonl'),'utf8').trim().split('\n').length:0;
 const launch=async mode=>{const c=fork(new URL('./fixtures/macro-effect-process-child.mjs',import.meta.url),[root,mode],{windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});children.add(c);let stderr='';c.stderr.on('data',v=>stderr+=v);
  const next=()=>new Promise((resolve,reject)=>{const cleanup=()=>{clearTimeout(timer);c.off('message',message);c.off('exit',exit);};const message=v=>{cleanup();v.type==='error'?reject(Error(v.message+'\n'+v.stack)):resolve(v);};const exit=code=>{cleanup();reject(Error(`child exited ${code}: ${stderr}`));};const timer=setTimeout(()=>{cleanup();reject(Error('macro boundary timeout: '+stderr));},25000);c.once('message',message);c.once('exit',exit);});
  assert.equal((await next()).type,'ready');return {run(){const reply=next();c.send('run');return reply;},async kill(){const end=once(c,'exit');c.kill('SIGKILL');await end;children.delete(c);}};};
 const initial=await launch(boundary==='changed'?'b-receipt':boundary),stopped=await initial.run();await initial.kill();
 if(['authority','forged','revoked','scope','store-switch'].includes(boundary)){
  if(boundary==='authority'){assert.equal(stopped.status,'COMPLETED',JSON.stringify(stopped));assert.equal(stopped.effect.state,'succeeded');assert.equal(stopped.bClaims,0);assert.equal(JSON.parse(stopped.output)['일일목록'].command,'파일 목록 확인');}
  else{assert.notEqual(stopped.status,'COMPLETED');if(boundary==='forged'){assert.equal(stopped.effect.state,'uncertain');assert.equal(stopped.outputExists,true);}else{assert.equal(stopped.outputExists,false);assert.equal(existsSync(join(root,'control','other.json')),false);}}
  return;
 }
 assert.equal(stopped.type,'boundary',JSON.stringify(stopped));
 const before=calls(),resumed=await(await launch(boundary==='changed'?'resume-changed':'resume')).run();
 assert.notEqual(resumed.pid,stopped.pid);
 if(['published','changed'].includes(boundary)){assert.notEqual(resumed.status,'COMPLETED');assert.equal(calls(),before);assert.equal(resumed.effect.state,'uncertain');assert.equal(resumed.outputExists,true);}
 else{assert.equal(resumed.status,'COMPLETED',JSON.stringify(resumed));assert.equal(calls(),1);assert.equal(resumed.effect.state,'succeeded');assert.equal(resumed.effect.operation_id,resumed.effect.provider_idempotency_key);assert.equal(resumed.bClaims,0);assert.deepEqual(resumed.keys,[resumed.effect.operation_id]);assert.equal(resumed.effect.operation_id,stopped.operationId);assert.equal(resumed.effect.effect_id,stopped.effectId);
  const repeated=await(await launch('resume')).run();assert.equal(repeated.status,'COMPLETED');assert.equal(calls(),1);assert.deepEqual(repeated.effect.receipt,resumed.effect.receipt);}
 t.diagnostic(JSON.stringify({boundary,initialPid:stopped.pid,resumedPid:resumed.pid,status:resumed.status,calls:calls(),effectState:resumed.effect.state}));
});
