import {join} from 'node:path';
import {createAgRuntime} from '../../apps/runtime-compose/src/create-runtime.js';
import {PersonalOperationsStore} from '../../packages/core/src/personal-operations/operations-store.js';
import {SqliteMissionStore} from '../../packages/core/src/mission/sqlite-mission-store.js';
import {MissionExecutionAuthority} from '../../packages/core/src/mission/mission-execution-authority.js';
import {PersonalMandateBudget} from '../../packages/core/src/personal-operations/mandate-budget.js';
import {MissionBudgetGate} from '../../packages/core/src/personal-operations/mission-budget-gate.js';
const [root,mode]=process.argv.slice(2),clock=()=>new Date('2026-10-07T00:00:0'+(mode==='baseline'?0:mode==='change'?2:4)+'Z');
try{
 const operations=new PersonalOperationsStore({dbPath:join(root,'ops.sqlite'),clock}),store=new SqliteMissionStore({operationsStore:operations});
 const authority=new MissionExecutionAuthority({store,ttlMs:1000});authority.activate({expectedToken:store.coreAuthorityStatus().token,heartbeat:false});
 const r=createAgRuntime({missionStore:store,missionExecutionAuthority:authority,clock,allowedRoots:[root],auditRoot:join(root,'audit'),workerDaemonEnabled:false,env:{JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'}});
 const budget=new PersonalMandateBudget(operations),quota=new MissionBudgetGate({store:operations,budget});r.missionRuntime.executionBudget=quota;
 if(mode==='baseline'){
  const q=quota.createQuota({validFrom:'2026-01-01T00:00:00Z',expiresAt:'2027-01-01T00:00:00Z',maxCalls:1});
  for(let i=0;i<2;i++)r.missionRuntime.createMission({objective:'작업 폴더 파일 목록 확인',successCriteria:['목록 확인'],executionMandateId:q.mandate.id});
 }else if(mode==='change'){
  const m=r.missionRuntime.listMissions().items[0];budget.reserve({mandateId:m.executionMandateId,requestId:'mission:'+m.missionId,request:quota.request()});
 }
 const result=r.missionRuntime.reconcileDependencyImpacts(),history=r.missionRuntime.dependencyImpactEvents();
 process.send({type:'result',pid:process.pid,result,history});
 // Parent deliberately kills this process while its SQL authority lease is live.
 setInterval(()=>{},1000);
}catch(error){process.send({type:'error',stack:error.stack});process.exitCode=1;process.disconnect();}
