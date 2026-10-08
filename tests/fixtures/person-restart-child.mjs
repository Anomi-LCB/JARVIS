import {readFileSync} from 'node:fs';
import {RuntimeTrustKernel} from '../../packages/core/src/security/runtime-trust-kernel.js';
import {join} from 'node:path';
import {createAgRuntime} from '../../apps/runtime-compose/src/create-runtime.js';
import {PersonalOperationsStore} from '../../packages/core/src/personal-operations/operations-store.js';
import {SqliteMissionStore} from '../../packages/core/src/mission/sqlite-mission-store.js';
import {SqliteMemoryStore} from '../../apps/growth-memory/src/db/sqlite-store.js';
const [root,phase,id]=process.argv.slice(2),workspace=join(root,'workspace'),first={id:'fictional-education',이름:'김민수',소속:'교육팀'};
const command=department=>`'people.json' JSON을 '명부'로 읽고; '명부'에서 이름 '김민수'${department?`와 소속 '${department}'`:''}에 일치하는 사람 한 명을 '선택'으로 골라; '선택'을 'selected.json' JSON으로 저장해`;
const store=new PersonalOperationsStore({dbPath:join(root,'ops.sqlite')}),memory=new SqliteMemoryStore({dbPath:join(root,'growth.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')});
const runtime=createAgRuntime({trustKernel:new RuntimeTrustKernel({actorId:'fixture-person-restart',keyPath:join(root,'private-trust-key.json'),statePath:join(root,'private-trust-state.json'),testMode:false}),allowedRoots:[workspace],auditRoot:join(root,'audit'),cwd:()=>workspace,memoryStore:memory,missionStore:new SqliteMissionStore({operationsStore:store}),workerDaemonEnabled:false,
 env:{JARVIS_TEST_MODE:'1',JARVIS_MISSION_EXECUTIVE:'0',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'}});
try{
 const owner=runtime.personalOwnerSession.activate({requestedBy:'person-restart-test',durationMinutes:5});
 let workerCalls=0;const run=runtime.orchestrationWorker.runTask.bind(runtime.orchestrationWorker);runtime.orchestrationWorker.runTask=(...args)=>{workerCalls++;return run(...args);};
 if(phase==='initial'){
  const created=runtime.missionRuntime.createMission({objective:command(),authorization:{mode:'trusted_session',ownerSessionId:owner.session.sessionId,grants:['read_only','local_reversible']},
   successCriteria:[{statement:'fixed independent person records',verificationSpec:{version:1,kind:'json.value',path:'selected.json',pointer:'',equals:[first]}}]});
  const result=await runtime.missionRuntime.runMission(created.missionId);
  console.log(JSON.stringify({phase,pid:process.pid,missionId:created.missionId,status:result.status,workerCalls,reason:result.stopReason,proof:runtime.missionRuntime.hasVerifiedUnpublishedPersonFailure(runtime.missionRuntime.missions.get(created.missionId).waves[0].actions[0])}));
 }else{
  const mission=runtime.missionRuntime.missions.get(id),action=mission.waves[0].actions[0];
  const restoredProof=runtime.missionRuntime.hasVerifiedUnpublishedPersonFailure(action);
  const copiedProof=runtime.missionRuntime.hasVerifiedUnpublishedPersonFailure(structuredClone(action));
  const revised=runtime.missionRuntime.reviseMissionGoal(id,{objective:command('교육팀'),expectedRevision:1,idempotencyKey:'confirmed-after-restart',reason:'사용자가 교육팀으로 정정',
   successCriteria:[{statement:'fixed education record',verificationSpec:{version:1,kind:'json.value',path:'selected.json',pointer:'',equals:[first]}}]});
  if(revised.status==='applied')runtime.missionRuntime.updateMission(id,{authorization:{mode:'trusted_session',ownerSessionId:owner.session.sessionId,grants:['read_only','local_reversible']}});
  const attempted=revised.status==='applied'?await runtime.missionRuntime.runMission(id):null;const result=runtime.missionRuntime.getMission(id);
  console.log(JSON.stringify({phase,pid:process.pid,missionId:id,restoredProof,copiedProof,revisionStatus:revised.status,status:result.status,workerCalls,revision:result.goalContract.revision,reason:result.stopReason,trust:{mode:runtime.trustKernel.status().mode,keyProvider:runtime.trustKernel.status().keyProvider},lastError:result.lastError,conflicts:revised.revisionRequest?.conflicts}));
 }
}finally{runtime.coreFacade.cognition.close();store.close();memory.close();}
