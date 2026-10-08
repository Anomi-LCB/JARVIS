import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PcOutboundMailbox } from '../packages/core/src/client/pc-outbound-mailbox.js';
import { PcOutboundCommandMailbox } from '../packages/core/src/client/pc-outbound-command-mailbox.js';

function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'jarvis-command-mailbox-'));let now=Date.now(),epoch=1,mailbox,commands;
  const open=()=>{mailbox=new PcOutboundMailbox({dbPath:join(root,'test.sqlite'),clock:()=>now,authorityGuard:()=>({token:epoch}),leaseMs:100});commands=new PcOutboundCommandMailbox({mailbox});};open();
  t.after(()=>{mailbox.close();rmSync(root,{recursive:true,force:true});});
  const peer='A'.repeat(64),deviceId='pc';
  mailbox.enroll({deviceId,certificateFingerprint:peer,allowedTaskIds:['task'],expiresAt:now+60000});
  const action={toolName:'filesystem.createTextFile',arguments:{path:'result.txt',content:'test'}};
  const operationId=`mission_op_${'a'.repeat(32)}`,packet={taskId:'task',idempotencyKey:operationId,action,capabilityToken:{capabilityToken:'synthetic-test-token-not-a-real-B-grant'}};
  const request={deviceId,requestId:'request',taskId:'task',operationId,action,kind:'execute',body:{packet,ticket:'synthetic-ticket',generation:1}};
  const grant=()=>commands.grant({deviceId,expectedGeneration:1,allowedTaskIds:['task'],expiresAt:now+50000});
  return {peer,deviceId,request,grant,get mailbox(){return mailbox;},get commands(){return commands;},advance:ms=>now+=ms,nextAuthority:()=>epoch++,restart(){mailbox.close();open();}};
}

test('read enrollment alone cannot authorize command transport',t=>{
  const f=fixture(t);assert.throws(()=>f.commands.enqueue(f.request),/EXECUTION_SCOPE_DENIED/u);
  assert.equal(f.commands.pull(f.peer),null);assert.throws(()=>f.commands.grant({deviceId:f.deviceId,expectedGeneration:1,allowedTaskIds:['unselected'],expiresAt:Date.now()+1000}),/EXECUTION_SCOPE_INVALID/u);
});
test('explicit scoped command is delivered once and duplicate ACK must match',t=>{
  const f=fixture(t);assert.equal(f.grant().executionAuthority,false);
  assert.equal(f.commands.enqueue(f.request).state,'queued');assert.equal(f.commands.enqueue(f.request).state,'queued');
  const packet=f.commands.pull(f.peer);assert.equal(packet.kind,'execute');assert.equal(packet.executionAuthority,false);
  assert.equal(f.commands.pull(f.peer),null);const reply={status:'received-not-verified'};
  f.commands.submit(f.peer,{requestId:packet.requestId,lease:packet.lease,result:reply});
  assert.deepEqual(f.commands.status(packet.requestId).result,reply);
  f.commands.submit(f.peer,{requestId:packet.requestId,lease:packet.lease,result:reply});
  assert.throws(()=>f.commands.submit(f.peer,{requestId:packet.requestId,lease:packet.lease,result:{status:'other'}}),/RESULT_CONFLICT/u);
  assert.throws(()=>f.commands.enqueue({...f.request,requestId:'second'}),/OPERATION_ALREADY_QUEUED/u);
});
test('request fingerprint, task, operation and packet are bound before enqueue',t=>{
  const f=fixture(t);f.grant();
  for(const changed of [{taskId:'other'},{operationId:`mission_op_${'b'.repeat(32)}`},{action:{...f.request.action,arguments:{path:'other.txt',content:'test'}}},{body:{...f.request.body,packet:{...f.request.body.packet,capabilityToken:''}}}])
    assert.throws(()=>f.commands.enqueue({...f.request,...changed}),/BINDING_MISMATCH/u);
  assert.throws(()=>f.commands.enqueue({...f.request,body:{...f.request.body,arbitrary:'url'}}),/CONTRACT_INVALID/u);
  f.commands.enqueue(f.request);assert.throws(()=>f.commands.enqueue({...f.request,body:{...f.request.body,ticket:'changed'}}),/REQUEST_CONFLICT/u);
});
test('lost leased request stays uncertain after clock expiry and restart, never redelivered',t=>{
  const f=fixture(t);f.grant();f.commands.enqueue(f.request);const delivered=f.commands.pull(f.peer);
  f.advance(101);f.restart();assert.equal(f.commands.status('request').state,'uncertain');assert.equal(f.commands.pull(f.peer),null);
  assert.throws(()=>f.commands.submit(f.peer,{requestId:'request',lease:delivered.lease,result:{status:'late'}}),/LEASE_INVALID/u);
  assert.throws(()=>f.commands.enqueue({...f.request,requestId:'retry'}),/OPERATION_ALREADY_QUEUED/u);
});
for(const phase of ['queued','leased','observed'])test(`authority rotation invalidates ${phase} command`,t=>{
  const f=fixture(t);f.grant();f.commands.enqueue(f.request);let packet;
  if(phase!=='queued')packet=f.commands.pull(f.peer);
  if(phase==='observed')f.commands.submit(f.peer,{requestId:'request',lease:packet.lease,result:{status:'ack'}});
  f.nextAuthority();assert.equal(f.commands.status('request').state,'invalidated');assert.equal(f.commands.pull(f.peer),null);
  if(packet)assert.throws(()=>f.commands.submit(f.peer,{requestId:'request',lease:packet.lease,result:{status:'ack'}}),/AUTHORITY_CHANGED|LEASE_INVALID/u);
});
for(const change of ['revoke','rotate','scope','expire'])test(`device ${change} blocks stale delivery and observation`,t=>{
  const f=fixture(t);f.grant();f.commands.enqueue(f.request);const packet=f.commands.pull(f.peer);
  if(change==='revoke')f.mailbox.revoke(f.deviceId);
  if(change==='rotate')f.mailbox.enroll({deviceId:f.deviceId,certificateFingerprint:f.peer,expiresAt:Date.now()+60000,allowedTaskIds:['task'],expectedGeneration:1});
  if(change==='scope')f.commands.grant({deviceId:f.deviceId,expectedGeneration:1,allowedTaskIds:[],expiresAt:Date.now()+1000});
  if(change==='expire')f.advance(50001);
  assert.equal(f.commands.status('request').state,'invalidated');
  assert.throws(()=>f.commands.submit(f.peer,{requestId:'request',lease:packet.lease,result:{status:'late'}}));
});

test('renewed command delegation cannot revive an old observed result',t=>{
  const f=fixture(t);f.grant();f.commands.enqueue(f.request);const packet=f.commands.pull(f.peer);
  f.commands.submit(f.peer,{requestId:'request',lease:packet.lease,result:{status:'ack'}});
  f.grant();assert.equal(f.commands.status('request').state,'invalidated');
  assert.throws(()=>f.commands.submit(f.peer,{requestId:'request',lease:packet.lease,result:{status:'ack'}}),/SCOPE_CHANGED/u);
  assert.throws(()=>f.commands.enqueue(f.request),/REQUEST_CONFLICT/u);
  assert.throws(()=>f.commands.enqueue({...f.request,requestId:'new'}),/OPERATION_ALREADY_QUEUED/u);
});

for(const kind of ['prepare','cancel'])test(`bounded ${kind} transport retains original operation binding`,t=>{
  const f=fixture(t);f.grant();
  const body=kind==='prepare'?{packet:f.request.body.packet}:{operationId:f.request.operationId,taskId:f.request.taskId,action:f.request.action};
  f.commands.enqueue({...f.request,kind,body});const received=f.commands.pull(f.peer);
  assert.equal(received.kind,kind);assert.deepEqual(received.body,body);
  assert.throws(()=>f.commands.enqueue({...f.request,requestId:'other',kind,body}),/OPERATION_ALREADY_QUEUED/u);
});

test('persisted high-water clock cannot revive an expired command lease',t=>{
  const f=fixture(t);f.grant();f.commands.enqueue(f.request);f.commands.pull(f.peer);
  f.advance(101);assert.equal(f.commands.status('request').state,'uncertain');
  f.advance(-200);f.restart();assert.equal(f.commands.status('request').state,'uncertain');assert.equal(f.commands.pull(f.peer),null);
});

for(const mode of ['allowed','revoked','missing','restart','async'])test(`dispatch-time Core execution fence ${mode}`,t=>{
  const f=fixture(t);f.grant();
  const commands=()=>new PcOutboundCommandMailbox({mailbox:f.mailbox,executionFenceRequired:true});
  let guarded=commands(),calls=0;
  guarded.enqueue({...f.request,...(mode==='missing'?{}:{dispatchGuard:()=>{calls++;if(mode==='revoked')throw new Error('Core no longer owns SQL lease');if(mode==='async')return Promise.resolve();}})});
  const delivery=guarded.pull(f.peer);
  if(mode==='restart')guarded=commands();
  const input={requestId:delivery.requestId,lease:delivery.lease};
  if(mode==='allowed'){assert.equal(guarded.validate(f.peer,input).allowed,true);assert.equal(calls,1);}
  else {assert.throws(()=>guarded.validate(f.peer,input),/DISPATCH_FENCE_MISSING|DISPATCH_FENCE_DENIED/u);assert.equal(calls,['missing','restart'].includes(mode)?0:1);}
});
