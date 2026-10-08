import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,realpathSync,statSync,existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {X509Certificate,createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createRemoteArtifactBinding} from '../packages/core/src/mission/remote-artifact-contract.js';
import {createWorkspaceClient} from '../src/ui/workspace/client.js';

function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'jarvis-outbound-service-process-')),workspace=join(root,'workspace');mkdirSync(workspace);
 const stat=statSync(workspace,{bigint:true}),rootScopeSha256=createHash('sha256').update(JSON.stringify([{path:workspace,physical:realpathSync(workspace),dev:stat.dev.toString(),ino:stat.ino.toString()}])).digest('hex');
 const binding=createRemoteArtifactBinding({deviceId:'process-pc',deviceGeneration:1,certificateFingerprint:new X509Certificate(readFileSync(new URL('./fixtures/google-broker-tls/core.pem',import.meta.url))).fingerprint256,pathPlatform:process.platform==='win32'?'win32':'posix',allowedRoots:[workspace],rootScopeSha256});
 writeFileSync(join(root,'binding.json'),JSON.stringify(binding));const children=new Set();
 t.after(async()=>{for(const c of children)if(c.exitCode===null&&c.signalCode===null){const exited=once(c,'exit');c.kill('SIGKILL');await exited;}rmSync(root,{recursive:true,force:true});});
 const count=name=>existsSync(join(root,name))?readFileSync(join(root,name),'utf8').trim().split('\n').length:0;
 const launch=async(role,mode='initial',token=0)=>{
  const child=fork(new URL('./fixtures/configured-outbound-crash-child.mjs',import.meta.url),[role,root,mode,String(token)],{windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});children.add(child);
  let stderr='';child.stderr.on('data',data=>{stderr+=data;});
  // Queue IPC observations before waiting: messages may arrive back-to-back.
  const queue=[],waiters=[];child.on('message',value=>{const waiter=waiters.shift();if(waiter)waiter.resolve(value);else queue.push(value);});
  child.on('exit',code=>{for(const w of waiters.splice(0))w.reject(new Error(`Child exit ${code}: ${stderr}`));});
  const next=()=>queue.length?Promise.resolve(queue.shift()):new Promise((resolve,reject)=>{
   const waiter={resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}};
   const timer=setTimeout(()=>{const index=waiters.indexOf(waiter);if(index>=0)waiters.splice(index,1);reject(new Error(`Child timeout: ${stderr}`));},20000);waiters.push(waiter);
  });
  const first=await next();return {child,first,next,async kill(){const exited=once(child,'exit');child.kill('SIGKILL');await exited;children.delete(child);}};
 };
 return {root,workspace,rootScopeSha256,count,launch};
}
for(const scenario of ['unchanged','tampered','offline-then-return'])test(`outbound configured service Core process crash, PC preserved: ${scenario}`,async t=>{
 const f=fixture(t),pc=await f.launch('pc'),core=await f.launch('core');assert.equal(pc.first.type,'ready');assert.equal(core.first.type,'ready');assert.notEqual(pc.first.pid,core.first.pid);
 core.child.send({type:'run'});const prepared=await core.next();assert.equal(prepared.type,'prepared',JSON.stringify(prepared));
 pc.child.send({type:'connect',port:core.first.relayPort,taskId:prepared.taskId,rootScopeSha256:f.rootScopeSha256,provision:true,dropAck:true});
 const connected=await pc.next();assert.equal(connected.type,'connected');core.child.send({type:'provision'});
 const completed=await Promise.race([pc.next(),core.next()]);assert.equal(completed.type,'completed-reply-lost',JSON.stringify(completed));assert.equal(f.count('pc-executions.jsonl'),1);assert.equal(f.count('pc-deliveries.jsonl'),1);
 await core.kill();assert.equal(pc.child.exitCode,null);assert.equal(pc.child.signalCode,null);
 if(scenario==='tampered')writeFileSync(join(f.workspace,'result.txt'),'changed while Core offline');
 await delay(1300);
 const resumed=await f.launch('core','recover',core.first.token);assert.equal(resumed.first.type,'ready',JSON.stringify(resumed.first));assert.equal(resumed.first.executionMode,'recovery-only');
 const client=createWorkspaceClient({storage:null,fetchImpl:(url,options)=>fetch(`http://127.0.0.1:${resumed.first.port}${url.replace(/^\/api\/core/u,'')}`,{...options,headers:{...options.headers,authorization:'Bearer local-core-admin'}})});
 if(scenario==='offline-then-return'){
  const waiting=await client.reconcileMission(prepared.missionId);assert.equal(waiting.status,'PAUSED');assert.equal(f.count('pc-executions.jsonl'),1);
 }
 pc.child.send({type:'connect',port:resumed.first.relayPort,taskId:prepared.taskId,rootScopeSha256:f.rootScopeSha256,provision:false,dropAck:false});
 const reconnected=await pc.next();assert.equal(reconnected.type,'connected');assert.equal(reconnected.pid,connected.pid);assert.equal(reconnected.scopeRevision,connected.scopeRevision);assert.equal(reconnected.catalogRevision,connected.catalogRevision);
 const result=await client.reconcileMission(prepared.missionId);
 const configuration=await fetch(`http://127.0.0.1:${resumed.first.port}/pc-nodes`,{headers:{authorization:'Bearer local-core-admin'}}).then(r=>r.json());
 assert.equal(configuration.executionConfiguration.configured,true);assert.equal(configuration.executionConfiguration.registrationMatch,true);assert.equal(configuration.executionConfiguration.executionMode,'recovery-only');assert.equal(configuration.executionConfiguration.completionVerified,false);
 if(scenario==='unchanged')console.log(JSON.stringify({pcBindingUiEvidence:configuration}));
 assert.equal(result.missionId,prepared.missionId);assert.equal(result.waves[0].actions[0].effect.effectId,prepared.effectId);
 assert.equal(result.status,scenario==='tampered'?'PAUSED':'COMPLETED',JSON.stringify({status:result.status,stopReason:result.stopReason,recovery:result.waves[0].actions[0].recovery}));
 assert.equal(f.count('pc-executions.jsonl'),1);assert.equal(f.count('pc-deliveries.jsonl'),1);assert.equal(f.count('forbidden-core-execution.jsonl'),0);
 assert.equal(readFileSync(join(f.workspace,'result.txt'),'utf8'),scenario==='tampered'?'changed while Core offline':'원격 서비스 프로세스 복구');
 const again=await client.reconcileMission(prepared.missionId);assert.equal(again.status,result.status);assert.equal(f.count('pc-executions.jsonl'),1);
 t.diagnostic(JSON.stringify({scenario,actualCoreProcessKill:true,pcProcessPreserved:true,realLeaseExpiration:true,mTLS:true,sameMission:true,sameEffect:true,scopeUnchanged:true,pcExecutions:1,executeDeliveries:1,localFallback:0,status:result.status}));
});
