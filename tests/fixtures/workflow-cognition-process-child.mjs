import {mkdirSync,writeFileSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {createAgRuntime} from '../../apps/runtime-compose/src/create-runtime.js';
import {PersonalOperationsStore} from '../../packages/core/src/personal-operations/operations-store.js';
import {SqliteMissionStore} from '../../packages/core/src/mission/sqlite-mission-store.js';
import {SqliteMemoryStore} from '../../apps/growth-memory/src/db/sqlite-store.js';
import {PcAgentExecutionClient} from '../../packages/core/src/client/pc-agent-execution-client.js';
const [root,mode,remoteUrl]=process.argv.slice(2),workspace=join(root,'workspace');
mkdirSync(workspace,{recursive:true});
if(mode.startsWith('fail-')||(mode.startsWith('effect-')&&!mode.startsWith('effect-resume')))writeFileSync(join(workspace,'input.json'),'[{"total":7}]');
const effectClock=mode.startsWith('effect-')?()=>new Date(mode.startsWith('effect-resume')?'2026-10-07T08:42:00Z':'2026-10-07T08:40:00Z'):undefined;
const operations=new PersonalOperationsStore({dbPath:join(root,'operations.sqlite'),...(effectClock?{clock:effectClock}:{})});
const memoryStore=new SqliteMemoryStore({dbPath:join(root,'growth.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')});
const runtime=createAgRuntime({missionStore:new SqliteMissionStore({operationsStore:operations}),allowedRoots:[workspace],cwd:()=>workspace,auditRoot:join(root,'audit'),cognitionStorePath:join(root,'cognition.sqlite'),
 ...(effectClock?{clock:effectClock}:{}),
 memoryStore,
 ...(remoteUrl?{pcAgentExecutor:new PcAgentExecutionClient({baseUrl:remoteUrl,executionToken:'synthetic-workflow-memory-execution-token'})}:{}),
 trustSigningSecret:'synthetic-owned-workflow-recovery-fixture-not-production-key',workerDaemonEnabled:false,
 env:{JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'}});
if(mode.startsWith('fail-')&&!mode.startsWith('fail-growth')&&!mode.startsWith('fail-work')){
 const boundary=mode==='fail-outcome'?'BEFORE INSERT ON cognitive_decision_outcomes':mode==='fail-goal'?"BEFORE UPDATE ON cognitive_goals WHEN NEW.status='COMPLETED'":'BEFORE INSERT ON cognitive_episodes';
 runtime.coreFacade.cognition.db.exec(`CREATE TRIGGER cognition_failure ${boundary} BEGIN SELECT RAISE(ABORT,'synthetic-process-cognition-failure'); END`);
}else if(mode!=='resume-still-failing')runtime.coreFacade.cognition.db.exec('DROP TRIGGER IF EXISTS cognition_failure');
const memoryFailureMode=mode.replace(/^resume-(growth|work-throw|work-false)-still-failing$/u,'fail-$1');
if(memoryFailureMode==='fail-growth'){
 const save=memoryStore.saveEvent.bind(memoryStore);
 memoryStore.saveEvent=event=>{if(event.eventType==='execution.completed')throw Object.assign(new Error('synthetic growth failure'),{code:'TEST_GROWTH_APPEND_FAILED'});return save(event);};
}
const adapter=runtime.pcAgent.registry.get('workflow.execute'),execute=adapter.execute.bind(adapter);
if(memoryFailureMode.startsWith('fail-work'))runtime.coreFacade.workMemory.record=()=>{if(memoryFailureMode==='fail-work-false')return null;throw Object.assign(new Error('synthetic work memory failure'),{code:'TEST_WORK_MEMORY_FAILED'});};
adapter.execute=async(...args)=>{const result=await execute(...args);appendFileSync(join(root,'calls.jsonl'),JSON.stringify({taskId:args[1]?.taskId,status:result.status})+'\n');return result;};
if(mode==='fail-before-pause'){
 const observe=runtime.coreFacade.cognition.observeRun.bind(runtime.coreFacade.cognition);
 runtime.coreFacade.cognition.observeRun=(...args)=>{const result=observe(...args);if(!result&&runtime.coreFacade.cognition.lastError){
  process.send({type:'boundary',boundary:'before-mission-pause',pid:process.pid});
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
 }return result;};
}
process.send({type:'ready',pid:process.pid});
const stopAt=async boundary=>{
 const action=[...runtime.missionRuntime.missions.values()][0]?.waves[0]?.actions[0];
 const effect=action?.effect?.effectId?runtime.missionRuntime.store.getEffect(action.effect.effectId):null;
 process.send({type:'boundary',boundary,pid:process.pid,effectFence:effect?.fence,effectId:effect?.effect_id,operationId:effect?.operation_id});
 await new Promise(r=>process.once('message',r));
};
if(mode==='effect-prepared'||mode==='effect-receipt-persisted')runtime.missionRuntime.effectCoordinator.onBoundary=async boundary=>{
 if(boundary===mode.slice('effect-'.length))await stopAt(boundary);
};
const quotaMode=mode.includes('quota');
let executionMandateId=null;
if(quotaMode){
 const gate=runtime.missionRuntime.store.quotaGate;
 runtime.missionRuntime.executionBudget=gate;
 executionMandateId=gate.list()[0]?.id??gate.createQuota({validFrom:'2026-10-07T08:00:00Z',
  expiresAt:mode.includes('expired')?'2026-10-07T08:41:00Z':'2026-10-07T09:00:00Z',maxCalls:1}).mandate.id;
 if(mode==='effect-resume-quota-revoked')operations.revokeMandate(executionMandateId);
}
if(mode.startsWith('effect-resume-'))runtime.missionRuntime.effectCoordinator.onBoundary=async boundary=>{
 if(boundary!=='claimed')return;
 const mission=[...runtime.missionRuntime.missions.values()][0];
 if(mode==='effect-resume-revoked')mission.authorization.grants=[];
 if(mode==='effect-resume-revision')mission.authorizationRevision=(mission.authorizationRevision??1)+1;
 if(mode==='effect-resume-cancelled')mission.status='CANCELLED';
 if(mode==='effect-resume-token')for(const [tokenId] of runtime.policyRuntime.capabilities.tokens)runtime.policyRuntime.capabilities.revoke({tokenId,reason:'synthetic-recovery-revocation'});
};
if(mode.startsWith('effect-publication-prepared')||mode.startsWith('effect-publication-published')){
 const record=adapter.recordPublicationBoundary.bind(adapter);
 adapter.recordPublicationBoundary=async(state,entry)=>{await record(state,entry);if(entry.phase===(mode.startsWith('effect-publication-prepared')?'prepared':'published'))await stopAt(entry.phase);};
}
if(mode==='effect-b-receipt'){
 const receive=runtime.pcAgent.receiveExecutionPacket.bind(runtime.pcAgent);
 runtime.pcAgent.receiveExecutionPacket=async(packet,options)=>{
  const result=await receive(packet,options);if(options?.dryRun!==true&&packet.action?.toolName==='workflow.execute'&&result.status==='COMPLETED')await stopAt('b-receipt');return result;
 };
}
process.once('message',async()=>{
 try{
  const mission=runtime.missionRuntime.listMissions().items[0]??runtime.missionRuntime.createMission({objective:"'input.json' JSON을 '원본'으로 읽고; '원본'의 개수가 1인지 검증하고; '원본'을 'output.json' JSON으로 저장해",...(executionMandateId?{executionMandateId}:{}),authorization:{grants:['read_only','local_reversible']},successCriteria:[{statement:'합계7',verificationSpec:{version:1,kind:'json.value',path:'output.json',pointer:'/0/total',equals:7}}]});
  if(mode==='resume-relocated'){
   const saved=runtime.missionRuntime.missions.get(mission.missionId);
   saved.metadata.userId='synthetic-alien-user';saved.metadata.conversationId='synthetic-alien-conversation';saved.metadata.workReferenceScope={userId:'synthetic-alien-user',workspaceId:workspace,conversationId:'synthetic-alien-conversation'};
  }
  const result=await runtime.missionRuntime.runMission(mission.missionId);
  const savedMission=result.mission??runtime.missionRuntime.missions.get(mission.missionId);
  const observedMission=result.waves?result:savedMission;
  const observation={missionId:observedMission.missionId,status:observedMission.status,stopReason:observedMission.stopReason,
   rejection:result.waves?null:result,
   episodes:runtime.coreFacade.cognition.db.prepare('SELECT count(*) AS n FROM cognitive_episodes').get().n,
   intents:operations.db.prepare('SELECT count(*) AS n FROM workflow_cognition_intents').get().n,pid:process.pid};
  observation.growthEvents=memoryStore.allEvents().filter(e=>e.eventType==='execution.completed').length;
  observation.workEntries=runtime.coreFacade.workMemory.load().filter(e=>e.status==='success').length;
  const action=observedMission.waves[0]?.actions[0];
  observation.effect=action?.effect?.effectId?runtime.missionRuntime.store.getEffect(action.effect.effectId):null;
  observation.recovery=action?.recovery;
  observation.lastError=action?.lastError;
  observation.defaultWorkflowEffectsEnabled=runtime.missionRuntime.effectCoordinator.workflowEffectsEnabled;
  if(executionMandateId){
   observation.quota=runtime.missionRuntime.executionBudget.inspect(observedMission);
   observation.quotaReservations=operations.db.prepare('SELECT id,state,actual_minor,receipt_ref FROM personal_budget_reservations WHERE mandate_id=?').all(executionMandateId);
  }
  observation.bKeys=runtime.pcAgent.packetJournal.records.filter(r=>r.recordType==='packet_result'&&r.toolName==='workflow.execute'&&r.dryRun===false).map(r=>r.idempotencyKey);
  observation.growthScopes=memoryStore.allEvents().filter(e=>e.eventType==='execution.completed').map(e=>e.source?.memoryScope);
  observation.workScopes=runtime.coreFacade.workMemory.load().filter(e=>e.status==='success').map(e=>e.scope);
  if(mode.startsWith('fail-')){process.send({type:'boundary',boundary:'after-mission-pause',...observation});await new Promise(resolve=>process.once('message',resolve));}
  else process.send({type:'result',...observation});
  runtime.coreFacade.cognition.close();operations.close();memoryStore.close();process.disconnect();
 }catch(e){process.send({type:'error',message:e.message,stack:e.stack});process.exitCode=1;runtime.coreFacade.cognition.close();operations.close();memoryStore.close();process.disconnect();}
});
