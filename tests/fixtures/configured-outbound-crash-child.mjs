import {appendFileSync,readFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {createConfiguredCoreServiceRuntime} from '../../scripts/core-service-runtime.mjs';
import {createAgRuntime} from '../../apps/runtime-compose/src/create-runtime.js';
import {startPcOutboundNodeService} from '../../packages/core/src/client/pc-outbound-service.js';
import {createPcAgentServer,PcAgentApiGuard} from '../../apps/pc-agent/src/main.mjs';
import {PcAgentExecutionClient} from '../../packages/core/src/client/pc-agent-execution-client.js';
import {createPcOutboundTransport,createPcOutboundCommandTransport} from '../../packages/core/src/client/pc-outbound-https.js';
import {createPcOutboundObserver} from '../../apps/pc-agent/src/outbound-observer.js';
import {createPcOutboundCommandDispatcher} from '../../apps/pc-agent/src/outbound-command-dispatcher.js';
import {createOperationArtifactReader} from '../../apps/pc-agent/src/operation-artifact-reader.js';
import {PcLocalTaskScope} from '../../apps/pc-agent/src/pc-local-task-scope.js';
import {MissionGrant} from '../../packages/core/src/mission/mission-runtime.js';
import {listenOnFetchSafePort} from '../../packages/shared/src/http.js';

const [role,root,mode='initial',token='0']=process.argv.slice(2),workspace=join(root,'workspace');
const pem=name=>readFileSync(new URL(`./google-broker-tls/${name}.pem`,import.meta.url));
const base={JARVIS_TEST_MODE:'1',JARVIS_MISSION_EXECUTIVE:'0',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'};
mkdirSync(workspace,{recursive:true});
try{
 if(role==='pc'){
  const runtime=createAgRuntime({env:base,taskEnv:base,allowedRoots:[workspace],auditRoot:join(root,'pc-audit'),cwd:()=>workspace,workerDaemonEnabled:false});
  const adapter=runtime.pcAgent.registry.get('filesystem.createTextFile'),execute=adapter.execute.bind(adapter);
  adapter.execute=async(...args)=>{const result=await execute(...args);appendFileSync(join(root,'pc-executions.jsonl'),JSON.stringify({taskId:args[1]?.taskId,status:result.status,pid:process.pid})+'\n');return result;};
  const scope=new PcLocalTaskScope({dbPath:join(root,'pc-scope.sqlite'),managedCatalog:true});
  const server=createPcAgentServer(runtime.pcAgent,{apiGuard:new PcAgentApiGuard({apiToken:'test-only-pc-admin',executionToken:'test-only-pc-execute'}),localTaskScope:scope});
  await listenOnFetchSafePort(server,{host:'127.0.0.1',port:0});
  const client=new PcAgentExecutionClient({baseUrl:`http://127.0.0.1:${server.address().port}`,executionToken:'test-only-pc-execute'});
  let timer,readTransport,commandTransport,announced=false;
  const pending=new Set();
  process.on('message',async message=>{
   if(message.type!=='connect')return;
   clearInterval(timer);await Promise.allSettled([...pending]);readTransport?.close();commandTransport?.close();
   if(message.provision){
    scope.replaceCatalog({expectedRevision:0,allowedTaskIds:[message.taskId],allowedArtifactTaskIds:[message.taskId],allowedCommandTaskIds:[message.taskId]});
    scope.replace({expectedRevision:1,allowedTaskIds:[message.taskId],expiresAt:Date.now()+120000});
   }
   readTransport=createPcOutboundTransport({url:`https://127.0.0.1:${message.port}/v1/pc/observe`,key:pem('core-key'),cert:pem('core'),ca:pem('ca')});
   commandTransport=createPcOutboundCommandTransport({url:`https://127.0.0.1:${message.port}/v1/pc/command`,key:pem('core-key'),cert:pem('core'),ca:pem('ca')});
   const wrapped={exchange:async(kind,input)=>{
    if(kind==='submit'&&input.result?.value?.status==='COMPLETED'&&message.dropAck){
     if(!announced){announced=true;process.send({type:'completed-reply-lost',taskId:message.taskId,pid:process.pid});}
     throw new Error('isolated lost execute acknowledgment');
    }
    const result=await commandTransport.exchange(kind,input);
    if(kind==='pull'&&result?.kind==='execute')appendFileSync(join(root,'pc-deliveries.jsonl'),JSON.stringify({taskId:message.taskId})+'\n');
    return result;
   }};
   const dispatcher=createPcOutboundCommandDispatcher({transport:wrapped,pcClient:client,pcAgent:runtime.pcAgent,taskScope:scope});
   const reader=createOperationArtifactReader({allowedRoots:[workspace],allowedTaskIds:[message.taskId],expectedRootScopeSha256:message.rootScopeSha256,readOperation:input=>client.readOperation(input)});
   const observer=createPcOutboundObserver({transport:readTransport,pcClient:{health:async()=>({status:'ok'}),readOperation:input=>client.readOperation(input)},taskCatalog:scope,artifactReader:reader});
   let errorCount=0;
   timer=setInterval(()=>{for(const part of [dispatcher,observer]){const p=part.tick().catch(error=>{if(errorCount++<4)process.stderr.write(`PC tick: ${error.code??error.message}\n`);}).finally(()=>pending.delete(p));pending.add(p);}},10);
   process.send({type:'connected',pid:process.pid,catalogRevision:scope.catalog().revision,scopeRevision:scope.snapshot().revision});
  });
  process.send({type:'ready',pid:process.pid});
 }else{
  const bindingPath=join(root,'binding.json'),binding=JSON.parse(readFileSync(bindingPath,'utf8'));
  const env={...base,JARVIS_CORE_ROOT:root,JARVIS_TEST_AUDIT_ROOT:join(root,'core-audit'),JARVIS_CORE_PORT:'0',JARVIS_CORE_ALLOWED_ROOTS:'workspace',
   JARVIS_CORE_WORKER_DAEMON_ENABLED:'0',JARVIS_CORE_WORKER_DAEMON_AUTOSTART:'0',JARVIS_PERSONAL_IMPORT_ENABLED:'0',JARVIS_GOOGLE_SYNC_ENABLED:'0',
   JARVIS_PERSONAL_OPERATIONS_DB:join(root,'core-operations.sqlite'),JARVIS_CORE_MISSION_STORE_BACKEND:'sqlite',JARVIS_CORE_MISSION_AUTHORITY_ENABLED:'1',
   JARVIS_CORE_MISSION_AUTHORITY_EXPECTED_TOKEN:token,JARVIS_CORE_MISSION_AUTHORITY_TTL_MS:'1000',JARVIS_CORE_MISSION_AUTHORITY_RECOVERY_ONLY:mode==='recover'?'1':'0',
   JARVIS_CORE_PC_OUTBOUND_ENABLED:'1',JARVIS_CORE_PC_OUTBOUND_COMMAND_ENABLED:'1',JARVIS_CORE_PC_OUTBOUND_EXECUTION_ENABLED:'1',JARVIS_CORE_PC_OUTBOUND_EXECUTION_BINDING_PATH:bindingPath};
  const runtime=await createConfiguredCoreServiceRuntime({env,pcOutboundServiceFactory:({authorityGuard})=>startPcOutboundNodeService({dbPath:join(root,'relay.sqlite'),authorityGuard,commandTransport:true,commandExecutionFenceRequired:true,tls:{key:pem('server-key'),cert:pem('server'),ca:pem('ca')}})});
  runtime.missionRuntime.effectCoordinator.leaseTtlMs=1000;
  // Any local fallback would violate the intended remote execution contract.
  runtime.pcAgent.registry.get('filesystem.createTextFile').execute=async()=>{appendFileSync(join(root,'forbidden-core-execution.jsonl'),'fallback\n');throw new Error('local fallback forbidden');};
  await listenOnFetchSafePort(runtime.server,{host:'127.0.0.1',port:0});
  runtime.missionRuntime.effectCoordinator.onBoundary=async(boundary,{action})=>{
   if(boundary!=='prepared'||mode!=='initial')return;
   process.send({type:'prepared',taskId:action.taskId,missionId:runtime.missionRuntime.listMissions().items[0].missionId,effectId:action.effect.effectId});
   await new Promise(resolve=>process.once('message',message=>{
    if(message.type!=='provision')throw new Error('invalid isolated provisioning');
    const relay=runtime.pcOutboundService;
    relay.controller.enroll({deviceId:binding.deviceId,certificateFingerprint:binding.certificateFingerprint,expiresAt:new Date(Date.now()+120000).toISOString().replace(/\.\d{3}Z$/u,'Z'),allowedTaskIds:[action.taskId],allowedArtifactTaskIds:[action.taskId],expectedGeneration:0});
    relay.commandMailbox.grant({deviceId:binding.deviceId,expectedGeneration:1,allowedTaskIds:[action.taskId],expiresAt:Date.now()+110000});resolve();
   }));
  };
  process.on('message',async message=>{
   if(message.type!=='run')return;
   try{
    const owner=runtime.personalOwnerSession.activate({requestedBy:'isolated-outbound-service-process',durationMinutes:5});
    const created=runtime.missionRuntime.createMission({objective:'result 텍스트 파일을 만들어줘. 내용은 원격 서비스 프로세스 복구',successCriteria:[{criterionId:'content',statement:'실제 원격 파일 내용 일치',verificationSpec:{version:1,kind:'text.equals',path:join(workspace,'result.txt'),equals:'원격 서비스 프로세스 복구'}}],authorization:{mode:'trusted_session',ownerSessionId:owner.session.sessionId,grants:[MissionGrant.READ_ONLY,MissionGrant.LOCAL_REVERSIBLE]}});
    const result=await runtime.missionRuntime.runMission(created.missionId);process.send({type:'result',status:result.status,stopReason:result.stopReason,recovery:result.waves?.[0]?.actions?.[0]?.recovery,observation:result.observations?.[0]?.error});
   }catch(error){process.send({type:'error',code:error.code??error.message});}
  });
  process.send({type:'ready',pid:process.pid,port:runtime.server.address().port,relayPort:runtime.pcOutboundService.address.port,token:runtime.missionExecutionAuthority.lease.token,executionMode:runtime.missionRuntime.status().executionMode});
 }
}catch(error){process.send({type:'startup-error',code:error.code??error.message});process.disconnect();}
