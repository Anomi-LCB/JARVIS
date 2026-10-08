import {PcLocalTaskScope} from '../../apps/pc-agent/src/pc-local-task-scope.js';
import { MissionExecutionAuthority } from '../../packages/core/src/mission/mission-execution-authority.js';
import { X509Certificate,createHash } from 'node:crypto';
import { createOperationArtifactReader } from '../../apps/pc-agent/src/operation-artifact-reader.js';
import { createRemoteArtifactBinding } from '../../packages/core/src/mission/remote-artifact-contract.js';
import { startPcOutboundNodeService } from '../../packages/core/src/client/pc-outbound-service.js';
import { PcOutboundExecutionClient } from '../../packages/core/src/client/pc-outbound-execution-client.js';
import { createPcOutboundCommandDispatcher } from '../../apps/pc-agent/src/outbound-command-dispatcher.js';
import { createPcOutboundCommandTransport, createPcOutboundTransport } from '../../packages/core/src/client/pc-outbound-https.js';
import { createPcOutboundObserver } from '../../apps/pc-agent/src/outbound-observer.js';
import { appendFileSync, mkdirSync, readFileSync,realpathSync,statSync } from 'node:fs';
import { join,basename } from 'node:path';
import { createTaskRequest } from '../../packages/shared/src/types.js';
import { canonicalJson } from '../../packages/core/src/mission/artifact-consistency.js';
import { createAgRuntime } from '../../apps/runtime-compose/src/create-runtime.js';
import { createPcAgentServer, PcAgentApiGuard } from '../../apps/pc-agent/src/main.mjs';
import { PcAgentExecutionClient } from '../../packages/core/src/client/pc-agent-execution-client.js';
import { PersonalOperationsStore } from '../../packages/core/src/personal-operations/operations-store.js';
import { SqliteMissionStore } from '../../packages/core/src/mission/sqlite-mission-store.js';
import { SqliteMemoryStore } from '../../apps/growth-memory/src/db/sqlite-store.js';
import { MissionGrant } from '../../packages/core/src/mission/mission-runtime.js';
import { listenOnFetchSafePort } from '../../packages/shared/src/http.js';

const [role, root, mode = 'normal', endpoint = '0', provisionedRootScope = ''] = process.argv.slice(2), workspace = join(root, 'workspace');
const content = mode.includes('criterion-json') ? '{"report":{"count":2,"label":"서울"}}'
  : mode.includes('criterion-csv') ? 'title,count\n"서울,목회",2\n' : 'actual remote durable effect';
const wrong = mode.includes('wrong-equals');
const managedPreflight=mode.includes('managed-preflight-')?mode.split('managed-preflight-')[1]:null;
const criterionValue = mode.includes('criterion-json') ? { kind: 'json.value', pointer: '/report/count', equals: wrong && !mode.includes('multi') ? 3 : 2 }
  : mode.includes('criterion-csv') ? { kind: 'csv.rows', numericColumns: ['count'], order: 'ordered', equals: [{ title: '서울,목회', count: wrong ? 3 : 2 }] }
  : { kind: 'text.equals', equals: wrong ? 'incorrect expected value' : content };
const fourFiles=mode.includes('four-files');
const fileKinds=['source','report','table','card'];
const facts={total:42,label:'서울'},factsDigest=createHash('sha256').update(canonicalJson(facts)).digest('hex');
const documents=fileKinds.map(kind=>kind==='source'?{sourceId:'source',revision:1,digest:factsDigest,facts}
  :{artifactId:kind,sourceRef:{sourceId:'source',revision:1,digest:factsDigest},facts:mode.includes('wrong-facts')&&kind==='card'?{...facts,total:99}:facts});
let fixedTaskIds=[];
if(!mode.includes('-os-boundary'))mkdirSync(workspace, { recursive: true });
const signingSecret = 'synthetic-remote-operation-capability-key-no-production-secret';
const trustSigningSecret = 'synthetic-remote-operation-trust-key-no-production-secret';
const executionToken = 'synthetic-remote-operation-http-execution-token';
const env = { JARVIS_TEST_MODE: '1', JARVIS_MISSION_EXECUTIVE: '0', JARVIS_LLM_INTENT: '0', JARVIS_LLM_PLANNER: '0', JARVIS_LLM_CONTENT: '0' };
const options = { ...(mode.startsWith('cognition-')?{cognitionStorePath:join(root,'remote-cognition.sqlite')}:{}), allowedRoots: [mode.includes('-os-boundary')?root:workspace], auditRoot: join(root, role), cwd: () => mode.includes('-os-boundary')?root:workspace,
  signingSecret, trustSigningSecret, env, taskEnv: env, workerDaemonEnabled: false };
async function stop(boundary) { process.send?.({ type: 'boundary', boundary }); await new Promise(resolve => process.once('message', resolve)); }
function testRootScope(){
  const physical=realpathSync(workspace),info=statSync(physical,{bigint:true});
  return createHash('sha256').update(JSON.stringify([{path:workspace,physical,dev:info.dev.toString(),ino:info.ino.toString()}])).digest('hex');
}
if (role === 'b') {
  const runtime = createAgRuntime(options), sockets = new Set();
  const adapter = runtime.pcAgent.registry.get('filesystem.createTextFile'), execute = adapter.execute.bind(adapter);
  adapter.execute = async (...args) => {
    const result = await execute(...args);
    appendFileSync(join(root, 'remote-adapter.jsonl'), JSON.stringify({ taskId: args[1].taskId, key: args[1].idempotencyKey, status: result.status }) + '\n');
    if (mode === 'file-effect') await stop(mode);
    return result;
  };
  runtime.pcAgent.remoteOperationBoundary = async boundary => {
    if (mode === 'revoke-at-claim' && boundary === 'claimed') {
      for (const tokenId of runtime.policyRuntime.capabilities.tokens.keys()) runtime.policyRuntime.capabilities.revoke({ tokenId, reason: 'synthetic-revocation' });
    }
    if (boundary === mode) await stop(boundary);
  };
  if (mode === 'b-journal') {
    const original = runtime.pcAgent.executeRemoteOperation.bind(runtime.pcAgent);
    // Pause immediately before the B operation receipt transaction, after its packet journal exists.
    const store = runtime.pcAgent.operationStore(), complete = store.complete.bind(store);
    store.complete = (...args) => { process.send?.({ type: 'boundary', boundary: mode }); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); return complete(...args); };
    runtime.pcAgent.executeRemoteOperation = original;
  }
  if (mode === 'drop-response') {
    const original = runtime.pcAgent.executeRemoteOperation.bind(runtime.pcAgent);
    runtime.pcAgent.executeRemoteOperation = async (...args) => { const result = await original(...args); for (const socket of sockets) socket.destroy(); return result; };
  }
  const server = createPcAgentServer(runtime.pcAgent, { apiGuard: new PcAgentApiGuard({ apiToken: 'synthetic-admin-token', executionToken }) });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  if (Number(endpoint) === 0) await listenOnFetchSafePort(server);
  else await new Promise(resolve => server.listen(Number(endpoint), '127.0.0.1', resolve));
  let observationTimer,observationTransport,commandTimer,commandTransport;
  process.on('message',message=>{
    if(message?.type!=='observe-artifact')return;
    clearInterval(observationTimer);observationTransport?.close();
    const pem=name=>readFileSync(new URL(`./google-broker-tls/${name}.pem`,import.meta.url));
    observationTransport=createPcOutboundTransport({url:message.url,key:pem('core-key'),cert:pem('core'),ca:pem('ca')});
    const readOperation=input=>{
      appendFileSync(join(root,'pc-observer.jsonl'),JSON.stringify({pid:process.pid,taskId:input.taskId})+'\n');
      return runtime.pcAgent.readRemoteOperation(input);
    };
    const pcClient={health:async()=>({status:'ok'}),readOperation};
    let localScope=null,managedOffset=0;
    if(message.localReadiness||message.managedPreflight){
      localScope=new PcLocalTaskScope({dbPath:join(root,'readiness-scope.sqlite'),managedCatalog:true,clock:()=>Date.now()+managedOffset});
      if(message.localReadiness!=='missing')localScope.replaceCatalog({expectedRevision:localScope.catalog().revision,allowedTaskIds:[message.taskId],allowedArtifactTaskIds:[message.taskId],allowedCommandTaskIds:[message.taskId]});
      if(message.managedPreflight)localScope.replace({expectedRevision:localScope.snapshot().revision,allowedTaskIds:[message.taskId],expiresAt:Date.now()+60000});
      if(message.localReadiness==='expired'){localScope.replace({expectedRevision:1,allowedTaskIds:[message.taskId],expiresAt:Date.now()+60000});managedOffset=120000;}
    }
    if(message.managedPreflight==='permission-after-readiness'){
      const exchange=observationTransport.exchange.bind(observationTransport);
      observationTransport.exchange=async(op,input)=>{const value=await exchange(op,input);
        if(op==='submit'&&input.result?.value?.locallyReady===true)localScope.replace({expectedRevision:localScope.snapshot().revision,allowedTaskIds:[],expiresAt:0});return value;};
    }
    const artifactReader=createOperationArtifactReader({allowedRoots:[workspace],allowedTaskIds:message.taskIds??[message.taskId],
      expectedRootScopeSha256:message.rootScopeSha256,readOperation});
    const observer=createPcOutboundObserver({transport:observationTransport,pcClient,...(message.managedPreflight?{taskCatalog:localScope}:{allowedTaskIds:message.taskIds??[message.taskId]}),artifactReader});
    observationTimer=setInterval(()=>void observer.tick().catch(()=>{}),10);
    if(message.commandUrl){
      clearInterval(commandTimer);commandTransport?.close();
      commandTransport=createPcOutboundCommandTransport({url:message.commandUrl,key:pem('core-key'),cert:pem('core'),ca:pem('ca')});
      const localClient=new PcAgentExecutionClient({baseUrl:`http://127.0.0.1:${server.address().port}`,executionToken});
      if(message.managedPreflight){
        const exchange=commandTransport.exchange.bind(commandTransport);let pulledKind=null;
        commandTransport.exchange=async(op,input)=>{
          if(message.managedPreflight==='lost-reply'&&op==='submit'&&pulledKind==='execute')throw new Error('synthetic lost command response');
          const value=await exchange(op,input);if(op==='pull')pulledKind=value?.kind;
          if(op==='submit'&&pulledKind==='prepare'&&input.result?.value?.state==='prepared'){
            if(message.managedPreflight==='catalog-after-prepare')localScope.replaceCatalog({expectedRevision:localScope.catalog().revision,allowedTaskIds:[message.taskId],allowedArtifactTaskIds:[message.taskId],allowedCommandTaskIds:[]});
            if(message.managedPreflight==='expiry-after-prepare')managedOffset=120000;
          }return value;};
      }
      const dispatcher=createPcOutboundCommandDispatcher({transport:commandTransport,pcClient:localClient,...(message.mutationFenceRequired||localScope?{pcAgent:runtime.pcAgent}:{}),taskScope:localScope,allowedTaskIds:message.localScopeDenied?[]:message.taskIds??[message.taskId]});
      commandTimer=setInterval(()=>void dispatcher.tick().catch(()=>{}),10);
    }

  });
  process.send?.({ type: 'ready', url: `http://127.0.0.1:${server.address().port}`, pid: process.pid,rootScopeSha256:testRootScope() });
} else {
  const operations = new PersonalOperationsStore({ dbPath: join(root, 'core-operations.sqlite'), clock: () => new Date(Date.now() + (mode.startsWith('resume') ? 120_000 : 0)) });
  const store = new SqliteMissionStore({ operationsStore: operations });
  const memoryStore = new SqliteMemoryStore({ dbPath: join(root, 'core-growth.sqlite'), reviewDir: join(root, 'reviews'), backupDir: join(root, 'backups') });
  let client = new PcAgentExecutionClient({ baseUrl: endpoint, executionToken, timeoutMs: 5000 });
  let relay,transport,observerTimer,artifactRecovery,artifactReconciliations=0;const artifactDiagnostics=[];
  const pem=name=>readFileSync(new URL(`./google-broker-tls/${name}.pem`,import.meta.url));
  const artifactMode=mode.includes('artifact'),commandMode=mode.includes('command-channel'),mutationMode=mode.includes('mutation-fenced');
  const authorityMode=mode.includes('core-authority');
  const coreAuthority=authorityMode?new MissionExecutionAuthority({store,ttlMs:30000}):null;
  coreAuthority?.activate({expectedToken:0,heartbeat:false});
  const pcObserverMode=mode.includes('pc-observer');let observationConfigured=false;
  if(artifactMode){
    relay=await startPcOutboundNodeService({dbPath:join(root,`artifact-relay-${process.pid}.sqlite`),commandTransport:commandMode,commandExecutionFenceRequired:commandMode,authorityGuard:()=>coreAuthority?coreAuthority.assertActive():({token:1}),tls:{key:pem('server-key'),cert:pem('server'),ca:pem('ca')}});
    if(!pcObserverMode)transport=createPcOutboundTransport({url:`https://127.0.0.1:${relay.address.port}/v1/pc/observe`,key:pem('core-key'),cert:pem('core'),ca:pem('ca')});
    // Synthetic owner provisioning independently observes this test PC root.
    // This is not a production root discovery or remote attestation API.
    const rootScopeSha256=pcObserverMode?provisionedRootScope:testRootScope();
    artifactRecovery={client:relay.createReceiptClient('reconcile-pc',{timeoutMs:1500,pollIntervalMs:10}),binding:createRemoteArtifactBinding({
      deviceId:'reconcile-pc',deviceGeneration:1,certificateFingerprint:new X509Certificate(pem('core')).fingerprint256,
      pathPlatform:process.platform==='win32'?'win32':'posix',allowedRoots:[workspace],rootScopeSha256})};
  }
  if(commandMode)client=new PcOutboundExecutionClient({commands:relay.commandMailbox,deviceId:'reconcile-pc',receiptClient:artifactRecovery.client,artifactBinding:artifactRecovery.binding,requireMutationFence:mutationMode,timeoutMs:5000,pollIntervalMs:10});
  if(artifactRecovery){
    const reconcile=artifactRecovery.client.reconcileDurableArtifact.bind(artifactRecovery.client);
    artifactRecovery.client.reconcileDurableArtifact=async input=>{artifactReconciliations++;return reconcile(input);};
    if(mode.includes('revoke-between')){
      const assertCurrent=artifactRecovery.client.assertConsumedArtifactObservationCurrent.bind(artifactRecovery.client);
      let checked=false;
      artifactRecovery.client.assertConsumedArtifactObservationCurrent=observation=>{
        const value=assertCurrent(observation);
        if(!checked){checked=true;relay.controller.revoke({deviceId:'reconcile-pc',expectedGeneration:1});}
        return value;
      };
    }
  }
  function observeArtifact(taskId){
    if(fourFiles)fixedTaskIds=runtime.missionRuntime.getMission(runtime.missionRuntime.listMissions().items[0].missionId).waves[0].actions.map(action=>action.reservedTaskId??action.taskId);
    observationConfigured=true;
    relay.controller.enroll({deviceId:'reconcile-pc',certificateFingerprint:new X509Certificate(pem('core')).fingerprint256,
      expiresAt:new Date(Date.now()+60000).toISOString().replace(/\.\d{3}Z$/u,'Z'),allowedTaskIds:fourFiles?fixedTaskIds:[taskId],allowedArtifactTaskIds:fourFiles?fixedTaskIds:[taskId],expectedGeneration:0});
    if(commandMode)relay.commandMailbox.grant({deviceId:'reconcile-pc',expectedGeneration:1,allowedTaskIds:fourFiles?fixedTaskIds:[taskId],expiresAt:Date.now()+50000});
    if(pcObserverMode){
      process.send?.({type:'pc-observer-config',taskId,taskIds:fourFiles?fixedTaskIds:[taskId],rootScopeSha256:artifactRecovery.binding.rootScopeSha256,...(managedPreflight?{managedPreflight}:{}),...(mode.endsWith('local-scope-denied')?{localScopeDenied:true}:{}),...(mode.includes('local-readiness-')?{localReadiness:mode.split('local-readiness-')[1]}:{}),
        url:`https://127.0.0.1:${relay.address.port}/v1/pc/observe`,...(commandMode?{commandUrl:`https://127.0.0.1:${relay.address.port}/v1/pc/command`,mutationFenceRequired:mutationMode}:{})});
      return;
    }
    const artifactReader=createOperationArtifactReader({allowedRoots:[workspace],allowedTaskIds:[taskId],
      expectedRootScopeSha256:artifactRecovery.binding.rootScopeSha256,readOperation:async input=>{
        const value=await client.readOperation(input);artifactDiagnostics.push({state:value?.state,success:value?.receipt?.executionResult?.success,
          status:value?.receipt?.executionResult?.status,files:value?.receipt?.evidence?.files});return value;}});
    const observedReader=async input=>{try{return await artifactReader(input);}catch(error){artifactDiagnostics.push({code:error.code});throw error;}};
    const observer=createPcOutboundObserver({transport,pcClient:client,allowedTaskIds:[taskId],artifactReader:observedReader});
    observerTimer=setInterval(()=>void observer.tick().catch(()=>{}),10);
  }
  const runtime = createAgRuntime({ ...options, missionStore: store, memoryStore, pcAgentExecutor: client,...(coreAuthority?{missionExecutionAuthority:coreAuthority}:{}),
    missionRemoteArtifactRecovery:artifactRecovery,
    missionPlanner: { async planNextWave(context) {
      if (context.observations.filter(item => item.outcome === 'success').length >= (fourFiles?4:1)) return { decision: 'complete', actions: [],
        criteriaAssessment: context.mission.successCriteria.map(item => ({ criterionId: item.criterionId, status: 'satisfied',
          evidenceActionIds: context.observations.filter(observation => observation.outcome === 'success').map(observation => observation.actionId) })) };
      if(fourFiles)return {decision:'continue',actions:fileKinds.map((kind,i)=>({id:`write_${kind}`,command:`${kind}.json 텍스트 파일을 만들어줘`,expectedToolName:'filesystem.createTextFile',
        arguments:{path:join(workspace,`${kind}.json`),content:JSON.stringify(documents[i])},dependencies:i?[`write_${fileKinds[i-1]}`]:[],
        requirementIds:[context.mission.goalContract.requirements[i]?.requirementId??context.mission.goalContract.requirements[0].requirementId]}))};
      return { decision: 'continue', actions: [{ id: 'write', command: 'result 텍스트 파일을 만들어줘', expectedToolName: 'filesystem.createTextFile',
        arguments: { path: join(workspace, 'result.txt'), content }, dependencies: [],
        requirementIds: [context.mission.goalContract.requirements[0].requirementId] }] };
    } } });
  // Same public executor injection used by the service; no local execution fallback.
  runtime.orchestrationWorker.pcAgent = client;
  let preflightObservation=null;
  if(mode==='cognition-failure')runtime.coreFacade.cognition.db.exec("CREATE TRIGGER cognition_failure BEFORE INSERT ON cognitive_episodes BEGIN SELECT RAISE(ABORT,'injected-remote-cognition-failure'); END");
  if(mode==='cognition-resume')runtime.coreFacade.cognition.db.exec('DROP TRIGGER IF EXISTS cognition_failure');
  runtime.missionRuntime.effectCoordinator.onBoundary = async (boundary,{action}) => {
    if(artifactMode&&boundary==='prepared'&&!observationConfigured){
      observeArtifact(action.taskId);
      if(managedPreflight){
        const requestId='managed-readiness';relay.controller.enqueue('reconcile-pc',{requestId,operation:'task-readiness',taskId:action.taskId});
        const deadline=Date.now()+5000;
        do{preflightObservation=relay.controller.result(requestId);if(preflightObservation?.state==='observed')break;await new Promise(r=>setTimeout(r,10));}while(Date.now()<deadline);
        if(preflightObservation?.configurationReadiness?.status!=='configuration-matched')throw new Error('MANAGED_PREFLIGHT_NOT_MATCHED');
        if(managedPreflight==='core-permission-after-readiness')relay.commandMailbox.grant({deviceId:'reconcile-pc',expectedGeneration:1,expectedRevision:1,allowedTaskIds:[],expiresAt:Date.now()+50000});
      }
    }
    if(artifactMode&&mode.endsWith('-revoke')&&boundary==='receipt-persisted')relay.controller.revoke('reconcile-pc',{expectedGeneration:1});
    if (boundary === mode) await stop(boundary);
  };
  client.remoteOperationBoundary = async boundary => {
    const stopPrepared = ['cancel-remote-prepared', 'revise-remote-prepared', 'shutdown-remote-prepared'].includes(mode) && boundary === 'remote-prepared';
    if (boundary === mode || stopPrepared) await stop(boundary);
    if (stopPrepared) {
      const missionId = runtime.missionRuntime.listMissions().items[0].missionId;
      if (mode === 'cancel-remote-prepared') runtime.missionRuntime.cancelMission(missionId);
      else if (mode === 'shutdown-remote-prepared') runtime.missionRuntime.requestShutdown({ reason: 'synthetic-prepared-shutdown' });
      else {
        const revision = runtime.missionRuntime.reviseMissionGoal(missionId, { expectedRevision: 1, idempotencyKey: 'synthetic_revision', objective: "'revised.txt'를 저장해" });
        if (!revision.success) throw new Error(JSON.stringify(revision));
      }
    }
  };
  if(artifactMode&&mode.startsWith('resume'))observeArtifact(runtime.missionRuntime.getMission(runtime.missionRuntime.listMissions().items[0].missionId).waves[0].actions[0].taskId);
  if(mode==='resume-outbound'){
    const taskId=runtime.missionRuntime.getMission(runtime.missionRuntime.listMissions().items[0].missionId).waves[0].actions[0].taskId;
    const pem=name=>readFileSync(new URL(`./google-broker-tls/${name}.pem`,import.meta.url));
    relay=await startPcOutboundNodeService({dbPath:join(root,'outbound-reconciliation.sqlite'),authorityGuard:()=>({token:1}),tls:{key:pem('server-key'),cert:pem('server'),ca:pem('ca')}});
    relay.controller.enroll({deviceId:'reconcile-pc',certificateFingerprint:new X509Certificate(pem('core')).fingerprint256,expiresAt:new Date(Date.now()+60000).toISOString().replace(/\.\d{3}Z$/u,'Z'),allowedTaskIds:[taskId],expectedGeneration:0});
    transport=createPcOutboundTransport({url:`https://127.0.0.1:${relay.address.port}/v1/pc/observe`,key:pem('core-key'),cert:pem('core'),ca:pem('ca')});
    const observer=createPcOutboundObserver({transport,pcClient:client,allowedTaskIds:[taskId]});
    observerTimer=setInterval(()=>void observer.tick().catch(()=>{}),25);
    const receipts=relay.createReceiptClient('reconcile-pc');client.receiptForOperation=input=>receipts.receiptForOperation(input);
  }
  const closeRelay=async()=>{clearInterval(observerTimer);transport?.close();await relay?.close();};
  process.send?.({ type: 'ready', pid: process.pid });
  process.once('message', async () => {
    try {
      const mission = runtime.missionRuntime.listMissions().items[0] ?? runtime.missionRuntime.createMission({ objective: fourFiles?fileKinds.map(kind=>`'${join(workspace,`${kind}.json`)}'를 저장해`).join(' 그리고 '):(mode.includes('-os-boundary')||commandMode)?`'${join(workspace,'result.txt')}'를 저장해`:"'result.txt'를 저장해",
        successCriteria: fourFiles?[{criterionId:'consistency',statement:'네 파일의 사실과 출처가 일치한다.',verificationSpec:{version:1,kind:'artifact.consistency',...Object.fromEntries(fileKinds.map(kind=>[`${kind}Path`,join(workspace,`${kind}.json`)]))}}]:[...(mode.includes('multi')?[{criterionId:'label',statement:'파일의 이름 값이 일치한다.',verificationSpec:{version:1,kind:'json.value',path:join(workspace,'result.txt'),pointer:'/report/label',equals:wrong?'부산':'서울'}}]:[]),{ criterionId: 'text', statement: '파일의 실제 내용이 일치한다.', verificationSpec: { version: 1, ...criterionValue, path: (mode.includes('-os-boundary')||commandMode)?join(workspace,'result.txt'):'result.txt' } }],
        authorization: { grants: [MissionGrant.READ_ONLY, MissionGrant.LOCAL_REVERSIBLE] } });
      const result = await runtime.missionRuntime.runMission(mission.missionId), action = result.waves[0]?.actions[0];
      if(mode==='cognition-failure')await stop('cognition-failed');
      await Promise.allSettled([...runtime.missionRuntime.goalRevisions.drains.values()]);
      process.send?.({ type: 'result', result, preflightObservation, effect: action?.effect ? store.getEffect(action.effect.effectId) : null,
        cognitionEpisodes:runtime.coreFacade.cognition.db.prepare('SELECT COUNT(*) AS n FROM cognitive_episodes').get().n,
        pendingFollowups: store.pendingFollowups().length,artifactDiagnostics,artifactReconciliations,
        coreUid:process.getuid?.()??null,
        coreCapabilities:mode.includes('-os-boundary')?readFileSync('/proc/self/status','utf8').match(/^CapEff:\s*(\w+)/mu)?.[1]:null,
        coreDirectRead:mode.includes('-os-boundary')?(()=>{try{readFileSync(join(workspace,fourFiles?'source.json':'result.txt'));return 'allowed';}catch(error){return error.code;}})():null,
        verificationScope:runtime.coreFacade.getTask(action?.taskId)?.executionVerification?.scope??null,
        growthCount: memoryStore.allEvents().filter(item => item.taskId === action?.taskId && item.eventType === 'execution.completed').length,
        allGrowthCount:memoryStore.allEvents().filter(item=>item.eventType==='execution.completed').length,allWorkCount:runtime.coreFacade.workMemory.load().length,
        workCount: runtime.coreFacade.workMemory.load().filter(item => item.taskId === action?.taskId).length });
      await closeRelay();operations.close(); memoryStore.close(); process.disconnect?.();
    } catch (error) { process.send?.({ type: 'error', message: error.message, stack: error.stack }); await closeRelay();operations.close(); memoryStore.close(); process.disconnect?.(); process.exitCode = 1; }
  });
}
