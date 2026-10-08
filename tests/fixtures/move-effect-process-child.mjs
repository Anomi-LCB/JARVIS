import {createAgRuntime} from '../../apps/runtime-compose/src/create-runtime.js';
import {PersonalOperationsStore} from '../../packages/core/src/personal-operations/operations-store.js';
import {SqliteMissionStore} from '../../packages/core/src/mission/sqlite-mission-store.js';
import {SqliteMemoryStore} from '../../apps/growth-memory/src/db/sqlite-store.js';
import {MissionExecutionAuthority} from '../../packages/core/src/mission/mission-execution-authority.js';
import {mkdirSync,writeFileSync,existsSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';
const [root,mode]=process.argv.slice(2),workspace=join(root,'workspace');mkdirSync(workspace,{recursive:true});
const moves=[1,2].map(n=>({from:join(workspace,`source${n}.txt`),to:join(workspace,`target${n}.txt`)}));
if(!mode.startsWith('resume'))for(const [i,move]of moves.entries())writeFileSync(move.from,`synthetic ${i}`);
const clock=()=>new Date(mode.startsWith('resume')?'2026-10-07T10:02:00Z':'2026-10-07T10:00:00Z');
const operations=new PersonalOperationsStore({dbPath:join(root,'operations.sqlite'),clock});
const memoryStore=new SqliteMemoryStore({dbPath:join(root,'growth.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')});
const store=new SqliteMissionStore({operationsStore:operations});
const authority=mode==='authority'?new MissionExecutionAuthority({store}):null;
authority?.activate({expectedToken:0,heartbeat:false});
const runtime=createAgRuntime({missionStore:store,memoryStore,clock,...(authority?{missionExecutionAuthority:authority}:{}),allowedRoots:[workspace],cwd:()=>workspace,
 auditRoot:join(root,'audit'),cognitionStorePath:join(root,'cognition.sqlite'),workerDaemonEnabled:false,
 trustSigningSecret:'synthetic-move-process-fixture-key-not-production',
 env:{JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'},
 missionPlanner:{async planNextWave(context){return context.observations.length?{decision:'complete',actions:[],criteriaAssessment:context.mission.successCriteria.map(c=>({criterionId:c.criterionId,status:'satisfied',evidenceObservationIds:context.observations.map(o=>o.observationId)}))}:
 {decision:'continue',actions:[{id:'move',command:`'${moves[0].from}' 파일을 '${moves[0].to}'로 이동해`,expectedToolName:'filesystem.moveFiles',arguments:{moves},dependencies:[],requirementIds:context.mission.goalContract.requirements.map(r=>r.requirementId)}]};}}});
const stop=async boundary=>{const action=[...runtime.missionRuntime.missions.values()][0]?.waves[0]?.actions[0];process.send({type:'boundary',boundary,pid:process.pid,operationId:action?.operation?.operationId,effectId:action?.effect?.effectId});await new Promise(r=>process.once('message',r));};
runtime.missionRuntime.effectCoordinator.onBoundary=async boundary=>{if(mode===boundary)await stop(boundary);};
runtime.pcAgent.remoteOperationBoundary=async boundary=>{
 if(mode==='b-receipt'&&boundary==='workflow-receipt-persisted')await stop(mode);
 if(mode==='late-target'&&boundary==='workflow-publication-claimed')writeFileSync(moves[1].to,'late user file');
};
if(mode==='partial'){
 const record=runtime.pcAgent.undoJournal.record.bind(runtime.pcAgent.undoJournal);
 runtime.pcAgent.undoJournal.record=(...args)=>{const result=record(...args);process.send({type:'boundary',boundary:'partial',pid:process.pid});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);return result;};
}
const adapter=runtime.pcAgent.registry.get('filesystem.moveFiles'),execute=adapter.execute.bind(adapter);
adapter.execute=async(...args)=>{const result=await execute(...args);appendFileSync(join(root,'calls.jsonl'),JSON.stringify({status:result.status})+'\n');return result;};
process.send({type:'ready',pid:process.pid});
process.once('message',async()=>{try{
 const mission=runtime.missionRuntime.listMissions().items[0]??runtime.missionRuntime.createMission({objective:'두 파일을 지정한 목적지로 이동해',authorization:{grants:['read_only','local_reversible']},successCriteria:moves.map(move=>({statement:'목적지 확인',verificationSpec:{version:1,kind:'file.exists',path:move.to}}))});
 if(mode==='resume-changed')writeFileSync(moves[0].to,'synthetic changed');
 const result=await runtime.missionRuntime.runMission(mission.missionId),action=result.waves[0]?.actions[0];
 const effect=action?.effect?.effectId?store.getEffect(action.effect.effectId):null;
 process.send({type:'result',pid:process.pid,status:result.status,stopReason:result.stopReason,recovery:action?.recovery,
  effect,files:moves.map(m=>({source:existsSync(m.from),target:existsSync(m.to)})),
  bFailures:runtime.pcAgent.packetJournal.records.filter(r=>r.recordType==='packet_result'&&r.result?.status==='FAILED').map(r=>r.result.executionResult),
  bClaims:runtime.pcAgent.operationStore().db.prepare('SELECT count(*) AS n FROM remote_operation_claims').get().n,
  keys:runtime.pcAgent.packetJournal.records.filter(r=>r.recordType==='packet_result'&&r.dryRun===false&&r.toolName==='filesystem.moveFiles').map(r=>r.idempotencyKey)});
 runtime.coreFacade.cognition.close();memoryStore.close();operations.close();process.disconnect();
 }catch(e){process.send({type:'error',message:e.message,stack:e.stack});process.exitCode=1;process.disconnect();}});
