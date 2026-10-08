import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,realpathSync,statSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {X509Certificate,createHash} from 'node:crypto';
import {createConfiguredCoreServiceRuntime} from '../scripts/core-service-runtime.mjs';
import {startPcOutboundNodeService} from '../packages/core/src/client/pc-outbound-service.js';
import {createRemoteArtifactBinding} from '../packages/core/src/mission/remote-artifact-contract.js';
import {createPcOutboundTransport,createPcOutboundCommandTransport} from '../packages/core/src/client/pc-outbound-https.js';
import {PcAgentExecutionClient} from '../packages/core/src/client/pc-agent-execution-client.js';
import {createPcAgentServer,PcAgentApiGuard} from '../apps/pc-agent/src/main.mjs';
import {createPcOutboundObserver} from '../apps/pc-agent/src/outbound-observer.js';
import {createPcOutboundCommandDispatcher} from '../apps/pc-agent/src/outbound-command-dispatcher.js';
import {createOperationArtifactReader} from '../apps/pc-agent/src/operation-artifact-reader.js';
import {PcLocalTaskScope} from '../apps/pc-agent/src/pc-local-task-scope.js';
import {listenOnFetchSafePort} from '../packages/shared/src/http.js';
import {MissionGrant} from '../packages/core/src/mission/mission-runtime.js';
import {assessMissionGoalCompletionCoverage} from '../packages/core/src/mission/mission-requirement-coverage.js';
import {createWorkspaceClient} from '../src/ui/workspace/client.js';

const pem=name=>readFileSync(new URL(`./fixtures/google-broker-tls/${name}.pem`,import.meta.url));
for(const mode of ['normal','wrong-criterion','tampered-artifact','lost-response','lost-response-tampered'])test(`configured service natural file instruction and current artifact: ${mode}`,async t=>{
 const recoveryMode=mode.startsWith('lost-response');
 const root=mkdtempSync(join(tmpdir(),'jarvis-service-mission-')),workspace=join(root,'workspace');mkdirSync(workspace);
 const info=statSync(workspace,{bigint:true}),rootScopeSha256=createHash('sha256').update(JSON.stringify([{path:workspace,physical:realpathSync(workspace),dev:info.dev.toString(),ino:info.ino.toString()}])).digest('hex');
 const binding=createRemoteArtifactBinding({deviceId:'mission-pc',deviceGeneration:1,certificateFingerprint:new X509Certificate(pem('core')).fingerprint256,pathPlatform:process.platform==='win32'?'win32':'posix',allowedRoots:[workspace],rootScopeSha256});
 const bindingPath=join(root,'binding.json');writeFileSync(bindingPath,JSON.stringify(binding));
 const env={JARVIS_TEST_MODE:'1',JARVIS_CORE_ROOT:root,JARVIS_TEST_AUDIT_ROOT:join(root,'audit'),JARVIS_CORE_PORT:'0',JARVIS_CORE_ALLOWED_ROOTS:'workspace',JARVIS_CORE_WORKER_DAEMON_ENABLED:'0',JARVIS_CORE_WORKER_DAEMON_AUTOSTART:'0',JARVIS_PERSONAL_IMPORT_ENABLED:'0',JARVIS_GOOGLE_SYNC_ENABLED:'0',JARVIS_PERSONAL_OPERATIONS_DB:join(root,'operations.sqlite'),JARVIS_CORE_MISSION_STORE_BACKEND:'sqlite',JARVIS_CORE_MISSION_AUTHORITY_ENABLED:'1',JARVIS_CORE_MISSION_AUTHORITY_EXPECTED_TOKEN:'0',JARVIS_CORE_PC_OUTBOUND_ENABLED:'1',JARVIS_CORE_PC_OUTBOUND_COMMAND_ENABLED:'1',JARVIS_CORE_PC_OUTBOUND_EXECUTION_ENABLED:'1',JARVIS_CORE_PC_OUTBOUND_EXECUTION_BINDING_PATH:bindingPath,JARVIS_MISSION_EXECUTIVE:'0',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'};
 let runtime,server,readTransport,commandTransport,timer,localScope,dispatches=0,adapterCalls=0,pumpErrors=[],observer,dispatcher,offset=0,dropAck=recoveryMode,executeDeliveries=0;
 const pending=new Set();
 const stopPump=async()=>{clearInterval(timer);await Promise.allSettled([...pending]);};
 const startPump=()=>{timer=setInterval(()=>{for(const component of [dispatcher,observer].filter(Boolean)){const p=component.tick().catch(e=>pumpErrors.push(e.code??e.message)).finally(()=>pending.delete(p));pending.add(p);}},10);};
 t.after(async()=>{await stopPump();readTransport?.close();commandTransport?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}try{await runtime?.close();}catch(e){if(!recoveryMode||!/EFFECT_RECONCILIATION_REQUIRED/.test(e.message))throw e;}finally{localScope?.close();rmSync(root,{recursive:true,force:true});}});
 const open=(expectedToken=0,recoveryOnly=false)=>createConfiguredCoreServiceRuntime({env:{...env,JARVIS_CORE_MISSION_AUTHORITY_EXPECTED_TOKEN:String(expectedToken),JARVIS_CORE_MISSION_AUTHORITY_RECOVERY_ONLY:recoveryOnly?'1':'0'},clock:()=>new Date(Date.now()+offset),pcOutboundServiceFactory:({authorityGuard})=>startPcOutboundNodeService({dbPath:join(root,'relay.sqlite'),authorityGuard,commandTransport:true,commandExecutionFenceRequired:true,tls:{key:pem('server-key'),cert:pem('server'),ca:pem('ca')}})});
 runtime=await open();
 assert.equal(runtime.orchestrationWorker.pcAgent,runtime.remotePcAgent);
 const adapter=runtime.pcAgent.registry.get('filesystem.createTextFile'),execute=adapter.execute.bind(adapter);
 adapter.execute=async(...args)=>{adapterCalls++;return execute(...args);};
 localScope=new PcLocalTaskScope({dbPath:join(root,'pc-scope.sqlite'),managedCatalog:true});
 server=createPcAgentServer(runtime.pcAgent,{apiGuard:new PcAgentApiGuard({apiToken:'synthetic-local-admin',executionToken:'synthetic-local-execution'}),localTaskScope:localScope});await listenOnFetchSafePort(server,{host:'127.0.0.1',port:0});
 const pcClient=new PcAgentExecutionClient({baseUrl:`http://127.0.0.1:${server.address().port}`,executionToken:'synthetic-local-execution'});
 const originalPcAgent=runtime.pcAgent;
 let relay=runtime.pcOutboundService;
 const connect=()=>{
  readTransport=createPcOutboundTransport({url:`https://127.0.0.1:${relay.address.port}/v1/pc/observe`,key:pem('core-key'),cert:pem('core'),ca:pem('ca')});
  commandTransport=createPcOutboundCommandTransport({url:`https://127.0.0.1:${relay.address.port}/v1/pc/command`,key:pem('core-key'),cert:pem('core'),ca:pem('ca')});
  const wrapped={exchange:async(kind,input)=>{if(kind==='submit'&&input.result?.value?.status==='COMPLETED'){if(dropAck)throw new Error('synthetic execute response lost');dispatches++;}const value=await commandTransport.exchange(kind,input);if(kind==='pull'&&value?.kind==='execute')executeDeliveries++;return value;}};
  dispatcher=createPcOutboundCommandDispatcher({transport:wrapped,pcClient,pcAgent:originalPcAgent,taskScope:localScope});
 };
 connect();
 const observe=taskId=>{const artifactReader=createOperationArtifactReader({allowedRoots:[workspace],allowedTaskIds:[taskId],expectedRootScopeSha256:rootScopeSha256,readOperation:input=>pcClient.readOperation(input)});
  observer=createPcOutboundObserver({transport:readTransport,pcClient:{health:async()=>({status:'ok'}),readOperation:input=>pcClient.readOperation(input)},taskCatalog:localScope,artifactReader});};
 runtime.missionRuntime.effectCoordinator.onBoundary=async(boundary,{action})=>{
  if(boundary==='receipt-persisted'&&mode==='tampered-artifact')writeFileSync(join(workspace,'service-result.txt'),'changed after receipt');
  if(boundary!=='prepared'||observer)return;
  const taskId=action.taskId;
  relay.controller.enroll({deviceId:binding.deviceId,certificateFingerprint:binding.certificateFingerprint,expiresAt:new Date(Date.now()+60000).toISOString().replace(/\.\d{3}Z$/u,'Z'),allowedTaskIds:[taskId],allowedArtifactTaskIds:[taskId],expectedGeneration:0});
  relay.commandMailbox.grant({deviceId:binding.deviceId,expectedGeneration:1,allowedTaskIds:[taskId],expiresAt:Date.now()+50000});
  localScope.replaceCatalog({expectedRevision:0,allowedTaskIds:[taskId],allowedArtifactTaskIds:[taskId],allowedCommandTaskIds:[taskId]});localScope.replace({expectedRevision:1,allowedTaskIds:[taskId],expiresAt:Date.now()+60000});
  observe(taskId);
 };
 startPump();
 const owner=runtime.personalOwnerSession.activate({requestedBy:'isolated-configured-service-mission',durationMinutes:5});
 const target=join(workspace,'service-result.txt'),content='서비스 종단 검증 완료';
 const mission=runtime.missionRuntime.createMission({objective:`service-result 텍스트 파일을 만들어줘. 내용은 ${content}`,successCriteria:[{criterionId:'content',statement:'실제 저장한 파일 내용이 일치한다.',verificationSpec:{version:1,kind:'text.equals',path:target,equals:mode==='wrong-criterion'?'incorrect criterion':content}}],authorization:{mode:'trusted_session',ownerSessionId:owner.session.sessionId,grants:[MissionGrant.READ_ONLY,MissionGrant.LOCAL_REVERSIBLE]}});
 assert.equal((await runtime.missionRuntime.runMission(mission.missionId,{reconciliationOnly:true})).error.code,'A_CORE_AUTHORITY_RECOVERY_MODE_REQUIRED');
 assert.equal((await runtime.missionRuntime.runMission(mission.missionId,{reconciliationOnly:'true'})).error.code,'A_CORE_AUTHORITY_RECOVERY_REQUEST_INVALID');
 assert.equal(adapterCalls,0);
 const result=await runtime.missionRuntime.runMission(mission.missionId);
 if(recoveryMode){
  assert.equal(result.status,'PAUSED');assert.equal(adapterCalls,1);assert.equal(executeDeliveries,1);assert.equal(dispatches,0);
  const originalAction=result.waves[0].actions[0],effectId=originalAction.effect.effectId;
  assert.equal(runtime.missionRuntime.store.getEffect(effectId).state,'uncertain');
  await stopPump();readTransport.close();commandTransport.close();
  const priorToken=runtime.missionExecutionAuthority.lease.token;
  await assert.rejects(runtime.close(),/EFFECT_RECONCILIATION_REQUIRED/);
  offset=120000;
  await assert.rejects(open(priorToken),/EFFECT_RECONCILIATION_REQUIRED/);
  runtime=await open(priorToken,true);relay=runtime.pcOutboundService;
  assert.equal(runtime.missionExecutionAuthority.recoveryOnly,true);
  assert.equal(runtime.missionRuntime.status().executionMode,'recovery-only');
  assert.throws(()=>runtime.missionExecutionAuthority.assertActive(),/RECOVERY_ONLY/);
  assert.equal(runtime.missionRuntime.createMission({objective:'새 파일을 만들어줘'}).error.code,'A_CORE_AUTHORITY_RECOVERY_ONLY');
  await assert.rejects(runtime.orchestrationWorker.runTask(originalAction.taskId),/RECOVERY_ONLY/);
  assert.throws(()=>runtime.orchestrationWorker.enqueueTask(originalAction.taskId),/RECOVERY_ONLY/);
  await assert.rejects(runtime.orchestrationWorker.executeRollbackProof({taskId:originalAction.taskId},{reason:'isolated-recovery',compensationActions:[{}]}),/RECOVERY_ONLY/);
  if(mode==='lost-response-tampered')writeFileSync(target,'changed while Core offline');
  dropAck=false;connect();observe(originalAction.taskId);startPump();
  await listenOnFetchSafePort(runtime.server,{host:'127.0.0.1',port:0});
  const requestPaths=[];
  const workspaceClient=createWorkspaceClient({storage:null,fetchImpl:(url,options)=>{
    requestPaths.push({path:url,method:options.method});
    return fetch(`http://127.0.0.1:${runtime.server.address().port}${url.replace(/^\/api\/core/u,'')}`,{...options,headers:{...options.headers,authorization:'Bearer local-core-admin'}});
  }});
  const resumed=await workspaceClient.reconcileMission(mission.missionId);
  assert.deepEqual(requestPaths.map(x=>x.method),['GET','GET','POST']);
  assert.equal(resumed.missionId,result.missionId);assert.equal(resumed.waves[0].actions[0].effect.effectId,effectId);
  assert.equal(adapterCalls,1);assert.equal(executeDeliveries,1);
  if(mode==='lost-response')assert.equal(resumed.status,'COMPLETED',JSON.stringify({status:resumed.status,stopReason:resumed.stopReason,recovery:resumed.waves[0].actions[0].recovery,pumpErrors:pumpErrors.slice(-3)}));
  else assert.notEqual(resumed.status,'COMPLETED');
  console.log(JSON.stringify({configuredServiceRecovery:true,scenario:mode,initialStatus:result.status,finalStatus:resumed.status,adapterCalls,executeDeliveries,sameMission:true,sameEffect:true,recoveryOnly:runtime.missionExecutionAuthority.recoveryOnly}));
  if(mode==='lost-response'){
   assert.throws(()=>runtime.missionExecutionAuthority.assertActive(),/RECOVERY_ONLY/,'completion never silently promotes recovery authority');
   await stopPump();readTransport.close();commandTransport.close();
   const recoveryToken=runtime.missionExecutionAuthority.lease.token;await runtime.close();
   runtime=await open(recoveryToken,false);runtime.missionExecutionAuthority.assertActive();
   assert.equal(runtime.missionRuntime.getMission(mission.missionId).status,'COMPLETED');assert.equal(adapterCalls,1);
  }
  return;
 }
 const details=JSON.stringify({status:result.status,stopReason:result.stopReason,verification:result.verificationSummary,coverage:result.goalCompletionCoverage,pumpErrors,adapterCalls,dispatches});
 console.log(JSON.stringify({configuredServiceMission:true,scenario:mode,status:result.status,stopReason:result.stopReason,
  adapterCalls,dispatches,criterionStatus:result.verificationSummary?.criteria?.[0]?.status,
  coverageStatus:result.goalCompletionCoverage?.status,modelCalls:result.metrics.plannerAttempts,
  scope:'isolated-configured-service-loopback-PC-same-process'}));
 assert.equal(adapterCalls,1);assert.equal(dispatches,1);
 if(mode==='tampered-artifact'){assert.notEqual(result.status,'COMPLETED',details);assert.equal(readFileSync(target,'utf8'),'changed after receipt');return;}
 assert.equal(readFileSync(target,'utf8'),content);
 if(mode==='wrong-criterion'){assert.notEqual(result.status,'COMPLETED',details);assert.equal(result.verificationSummary.criteria[0].status,'failed');return;}
 assert.equal(result.status,'COMPLETED',details);
 assert.equal(result.verificationSummary.criteria[0].checks[0].checkId,'current_remote_typed_criterion');
 const action=result.waves[0].actions[0],effect=runtime.missionRuntime.store.getEffect(action.effect.effectId);
 assert.equal(effect.state,'succeeded');assert.equal(effect.intent.request.executorBinding.kind,'pc-outbound-command');
 assert.equal(runtime.coreFacade.getTask(action.taskId).status,'COMPLETED');
 for(const mutate of [
  value=>{value.waves[0].actions[0].operation.dispatch.arguments.content='different';},
  value=>{value.waves[0].actions[0].operation.dispatch.arguments.path=join(workspace,'other.txt');},
  value=>{value.observations.find(x=>x.outcome==='success').artifacts[0].contentSha256='f'.repeat(64);},
  value=>{value.waves[0].actions.push({...value.waves[0].actions[0],actionId:'extra-action'});},
  value=>{value.constraints=['추가 조건'];},
  value=>{value.goalContract.objective='changed source';}
 ]){const altered=structuredClone(result);mutate(altered);assert.notEqual(assessMissionGoalCompletionCoverage({mission:altered,allowedRoots:[workspace]}).allowed,true,'tampered source/arguments/evidence cannot use bounded completion');}
});
