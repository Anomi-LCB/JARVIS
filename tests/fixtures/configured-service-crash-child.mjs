import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createConfiguredCoreServiceRuntime } from '../../scripts/core-service-runtime.mjs';
import { listenOnFetchSafePort } from '../../packages/shared/src/http.js';
import { MissionGrant } from '../../packages/core/src/mission/mission-runtime.js';

const [root, mode, priorToken='0'] = process.argv.slice(2);
const workspace=join(root,'workspace'); mkdirSync(workspace,{recursive:true});
// Isolated synthetic authorization only. No production environment inherited.
const env={JARVIS_TEST_MODE:'1',JARVIS_CORE_ROOT:root,JARVIS_TEST_AUDIT_ROOT:join(root,'audit'),
 JARVIS_CORE_PORT:'0',JARVIS_CORE_ALLOWED_ROOTS:'workspace',JARVIS_CORE_WORKER_DAEMON_ENABLED:'0',
 JARVIS_CORE_WORKER_DAEMON_AUTOSTART:'0',JARVIS_PERSONAL_IMPORT_ENABLED:'0',JARVIS_GOOGLE_SYNC_ENABLED:'0',
 JARVIS_PERSONAL_OPERATIONS_DB:join(root,'operations.sqlite'),JARVIS_CORE_MISSION_STORE_BACKEND:'sqlite',
 JARVIS_CORE_MISSION_AUTHORITY_ENABLED:'1',JARVIS_CORE_MISSION_AUTHORITY_EXPECTED_TOKEN:priorToken,
 JARVIS_CORE_MISSION_AUTHORITY_TTL_MS:'1000',JARVIS_CORE_MISSION_AUTHORITY_RECOVERY_ONLY:mode==='recover'?'1':'0',
 JARVIS_MISSION_EXECUTIVE:'0',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'};
let runtime;
try {
 runtime=await createConfiguredCoreServiceRuntime({env});
 await listenOnFetchSafePort(runtime.server,{host:'127.0.0.1',port:0});
 runtime.missionRuntime.effectCoordinator.leaseTtlMs=1000;
 const stop=async(boundary,action)=>{
  process.send({type:'boundary',boundary,missionId:runtime.missionRuntime.listMissions().items[0].missionId,
   token:runtime.missionExecutionAuthority.lease.token,effectId:action?.effect?.effectId??null});
  await new Promise(()=>{});
 };
 const adapter=runtime.pcAgent.registry.get('filesystem.createTextFile'),execute=adapter.execute.bind(adapter);
 adapter.execute=async(...args)=>{
  const result=await execute(...args);
  appendFileSync(join(root,'actual-adapter-calls.jsonl'),JSON.stringify({status:result.status})+'\n');
  if(mode==='file-effect')await stop('file-effect');
  return result;
 };
 runtime.missionRuntime.effectCoordinator.onBoundary=async(boundary,{action})=>{
  if(mode===boundary)await stop(boundary,action);
 };
 process.send({type:'ready',token:runtime.missionExecutionAuthority.lease.token,
  port:runtime.server.address().port,executionMode:runtime.missionRuntime.status().executionMode});
 process.on('message',async message=>{
  if(message.type==='close') {
   try {await runtime.close();process.send({type:'closed'});process.disconnect();}
   catch(error){process.send({type:'close-error',code:error.code??error.message});}
   return;
  }
  if(message.type!=='run')return;
  try {
   const owner=runtime.personalOwnerSession.activate({requestedBy:'isolated-service-process-test',durationMinutes:5});
   const mission=runtime.missionRuntime.createMission({objective:'result 텍스트 파일을 만들어줘. 내용은 실제 서비스 프로세스 복구',
    successCriteria:[{criterionId:'content',statement:'저장 내용 일치',verificationSpec:{version:1,kind:'text.equals',path:join(workspace,'result.txt'),equals:'실제 서비스 프로세스 복구'}}],
    authorization:{mode:'trusted_session',ownerSessionId:owner.session.sessionId,grants:[MissionGrant.READ_ONLY,MissionGrant.LOCAL_REVERSIBLE]}});
   const result=await runtime.missionRuntime.runMission(mission.missionId);
   process.send({type:'result',status:result.status,stopReason:result.stopReason});
  }catch(error){process.send({type:'error',code:error.code??error.message});}
 });
}catch(error){process.send({type:'startup-error',code:error.code??error.message});process.disconnect();}
