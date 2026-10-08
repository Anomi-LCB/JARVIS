import {createAgRuntime} from '../../apps/runtime-compose/src/create-runtime.js';
import {PersonalOperationsStore} from '../../packages/core/src/personal-operations/operations-store.js';
import {SqliteMissionStore} from '../../packages/core/src/mission/sqlite-mission-store.js';
import {SqliteMemoryStore} from '../../apps/growth-memory/src/db/sqlite-store.js';
import {MissionExecutionAuthority} from '../../packages/core/src/mission/mission-execution-authority.js';
import {mkdirSync,writeFileSync,existsSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';
const [root,mode]=process.argv.slice(2),workspace=join(root,'workspace');mkdirSync(workspace,{recursive:true});
const outputPath=join(workspace,'report.xlsx'),args={outputPath,sheetName:'예산',columns:['항목','금액'],rows:[['준비',10],['합계',10]]};
const clock=()=>new Date(mode.startsWith('resume')?'2026-10-07T10:22:00Z':'2026-10-07T10:20:00Z');
const operations=new PersonalOperationsStore({dbPath:join(root,'operations.sqlite'),clock});
const memoryStore=new SqliteMemoryStore({dbPath:join(root,'growth.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')});
const store=new SqliteMissionStore({operationsStore:operations}),authority=mode==='authority'?new MissionExecutionAuthority({store}):null;authority?.activate({expectedToken:0,heartbeat:false});
const runtime=createAgRuntime({missionStore:store,memoryStore,clock,...(authority?{missionExecutionAuthority:authority}:{}),allowedRoots:[workspace],cwd:()=>workspace,auditRoot:join(root,'audit'),cognitionStorePath:join(root,'cognition.sqlite'),workerDaemonEnabled:false,
 trustSigningSecret:'synthetic-workbook-fixture-key-not-production',env:{JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'},
 missionPlanner:{async planNextWave(context){return context.observations.length?{decision:'complete',actions:[],criteriaAssessment:context.mission.successCriteria.map(c=>({criterionId:c.criterionId,status:'satisfied',evidenceObservationIds:context.observations.map(o=>o.observationId)}))}:
 {decision:'continue',actions:[{id:'workbook',command:`'${outputPath}' 엑셀 파일을 만들어줘`,expectedToolName:'excel.createWorkbook',arguments:args,dependencies:[],requirementIds:context.mission.goalContract.requirements.map(r=>r.requirementId)}]};}}});
const stop=async boundary=>{const action=[...runtime.missionRuntime.missions.values()][0]?.waves[0]?.actions[0];process.send({type:'boundary',boundary,pid:process.pid,operationId:action?.operation?.operationId,effectId:action?.effect?.effectId});await new Promise(r=>process.once('message',r));};
runtime.missionRuntime.effectCoordinator.onBoundary=async boundary=>{if(mode===boundary)await stop(boundary);};
runtime.pcAgent.remoteOperationBoundary=async boundary=>{if(mode==='b-receipt'&&boundary==='workflow-receipt-persisted')await stop(mode);};
const adapter=runtime.pcAgent.registry.get('excel.createWorkbook'),execute=adapter.execute.bind(adapter);
adapter.execute=async(...values)=>{const result=await execute(...values);appendFileSync(join(root,'calls.jsonl'),JSON.stringify({status:result.status})+'\n');return result;};
if(mode==='partial'){
 const record=runtime.pcAgent.undoJournal.record.bind(runtime.pcAgent.undoJournal);
 runtime.pcAgent.undoJournal.record=(...values)=>{const result=record(...values);process.send({type:'boundary',boundary:'partial',pid:process.pid});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);return result;};
}
process.send({type:'ready',pid:process.pid});
process.once('message',async()=>{try{
 const mission=runtime.missionRuntime.listMissions().items[0]??runtime.missionRuntime.createMission({objective:'예산 엑셀을 만들어줘',authorization:{grants:['read_only','local_reversible']},successCriteria:[{statement:'원본 셀 확인',verificationSpec:{version:1,kind:'xlsx.cells',path:outputPath,sheetName:'예산',equals:{A1:'항목',B1:'금액',A2:'준비',B2:10,A3:'합계',B3:10}}}]});
 if(mode==='resume-changed')writeFileSync(outputPath,'synthetic changed');
 const result=await runtime.missionRuntime.runMission(mission.missionId),action=result.waves[0]?.actions[0];
 process.send({type:'result',pid:process.pid,status:result.status,stopReason:result.stopReason,recovery:action?.recovery,lastError:action?.lastError,
  effect:action?.effect?.effectId?store.getEffect(action.effect.effectId):null,outputExists:existsSync(outputPath),
  bClaims:runtime.pcAgent.operationStore().db.prepare('SELECT count(*) AS n FROM remote_operation_claims').get().n,
  keys:runtime.pcAgent.packetJournal.records.filter(r=>r.recordType==='packet_result'&&r.dryRun===false&&r.toolName==='excel.createWorkbook').map(r=>r.idempotencyKey)});
 runtime.coreFacade.cognition.close();memoryStore.close();operations.close();process.disconnect();
 }catch(e){process.send({type:'error',message:e.message,stack:e.stack});process.exitCode=1;process.disconnect();}});
