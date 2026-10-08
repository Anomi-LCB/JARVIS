import {createAgRuntime} from '../../apps/runtime-compose/src/create-runtime.js';
import {PersonalOperationsStore} from '../../packages/core/src/personal-operations/operations-store.js';
import {SqliteMissionStore} from '../../packages/core/src/mission/sqlite-mission-store.js';
import {SqliteMemoryStore} from '../../apps/growth-memory/src/db/sqlite-store.js';
import {MissionExecutionAuthority} from '../../packages/core/src/mission/mission-execution-authority.js';
import {ExcelWorkbookWorker} from '../../apps/pc-agent/src/adapters/excel/excel-worker.js';
import {mkdirSync,writeFileSync,existsSync,appendFileSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
const [root,mode]=process.argv.slice(2),workspace=join(root,'workspace');mkdirSync(workspace,{recursive:true});
const inputPath=join(workspace,'source.xlsx'),outputPath=join(workspace,'report.pdf');
if(!existsSync(inputPath))await new ExcelWorkbookWorker().writeWorkbook({outputPath:inputPath,sheetName:'예산',columns:['항목','금액'],rows:[['합계',10]]});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),args={inputPath,outputPath};
const clock=()=>new Date(mode.startsWith('resume')?'2026-10-07T10:22:00Z':'2026-10-07T10:20:00Z');
const operations=new PersonalOperationsStore({dbPath:join(root,'operations.sqlite'),clock});
const memoryStore=new SqliteMemoryStore({dbPath:join(root,'growth.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')});
const store=new SqliteMissionStore({operationsStore:operations}),authority=mode==='authority'?new MissionExecutionAuthority({store}):null;authority?.activate({expectedToken:0,heartbeat:false});
const runtime=createAgRuntime({missionStore:store,memoryStore,clock,...(authority?{missionExecutionAuthority:authority}:{}),allowedRoots:[workspace],cwd:()=>workspace,auditRoot:join(root,'audit'),cognitionStorePath:join(root,'cognition.sqlite'),workerDaemonEnabled:false,
 trustSigningSecret:'synthetic-pdf-fixture-key-not-production',env:{JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'},
 missionPlanner:{async planNextWave(context){return context.observations.length?{decision:'complete',actions:[],criteriaAssessment:context.mission.successCriteria.map(c=>({criterionId:c.criterionId,status:'satisfied',evidenceObservationIds:context.observations.map(o=>o.observationId)}))}:
 {decision:'continue',actions:[{id:'pdf',command:`'${inputPath}'를 '${outputPath}'로 변환해줘`,expectedToolName:'excel.exportPdf',arguments:args,dependencies:[],requirementIds:context.mission.goalContract.requirements.map(r=>r.requirementId)}]};}}});
const stop=async boundary=>{const action=[...runtime.missionRuntime.missions.values()][0]?.waves[0]?.actions[0];process.send({type:'boundary',boundary,pid:process.pid,operationId:action?.operation?.operationId,effectId:action?.effect?.effectId});await new Promise(r=>process.once('message',r));};
runtime.missionRuntime.effectCoordinator.onBoundary=async boundary=>{if(mode===boundary)await stop(boundary);};
runtime.pcAgent.remoteOperationBoundary=async boundary=>{if(mode==='b-receipt'&&boundary==='workflow-receipt-persisted')await stop(mode);};
const adapter=runtime.pcAgent.registry.get('excel.exportPdf'),execute=adapter.execute.bind(adapter);
// Synthetic renderer receipt exercises recovery contracts only, not native COM.
if(mode!=='native')adapter.renderer={async render({inputPath,outputPath,expectedSha256,beforePublish}){
 await beforePublish?.();const bytes=Buffer.from('%PDF-1.4\nsynthetic recovery fixture\n%%EOF\n');writeFileSync(outputPath,bytes,{flag:'wx'});
 return {status:'passed',requested:true,actualRenderingExecuted:true,renderer:'Microsoft Excel COM',sourceUnchanged:true,readOnly:true,
  sourceSha256:expectedSha256,pdf:{path:outputPath,sha256:hash(bytes),size:bytes.length}};
}};
adapter.execute=async(...values)=>{const result=await execute(...values);appendFileSync(join(root,'calls.jsonl'),JSON.stringify({status:result.status})+'\n');return result;};
if(mode==='partial'){
 const record=runtime.pcAgent.undoJournal.record.bind(runtime.pcAgent.undoJournal);
 runtime.pcAgent.undoJournal.record=(...values)=>{const result=record(...values);process.send({type:'boundary',boundary:'partial',pid:process.pid});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);return result;};
}
process.send({type:'ready',pid:process.pid});
process.once('message',async()=>{try{
 const mission=runtime.missionRuntime.listMissions().items[0]??runtime.missionRuntime.createMission({objective:'기존 예산 엑셀을 PDF로 변환해줘',authorization:{grants:['read_only','local_reversible']},successCriteria:[{statement:'PDF 확인',verificationSpec:{version:1,kind:'file.exists',path:outputPath}}]});
 if(mode==='resume-changed')writeFileSync(outputPath,'synthetic changed');
 if(mode==='resume-source-changed')writeFileSync(inputPath,'changed source');
 const result=await runtime.missionRuntime.runMission(mission.missionId),action=result.waves[0]?.actions[0];
 process.send({type:'result',pid:process.pid,status:result.status,stopReason:result.stopReason,recovery:action?.recovery,lastError:action?.lastError,
  effect:action?.effect?.effectId?store.getEffect(action.effect.effectId):null,outputExists:existsSync(outputPath),sourceSha256:hash(readFileSync(inputPath)),native:mode==='native',
  nativeRender:mode==='native'?runtime.coreFacade.getTask(action.taskId)?.executionResult?.executionResult?.pdfExport?.render:null,
  bClaims:runtime.pcAgent.operationStore().db.prepare('SELECT count(*) AS n FROM remote_operation_claims').get().n,
  keys:runtime.pcAgent.packetJournal.records.filter(r=>r.recordType==='packet_result'&&r.dryRun===false&&r.toolName==='excel.exportPdf').map(r=>r.idempotencyKey)});
 runtime.coreFacade.cognition.close();memoryStore.close();operations.close();process.disconnect();
 }catch(e){process.send({type:'error',message:e.message,stack:e.stack});process.exitCode=1;process.disconnect();}});
