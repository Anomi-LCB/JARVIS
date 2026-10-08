import {createAgRuntime} from '../../apps/runtime-compose/src/create-runtime.js';
import {PersonalOperationsStore} from '../../packages/core/src/personal-operations/operations-store.js';
import {SqliteMissionStore} from '../../packages/core/src/mission/sqlite-mission-store.js';
import {SqliteMemoryStore} from '../../apps/growth-memory/src/db/sqlite-store.js';
import {MissionExecutionAuthority} from '../../packages/core/src/mission/mission-execution-authority.js';
import {mkdirSync,writeFileSync,existsSync,appendFileSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
const [root,mode]=process.argv.slice(2),workspace=join(root,'workspace');mkdirSync(workspace,{recursive:true});
const inputPath=join(workspace,'source.txt'),outputPath=join(workspace,mode==='authority-pdf'?'document.pdf':'document.docx');
if(!existsSync(inputPath))writeFileSync(inputPath,'original synthetic archive source');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),args={path:outputPath,...(mode==='authority-pdf'?{outputFormat:'pdf'}:{}),title:'영속 Word 실행 시험',blocks:[{type:'paragraph',text:'중단 후에도 원래 문서와 미리보기를 검증합니다.'}]};
const clock=()=>new Date(mode.startsWith('resume')?'2026-10-07T11:22:00Z':'2026-10-07T11:20:00Z');
const operations=new PersonalOperationsStore({dbPath:join(root,'operations.sqlite'),clock});
const memoryStore=new SqliteMemoryStore({dbPath:join(root,'growth.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')});
const store=new SqliteMissionStore({operationsStore:operations}),authority=mode.startsWith('authority')?new MissionExecutionAuthority({store}):null;authority?.activate({expectedToken:0,heartbeat:false});
const runtime=createAgRuntime({missionStore:store,memoryStore,clock,...(authority?{missionExecutionAuthority:authority}:{}),allowedRoots:[workspace],cwd:()=>workspace,auditRoot:join(root,'audit'),cognitionStorePath:join(root,'cognition.sqlite'),workerDaemonEnabled:false,
 trustSigningSecret:'synthetic-archive-fixture-key-not-production',env:{JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'},
 missionPlanner:{async planNextWave(context){return context.observations.length?{decision:'complete',actions:[],criteriaAssessment:context.mission.successCriteria.map(c=>({criterionId:c.criterionId,status:'satisfied',evidenceObservationIds:context.observations.map(o=>o.observationId)}))}:
 {decision:'continue',actions:[{id:'word',command:`'${outputPath}' 워드 문서를 만들어줘`,expectedToolName:'word.create',arguments:args,dependencies:[],requirementIds:context.mission.goalContract.requirements.map(r=>r.requirementId)}]};}}});
const stop=async boundary=>{const action=[...runtime.missionRuntime.missions.values()][0]?.waves[0]?.actions[0];process.send({type:'boundary',boundary,pid:process.pid,operationId:action?.operation?.operationId,effectId:action?.effect?.effectId});await new Promise(r=>process.once('message',r));};
runtime.missionRuntime.effectCoordinator.onBoundary=async boundary=>{if(mode===boundary)await stop(boundary);};
runtime.pcAgent.remoteOperationBoundary=async boundary=>{if(mode==='b-receipt'&&boundary==='workflow-receipt-persisted')await stop(mode);};
const adapter=runtime.pcAgent.registry.get('word.create'),execute=adapter.execute.bind(adapter);
adapter.execute=async(...values)=>{const result=await execute(...values);appendFileSync(join(root,'calls.jsonl'),JSON.stringify({status:result.status})+'\n');return result;};
if(mode==='partial'){
 const record=runtime.pcAgent.undoJournal.record.bind(runtime.pcAgent.undoJournal);
 runtime.pcAgent.undoJournal.record=(...values)=>{const result=record(...values);process.send({type:'boundary',boundary:'partial',pid:process.pid});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);return result;};
}
const verify=runtime.orchestrationWorker.verifyExecution.bind(runtime.orchestrationWorker);
runtime.orchestrationWorker.verifyExecution=async(...values)=>{const result=await verify(...values);if(result.status!=='passed')appendFileSync(join(root,'verification-failures.jsonl'),JSON.stringify(result)+'\n');return result;};
process.send({type:'ready',pid:process.pid});
process.once('message',async()=>{try{
 const mission=runtime.missionRuntime.listMissions().items[0]??runtime.missionRuntime.createMission({objective:'워드 문서를 만들어줘',authorization:{grants:['read_only','local_reversible']},successCriteria:[{statement:'Word 확인',verificationSpec:{version:1,kind:'file.exists',path:outputPath}}]});
 if(mode==='resume-changed')writeFileSync(outputPath,'synthetic changed');
 if(mode==='resume-source-changed'){const artifact=[...runtime.missionRuntime.missions.values()][0].waves[0].actions[0].effect;const plan=store.getEffect(artifact.effectId).intent.request.artifactPlan;writeFileSync(plan.paths[2],'changed preview');}
 const result=await runtime.missionRuntime.runMission(mission.missionId),action=result.waves[0]?.actions[0];
 process.send({type:'result',pid:process.pid,status:result.status,stopReason:result.stopReason,recovery:action?.recovery,verificationFailures:existsSync(join(root,'verification-failures.jsonl'))?readFileSync(join(root,'verification-failures.jsonl'),'utf8'):null,lastError:action?.lastError,
  effect:action?.effect?.effectId?store.getEffect(action.effect.effectId):null,outputExists:existsSync(outputPath),sourceSha256:hash(readFileSync(inputPath)),task:runtime.coreFacade.getTask(action?.taskId),
  bClaims:runtime.pcAgent.operationStore().db.prepare('SELECT count(*) AS n FROM remote_operation_claims').get().n,
  keys:runtime.pcAgent.packetJournal.records.filter(r=>r.recordType==='packet_result'&&r.dryRun===false&&r.toolName==='word.create').map(r=>r.idempotencyKey)});
 runtime.coreFacade.cognition.close();memoryStore.close();operations.close();process.disconnect();
 }catch(e){process.send({type:'error',message:e.message,stack:e.stack});process.exitCode=1;process.disconnect();}});
