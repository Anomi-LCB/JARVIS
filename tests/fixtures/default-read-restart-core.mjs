import {appendFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createConfiguredCoreServiceRuntime} from '../../scripts/core-service-runtime.mjs';
const [root,expectedToken]=process.argv.slice(2);
const env={JARVIS_TEST_MODE:'0',JARVIS_CORE_ROOT:root,JARVIS_CORE_AUDIT_ROOT:join(root,'audit'),JARVIS_CORE_ALLOWED_ROOTS:'workspace',
 JARVIS_CORE_PORT:'0',JARVIS_CORE_WORKER_DAEMON_ENABLED:'0',JARVIS_CORE_WORKER_DAEMON_AUTOSTART:'0',JARVIS_CORE_REMOTE_PC_EXECUTION_ENABLED:'0',
 JARVIS_PERSONAL_IMPORT_ENABLED:'0',JARVIS_GOOGLE_SYNC_ENABLED:'0',JARVIS_PERSONAL_OPERATIONS_DB:join(root,'operations.sqlite'),
 JARVIS_CORE_MISSION_STORE_BACKEND:'sqlite',JARVIS_CORE_MISSION_AUTHORITY_ENABLED:'1',JARVIS_CORE_MISSION_AUTHORITY_EXPECTED_TOKEN:expectedToken,
 JARVIS_CORE_ADMIN_TOKEN:'synthetic-default-read-admin',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'};
let service;
try{
 service=await createConfiguredCoreServiceRuntime({env});
 const run=service.orchestrationWorker.runTask.bind(service.orchestrationWorker);
 service.orchestrationWorker.runTask=(id,...args)=>{
  const action=service.coreFacade.getTask(id)?.plan.action;
  return appendFile(join(root,'calls.jsonl'),JSON.stringify({pid:process.pid,tool:action.toolName,path:action.arguments.path,offset:action.arguments.offset??0})+'\n').then(()=>run(id,...args));
 };
 await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));
 process.send({type:'ready',pid:process.pid,port:service.server.address().port,authority:service.missionRuntime.store.coreAuthorityStatus(),
  keySha256:createHash('sha256').update(await readFile(join(root,'audit/trust/runtime-trust-key.json'))).digest('hex')});
 process.on('message',async message=>{
  if(message.type==='stop'){service.server.closeAllConnections();await service.close();process.exit(0);}
 });
}catch(error){process.send({type:'error',code:error.code??error.message});await service?.close();process.exit(1);}
