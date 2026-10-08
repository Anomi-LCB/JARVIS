import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join,resolve,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
async function launch(root,token){
 const child=fork(new URL('./fixtures/default-read-restart-core.mjs',import.meta.url),[root,String(token)],{windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});
 let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});
 let ready;try{ready=await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{cleanup();reject(Error('child startup timeout: '+stderr));},20000);
  const message=data=>{cleanup();data.type==='ready'?resolve(data):reject(Error(JSON.stringify(data)));};
  const exit=code=>{cleanup();reject(Error('child exited '+code+': '+stderr));};
  const cleanup=()=>{clearTimeout(timer);child.off('message',message);child.off('exit',exit);};
  child.once('message',message);child.once('exit',exit);
 });}catch(error){if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill();await exited;}throw error;}
 const base=`http://127.0.0.1:${ready.port}`,headers={authorization:'Bearer synthetic-default-read-admin','content-type':'application/json'};
 return {child,ready,base,async request(path,body){const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers,...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});return {status:response.status,body:await response.json()};},
  async stop(){const exited=once(child,'exit');child.send({type:'stop'});const [code]=await exited;assert.equal(code,0);}};
}
for(const changed of [false,true])test(`authenticated default read resumes in a different Core process: changed=${changed}`,{timeout:50000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-default-http-restart-'));let first,second;
 const source='자료😀\n'.repeat(24000),objective="'source.txt'를 읽어";
 try{
  await mkdir(join(root,'workspace'));await writeFile(join(root,'workspace/source.txt'),source);await writeFile(join(root,'calls.jsonl'),'');
  first=await launch(root,0);
  const unauthorized=await fetch(first.base+'/missions');assert.equal(unauthorized.status,401);
  const created=await first.request('/missions',{objective,idempotencyKey:'default-read-http',authorization:{grants:['read_only']},metadata:{longTermMemory:false}});
  assert.equal(created.status,201);assert.equal(created.body.successCriteria[0].statement,objective);
  const id=created.body.missionId,route='/missions/'+encodeURIComponent(id);
  const partial=await first.request(route+'/run',{maxWaves:1});
  assert.equal(partial.body.status,'PAUSED');assert.equal(partial.body.observations.length,1);
  assert.equal(partial.body.observations[0].data.textRead.returnedChars,50000);
  const token=first.ready.authority.token,firstPid=first.ready.pid,keyHash=first.ready.keySha256;
  await first.stop();first=null;
  if(changed)await writeFile(join(root,'workspace/source.txt'),'changed input');
  second=await launch(root,token);
  assert.notEqual(second.ready.pid,firstPid);assert.equal(second.ready.keySha256,keyHash);
  const resumed=await second.request(route+'/run',{maxWaves:8});
  const calls=(await readFile(join(root,'calls.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  if(changed){assert.equal(resumed.body.status,'PAUSED');assert.equal(resumed.body.stopReason,'mission-text-read-evidence-invalidated');assert.equal(resumed.body.metrics.plannerAttempts,0);assert.deepEqual(calls.map(c=>c.offset),[0]);assert.equal(await readFile(join(root,'workspace/source.txt'),'utf8'),'changed input');}
  else{
   assert.equal(resumed.body.status,'COMPLETED',JSON.stringify(resumed.body.verificationSummary));
   assert.equal(resumed.body.metrics.plannerAttempts,0);assert.deepEqual(calls.map(c=>c.offset),[0,50000,100000]);
   assert.equal(resumed.body.successCriteria[0].statement,objective);
   const again=await second.request('/missions',{objective,idempotencyKey:'default-read-http',authorization:{grants:['read_only']},metadata:{longTermMemory:false}});
   assert.equal(again.body.missionId,id);assert.equal(again.body.status,'COMPLETED');
   assert.equal(await readFile(join(root,'workspace/source.txt'),'utf8'),source);
  }
  assert.ok(calls.every(c=>c.tool==='filesystem.readText'));
  console.log(JSON.stringify({changed,status:resumed.body.status,firstPid,secondPid:second.ready.pid,offsets:calls.map(c=>c.offset),keyPreserved:true,externalModelCalls:0}));
 }finally{
  if(first)await first.stop();if(second)await second.stop();assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(basename(root).startsWith('jarvis-default-http-restart-'));await rm(root,{recursive:true,force:true});
 }
});
