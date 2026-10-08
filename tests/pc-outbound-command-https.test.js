import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { X509Certificate } from 'node:crypto';
import { startPcOutboundNodeService } from '../packages/core/src/client/pc-outbound-service.js';
import { createPcOutboundCommandTransport,createPcOutboundTransport } from '../packages/core/src/client/pc-outbound-https.js';

const pem=name=>readFileSync(new URL(`./fixtures/google-broker-tls/${name}.pem`,import.meta.url));
async function fixture(t,enabled=true){
  const root=await mkdtemp(join(tmpdir(),'jarvis-command-tls-'));let now=Date.now(),epoch=1;
  const relay=await startPcOutboundNodeService({dbPath:join(root,'relay.sqlite'),commandTransport:enabled,clock:()=>now,authorityGuard:()=>({token:epoch}),tls:{key:pem('server-key'),cert:pem('server'),ca:pem('ca')}});
  const transports=[];t.after(async()=>{for(const channel of transports)channel.close();await relay.close();await rm(root,{recursive:true,force:true});});
  const transport=(cert='core')=>{const value=createPcOutboundCommandTransport({url:`https://127.0.0.1:${relay.address.port}/v1/pc/command`,key:pem(`${cert}-key`),cert:pem(cert),ca:pem('ca')});transports.push(value);return value;};
  relay.controller.enroll({deviceId:'pc',certificateFingerprint:new X509Certificate(pem('core')).fingerprint256,allowedTaskIds:['task'],expiresAt:new Date(now+60000).toISOString().replace(/\.\d{3}Z$/u,'Z'),expectedGeneration:0});
  const action={toolName:'filesystem.createTextFile',arguments:{path:'result.txt',content:'원문'}},operationId=`mission_op_${'a'.repeat(32)}`;
  const packet={taskId:'task',idempotencyKey:operationId,action,capabilityToken:{capabilityToken:'synthetic-not-a-valid-B-grant'}};
  const request={requestId:'request',deviceId:'pc',taskId:'task',operationId,action,kind:'prepare',body:{packet}};
  return {relay,transport,request,grant:()=>relay.commandMailbox.grant({deviceId:'pc',expectedGeneration:1,allowedTaskIds:['task'],expiresAt:now+50000}),advance:ms=>now+=ms,nextAuthority:()=>epoch++};
}
test('command HTTPS is absent unless explicitly enabled; read transport cannot use its path',async t=>{
  const f=await fixture(t,false);assert.equal(f.relay.commandMailbox,null);
  await assert.rejects(f.transport().exchange('pull',{}),/ROUTE_DENIED/u);
  assert.throws(()=>createPcOutboundTransport({url:'https://localhost/v1/pc/command',key:pem('core-key'),cert:pem('core'),ca:pem('ca')}),/CONFIG_INVALID/u);
});
test('trusted CA alone cannot pull commands for an unenrolled certificate',async t=>{
  const f=await fixture(t);f.grant();f.relay.commandMailbox.enqueue(f.request);
  await assert.rejects(f.transport('other').exchange('pull',{}),/DEVICE_DENIED/u);
  assert.equal(f.relay.commandMailbox.status('request').state,'queued');
});
for(const kind of ['prepare','execute','cancel'])test(`mTLS ${kind} delivery validates current lease and binds response`,async t=>{
  const f=await fixture(t),channel=f.transport();f.grant();
  const body=kind==='prepare'?f.request.body:kind==='execute'?{...f.request.body,ticket:'synthetic-ticket',generation:1}:{taskId:f.request.taskId,operationId:f.request.operationId,action:f.request.action};
  f.relay.commandMailbox.enqueue({...f.request,kind,body});const delivered=await channel.exchange('pull',{});
  assert.equal(delivered.kind,kind);assert.deepEqual(delivered.body,body);assert.equal(delivered.executionAuthority,false);
  assert.equal((await channel.exchange('validate',{requestId:delivered.requestId,lease:delivered.lease})).allowed,true);
  assert.equal(await channel.exchange('pull',{}),null);
  await channel.exchange('submit',{requestId:delivered.requestId,lease:delivered.lease,result:{status:'transport-received'}});
  assert.equal(f.relay.commandMailbox.status('request').result.status,'transport-received');
  await assert.rejects(channel.exchange('validate',{requestId:delivered.requestId,lease:delivered.lease}),/LEASE_INVALID/u);
  await assert.rejects(channel.exchange('submit',{requestId:delivered.requestId,lease:delivered.lease,result:{status:'changed'}}),/RESULT_CONFLICT/u);
});
for(const change of ['scope','authority','expire','device'])test(`mTLS lease recheck rejects ${change} before dispatch`,async t=>{
  const f=await fixture(t),channel=f.transport();f.grant();f.relay.commandMailbox.enqueue(f.request);const delivered=await channel.exchange('pull',{});
  if(change==='scope')f.grant();if(change==='authority')f.nextAuthority();if(change==='expire')f.advance(15001);if(change==='device')f.relay.controller.revoke('pc',{expectedGeneration:1});
  await assert.rejects(channel.exchange('validate',{requestId:delivered.requestId,lease:delivered.lease}),/LEASE_INVALID|SCOPE_CHANGED|DEVICE_DENIED/u);
  await assert.rejects(channel.exchange('submit',{requestId:delivered.requestId,lease:delivered.lease,result:{status:'late'}}));
  if(change==='expire')assert.equal(f.relay.commandMailbox.status('request').state,'uncertain');
});
test('PC command endpoint cannot grant, enqueue, observe arbitrary URL or supply extra validation fields',async t=>{
  const f=await fixture(t),channel=f.transport();
  for(const body of [1,'',[],null])await assert.rejects(channel.exchange('pull',body),/REQUEST_INVALID/u);
  for(const operation of ['grant','enqueue','read-url'])await assert.rejects(channel.exchange(operation,f.request),/REQUEST_INVALID/u);
  await assert.rejects(channel.exchange('validate',{requestId:'request',lease:'forged',url:'https://example.test'}),/REQUEST_INVALID/u);
  assert.throws(()=>f.relay.commandMailbox.enqueue(f.request),/EXECUTION_SCOPE_DENIED/u);
});
