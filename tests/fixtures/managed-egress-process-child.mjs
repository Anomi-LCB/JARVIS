import {appendFileSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createAgRuntime} from '../../apps/runtime-compose/src/create-runtime.js';
import {PersonalOperationsStore} from '../../packages/core/src/personal-operations/operations-store.js';
import {SqliteMissionStore} from '../../packages/core/src/mission/sqlite-mission-store.js';
import {SqliteMemoryStore} from '../../apps/growth-memory/src/db/sqlite-store.js';
import {MissionEgressDecisionKeyStore} from '../../packages/core/src/security/mission-egress-decision-key-store.js';
import {ManagedAgentSessionBroker} from '../../packages/core/src/mission/managed-agent-session-broker.js';
import {createMissionRuntimeManagedAgentDispatcher,MANAGED_AGENT_MISSION_TOOLS} from '../../packages/core/src/mission/managed-agent-mission-tool-dispatcher.js';
const [root,mode,clockIso]=process.argv.slice(2),clock=()=>new Date(clockIso),workspace=join(root,'workspace');
const store=new PersonalOperationsStore({dbPath:join(root,'ops.sqlite')}),memory=new SqliteMemoryStore({dbPath:join(root,'growth.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')});
const keyStore=new MissionEgressDecisionKeyStore({path:join(root,'egress-key.json'),clock});
if(mode==='hold')keyStore.initialize();
const db=new DatabaseSync(join(root,'broker.sqlite'));db.exec('PRAGMA foreign_keys=ON');
const journalPath=join(root,'provider.jsonl'),journal=()=>{try{return readFileSync(journalPath,'utf8').trim().split(/\r?\n/u).map(JSON.parse);}catch{return[];}};
let broker;
const provider={async retrieveSession(id){return{id,required_actions:mode==='hold'?[{type:'function_call',turn_id:'turn-process',call_id:'call-process',name:MANAGED_AGENT_MISSION_TOOLS[0],arguments:{path:'notes.txt'}}]:[]};},
 async submitToolResult(sessionId,payload,options){const old=journal();appendFileSync(journalPath,JSON.stringify({pid:process.pid,sessionId,payload,options,duplicateKey:old.some(e=>e.options.idempotencyKey===options.idempotencyKey)})+'\n');console.log('ACCEPTED:'+process.pid);if(mode==='hold')await new Promise(()=>{});}};
const runtime=createAgRuntime({env:{JARVIS_TEST_MODE:'1',JARVIS_MISSION_EXECUTIVE:'0',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0'},clock,allowedRoots:[workspace],auditRoot:join(root,'audit'),cwd:()=>workspace,memoryStore:memory,missionStore:new SqliteMissionStore({operationsStore:store}),workerDaemonEnabled:false,managedAgentEgressKeyStore:keyStore,
 managedAgentSessionBrokerFactory:({missionRuntime,managedAgentEgressPolicy})=>{
  const dispatcher=createMissionRuntimeManagedAgentDispatcher({missionRuntime,egressPolicy:managedAgentEgressPolicy});
  broker=new ManagedAgentSessionBroker({db,provider,clock,callLeaseTtlMs:1000,dispatchVerifiedTool:dispatcher,allowedToolNames:[...MANAGED_AGENT_MISSION_TOOLS]});return broker;
 }});
let reads=0;const run=runtime.orchestrationWorker.runTask.bind(runtime.orchestrationWorker);runtime.orchestrationWorker.runTask=(...args)=>{reads++;return run(...args);};
try{
 let missionId;
 if(mode==='hold'){
  missionId=runtime.missionRuntime.createMission({objective:'공개 합성 연구 메모 읽기',authorization:{grants:['read_only']},successCriteria:['공개 메모를 읽는다']}).missionId;
  writeFileSync(join(root,'mission-id.txt'),missionId);broker.bindSession({missionId,sessionId:'process-session'});
 }else{
  missionId=readFileSync(join(root,'mission-id.txt'),'utf8');const m=runtime.missionRuntime.missions.get(missionId);
  if(mode==='revoke'){m.authorization.grants=[];runtime.missionRuntime.touch(m,'test-revoke');}
  if(mode==='rotate')keyStore.rotate({rotatedBy:'isolated-process-test'});
  if(mode==='goal'){
   const revised=runtime.missionRuntime.reviseMissionGoal(missionId,{objective:'새 목표에 따른 다른 자료 연구',expectedRevision:m.goalContract.revision,idempotencyKey:'process-revised-goal',reason:'시험 사용자의 목표 정정'});
   if(revised.status!=='applied')throw new Error('goal revision failed');
  }
 }
 try{await broker.reconcileMission(missionId);console.log(JSON.stringify({pid:process.pid,status:'submitted',reads,key:keyStore.status()}));}
 catch(e){console.log(JSON.stringify({pid:process.pid,status:'blocked',code:e.code,reads,key:keyStore.status()}));if(mode==='hold')throw e;}
}finally{if(mode!=='hold'){runtime.coreFacade.cognition.close();store.close();memory.close();db.close();}}
