import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {X509Certificate} from 'node:crypto';
import {PcLocalTaskScope} from '../apps/pc-agent/src/pc-local-task-scope.js';
import {createPcOutboundObserver} from '../apps/pc-agent/src/outbound-observer.js';
import {startPcOutboundNodeService} from '../packages/core/src/client/pc-outbound-service.js';
import {createPcOutboundTransport} from '../packages/core/src/client/pc-outbound-https.js';
import {validPcReadiness} from '../packages/shared/src/pc-readiness-contract.js';
const pem=name=>readFileSync(new URL(`./fixtures/google-broker-tls/${name}.pem`,import.meta.url));
const peer=new X509Certificate(pem('core')).fingerprint256;
async function fixture(t,{mode='normal'}={}){
  const root=await mkdtemp(join(tmpdir(),'jarvis-readiness-'));let now=Date.now(),epoch=1;
  const scope=new PcLocalTaskScope({dbPath:join(root,'local.sqlite'),managedCatalog:true,clock:()=>now});
  scope.replaceCatalog({expectedRevision:0,allowedTaskIds:['task'],allowedArtifactTaskIds:mode==='local-catalog'?[]:['task'],allowedCommandTaskIds:mode==='local-catalog'?[]:['task']});
  if(!['local-catalog','local-grant'].includes(mode))scope.replace({expectedRevision:1,allowedTaskIds:['task'],expiresAt:now+60000});
  const service=await startPcOutboundNodeService({dbPath:join(root,'core.sqlite'),clock:()=>now,authorityGuard:()=>({token:epoch}),commandTransport:true,tls:{key:pem('server-key'),cert:pem('server'),ca:pem('ca')}});
  service.controller.enroll({deviceId:'pc',certificateFingerprint:peer,allowedTaskIds:['task'],allowedArtifactTaskIds:mode==='core-artifact'?[]:['task'],expiresAt:new Date(now+120000).toISOString().replace(/\.\d{3}Z$/u,'Z'),expectedGeneration:0});
  if(mode!=='core-command')service.commandMailbox.grant({deviceId:'pc',expectedGeneration:1,allowedTaskIds:['task'],expiresAt:now+60000});
  const transport=createPcOutboundTransport({url:`https://127.0.0.1:${service.address.port}/v1/pc/observe`,key:pem('core-key'),cert:pem('core'),ca:pem('ca')});
  const observer=createPcOutboundObserver({taskCatalog:scope,transport,pcClient:{health:async()=>({status:'ok'})},clock:()=>now});
  t.after(async()=>{transport.close();await service.close();scope.close();await rm(root,{recursive:true,force:true});});
  const enqueue=id=>service.controller.enqueue('pc',{requestId:id,operation:'task-readiness',taskId:'task'});
  return {scope,service,observer,transport,enqueue,advance:ms=>now+=ms,rotate:()=>epoch++,now:()=>now};
}
for(const mode of ['normal','local-catalog','local-grant','core-command','core-artifact'])test(`actual mTLS same-device readiness compares PC and Core scopes: ${mode}`,async t=>{
  const f=await fixture(t,{mode});f.enqueue('readiness');await f.observer.tick();const result=f.service.controller.result('readiness');
  assert.equal(result.observationCurrent,true);assert.equal(result.deviceId,'pc');assert.equal(result.deviceGeneration,1);
  const readiness=result.configurationReadiness;assert.equal(readiness.status,mode==='normal'?'configuration-matched':'not-matched');assert.equal(readiness.executionAuthority,false);assert.equal(readiness.verifiedCompletion,false);
  const codes={'local-catalog':'B_PC_COMMAND_LOCAL_CATALOG_MISSING','local-grant':'B_PC_COMMAND_LOCAL_PERMISSION_MISSING','core-command':'CORE_COMMAND_SCOPE_MISSING','core-artifact':'CORE_ARTIFACT_SCOPE_MISSING'};
  if(mode!=='normal')assert.ok(readiness.issues.some(issue=>issue.code===codes[mode]));
  assert.doesNotMatch(JSON.stringify(result),/local\.sqlite|core\.sqlite|PRIVATE KEY/u);
});
test('same-device observation expires, authority rotates and revocation invalidate a previous match',async t=>{
  const f=await fixture(t);f.enqueue('first');await f.observer.tick();assert.equal(f.service.controller.result('first').configurationReadiness.status,'configuration-matched');
  f.advance(16000);assert.equal(f.service.controller.result('first').configurationReadiness.status,'not-matched');
  f.enqueue('second');await f.observer.tick();f.rotate();assert.equal(f.service.controller.result('second').configurationReadiness.status,'not-matched');
  f.enqueue('third');await f.observer.tick();f.service.controller.revoke('pc',{expectedGeneration:1});assert.equal(f.service.controller.result('third').configurationReadiness.status,'not-matched');
});
test('Core scope and local permission expiry after an observation are checked again by comparison',async t=>{
  const f=await fixture(t);f.enqueue('first');await f.observer.tick();
  f.service.commandMailbox.grant({deviceId:'pc',expectedGeneration:1,expectedRevision:1,allowedTaskIds:[],expiresAt:f.now()+60000});
  assert.ok(f.service.controller.result('first').configurationReadiness.issues.some(issue=>issue.code==='CORE_COMMAND_SCOPE_MISSING'));
  f.advance(61000);f.enqueue('expired');await f.observer.tick();assert.ok(f.service.controller.result('expired').configurationReadiness.issues.some(issue=>issue.code==='B_PC_COMMAND_LOCAL_PERMISSION_EXPIRED'));
});
test('readiness cannot query unselected tasks or accept wrong identities, authority or secret payload fields',async t=>{
  const f=await fixture(t);assert.throws(()=>f.service.controller.enqueue('pc',{requestId:'bad',operation:'task-readiness',taskId:'other'}),/READ_SCOPE_DENIED/u);
  f.enqueue('strict');const packet=f.service.controller.mailbox.pull(peer),value=f.scope.commandReadiness('task');
  for(const patch of [{taskId:'other'},{executionAuthority:true},{locallyReady:true,registered:false},{path:'secret'},{catalogRevision:-1},{reason:'run shell'}]){
    const submitted={...value,...patch};assert.equal(validPcReadiness(submitted,'task'),false);
    assert.throws(()=>f.service.controller.mailbox.submit(peer,{requestId:packet.requestId,generation:packet.generation,lease:packet.lease,result:{status:'observed',value:submitted}}),/RESULT_INVALID/u);
  }
  const other=createPcOutboundTransport({url:`https://127.0.0.1:${f.service.address.port}/v1/pc/observe`,key:pem('other-key'),cert:pem('other'),ca:pem('ca')});
  try{await assert.rejects(other.exchange('pull',{}),/DEVICE_DENIED/u);}finally{other.close();}
});
test('permission revoked after lost ACK prevents replay of a previous ready snapshot',async t=>{
  const f=await fixture(t);f.enqueue('lost');let submitted=0;
  const observer=createPcOutboundObserver({taskCatalog:f.scope,pcClient:{health:async()=>({})},transport:{exchange:async(op,input)=>{
    if(op==='submit'){submitted++;await f.transport.exchange(op,input);throw new Error('lost ACK');}return f.transport.exchange(op,input);
  }}});
  await assert.rejects(observer.tick(),/lost ACK/u);assert.equal(submitted,1);
  f.scope.replace({expectedRevision:2,allowedTaskIds:[],expiresAt:0});assert.equal((await observer.tick()).status,'scope-changed');assert.equal(submitted,1);
  // Already accepted bytes are historical configuration, not a revocable execution grant.
  assert.equal(f.service.controller.result('lost').configurationReadiness.executionAuthority,false);
});
