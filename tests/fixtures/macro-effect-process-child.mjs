import {createAgRuntime} from '../../apps/runtime-compose/src/create-runtime.js';
import {PersonalOperationsStore} from '../../packages/core/src/personal-operations/operations-store.js';
import {SqliteMissionStore} from '../../packages/core/src/mission/sqlite-mission-store.js';
import {SqliteMemoryStore} from '../../apps/growth-memory/src/db/sqlite-store.js';
import {MissionExecutionAuthority} from '../../packages/core/src/mission/mission-execution-authority.js';
import {mkdirSync,writeFileSync,existsSync,appendFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
const [root,mode]=process.argv.slice(2),workspace=join(root,'workspace'),control=join(root,'control','macros.json');
mkdirSync(workspace,{recursive:true});mkdirSync(join(root,'control'),{recursive:true});
process.env.JARVIS_MACRO_PATH=control;
const objective='파일 목록 확인을 일일목록으로 저장해줘',args={rawText:objective};
const clock=()=>new Date(mode.startsWith('resume')?'2026-10-07T16:22:00Z':'2026-10-07T16:20:00Z');
const operations=new PersonalOperationsStore({dbPath:join(root,'operations.sqlite'),clock});
const memoryStore=new SqliteMemoryStore({dbPath:join(root,'growth.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')});
const store=new SqliteMissionStore({operationsStore:operations}),authority=mode==='authority'?new MissionExecutionAuthority({store}):null;
authority?.activate({expectedToken:0,heartbeat:false});
const runtime=createAgRuntime({missionStore:store,memoryStore,clock,...(authority?{missionExecutionAuthority:authority}:{}),allowedRoots:[workspace],cwd:()=>workspace,auditRoot:join(root,'audit'),cognitionStorePath:join(root,'cognition.sqlite'),workerDaemonEnabled:false,
 trustSigningSecret:'synthetic-macro-process-key',env:{JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'},
 missionPlanner:{async planNextWave(context){return context.observations.length?{decision:'complete',actions:[],criteriaAssessment:context.mission.successCriteria.map(c=>({criterionId:c.criterionId,status:'satisfied',evidenceObservationIds:context.observations.map(o=>o.observationId)}))}:
 {decision:'continue',actions:[{id:'macro',command:objective,expectedToolName:'macro.save',arguments:args,dependencies:[],requirementIds:context.mission.goalContract.requirements.map(r=>r.requirementId)}]};}}});
const stop=async boundary=>{const action=[...runtime.missionRuntime.missions.values()][0]?.waves[0]?.actions[0];process.send({type:'boundary',boundary,pid:process.pid,operationId:action?.operation?.operationId,effectId:action?.effect?.effectId});await new Promise(r=>process.once('message',r));};
runtime.missionRuntime.effectCoordinator.onBoundary=async boundary=>{if(mode===boundary)await stop(boundary);};
runtime.pcAgent.remoteOperationBoundary=async boundary=>{if(mode==='b-receipt'&&boundary==='workflow-receipt-persisted')await stop(mode);};
const adapter=runtime.pcAgent.registry.get('macro.save'),execute=adapter.execute.bind(adapter);
if(mode==='scope'){
 const receive=runtime.pcAgent.receiveExecutionPacket.bind(runtime.pcAgent);
 runtime.pcAgent.receiveExecutionPacket=(packet,options)=>{packet.capabilityToken.scope.allowedPaths=[join(root,'not-authorized')];return receive(packet,options);};
}
if(mode==='store-switch')runtime.missionRuntime.effectCoordinator.onBoundary=async boundary=>{if(boundary==='prepared')adapter.store.path=join(root,'control','other.json');};
adapter.execute=async(...values)=>{appendFileSync(join(root,'calls.jsonl'),'started\n');const result=await execute(...values);
 if(mode==='forged'&&result.status==='success'){result.macroPublication.record.command='unrequested';result.macroObservation.record.command='unrequested';}
 return result;};
if(mode==='published'){
 const snapshot=adapter.store.snapshot.bind(adapter.store);
 adapter.store.snapshot=()=>{if(adapter.store.lastSavePublished){process.send({type:'boundary',boundary:'published',pid:process.pid});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}return snapshot();};
}
if(mode==='revoked'){
 const save=adapter.store.save.bind(adapter.store);
 adapter.store.save=(name,command,options)=>save(name,command,{...options,assertAccess(){throw Error('fixture-authority-revoked');}});
}
process.send({type:'ready',pid:process.pid});
process.once('message',async()=>{try{
 const mission=runtime.missionRuntime.listMissions().items[0]??runtime.missionRuntime.createMission({objective,authorization:{grants:['read_only','local_reversible']},successCriteria:[{statement:objective}]});
 if(mode==='resume-changed')writeFileSync(control,'{"changed":{"name":"changed","command":"keep changed"}}');
 const result=await runtime.missionRuntime.runMission(mission.missionId),action=result.waves[0]?.actions[0];
 process.send({type:'result',pid:process.pid,status:result.status,stopReason:result.stopReason,completion:result.completion,observations:result.observations,criteria:result.successCriteria,recovery:action?.recovery,lastError:action?.lastError??action?.requirementCoverage,
 effect:action?.effect?.effectId?store.getEffect(action.effect.effectId):null,outputExists:existsSync(control),output:existsSync(control)?readFileSync(control,'utf8'):null,
 task:runtime.coreFacade.getTask(action?.taskId),
 bClaims:runtime.pcAgent.operationStore().db.prepare('SELECT count(*) AS n FROM remote_operation_claims').get().n,
 keys:runtime.pcAgent.packetJournal.records.filter(r=>r.recordType==='packet_result'&&r.dryRun===false&&r.toolName==='macro.save').map(r=>r.idempotencyKey)});
 runtime.coreFacade.cognition.close();memoryStore.close();operations.close();process.disconnect();
 }catch(e){process.send({type:'error',message:e.message,stack:e.stack});process.exitCode=1;process.disconnect();}});
