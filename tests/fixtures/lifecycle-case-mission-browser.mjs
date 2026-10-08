import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createServer} from 'node:net';import {spawn} from 'node:child_process';
import {PersonalLifecycleCases} from '../../packages/core/src/personal-operations/lifecycle-cases.js';
import {createConfiguredCoreServiceRuntime} from '../../scripts/core-service-runtime.mjs';
const root=await mkdtemp(join(tmpdir(),'jarvis-case-mission-ui-'));
const service=await createConfiguredCoreServiceRuntime({env:{JARVIS_TEST_MODE:'0',JARVIS_CORE_ROOT:root,JARVIS_CORE_AUDIT_ROOT:join(root,'audit'),JARVIS_CORE_PORT:'0',JARVIS_CORE_ALLOWED_ROOTS:'workspace',JARVIS_CORE_WORKER_DAEMON_ENABLED:'0',JARVIS_CORE_WORKER_DAEMON_AUTOSTART:'0',JARVIS_CORE_REMOTE_PC_EXECUTION_ENABLED:'0',JARVIS_PERSONAL_IMPORT_ENABLED:'0',JARVIS_GOOGLE_SYNC_ENABLED:'0',JARVIS_PERSONAL_OPERATIONS_DB:join(root,'operations.sqlite'),JARVIS_CORE_MISSION_STORE_BACKEND:'sqlite',JARVIS_CORE_MISSION_AUTHORITY_ENABLED:'1',JARVIS_CORE_MISSION_AUTHORITY_EXPECTED_TOKEN:'0',JARVIS_CORE_ADMIN_TOKEN:'synthetic-browser-admin',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'}});
new PersonalLifecycleCases(service.personalOperations.store).create({requestId:'fixture',kind:'shipment',provider:'dhl',accountRef:'synthetic',providerRef:'synthetic-receipt',title:'합성 배송 조회',dueAt:'2026-10-06T00:00:00Z'});
const core=service.server;
await new Promise(r=>core.listen(0,'127.0.0.1',r));const reservation=createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));
const childEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|COMSPEC)$/iu.test(key)));
const ui=spawn(process.execPath,['scripts/dev-server.mjs'],{cwd:process.cwd(),windowsHide:true,env:{...childEnv,PORT:String(port),JARVIS_CORE_API_URL:`http://127.0.0.1:${core.address().port}`,JARVIS_CORE_ADMIN_TOKEN:'synthetic-browser-admin'},stdio:['ignore','pipe','ignore']});
await new Promise((resolve,reject)=>{ui.stdout.once('data',resolve);ui.once('exit',code=>reject(Error('UI exit '+code)));});console.log(JSON.stringify({status:'ready',url:`http://127.0.0.1:${port}`,configuredService:true}));let stopped=false;
async function stop(){if(stopped)return;stopped=true;ui.kill();core.closeAllConnections();await service.close();await rm(root,{recursive:true,force:true});process.exit(0);}
process.stdin.once('data',stop);process.stdin.once('end',stop);
