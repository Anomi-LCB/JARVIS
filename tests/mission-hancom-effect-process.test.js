import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,existsSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
for(const format of ['hwp','hwpx'])for(const boundary of ['prepared','b-receipt','receipt-persisted','partial','changed','source-changed','authority'])test(`actual ${format} effect process recovery: ${boundary}`,{skip:process.env.JARVIS_NATIVE_HWP_TEST!=='1'||process.platform!=='win32',timeout:180000},async t=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-hancom-process-')),children=new Set();
 t.after(async()=>{for(const c of children)if(c.exitCode===null&&c.signalCode===null){const end=once(c,'exit');c.kill('SIGKILL');await end;}rmSync(root,{recursive:true,force:true});});
 const calls=()=>existsSync(join(root,'calls.jsonl'))?readFileSync(join(root,'calls.jsonl'),'utf8').trim().split('\n').length:0;
 const launch=async mode=>{const c=fork(new URL('./fixtures/hancom-effect-process-child.mjs',import.meta.url),[root,mode,format],{windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});children.add(c);let stderr='';c.stderr.on('data',v=>stderr+=v);
  const next=()=>new Promise((resolve,reject)=>{const cleanup=()=>{clearTimeout(timer);c.off('message',message);c.off('exit',exit);};const message=v=>{cleanup();v.type==='error'?reject(Error(v.message+'\n'+v.stack)):resolve(v);};const exit=code=>{cleanup();reject(Error(`child exited ${code}: ${stderr}`));};const timer=setTimeout(()=>{cleanup();reject(Error('hancom boundary timeout: '+stderr));},120000);c.once('message',message);c.once('exit',exit);});
  assert.equal((await next()).type,'ready');return {run(){const reply=next();c.send('run');return reply;},async kill(){const end=once(c,'exit');c.kill('SIGKILL');await end;children.delete(c);}};};
 const initial=await launch(['changed','source-changed'].includes(boundary)?'b-receipt':boundary),stopped=await initial.run();await initial.kill();
 if(boundary.startsWith('authority')){assert.equal(stopped.status,'COMPLETED',JSON.stringify({lastError:stopped.lastError,recovery:stopped.recovery,task:stopped.task,verificationFailures:stopped.verificationFailures}));assert.equal(stopped.effect.state,'succeeded');assert.equal(stopped.bClaims,0);assert.equal(stopped.outputExists,true);assert.equal(stopped.effect.intent.request.artifactPlan.hancomPublication.verifyRendering,true);assert.match(stopped.effect.intent.request.artifactPlan.paths[0],format==='hwpx'?/\.hwpx$/u:/\.hwp$/u);return;}
 const before=calls(),resumed=await(await launch(['changed','source-changed'].includes(boundary)?boundary==='changed'?'resume-changed':'resume-source-changed':'resume')).run();
 if(['partial','changed','source-changed'].includes(boundary)){
  assert.notEqual(resumed.status,'COMPLETED');assert.equal(calls(),before);assert.equal(resumed.effect.state,'uncertain');
  assert.equal(resumed.outputExists,true);
 }else{
  assert.equal(resumed.status,'COMPLETED',JSON.stringify({recovery:resumed.recovery,verificationFailures:resumed.verificationFailures}));assert.equal(calls(),1);
  assert.equal(resumed.effect.state,'succeeded');assert.equal(resumed.effect.operation_id,resumed.effect.provider_idempotency_key);
  assert.equal(resumed.bClaims,0,'completed original B receipt must release all hancom input/output claims');
  assert.deepEqual(resumed.keys,[resumed.effect.operation_id]);assert.ok(resumed.effect.receipt.evidenceId);
  assert.equal(resumed.outputExists,true);
  assert.equal(resumed.effect.operation_id,stopped.operationId);assert.equal(resumed.effect.effect_id,stopped.effectId);
  const repeated=await(await launch('resume')).run();assert.equal(repeated.status,'COMPLETED');assert.equal(calls(),1);assert.deepEqual(repeated.effect.receipt,resumed.effect.receipt);
 }
 t.diagnostic(JSON.stringify({boundary,initialPid:stopped.pid,resumedPid:resumed.pid,status:resumed.status,completedAdapterReturns:calls(),effectState:resumed.effect.state}));
});

