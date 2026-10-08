import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { PcOutboundMailbox } from '../packages/core/src/client/pc-outbound-mailbox.js';
import { PcOutboundNodeController } from '../packages/core/src/client/pc-outbound-service.js';
import { PcOutboundReceiptClient } from '../packages/core/src/client/pc-outbound-receipt-client.js';
import { executionPacketFingerprint } from '../packages/shared/src/execution-packet-fingerprint.js';

function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'jarvis-outbound-receipt-'));let time=Date.now(),epoch=1;
  const peer='A'.repeat(64),store=new PcOutboundMailbox({dbPath:join(root,'test.sqlite'),clock:()=>time,authorityGuard:()=>({token:epoch})});
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  const controller=new PcOutboundNodeController({mailbox:store,authorityGuard:()=>({token:epoch})});
  store.enroll({deviceId:'pc',certificateFingerprint:peer,expiresAt:time+60000,allowedTaskIds:['task_한국어-복구'],expectedGeneration:0});
  const client=new PcOutboundReceiptClient({controller,deviceId:'pc',timeoutMs:200,pollIntervalMs:10});
  return {store,client,peer,advance:value=>time+=value,nextAuthority:()=>epoch++};
}
test('reconciliation preserves bounded Korean task IDs and remains read-only',async t=>{
  const f=fixture(t),pending=f.client.taskResult('task_한국어-복구');
  const packet=f.store.pull(f.peer);assert.equal(packet.request.taskId,'task_한국어-복구');
  f.store.submit(f.peer,{requestId:packet.requestId,generation:packet.generation,lease:packet.lease,result:{status:'observed',value:{taskId:'task_한국어-복구',status:'COMPLETED'}}});
  assert.equal((await pending).status,'COMPLETED');assert.equal(f.client.supportsDurableMissionEffects(),false);
  await assert.rejects(f.client.receiveExecutionPacket(),{code:'A_PC_OUTBOUND_RECOVERY_READ_ONLY'});
  await assert.rejects(f.client.taskResult('unselected'),/READ_SCOPE_DENIED/u);
  for(const task of ['../other','task/path','task?token=x'])await assert.rejects(f.client.taskResult(task),/READ_CONTRACT_INVALID/u);
});
test('reconciliation invalidates after device revocation or Core authority change',async t=>{
  for(const change of ['device','authority']){
    const f=fixture(t),pending=f.client.taskResult('task_한국어-복구');
    if(change==='device')f.store.revoke('pc');else f.nextAuthority();
    await assert.rejects(pending,{code:'A_PC_OUTBOUND_RECONCILIATION_INVALIDATED'});
  }
});
test('expired observation, unavailable receipt and disconnected PC cannot become a completed reconciliation',async t=>{
  for(const mode of ['stale','unavailable','offline']){
    const f=fixture(t),pending=f.client.taskResult('task_한국어-복구');
    if(mode!=='offline'){
      const p=f.store.pull(f.peer);f.store.submit(f.peer,{requestId:p.requestId,generation:p.generation,lease:p.lease,result:{status:mode==='stale'?'observed':'unavailable',value:{status:'COMPLETED'}}});
      if(mode==='stale')f.advance(15001);
    }
    await assert.rejects(pending,{code:`A_PC_OUTBOUND_${mode==='stale'?'OBSERVATION_STALE':mode==='unavailable'?'OBSERVATION_UNAVAILABLE':'RECONCILIATION_TIMEOUT'}`});
  }
});

test('operation reconciliation binds ID, task and the complete action fingerprint',async t=>{
  for(const mode of ['correct','operation','task','fingerprint','uncertain']){
    const f=fixture(t),taskId='task_한국어-복구',operationId=`mission_op_${'a'.repeat(32)}`;
    const action={actionType:'CREATE_FILE',toolName:'filesystem.createTextFile',arguments:{path:'result.txt',content:'original'}};
    const pending=f.client.receiptForOperation({operationId,taskId,action}),p=f.store.pull(f.peer);
    const receipt={taskId,status:'COMPLETED'};
    f.store.submit(f.peer,{requestId:p.requestId,generation:p.generation,lease:p.lease,result:{status:'observed',value:{
      operationId:mode==='operation'?`mission_op_${'b'.repeat(32)}`:operationId,taskId:mode==='task'?'other':taskId,
      fingerprint:mode==='fingerprint'?'0'.repeat(64):executionPacketFingerprint({taskId,action,requestedMode:'execute'}),
      state:mode==='uncertain'?'uncertain':'succeeded',receipt,executionAuthority:false}}});
    if(mode==='correct')assert.deepEqual(await pending,receipt);
    else if(mode==='uncertain')assert.equal(await pending,null);
    else await assert.rejects(pending,{code:'A_PC_OUTBOUND_RECEIPT_BINDING_MISMATCH'});
  }
});

test('Core recomputes received artifact bytes and refuses forged hash, content, encoding or completion claims',async t=>{
  for(const mode of ['correct','hash','content','encoding','completion','packet','size']){
    const f=fixture(t),taskId='task_한국어-복구',operationId=`mission_op_${'a'.repeat(32)}`;
    f.store.enroll({deviceId:'pc',certificateFingerprint:f.peer,expiresAt:Date.now()+60000,
      allowedTaskIds:[taskId],allowedArtifactTaskIds:[taskId],expectedGeneration:1});
    const action={toolName:'filesystem.createTextFile',arguments:{path:'file.txt',content:'원문'}};
    const bytes=Buffer.from(mode==='content'?'악성':'원문');
    const pending=f.client.artifactForOperation({operationId,taskId,action});
    const outcome=pending.then(value=>({value}),error=>({error}));
    const p=f.store.pull(f.peer);
    f.store.submit(f.peer,{requestId:p.requestId,generation:p.generation,lease:p.lease,result:{status:'observed',value:{
      operationId,taskId,fingerprint:executionPacketFingerprint({taskId,action,requestedMode:'execute'}),
      packetId:mode==='packet'?'':'packet',evidenceId:'evidence',executionAuthority:false,verifiedCompletion:mode==='completion',
      encoding:'base64',bytes:mode==='encoding'?bytes.toString('base64')+'\n':bytes.toString('base64'),
      size:mode==='size'?65537:bytes.length,sha256:mode==='hash'?'0'.repeat(64):createHash('sha256').update(bytes).digest('hex')}}});
    const result=await outcome;
    if(mode==='correct')assert.equal(result.value.bytes.toString('utf8'),'원문');
    else assert.match(result.error.code,/A_PC_OUTBOUND_ARTIFACT_(CONTENT|BINDING)_MISMATCH/u);
  }
});
