import {readFile,writeFile,appendFile} from 'node:fs/promises';import {join} from 'node:path';
import {createHash} from 'node:crypto';import {createConfiguredCoreServiceRuntime} from '../../scripts/core-service-runtime.mjs';
const [root,phase,port,expectedToken]=process.argv.slice(2),workspace=join(root,'workspace');
const env={JARVIS_TEST_MODE:'0',JARVIS_CORE_ROOT:root,JARVIS_CORE_AUDIT_ROOT:join(root,'audit'),JARVIS_CORE_ALLOWED_ROOTS:'workspace',
 JARVIS_CORE_PORT:port,JARVIS_CORE_WORKER_DAEMON_ENABLED:'0',JARVIS_CORE_WORKER_DAEMON_AUTOSTART:'0',JARVIS_CORE_REMOTE_PC_EXECUTION_ENABLED:'0',
 JARVIS_PERSONAL_IMPORT_ENABLED:'0',JARVIS_GOOGLE_SYNC_ENABLED:'0',JARVIS_PERSONAL_OPERATIONS_DB:join(root,'operations.sqlite'),
 JARVIS_CORE_MISSION_STORE_BACKEND:'sqlite',JARVIS_CORE_MISSION_AUTHORITY_ENABLED:'1',JARVIS_CORE_MISSION_AUTHORITY_EXPECTED_TOKEN:expectedToken,
 JARVIS_CORE_ADMIN_TOKEN:'synthetic-clarification-restart',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'};
let service;try{service=await createConfiguredCoreServiceRuntime({env});}catch(error){process.send({type:'startup-error',code:error.code??error.message});process.exit(1);}
const callsPath=join(root,'calls.jsonl');
const execute=service.orchestrationWorker.runTask.bind(service.orchestrationWorker);
service.orchestrationWorker.runTask=async(id,...rest)=>{const tool=service.coreFacade.getTask(id)?.plan.action.toolName;
 await appendFile(callsPath,JSON.stringify({pid:process.pid,tool})+'\n');return execute(id,...rest);};
const questions=['최종 결과에 포함할 항목은 무엇인가요?','보고서 제목은 무엇인가요?'];
service.missionRuntime.planner={async planNextWave(context){
 const reqs=context.mission.goalContract.requirements,observed=context.observations.find(o=>o.toolName==='filesystem.readText'&&o.outcome==='success');
 const gate=service.missionRuntime.missions.get(context.mission.missionId).gates.find(g=>g.type==='clarification'&&g.status==='approved'&&g.goalRevision===context.mission.goalContract.revision);
 if(!gate)return {decision:'ask_user',questions,actions:observed?[]:[{id:'read',command:"'source.txt'를 읽어",expectedToolName:'filesystem.readText',
  arguments:{path:join(workspace,'source.txt')},requirementIds:[reqs[0].requirementId],dependencies:[],clarificationIndependent:true}]};
 if(!context.observations.some(o=>o.toolName==='filesystem.createTextFile'&&o.outcome==='success')){
  const source=observed?.data?.textRead?.content;if(typeof source!=='string')throw Error('SOURCE_NOT_OBSERVED');
  return {decision:'continue',actions:[{id:'write',command:"'result.txt'를 저장해",expectedToolName:'filesystem.createTextFile',
   arguments:{path:join(workspace,'result.txt'),content:gate.answers[1]+'\n'+gate.answers[0]+'\n'+source,allowOverwrite:false},requirementIds:[reqs[1].requirementId],dependencies:[]}]};}
 return {decision:'complete',actions:[],criteriaAssessment:context.mission.successCriteria.map(c=>({criterionId:c.criterionId,status:'satisfied',evidenceActionIds:context.observations.filter(o=>o.outcome==='success'&&o.actionId).map(o=>o.actionId)}))};
}};
let missionId;
if(phase==='seed'){
 await writeFile(join(workspace,'source.txt'),'합성 자료: 관측 3건',{flag:'wx'});
 const m=service.missionRuntime.createMission({objective:"'source.txt'를 읽어; 'result.txt'를 저장해",metadata:{longTermMemory:false},
  authorization:{grants:['read_only','local_reversible']},successCriteria:[{statement:'내용 일치',verificationSpec:{version:1,kind:'text.equals',path:'result.txt',equals:'검증 보고\n항목 전체\n합성 자료: 관측 3건'}}]});
 missionId=m.missionId;const waiting=await service.missionRuntime.runMission(missionId);if(waiting.status!=='WAITING_APPROVAL')throw Error(waiting.stopReason);
 await writeFile(join(root,'mission.json'),JSON.stringify({missionId}),{flag:'wx'});
}else missionId=JSON.parse(await readFile(join(root,'mission.json'),'utf8')).missionId;
await new Promise(r=>service.server.listen(Number(port),'127.0.0.1',r));
async function observe(){const calls=(await readFile(callsPath,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);let content=null;try{content=await readFile(join(workspace,'result.txt'),'utf8');}catch{}
 return {pid:process.pid,mission:service.missionRuntime.getMission(missionId),reads:calls.filter(c=>c.tool==='filesystem.readText').length,writes:calls.filter(c=>c.tool==='filesystem.createTextFile').length,content,
  keySha256:createHash('sha256').update(await readFile(join(root,'audit/trust/runtime-trust-key.json'))).digest('hex'),authority:service.missionRuntime.store.coreAuthorityStatus()};}
process.send({type:'ready',port:service.server.address().port,missionId,...await observe()});
process.on('message',async message=>{if(message.type==='observe')process.send({type:'observed',requestId:message.requestId,...await observe()});
 if(message.type==='stop'){service.server.closeAllConnections();await service.close();process.exit(0);}});
