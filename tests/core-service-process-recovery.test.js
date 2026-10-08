import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync,readFileSync,writeFileSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createWorkspaceClient } from '../src/ui/workspace/client.js';
import {loadRuntimeConnectionStatus} from '../src/ui/connections/runtime-status.js';

function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'jarvis-service-process-')),children=new Set();
 t.after(async()=>{for(const child of children)if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}rmSync(root,{recursive:true,force:true});});
 const calls=()=>readFileSync(join(root,'actual-adapter-calls.jsonl'),'utf8').trim().split('\n').length;
 const launch=async(mode,token=0)=>{
  const child=fork(new URL('./fixtures/configured-service-crash-child.mjs',import.meta.url),[root,mode,String(token)],
   {windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});children.add(child);
  let stderr='';child.stderr.on('data',data=>{stderr+=data;});
  const next=()=>new Promise((resolve,reject)=>{
   const cleanup=()=>{clearTimeout(timer);child.off('message',message);child.off('exit',exit);};
   const message=value=>{cleanup();resolve(value);};
   const exit=code=>{cleanup();reject(new Error(`Child exit ${code}: ${stderr}`));};
   const timer=setTimeout(()=>{cleanup();reject(new Error(`Child timeout: ${stderr}`));},15000);
   child.once('message',message);child.once('exit',exit);
  });
  const first=await next();
  return {child,first,next,async kill(){const exited=once(child,'exit');child.kill('SIGKILL');await exited;children.delete(child);},
   async run(){const reply=next();child.send({type:'run'});return reply;}};
 };
 return {root,calls,launch};
}
for(const scenario of ['receipt-persisted','receipt-tampered','file-effect'])test(`configured service OS crash recovery: ${scenario}`,async t=>{
 const f=fixture(t),original=await f.launch(scenario==='receipt-tampered'?'receipt-persisted':scenario);
 assert.equal(original.first.type,'ready');
 const boundary=await original.run();assert.equal(boundary.type,'boundary',JSON.stringify(boundary));
 assert.equal(f.calls(),1);
 const competitor=await f.launch('recover',boundary.token);
 assert.equal(competitor.first.type,'startup-error');assert.equal(competitor.first.code,'A_CORE_AUTHORITY_ANOTHER_CORE_ACTIVE');
 await original.kill();
 if(scenario==='receipt-tampered')writeFileSync(join(f.root,'workspace/result.txt'),'user changed file');
 // Actual wall-clock expiration: no injected clock or SQLite timestamp edits.
 await delay(1300);
 const normal=await f.launch('normal',boundary.token);
 assert.equal(normal.first.type,'startup-error');assert.equal(normal.first.code,'A_CORE_AUTHORITY_MISSIONS_ACTIVE');
 const recovered=await f.launch('recover',boundary.token);
 assert.equal(recovered.first.type,'ready',JSON.stringify(recovered.first));
 assert.equal(recovered.first.executionMode,'recovery-only');assert.equal(recovered.first.token,boundary.token+1);
 const currentStatus=await loadRuntimeConnectionStatus({request:async path=>{
  const response=await fetch(`http://127.0.0.1:${recovered.first.port}${path}`,{headers:{authorization:'Bearer local-core-admin'}});
  if(!response.ok)throw new Error('status unavailable');return response.json();
 }});
 assert.equal(currentStatus.connected,true);assert.equal(currentStatus.mode,'recovery-only');assert.equal(currentStatus.workCompletionVerified,false);
 const client=createWorkspaceClient({storage:null,fetchImpl:(url,options)=>fetch(
  `http://127.0.0.1:${recovered.first.port}${url.replace(/^\/api\/core/u,'')}`,
  {...options,headers:{...options.headers,authorization:'Bearer local-core-admin'}})});
 const result=await client.reconcileMission(boundary.missionId);
 assert.equal(result.missionId,boundary.missionId);assert.equal(f.calls(),1);
 assert.equal(result.status,scenario==='receipt-persisted'?'COMPLETED':'PAUSED',JSON.stringify({status:result.status,stopReason:result.stopReason,recovery:result.waves?.[0]?.actions?.[0]?.recovery}));
 assert.equal(readFileSync(join(f.root,'workspace/result.txt'),'utf8'),scenario==='receipt-tampered'?'user changed file':'실제 서비스 프로세스 복구');
 const replay=await client.reconcileMission(boundary.missionId);assert.equal(replay.status,result.status);assert.equal(f.calls(),1);
 const denied=await fetch(`http://127.0.0.1:${recovered.first.port}/missions`,{method:'POST',headers:{authorization:'Bearer local-core-admin','content-type':'application/json'},body:JSON.stringify({objective:'새 텍스트 파일을 만들어줘'})});
 const deniedResult=await denied.json();assert.equal(deniedResult.error.code,'A_CORE_AUTHORITY_RECOVERY_ONLY');assert.equal(f.calls(),1);
 if(scenario==='receipt-persisted'){
  const closed=recovered.next();recovered.child.send({type:'close'});assert.equal((await closed).type,'closed');
  const next=await f.launch('normal',recovered.first.token);assert.equal(next.first.type,'ready');assert.equal(next.first.executionMode,'standard');
  const observed=await fetch(`http://127.0.0.1:${next.first.port}/missions/${encodeURIComponent(boundary.missionId)}`,{headers:{authorization:'Bearer local-core-admin'}});
  assert.equal((await observed.json()).status,'COMPLETED');assert.equal(f.calls(),1);
 }
 t.diagnostic(JSON.stringify({scenario,actualOSKill:true,realLeaseExpiration:true,sameMission:true,adapterCalls:f.calls(),finalStatus:result.status}));
});
