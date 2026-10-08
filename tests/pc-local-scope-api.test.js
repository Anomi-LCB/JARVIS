import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { PcLocalTaskScope } from '../apps/pc-agent/src/pc-local-task-scope.js';
import { createPcAgentServer,PcAgentApiGuard,startPcAgentServiceRuntime } from '../apps/pc-agent/src/main.mjs';
import { listenOnFetchSafePort } from '../packages/shared/src/http.js';
import { createPcOutboundNodeSupervisor } from '../apps/pc-agent/src/outbound-node-supervisor.js';

async function fixture(t,{configured=true}={}) {
  const root=await mkdtemp(join(tmpdir(),'jarvis-local-scope-api-'));
  const runtime=createAgRuntime({allowedRoots:[root],auditRoot:join(root,'audit'),workerDaemonEnabled:false,env:{JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0'}});
  const scope=configured?new PcLocalTaskScope({dbPath:join(root,'scope.sqlite')}):null;
  const apiGuard=new PcAgentApiGuard({apiToken:'synthetic-local-admin',executionToken:'synthetic-core-executor'});
  const server=createPcAgentServer(runtime.pcAgent,{apiGuard,localTaskScope:scope,localTaskIds:['task','한국어_업무']});
  const address=await listenOnFetchSafePort(server),url=`http://127.0.0.1:${address.port}/outbound/local-task-scope`;
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));scope?.close();await rm(root,{recursive:true,force:true});});
  const request=async({method='GET',token='synthetic-local-admin',body,headers={},query=''}={})=>{
    const reply=await fetch(url+query,{method,headers:{...(token?{authorization:`Bearer ${token}`} : {}),...(body!==undefined?{'content-type':'application/json'}:{}),...headers},...(body!==undefined?{body:typeof body==='string'?body:JSON.stringify(body)}:{})});
    return {status:reply.status,body:await reply.json()};
  };
  return {root,scope,request,server,url,apiGuard};
}

test('administrator revocation while receiving a PUT body prevents saving a new permission',async t=>{
  const {scope,server,url,apiGuard}=await fixture(t);
  const input=JSON.stringify({expectedRevision:0,allowedTaskIds:['task'],expiresAt:Date.now()+60000});
  const received=new Promise(resolve=>server.once('request',resolve));
  let client;
  const outcome=new Promise((resolve,reject)=>{
    client=httpRequest(url,{method:'PUT',headers:{authorization:'Bearer synthetic-local-admin','content-type':'application/json','content-length':Buffer.byteLength(input)}},response=>{let body='';response.on('data',chunk=>{body+=chunk;});response.on('end',()=>resolve({status:response.statusCode,body:JSON.parse(body)}));});
    client.on('error',reject);client.write(input.slice(0,8));
  });
  await received;apiGuard.tokenStore.tokenHash=null;client.end(input.slice(8));
  assert.equal((await outcome).status,401);assert.equal(scope.snapshot().revision,0);
});

test('actual local API requires administrator token for both reads and permission changes',async t=>{
  const {scope,request}=await fixture(t);
  for(const method of ['GET','PUT'])for(const token of [null,'synthetic-core-executor','invalid']){
    assert.equal((await request({method,token,...(method==='PUT'?{body:{expectedRevision:0,allowedTaskIds:['task'],expiresAt:Date.now()+60000}}:{})})).status,401);
  }
  assert.equal(scope.snapshot().revision,0);
  const initial=await request();assert.equal(initial.status,200);assert.equal(initial.body.active,false);
  assert.equal(initial.body.executionAuthority,false);assert.equal(initial.body.verifiedCompletion,false);
  assert.deepEqual(initial.body.selectableTaskIds,['task','한국어_업무']);
  assert.equal(JSON.stringify(initial.body).includes('scope.sqlite'),false);
});

test('actual API saves and revokes the same scope object used by a captured execution lease',async t=>{
  const {scope,request}=await fixture(t),grant={expectedRevision:0,allowedTaskIds:['task'],expiresAt:Date.now()+60000};
  const saved=await request({method:'PUT',body:grant});assert.equal(saved.status,200);assert.equal(saved.body.revision,1);
  const lease=scope.capture('task');
  const collision=await request({method:'PUT',body:grant});assert.equal(collision.status,409);
  assert.equal(scope.snapshot().revision,1);scope.assertCurrent('task',lease);
  const revoked=await request({method:'PUT',body:{expectedRevision:1,allowedTaskIds:[],expiresAt:0}});
  assert.equal(revoked.status,200);assert.equal(revoked.body.active,false);assert.throws(()=>scope.assertCurrent('task',lease),/CHANGED/u);
});

test('actual API rejects unconfigured targets, unknown fields, malformed, oversized or wrong media requests',async t=>{
  const {scope,request}=await fixture(t),base={expectedRevision:0,allowedTaskIds:['task'],expiresAt:Date.now()+60000};
  for(const body of [{...base,allowedTaskIds:['other']},{...base,allowedTaskIds:['task','task']},{...base,expiresAt:0},{...base,extra:true},null,[],{},'{bad'])
    assert.equal((await request({method:'PUT',body})).status,400);
  assert.equal((await request({method:'PUT',body:base,headers:{'content-type':'text/plain'}})).status,415);
  assert.equal((await request({method:'PUT',body:base,headers:{'content-encoding':'gzip'}})).status,415);
  assert.equal((await request({method:'PUT',body:'x'.repeat(262145)})).status,413);
  assert.equal((await request({query:'?grant=all'})).status,400);
  assert.equal((await request({method:'POST',body:base})).status,405);
  assert.equal(scope.snapshot().revision,0);
});

test('unconfigured API reports preparation missing only to an authenticated administrator',async t=>{
  const {request}=await fixture(t,{configured:false});
  assert.equal((await request({token:null})).status,401);
  const value=await request();assert.equal(value.status,503);assert.equal(value.body.error.code,'B_PC_LOCAL_SCOPE_NOT_CONFIGURED');
});

test('actual service shares local scope with outbound factory, persists across restart, and closes after node stop',async t=>{
  const root=await mkdtemp(join(tmpdir(),'jarvis-local-scope-service-'));let service,scopeRef,stops=0;
  t.after(async()=>{await service?.close();await rm(root,{recursive:true,force:true});});
  const env={PORT:'0',JARVIS_TEST_MODE:'1',JARVIS_ALLOWED_ROOTS:root,JARVIS_AUDIT_ROOT:join(root,'audit'),JARVIS_TRUST_ROOT:join(root,'trust'),JARVIS_TEST_AUDIT_ROOT:root,
    JARVIS_QUEUE_DRAIN_ENABLED:'0',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0',JARVIS_PC_AGENT_API_TOKEN:'synthetic-service-admin',
    JARVIS_PC_OUTBOUND_ENABLED:'1',JARVIS_PC_OUTBOUND_COMMAND_ENABLED:'1',JARVIS_PC_OUTBOUND_COMMAND_TASK_IDS:'["task"]',JARVIS_PC_OUTBOUND_LOCAL_SCOPE_DB:join(root,'scope.sqlite'),
    ...Object.fromEntries([['UNDO_JOURNAL','undo.jsonl'],['ROLLBACK_TRANSACTIONS','rollback.jsonl'],['PACKET_JOURNAL','packets.jsonl'],['PACKET_QUEUE','queue.json'],['TOKEN_VAULT','vault.jsonl']].map(([key,leaf])=>[`JARVIS_${key}`,join(root,leaf)]))};
  const factory=({localTaskScope})=>{scopeRef=localTaskScope;return createPcOutboundNodeSupervisor({observer:{tick:async()=>({status:'idle'})},close:()=>{assert.equal(scopeRef.snapshot().revision,1);stops++;},intervalMs:100,maxIdleMs:100});};
  service=await startPcAgentServiceRuntime({env,pcOutboundNodeFactory:factory});
  assert.equal(service.localTaskScope,scopeRef);
  const reply=await fetch(`http://127.0.0.1:${service.port}/outbound/local-task-scope`,{method:'PUT',headers:{authorization:'Bearer synthetic-service-admin','content-type':'application/json'},body:JSON.stringify({expectedRevision:0,allowedTaskIds:['task'],expiresAt:Date.now()+60000})});
  assert.equal(reply.status,200);await reply.json();assert.equal(scopeRef.capture('task').revision,1);
  await Promise.all([service.close(),service.close()]);assert.equal(stops,1);assert.throws(()=>scopeRef.snapshot());
  service=await startPcAgentServiceRuntime({env,pcOutboundNodeFactory:factory});assert.equal(service.localTaskScope.snapshot().revision,1);await service.close();assert.equal(stops,2);
  await assert.rejects(startPcAgentServiceRuntime({env:{...env,JARVIS_PC_OUTBOUND_ENABLED:'0'},pcOutboundNodeFactory:factory}),/CONFIG_INVALID/u);
  await assert.rejects(startPcAgentServiceRuntime({env:{...env,JARVIS_PC_OUTBOUND_LOCAL_SCOPE_DB:'relative.sqlite'},pcOutboundNodeFactory:factory}),/CONFIG_INVALID/u);
});

test('managed catalog service boots empty, preserves registration and separate grants across restart',async t=>{
  const root=await mkdtemp(join(tmpdir(),'jarvis-managed-catalog-service-'));let service,owned,stops=0;
  t.after(async()=>{await service?.close();await rm(root,{recursive:true,force:true});});
  const env={PORT:'0',JARVIS_TEST_MODE:'1',JARVIS_ALLOWED_ROOTS:root,JARVIS_AUDIT_ROOT:join(root,'audit'),JARVIS_TRUST_ROOT:join(root,'trust'),JARVIS_TEST_AUDIT_ROOT:root,
    JARVIS_QUEUE_DRAIN_ENABLED:'0',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0',JARVIS_PC_AGENT_API_TOKEN:'synthetic-service-admin',
    JARVIS_PC_OUTBOUND_ENABLED:'1',JARVIS_PC_OUTBOUND_COMMAND_ENABLED:'1',JARVIS_PC_OUTBOUND_COMMAND_TASK_IDS:'[]',
    JARVIS_PC_OUTBOUND_LOCAL_CATALOG_ENABLED:'1',JARVIS_PC_OUTBOUND_LOCAL_SCOPE_DB:join(root,'scope.sqlite'),
    ...Object.fromEntries([['UNDO_JOURNAL','undo.jsonl'],['ROLLBACK_TRANSACTIONS','rollback.jsonl'],['PACKET_JOURNAL','packets.jsonl'],['PACKET_QUEUE','queue.json'],['TOKEN_VAULT','vault.jsonl']].map(([key,leaf])=>[`JARVIS_${key}`,join(root,leaf)]))};
  const factory=({localTaskScope})=>{owned=localTaskScope;assert.equal(owned.catalogEnabled,true);return createPcOutboundNodeSupervisor({observer:{tick:async()=>({status:'idle'})},close:()=>{owned.catalog();stops++;},intervalMs:100,maxIdleMs:100});};
  service=await startPcAgentServiceRuntime({env,pcOutboundNodeFactory:factory});assert.equal(service.localTaskScope,owned);
  assert.deepEqual(owned.catalog().allowedTaskIds,[]);assert.equal(owned.snapshot().active,false);
  const put=async(path,body)=>{const response=await fetch(`http://127.0.0.1:${service.port}/outbound/${path}`,{method:'PUT',headers:{authorization:'Bearer synthetic-service-admin','content-type':'application/json'},body:JSON.stringify(body)});assert.equal(response.status,200);return response.json();};
  await put('local-task-catalog',{expectedRevision:0,allowedTaskIds:['new-task'],allowedArtifactTaskIds:['new-task'],allowedCommandTaskIds:['new-task']});
  assert.equal(owned.snapshot().active,false);
  await put('local-task-scope',{expectedRevision:1,allowedTaskIds:['new-task'],expiresAt:Date.now()+60000});
  assert.equal(owned.capture('new-task').revision,2);
  await service.close();assert.equal(stops,1);assert.throws(()=>owned.catalog());
  service=await startPcAgentServiceRuntime({env,pcOutboundNodeFactory:factory});
  assert.deepEqual(owned.catalog().allowedCommandTaskIds,['new-task']);assert.equal(owned.capture('new-task').revision,2);
  await put('local-task-catalog',{expectedRevision:1,allowedTaskIds:[],allowedArtifactTaskIds:[],allowedCommandTaskIds:[]});assert.equal(owned.snapshot().active,false);
  await service.close();assert.equal(stops,2);
  for(const patch of [{JARVIS_PC_OUTBOUND_LOCAL_CATALOG_ENABLED:'yes'},{JARVIS_PC_OUTBOUND_COMMAND_TASK_IDS:'["static-task"]'},{JARVIS_PC_OUTBOUND_LOCAL_SCOPE_DB:''}])
    await assert.rejects(startPcAgentServiceRuntime({env:{...env,...patch},pcOutboundNodeFactory:factory}),/CONFIG_INVALID/u);
});
