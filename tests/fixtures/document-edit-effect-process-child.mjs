import {createAgRuntime} from '../../apps/runtime-compose/src/create-runtime.js';
import {PersonalOperationsStore} from '../../packages/core/src/personal-operations/operations-store.js';
import {SqliteMissionStore} from '../../packages/core/src/mission/sqlite-mission-store.js';
import {SqliteMemoryStore} from '../../apps/growth-memory/src/db/sqlite-store.js';
import {MissionExecutionAuthority} from '../../packages/core/src/mission/mission-execution-authority.js';
import {mkdirSync,writeFileSync,existsSync,appendFileSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
const [root,mode]=process.argv.slice(2),workspace=join(root,'workspace');mkdirSync(workspace,{recursive:true});
const outputPath=join(workspace,'source.xlsx');
const mod=await import('../../apps/pc-agent/node_modules/exceljs/excel.js'),ExcelJS=mod.default??mod;
if(!existsSync(outputPath)){const wb=new ExcelJS.Workbook();wb.addWorksheet('Data').getCell('A1').value='original';await wb.xlsx.writeFile(outputPath);}
const args={targetPath:outputPath,sheet:'Data',edits:[{cell:'A1',value:'edited'}]};
const clock=()=>new Date(mode.startsWith('resume')?'2026-10-07T11:22:00Z':'2026-10-07T11:20:00Z');
const operations=new PersonalOperationsStore({dbPath:join(root,'operations.sqlite'),clock});
const memoryStore=new SqliteMemoryStore({dbPath:join(root,'growth.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')});
const store=new SqliteMissionStore({operationsStore:operations}),authority=mode.startsWith('authority')?new MissionExecutionAuthority({store}):null;authority?.activate({expectedToken:0,heartbeat:false});
const runtime=createAgRuntime({missionStore:store,memoryStore,clock,...(authority?{missionExecutionAuthority:authority}:{}),allowedRoots:[workspace],cwd:()=>workspace,auditRoot:join(root,'audit'),cognitionStorePath:join(root,'cognition.sqlite'),workerDaemonEnabled:false,
 trustSigningSecret:'synthetic-archive-fixture-key-not-production',env:{JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'},
 missionPlanner:{async planNextWave(context){return context.observations.length?{decision:'complete',actions:[],criteriaAssessment:context.mission.successCriteria.map(c=>({criterionId:c.criterionId,status:'satisfied',evidenceObservationIds:context.observations.map(o=>o.observationId)}))}:
 {decision:'continue',actions:[{id:'cards',command:`'${outputPath}'의 Data 시트 A1 셀을 edited로 수정해줘`,expectedToolName:'document.edit',arguments:args,dependencies:[],requirementIds:context.mission.goalContract.requirements.map(r=>r.requirementId)}]};}}});
const stop=async boundary=>{const action=[...runtime.missionRuntime.missions.values()][0]?.waves[0]?.actions[0];process.send({type:'boundary',boundary,pid:process.pid,operationId:action?.operation?.operationId,effectId:action?.effect?.effectId});await new Promise(r=>process.once('message',r));};
runtime.missionRuntime.effectCoordinator.onBoundary=async boundary=>{if(mode===boundary)await stop(boundary);};
runtime.pcAgent.remoteOperationBoundary=async boundary=>{if(mode==='b-receipt'&&boundary==='workflow-receipt-persisted')await stop(mode);};
const adapter=runtime.pcAgent.registry.get('document.edit'),execute=adapter.execute.bind(adapter);
adapter.execute=async(...values)=>{const result=await execute(...values);appendFileSync(join(root,'calls.jsonl'),JSON.stringify({status:result.status})+'\n');return result;};
if(mode==='partial'){
 adapter.execute=async(...values)=>{const context=values[2]??{},prepared=await adapter.preparePublication(values[0]);
  values[2]={...context,assertAccess(){context.assertAccess?.();if(existsSync(prepared.backupPath)){process.send({type:'boundary',boundary:'partial',pid:process.pid});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}}};
  const result=await execute(...values);appendFileSync(join(root,'calls.jsonl'),JSON.stringify({status:result.status})+'\n');return result;};
}

const verify=runtime.orchestrationWorker.verifyExecution.bind(runtime.orchestrationWorker);
runtime.orchestrationWorker.verifyExecution=async(...values)=>{const result=await verify(...values);if(result.status!=='passed')appendFileSync(join(root,'verification-failures.jsonl'),JSON.stringify(result)+'\n');return result;};
process.send({type:'ready',pid:process.pid});
process.once('message',async()=>{try{
 const mission=runtime.missionRuntime.listMissions().items[0]??runtime.missionRuntime.createMission({objective:'source.xlsx의 Data 시트 A1 셀을 edited로 수정해줘',authorization:{grants:['read_only','local_reversible']},successCriteria:[{statement:'편집 셀 확인',verificationSpec:{version:1,kind:'xlsx.cells',path:outputPath,sheetName:'Data',equals:{A1:'edited'}}}]});
 if(mode==='resume-changed')writeFileSync(outputPath,'synthetic changed');
 if(mode==='resume-source-changed'){const artifact=[...runtime.missionRuntime.missions.values()][0].waves[0].actions[0].effect;const plan=store.getEffect(artifact.effectId).intent.request.artifactPlan;writeFileSync(plan.documentEditPublication.backupPath,'changed backup');}
 const result=await runtime.missionRuntime.runMission(mission.missionId),action=result.waves[0]?.actions[0];
 process.send({type:'result',pid:process.pid,status:result.status,stopReason:result.stopReason,recovery:action?.recovery,verificationFailures:existsSync(join(root,'verification-failures.jsonl'))?readFileSync(join(root,'verification-failures.jsonl'),'utf8'):null,lastError:action?.lastError,
  effect:action?.effect?.effectId?store.getEffect(action.effect.effectId):null,outputExists:existsSync(outputPath),task:runtime.coreFacade.getTask(action?.taskId),
  bClaims:runtime.pcAgent.operationStore().db.prepare('SELECT count(*) AS n FROM remote_operation_claims').get().n,
  keys:runtime.pcAgent.packetJournal.records.filter(r=>r.recordType==='packet_result'&&r.dryRun===false&&r.toolName==='document.edit').map(r=>r.idempotencyKey)});
 runtime.coreFacade.cognition.close();memoryStore.close();operations.close();process.disconnect();
 }catch(e){process.send({type:'error',message:e.message,stack:e.stack});process.exitCode=1;process.disconnect();}});
