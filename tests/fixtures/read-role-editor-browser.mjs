import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join,resolve,sep} from 'node:path';
import {spawn} from 'node:child_process';import {createServer} from 'node:http';
import {createConfiguredCoreServiceRuntime} from '../../scripts/core-service-runtime.mjs';
const root=await mkdtemp(join(tmpdir(),'jarvis-clarification-live-')),workspace=join(root,'workspace');
const env={JARVIS_TEST_MODE:'0',JARVIS_CORE_ROOT:root,JARVIS_CORE_AUDIT_ROOT:join(root,'audit'),JARVIS_CORE_ALLOWED_ROOTS:'workspace',
 JARVIS_CORE_PORT:'0',JARVIS_CORE_WORKER_DAEMON_ENABLED:'0',JARVIS_CORE_WORKER_DAEMON_AUTOSTART:'0',JARVIS_CORE_REMOTE_PC_EXECUTION_ENABLED:'0',
 JARVIS_PERSONAL_IMPORT_ENABLED:'0',JARVIS_GOOGLE_SYNC_ENABLED:'0',JARVIS_PERSONAL_OPERATIONS_DB:join(root,'operations.sqlite'),
 JARVIS_CORE_MISSION_STORE_BACKEND:'sqlite',JARVIS_CORE_MISSION_AUTHORITY_ENABLED:'1',JARVIS_CORE_MISSION_AUTHORITY_EXPECTED_TOKEN:'0',
 JARVIS_CORE_ADMIN_TOKEN:'synthetic-clarification-admin',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'};
const service=await createConfiguredCoreServiceRuntime({env});
await writeFile(join(workspace,'source.txt'),'합성 자료: 관측 3건');let reads=0,writes=0;
const execute=service.orchestrationWorker.runTask.bind(service.orchestrationWorker);
service.orchestrationWorker.runTask=(id,...rest)=>{const tool=service.coreFacade.getTask(id)?.plan.action.toolName;if(tool==='filesystem.readText')reads++;if(tool==='filesystem.createTextFile')writes++;return execute(id,...rest);};
await writeFile(join(workspace,'protected.txt'),'보존 자료');
const m=service.missionRuntime.createMission({objective:"'source.txt'를 읽어; 'protected.txt'는 삭제하지 마",metadata:{longTermMemory:false},
 authorization:{grants:['read_only']},budgets:{maxActions:6,maxPlannerCalls:6},successCriteria:[
 {statement:'원본 확인',verificationSpec:{version:1,kind:'text.equals',path:'source.txt',equals:'합성 자료: 관측 3건'}},
 {statement:'보존 확인',verificationSpec:{version:1,kind:'text.equals',path:'protected.txt',equals:'보존 자료'}}]});
const waiting=await service.missionRuntime.runMission(m.missionId);if(waiting.status!=='WAITING_APPROVAL')throw Error(JSON.stringify(waiting));
await new Promise(r=>service.server.listen(0,'127.0.0.1',r));
const control=createServer(async(req,res)=>{const current=service.missionRuntime.getMission(m.missionId);let content=null;try{content=await readFile(join(workspace,'result.txt'),'utf8');}catch{}
 res.setHeader('content-type','application/json');res.end(JSON.stringify({mission:current,reads,writes,content}));});
await new Promise(r=>control.listen(0,'127.0.0.1',r));
const reservation=createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));
const childEnv=Object.fromEntries(Object.entries(process.env).filter(([k])=>/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|COMSPEC)$/iu.test(k)));
const ui=spawn(process.execPath,['scripts/dev-server.mjs'],{cwd:process.cwd(),windowsHide:true,env:{...childEnv,PORT:String(port),JARVIS_CORE_API_URL:`http://127.0.0.1:${service.server.address().port}`,JARVIS_CORE_ADMIN_TOKEN:env.JARVIS_CORE_ADMIN_TOKEN,
 ...(process.argv[2]?{JARVIS_UI_PACKAGE_DIR:resolve(process.argv[2])}:{})},stdio:['ignore','pipe','ignore']});
await new Promise((done,reject)=>{ui.stdout.once('data',done);ui.once('exit',c=>reject(Error('UI_EXIT:'+c)));});
console.log(JSON.stringify({status:'ready',url:`http://127.0.0.1:${port}`,control:`http://127.0.0.1:${control.address().port}`,missionId:m.missionId}));
let stopped=false;async function stop(){if(stopped)return;stopped=true;ui.kill();service.server.closeAllConnections();control.closeAllConnections();await new Promise(r=>control.close(r));await service.close();
 const target=resolve(root);if(!target.startsWith(resolve(tmpdir())+sep)||!target.includes('jarvis-clarification-live-'))throw Error('CLEANUP_BOUNDARY');await rm(target,{recursive:true,force:true});process.exit(0);}
process.stdin.once('data',stop);process.stdin.once('end',stop);
