import { createPcOutboundNodeSupervisor } from '../apps/pc-agent/src/outbound-node-supervisor.js';
import { createPcOutboundObserver } from '../apps/pc-agent/src/outbound-observer.js';
import { PersonalOperationsStore } from '../packages/core/src/personal-operations/operations-store.js';
import { SqliteMissionStore } from '../packages/core/src/mission/sqlite-mission-store.js';
import { MissionExecutionAuthority } from '../packages/core/src/mission/mission-execution-authority.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { existsSync,readFileSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { X509Certificate } from 'node:crypto';
import { startPcOutboundNodeService } from '../packages/core/src/client/pc-outbound-service.js';
import { createPcOutboundCommandTransport,createPcOutboundTransport } from '../packages/core/src/client/pc-outbound-https.js';
import { PcOutboundExecutionClient } from '../packages/core/src/client/pc-outbound-execution-client.js';
import { PcAgentExecutionClient } from '../packages/core/src/client/pc-agent-execution-client.js';
import { PcLocalTaskScope } from '../apps/pc-agent/src/pc-local-task-scope.js';
import { createPcOutboundCommandDispatcher } from '../apps/pc-agent/src/outbound-command-dispatcher.js';
import {createOperationArtifactReader} from '../apps/pc-agent/src/operation-artifact-reader.js';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { createPcAgentServer,PcAgentApiGuard } from '../apps/pc-agent/src/main.mjs';
import { listenOnFetchSafePort } from '../packages/shared/src/http.js';
import { CapabilityTokenService } from '../apps/policy-security/src/policy-runtime.js';
import { ActionType } from '../packages/shared/src/types.js';

const pem=name=>readFileSync(new URL(`./fixtures/google-broker-tls/${name}.pem`,import.meta.url));
for(const mode of ['scoped-catalog-core-missing','scoped-catalog-core-ungranted','scoped-catalog-core-expired','scoped-catalog-normal','scoped-catalog-revoke','scoped-catalog-ungranted','scoped-api-revoke','scoped-normal','scoped-denied','scoped-before-directory','scoped-before-write','scoped-expiry','scoped-same-task-revision','scoped-unfenced','local-scope-prior-effect','local-scope-prepare','local-scope-execute','local-scope-cancel','local-scope-lost-ack','core-local-scope','normal','lost-ack','bad-signature','revoked','changed-body','lost-execute-response','cancel','core-client','core-fence','core-response-loss','core-restart','core-timeout','core-revoke','core-async-fence','mutation-normal','mutation-late-revoke','mutation-core-revoke','mutation-core-offline','mutation-wrong-permit','mutation-before-write','mutation-expired','mutation-unavailable','mutation-http-bypass','mutation-overwrite-revoke','mutation-sql-authority','mutation-sql-expired','mutation-sql-rotation','lost-ack-expired','node-supervised-mutation'])test(`actual B command dispatcher ${mode}`,async t=>{
  const root=await mkdtemp(join(tmpdir(),'jarvis-command-dispatch-'));let calls=0,localCalls=0,coreActive=true,executeValidations=0;
  const mutationMode=mode.startsWith('scoped-')||mode.startsWith('mutation-')||mode==='node-supervised-mutation';let authorityTime=Date.now(),relayTime=Date.now();
  const authorityStore=mode.startsWith('mutation-sql-')?new PersonalOperationsStore({dbPath:join(root,'authority.sqlite'),clock:()=>new Date(authorityTime)}):null;
  const missionStore=authorityStore?new SqliteMissionStore({operationsStore:authorityStore}):null;
  const actualAuthority=missionStore?new MissionExecutionAuthority({store:missionStore,ttlMs:30000}):null;
  actualAuthority?.activate({expectedToken:0,heartbeat:false});
  t.after(()=>{actualAuthority?.stopHeartbeat();authorityStore?.close();});
  let localScopeTime=Date.now();
  const localScope=mode.startsWith('scoped-')?new PcLocalTaskScope({dbPath:join(root,'local-scope.sqlite'),clock:()=>localScopeTime,managedCatalog:mode.includes('catalog')}):null;
  if(localScope&&mode!=='scoped-denied'&&!mode.includes('catalog'))localScope.replace({expectedRevision:0,allowedTaskIds:['task'],expiresAt:localScopeTime+50000});
  t.after(()=>localScope?.close());
  const secret='synthetic-command-test-signing-key-not-production';
  const runtime=createAgRuntime({allowedRoots:[root],auditRoot:join(root,'b'),signingSecret:secret,workerDaemonEnabled:false,env:{JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0'}});
  const adapter=runtime.pcAgent.registry.get('filesystem.createTextFile'),execute=adapter.execute.bind(adapter);
  adapter.execute=async(...args)=>{calls++;return execute(...args);};
  const local=createPcAgentServer(runtime.pcAgent,{apiGuard:new PcAgentApiGuard({apiToken:'synthetic-command-admin-token',executionToken:'synthetic-command-local-token'}),localTaskScope:localScope,localTaskIds:localScope&&!mode.includes('catalog')?['task']:[]});
  await listenOnFetchSafePort(local);
  if(mode.includes('catalog')){
    const reply=await fetch(`http://127.0.0.1:${local.address().port}/outbound/local-task-catalog`,{method:'PUT',headers:{authorization:'Bearer synthetic-command-admin-token','content-type':'application/json'},body:JSON.stringify({expectedRevision:0,allowedTaskIds:['task'],allowedArtifactTaskIds:['task'],allowedCommandTaskIds:mode==='scoped-catalog-core-missing'?[]:['task']})});assert.equal(reply.status,200);await reply.json();
    assert.equal(localScope.snapshot().active,false,'registration alone must not execute');
    if(!['scoped-catalog-ungranted','scoped-catalog-core-missing','scoped-catalog-core-ungranted'].includes(mode))localScope.replace({expectedRevision:1,allowedTaskIds:['task'],expiresAt:localScopeTime+50000});
  }

  if(mode==='scoped-catalog-core-expired')localScopeTime+=60000;
  const relay=await startPcOutboundNodeService({dbPath:join(root,'relay.sqlite'),authorityGuard:()=>actualAuthority?actualAuthority.assertActive():({token:1}),commandTransport:true,clock:()=>mode==='lost-ack-expired'?relayTime:Date.now(),commandExecutionFenceRequired:mutationMode,tls:{key:pem('server-key'),cert:pem('server'),ca:pem('ca')}});
  const transport=createPcOutboundCommandTransport({url:`https://127.0.0.1:${relay.address.port}/v1/pc/command`,key:pem('core-key'),cert:pem('core'),ca:pem('ca')});
  t.after(async()=>{transport.close();await relay.close();local.closeAllConnections();await new Promise(resolve=>local.close(resolve));await rm(root,{recursive:true,force:true});});
  relay.controller.enroll({deviceId:'pc',certificateFingerprint:new X509Certificate(pem('core')).fingerprint256,allowedTaskIds:['task'],expiresAt:new Date(Date.now()+60000).toISOString().replace(/\.\d{3}Z$/u,'Z'),expectedGeneration:0});
  relay.commandMailbox.grant({deviceId:'pc',expectedGeneration:1,allowedTaskIds:['task'],expiresAt:Date.now()+50000});
  const action={actionType:ActionType.CREATE_FILE,toolName:'filesystem.createTextFile',arguments:{path:join(root,...(mode.startsWith('scoped-')?['new-folder','result.txt']:['result.txt'])),content:'실제 파일',...(mode==='mutation-overwrite-revoke'?{allowOverwrite:true}:{})}};
  if(mode==='mutation-overwrite-revoke')writeFileSync(action.arguments.path,'preserved original');
  const issuer=new CapabilityTokenService({signingSecret:secret}),token=issuer.issue({taskId:'task',planId:'plan',approvalId:'approval',action,allowedPaths:[root]});
  const packet={packetId:'packet',taskId:'task',planId:'plan',action,capabilityToken:token,requestedMode:'execute',idempotencyKey:`mission_op_${'a'.repeat(32)}`,userConfirmation:{confirmed:true,approvalId:'approval',confirmedAt:new Date().toISOString()}};
  if(mode==='bad-signature')packet.capabilityToken.capabilityToken='invalid-signature';
  const request=(kind,body)=>({deviceId:'pc',requestId:kind,kind,taskId:'task',operationId:packet.idempotencyKey,action,body,...(mutationMode&&kind==='execute'?{dispatchGuard:()=>{if(!coreActive)throw new Error('Core SQL fence revoked');}}:{})});
  let lost=false;
  const pcClient=new PcAgentExecutionClient({baseUrl:`http://127.0.0.1:${local.address().port}`,executionToken:'synthetic-command-local-token',fetchImpl:async(...args)=>{
    localCalls++;const value=await fetch(...args);if(['lost-execute-response','core-response-loss'].includes(mode)&&String(args[0]).endsWith('/operations/execute')){await value.text();throw new Error('response lost');}return value;
  }});
  const wrapped={exchange:async(op,body)=>{
    if(op==='validate'&&body.requestId==='execute'){
      executeValidations++;
      if(['mutation-sql-expired','mutation-sql-rotation'].includes(mode)&&executeValidations===3){
        authorityTime+=60000;
        if(mode==='mutation-sql-rotation')assert.equal(missionStore.acquireCoreAuthority({ownerId:'replacement-core',expectedToken:1,ttlMs:30000}).token,2);
      }
      if(mode==='mutation-late-revoke'&&executeValidations===2||mode==='mutation-before-write'&&executeValidations===3)relay.controller.revoke('pc',{expectedGeneration:1});
      if(mode==='mutation-core-revoke'&&executeValidations===2||mode==='mutation-overwrite-revoke'&&executeValidations===3)coreActive=false;
      if(mode==='mutation-core-offline'&&executeValidations===2)throw new Error('Core connection lost before mutation');
    }
    if(op==='validate'&&mode==='revoked')relay.controller.revoke('pc',{expectedGeneration:1});
    if(op==='submit'&&body.requestId==='execute'&&mode==='lost-ack-expired'&&!lost){lost=true;throw new Error('A_PC_OUTBOUND_NETWORK');}
    const value=await transport.exchange(op,body);
    if(op==='validate'&&body.requestId==='execute'){
      if(mode==='scoped-before-directory'&&executeValidations===2||mode==='scoped-before-write'&&executeValidations===3)localScope.replace({expectedRevision:1,allowedTaskIds:[],expiresAt:0});
      if(mode==='scoped-same-task-revision'&&executeValidations===2)localScope.replace({expectedRevision:1,allowedTaskIds:['task'],expiresAt:localScopeTime+60000});
      if(mode==='scoped-expiry'&&executeValidations===2)localScopeTime+=60000;
      if(mode==='scoped-catalog-revoke'&&executeValidations===2){const reply=await fetch(`http://127.0.0.1:${local.address().port}/outbound/local-task-catalog`,{method:'PUT',headers:{authorization:'Bearer synthetic-command-admin-token','content-type':'application/json'},body:JSON.stringify({expectedRevision:1,allowedTaskIds:[],allowedArtifactTaskIds:[],allowedCommandTaskIds:[]})});assert.equal(reply.status,200);await reply.json();}
      if(mode==='scoped-api-revoke'&&executeValidations===2){const reply=await fetch(`http://127.0.0.1:${local.address().port}/outbound/local-task-scope`,{method:'PUT',headers:{authorization:'Bearer synthetic-command-admin-token','content-type':'application/json'},body:JSON.stringify({expectedRevision:1,allowedTaskIds:[],expiresAt:0})});assert.equal(reply.status,200);await reply.json();}
    }
    if(op==='validate'&&body.requestId==='execute'&&executeValidations===2&&mode==='mutation-wrong-permit')value.bodySha256='f'.repeat(64);
    if(op==='validate'&&body.requestId==='execute'&&executeValidations===2&&mode==='mutation-expired')value.expiresAt=Date.now()-1;
    if(op==='pull'&&value&&mode==='changed-body')value.body.packet.action.arguments.content='forged';
    if(op==='submit'&&(body.requestId==='execute'&&mode==='lost-ack'||mode==='local-scope-lost-ack')&&!lost){lost=true;throw new Error('ACK lost');}
    return value;
  }};
  const dispatcher=createPcOutboundCommandDispatcher({transport:wrapped,pcClient,taskScope:localScope,...(mutationMode&&mode!=='mutation-unavailable'?{pcAgent:runtime.pcAgent}:{}),allowedTaskIds:mode.startsWith('local-scope')||mode==='core-local-scope'||mode.includes('catalog')?[]:['task']});
  if(mode.startsWith('local-scope')){
    const kind=mode==='local-scope-execute'?'execute':mode==='local-scope-cancel'?'cancel':'prepare';
    const prepared=kind==='execute'||mode==='local-scope-prior-effect'?await pcClient.prepareOperation(packet):null;
    if(mode==='local-scope-prior-effect'){const result=await pcClient.request('/operations/execute',{method:'POST',body:{packet,ticket:prepared.ticket,generation:prepared.generation}});assert.equal(result.status,'COMPLETED');}
    const baselineCalls=localCalls;
    const body=kind==='execute'?{packet,ticket:prepared.ticket,generation:prepared.generation}:kind==='cancel'?{taskId:'task',operationId:packet.idempotencyKey,action}:{packet};
    relay.commandMailbox.enqueue(request(kind,body));
    if(mode==='local-scope-lost-ack'){await assert.rejects(dispatcher.tick(),/ACK lost/u);assert.equal((await dispatcher.tick()).status,'idle');}else await dispatcher.tick();
    const result=relay.commandMailbox.status(kind);assert.equal(result.state,'observed');assert.equal(result.result.status,'unavailable');assert.equal(result.result.reason,'B_PC_COMMAND_LOCAL_SCOPE_DENIED');
    assert.equal(localCalls,baselineCalls);assert.equal(calls,mode==='local-scope-prior-effect'?1:0);assert.equal(existsSync(action.arguments.path),mode==='local-scope-prior-effect');
    if(mode==='local-scope-prior-effect'){assert.equal(readFileSync(action.arguments.path,'utf8'),action.arguments.content);assert.equal((await pcClient.readOperation({taskId:'task',operationId:packet.idempotencyKey,action})).state,'succeeded');}return;
  }
  if(mode==='core-local-scope'||mode.startsWith('scoped-catalog-core-')){
    const producer=new PcOutboundExecutionClient({commands:relay.commandMailbox,deviceId:'pc',timeoutMs:2000,pollIntervalMs:10});
    const outcome=producer.prepareOperation(packet).then(value=>({value}),error=>({error}));
    await dispatcher.tick();const result=await outcome;assert.equal(result.error?.code,'A_PC_COMMAND_LOCAL_SCOPE_DENIED');
    assert.equal(result.error.executionUncertain,true,'A denial of this dispatch cannot disprove an earlier external effect');
    assert.match(result.error.nextAction,/PC/u);if(mode.startsWith('scoped-catalog-core-'))assert.match(result.error.nextAction,mode.endsWith('missing')?/명령 후보로 등록/u:mode.endsWith('expired')?/기간이 끝났/u:/허용 종료 시각/u);assert.equal(localCalls,0);assert.equal(calls,0);return;
  }
  if(mode==='node-supervised-mutation'){
    const readTransport=createPcOutboundTransport({url:`https://127.0.0.1:${relay.address.port}/v1/pc/observe`,key:pem('core-key'),cert:pem('core'),ca:pem('ca')});
    const observer=createPcOutboundObserver({transport:readTransport,pcClient,allowedTaskIds:['task']});
    const node=createPcOutboundNodeSupervisor({observer,dispatcher,close:()=>readTransport.close(),intervalMs:100,maxIdleMs:100});
    t.after(()=>node.stop());
    const until=async predicate=>{const end=Date.now()+5000;while(!predicate()){if(Date.now()>end)throw new Error('node pipeline timeout');await new Promise(resolve=>setTimeout(resolve,5));}};
    relay.commandMailbox.enqueue(request('prepare',{packet}));
    relay.controller.enqueue('pc',{requestId:'health-node',operation:'health',taskId:null});
    node.start();await until(()=>relay.commandMailbox.status('prepare').state==='observed');
    const prep=relay.commandMailbox.status('prepare').result.value;
    relay.commandMailbox.enqueue(request('execute',{packet,ticket:prep.ticket,generation:prep.generation,mutationFenceRequired:true}));
    await until(()=>relay.commandMailbox.status('execute').state==='observed');
    await until(()=>relay.controller.result('health-node')?.state==='observed');
    await node.stop();
    assert.equal(calls,1);assert.equal(readFileSync(action.arguments.path,'utf8'),action.arguments.content);
    assert.equal(relay.commandMailbox.status('execute').result.value.status,'COMPLETED');
    assert.equal(node.status().stopped,true);assert.equal(node.status().failures,0);return;
  }
  if(mode.startsWith('core-')){
    const client=()=>new PcOutboundExecutionClient({commands:relay.commandMailbox,deviceId:'pc',timeoutMs:2000,pollIntervalMs:10});
    const producer=client();
    if(mode==='core-timeout'){
      const short=new PcOutboundExecutionClient({commands:relay.commandMailbox,deviceId:'pc',timeoutMs:100,pollIntervalMs:10});
      await assert.rejects(short.receiveExecutionPacket(packet,{beforeLocalExecute:async()=>()=>{}}),/DELIVERY_TIMEOUT/u);
      assert.equal(calls,0);
    }
    let stopped=false,pumpError=null,fences=0,cancellations=0;
    const pump=(async()=>{while(!stopped){try{await dispatcher.tick();}catch(error){pumpError=error;break;}await new Promise(resolve=>setTimeout(resolve,5));}})();
    const fence=()=>{fences++;if(mode==='core-revoke'&&fences===2)relay.controller.revoke('pc',{expectedGeneration:1});if(mode==='core-fence'&&fences===2)throw new Error('Core lease revoked');};
    fence.onRemoteCancellation=()=>cancellations++;
    try{
      await assert.rejects(producer.receiveExecutionPacket(packet),/EFFECT_HOOK_REQUIRED/u);
      const checkedFence=mode==='core-async-fence'?Object.assign(async()=>{fences++;if(fences===2)throw new Error('Core lease revoked');},{onRemoteCancellation:fence.onRemoteCancellation}):fence;
      const input={beforeLocalExecute:async()=>checkedFence};
      if(['core-fence','core-async-fence'].includes(mode)){
        await assert.rejects(producer.receiveExecutionPacket(packet,input),/Core lease revoked/u);
        assert.equal(calls,0);assert.equal(cancellations,1);
        assert.equal((await pcClient.readOperation({taskId:'task',operationId:packet.idempotencyKey,action})).state,'cancelled');
      }else if(mode==='core-revoke'){
        await assert.rejects(producer.receiveExecutionPacket(packet,input),/EXECUTION_SCOPE_DENIED/u);
        assert.equal(calls,0);assert.equal(existsSync(action.arguments.path),false);
      }else if(mode==='core-response-loss'){
        await assert.rejects(producer.receiveExecutionPacket(packet,input),/DELIVERY_UNRESOLVED/u);
        await assert.rejects(client().receiveExecutionPacket(packet,input),/DELIVERY_UNRESOLVED/u);
        assert.equal(calls,1);
        assert.equal((await pcClient.readOperation({taskId:'task',operationId:packet.idempotencyKey,action})).state,'succeeded');
      }else{
        const receipt=await producer.receiveExecutionPacket(packet,input);assert.equal(receipt.status,'COMPLETED');
        if(mode==='core-restart')assert.equal((await client().receiveExecutionPacket(packet,input)).status,'COMPLETED');
  assert.equal(calls,1);assert.equal(readFileSync(action.arguments.path,'utf8'),action.arguments.content);
      }
      assert.equal(producer.supportsDurableMissionEffects(),false);
    }finally{stopped=true;await pump;}
    if(mode!=='core-revoke')assert.equal(pumpError,null);return;
  }
  relay.commandMailbox.enqueue(request('prepare',{packet}));
  if(['revoked','changed-body'].includes(mode)){await assert.rejects(dispatcher.tick());assert.equal(calls,0);assert.equal(existsSync(action.arguments.path),false);return;}
  await dispatcher.tick();const prepared=relay.commandMailbox.status('prepare').result;
  if(['scoped-denied','scoped-catalog-ungranted'].includes(mode)){assert.equal(prepared.reason,mode==='scoped-catalog-ungranted'?'B_PC_COMMAND_LOCAL_PERMISSION_MISSING':'B_PC_COMMAND_LOCAL_SCOPE_DENIED');assert.equal(localCalls,0);assert.equal(calls,0);return;}
  if(mode==='bad-signature'){assert.equal(prepared.status,'unavailable');assert.equal(calls,0);assert.equal(existsSync(action.arguments.path),false);return;}
  assert.equal(prepared.status,'observed');assert.equal(prepared.value.state,'prepared');
  if(mode==='cancel'){
    relay.commandMailbox.enqueue(request('cancel',{taskId:'task',operationId:packet.idempotencyKey,action}));await dispatcher.tick();
    assert.equal(relay.commandMailbox.status('cancel').result.value.state,'cancelled');assert.equal(calls,0);return;
  }
  if(mode==='mutation-http-bypass'){
    await assert.rejects(pcClient.request('/operations/execute',{method:'POST',body:{packet,ticket:prepared.value.ticket,generation:prepared.value.generation,mutationFenceRequired:true}}),{code:'B_OPERATION_MUTATION_FENCE_UNSUPPORTED'});
    assert.equal(calls,0);assert.equal(existsSync(action.arguments.path),false);
    assert.equal((await pcClient.readOperation({taskId:'task',operationId:packet.idempotencyKey,action})).state,'prepared');return;
  }
  relay.commandMailbox.enqueue(request('execute',{packet,ticket:prepared.value.ticket,generation:prepared.value.generation,...(mutationMode&&mode!=='scoped-unfenced'?{mutationFenceRequired:true}:{})}));
  if(mode==='lost-ack-expired'){
    await assert.rejects(dispatcher.tick(),/NETWORK/u);assert.equal(calls,1);relayTime+=20000;
    const nextAction={...action,arguments:{...action.arguments,path:join(root,'second.txt')}};
    const nextToken=issuer.issue({taskId:'task',planId:'plan2',approvalId:'approval2',action:nextAction,allowedPaths:[root]});
    const nextPacket={...packet,packetId:'packet2',planId:'plan2',action:nextAction,capabilityToken:nextToken,idempotencyKey:`mission_op_${'b'.repeat(32)}`,userConfirmation:{confirmed:true,approvalId:'approval2',confirmedAt:new Date().toISOString()}};
    const next=(kind,body)=>({deviceId:'pc',requestId:`next-${kind}`,kind,taskId:'task',operationId:nextPacket.idempotencyKey,action:nextAction,body});
    relay.commandMailbox.enqueue(next('prepare',{packet:nextPacket}));
    await assert.rejects(dispatcher.tick(),/LEASE_INVALID/u);
    assert.equal(relay.commandMailbox.status('execute').state,'uncertain');
    await dispatcher.tick();const prepared2=relay.commandMailbox.status('next-prepare').result.value;
    assert.equal(prepared2.state,'prepared');assert.equal(calls,1);
    relay.commandMailbox.enqueue(next('execute',{packet:nextPacket,ticket:prepared2.ticket,generation:prepared2.generation}));
    await dispatcher.tick();assert.equal(calls,2);
    assert.equal(readFileSync(nextAction.arguments.path,'utf8'),nextAction.arguments.content);
    assert.equal((await pcClient.readOperation({taskId:'task',operationId:packet.idempotencyKey,action})).state,'succeeded');return;
  }
  if(mode==='lost-ack'){await assert.rejects(dispatcher.tick(),/ACK lost/u);assert.equal((await dispatcher.tick()).status,'idle');}
  else if(['mutation-late-revoke','mutation-before-write'].includes(mode))await assert.rejects(dispatcher.tick(),/DEVICE_DENIED/u);
  else if(['mutation-sql-expired','mutation-sql-rotation'].includes(mode))await assert.rejects(dispatcher.tick(),/AUTHORITY_LOST/u);
  else await dispatcher.tick();
  if(mode.startsWith('scoped-')){
    const result=relay.commandMailbox.status('execute').result;
    if(['scoped-normal','scoped-catalog-normal'].includes(mode)){assert.equal(result.status,'observed');assert.equal(calls,1);assert.equal(readFileSync(action.arguments.path,'utf8'),action.arguments.content);
      if(mode==='scoped-catalog-normal'){
        const reader=createOperationArtifactReader({taskCatalog:localScope,allowedTaskIds:[],allowedRoots:[root],readOperation:input=>pcClient.readOperation(input)});
        const artifact=await reader({operationId:packet.idempotencyKey,taskId:packet.taskId,action});assert.equal(Buffer.from(artifact.bytes,'base64').toString('utf8'),action.arguments.content);assert.equal(artifact.verifiedCompletion,false);
      }
    }
    else {assert.equal(result.status,mode==='scoped-unfenced'?'uncertain':'observed');if(mode!=='scoped-unfenced')assert.equal(result.value.status,'BLOCKED');assert.equal(existsSync(action.arguments.path),false);assert.equal(calls,mode==='scoped-unfenced'?0:1);assert.notEqual((await pcClient.readOperation({taskId:'task',operationId:packet.idempotencyKey,action})).state,'succeeded');}
    if(['scoped-catalog-revoke','scoped-api-revoke','scoped-before-directory','scoped-same-task-revision'].includes(mode))assert.equal(result.value.blockedReason,'B_PC_LOCAL_SCOPE_CHANGED');
    if(mode==='scoped-before-directory')assert.equal(existsSync(join(root,'new-folder')),false);
    if(mode==='scoped-before-write'){assert.equal(result.value.blockedReason,'B_PC_LOCAL_SCOPE_CHANGED');assert.equal(existsSync(join(root,'new-folder')),true);}
    if(mode==='scoped-expiry')assert.equal(result.value.blockedReason,'B_PC_LOCAL_SCOPE_EXPIRED');
    return;
  }
        if(mutationMode){
    if(['mutation-normal','mutation-sql-authority'].includes(mode)){
      assert.equal(executeValidations,3);assert.equal(calls,1);assert.equal(readFileSync(action.arguments.path,'utf8'),action.arguments.content);
      assert.equal((await pcClient.readOperation({taskId:'task',operationId:packet.idempotencyKey,action})).state,'succeeded');
    }else{
      if(mode==='mutation-overwrite-revoke')assert.equal(readFileSync(action.arguments.path,'utf8'),'preserved original');
      else assert.equal(existsSync(action.arguments.path),false);
      assert.equal(calls,mode==='mutation-unavailable'?0:1);
      assert.notEqual((await pcClient.readOperation({taskId:'task',operationId:packet.idempotencyKey,action})).state,'succeeded');
    }
    return;
  }
  assert.equal(calls,1);assert.equal(readFileSync(action.arguments.path,'utf8'),action.arguments.content);
  const result=relay.commandMailbox.status('execute').result;
  assert.equal(result.verifiedCompletion,false);assert.equal(result.status,mode==='lost-execute-response'?'uncertain':'observed');
  const journal=await pcClient.readOperation({taskId:'task',operationId:packet.idempotencyKey,action});assert.equal(journal.state,'succeeded');
  assert.equal((await dispatcher.tick()).status,'idle');assert.equal(calls,1);
});
