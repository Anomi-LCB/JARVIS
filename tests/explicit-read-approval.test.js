import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {createGoalContract} from '../packages/core/src/mission/goal-contract.js';
import {explicitReadApproval,explicitApprovalAnswer} from '../packages/core/src/mission/explicit-read-approval.js';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {SqliteMissionStore} from '../packages/core/src/mission/sqlite-mission-store.js';
import {SqliteMemoryStore} from '../apps/growth-memory/src/db/sqlite-store.js';
import {createCoreServer} from '../packages/core/src/main.mjs';
import {listenOnFetchSafePort} from '../packages/shared/src/http.js';
const request=objective=>({objective,goalContract:createGoalContract({objective}),successCriteria:[{statement:objective}],constraints:[],waves:[]});
test('only explicit user-owned bounded text-read approval is resolved; factual and external predicates remain unresolved',()=>{
 for(const prefix of ['내가 승인하면','내 승인을 받은 후']){
  const original=`${prefix} 'source.txt'를 읽어`,c=explicitReadApproval(request(original));assert.equal(c.effectiveObjective,"'source.txt'를 읽어");assert.equal(c.executionAuthority,false);
 }
 for(const objective of ["승인하면 'source.txt'를 읽어","관리자가 승인하면 'source.txt'를 읽어","내용이 정확하면 'source.txt'를 읽어","내가 승인하면 'source.txt'를 보내","내가 승인하면 'source.txt'를 삭제해","내가 승인하면 'source.txt'를 읽어; 'result.txt'를 저장해","내가 승인하면 5분 이내 'source.txt'를 읽어","내가 승인하면 'source.pdf'를 읽어"])
  assert.equal(explicitReadApproval(request(objective)),null,objective);
 for(const answer of ['예','아마도','나중에 승인','승인하지 마','승인 후 보내줘'])assert.equal(explicitApprovalAnswer({answers:[answer]}),false);
 assert.equal(explicitApprovalAnswer({answers:['승인']}),true);assert.equal(explicitApprovalAnswer({responseText:'승인합니다'}),true);
 const altered=request("내가 승인하면 'source.txt'를 읽어");altered.goalContract.objectiveSha256='0'.repeat(64);assert.equal(explicitReadApproval(altered),null);
});
for(const mode of ['approve','reject','ambiguous','stale','no-grant','http','large'])test('actual Core SQL explicit read condition '+mode,async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-explicit-read-')),workspace=join(root,'workspace');await mkdir(workspace);await writeFile(join(workspace,'source.txt'),mode==='large'?'a'.repeat(120000):'actual condition-scoped data');
 const store=new PersonalOperationsStore({dbPath:join(root,'ops.sqlite')}),memory=new SqliteMemoryStore({dbPath:join(root,'growth.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')});
 const runtime=createAgRuntime({allowedRoots:[workspace],auditRoot:join(root,'audit'),cwd:()=>workspace,memoryStore:memory,missionStore:new SqliteMissionStore({operationsStore:store}),workerDaemonEnabled:false,
  env:{JARVIS_TEST_MODE:'1',JARVIS_MISSION_EXECUTIVE:'0',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'}});
 t.after(async()=>{runtime.coreFacade.cognition.close();store.close();memory.close();assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));await rm(root,{recursive:true,force:true});});
 let reads=0;const adapter=runtime.pcAgent.registry.get('filesystem.readText'),execute=adapter.execute.bind(adapter);adapter.execute=(...a)=>{reads++;return execute(...a);};
 const objective="내가 승인하면 'source.txt'를 읽어",grants=mode==='no-grant'?[]:['read_only'];
 const created=runtime.missionRuntime.createMission({objective,authorization:{grants}});
 // Exercise loss of an existing grant; createMission normally supplies read_only
 // as its baseline and is not a way to remove it.
 if(mode==='no-grant')runtime.missionRuntime.missions.get(created.missionId).authorization.grants=[];
 const waiting=await runtime.missionRuntime.runMission(created.missionId);
 assert.equal(waiting.status,'WAITING_APPROVAL');assert.equal(reads,0);assert.equal(waiting.metrics.plannerCalls,0);assert.equal(waiting.pendingGates.length,1);
 const gate=waiting.pendingGates[0];assert.equal(gate.questions.length,1);assert.equal(gate.explicitReadApproval.executionAuthority,false);
 if(mode==='stale'){
  runtime.missionRuntime.missions.get(created.missionId).gates.find(g=>g.gateId===gate.gateId).explicitReadApproval.target='other.txt';
 }
 let decided;
 if(mode==='http'){
  const server=createCoreServer(runtime.coreFacade,{adminToken:'explicit-condition-fixture',missionRuntime:runtime.missionRuntime}),addr=await listenOnFetchSafePort(server);
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url=`http://127.0.0.1:${addr.port}/missions/${encodeURIComponent(created.missionId)}/gates/${encodeURIComponent(gate.gateId)}/decision`;
  const denied=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({decision:'approve',answers:['승인']})});assert.equal(denied.status,401);assert.equal(reads,0);
  const response=await fetch(url,{method:'POST',headers:{authorization:'Bearer explicit-condition-fixture','content-type':'application/json'},body:JSON.stringify({decision:'approve',answers:['승인'],decidedBy:'forged-model-actor'})});
  assert.equal(response.status,200);decided=await response.json();assert.equal(decided.status,'COMPLETED');assert.match(decided.gates[0].decidedBy,/^core-admin:/);assert.notEqual(decided.gates[0].decidedBy,'forged-model-actor');
 }else decided=runtime.missionRuntime.decideGate(created.missionId,gate.gateId,{decision:mode==='reject'?'reject':'approve',answers:[mode==='ambiguous'?'예':'승인'],decidedBy:'core-admin:synthetic-user'});
 if(['ambiguous','stale'].includes(mode)){assert.equal(decided.success,false);assert.equal(reads,0);assert.equal(runtime.missionRuntime.getMission(created.missionId).objective,objective);return;}
 if(mode==='reject'){assert.equal(decided.status,'CANCELLED');assert.equal(reads,0);return;}
 assert.equal(decided.goalContract.revision,2);assert.equal(decided.objective,"'source.txt'를 읽어");assert.deepEqual(decided.authorization.grants,grants);
 const result=await runtime.missionRuntime.runMission(created.missionId);
 if(mode==='no-grant'){assert.equal(reads,0);assert.notEqual(result.status,'COMPLETED');return;}
 const expectedReads=mode==='large'?3:1;
 assert.equal(result.status,'COMPLETED',JSON.stringify({status:result.status,reason:result.stopReason,error:result.lastError,verification:result.verificationSummary}));assert.equal(reads,expectedReads);
 assert.equal(result.goalRevisionHistory[0].goalContract.objective,objective);assert.equal(result.gates[0].decision,'approve');
 const again=await runtime.missionRuntime.runMission(created.missionId);assert.equal(again.status,'COMPLETED');assert.equal(reads,expectedReads);
 assert.equal(runtime.missionRuntime.decideGate(created.missionId,gate.gateId,{decision:'approve',answers:['승인']}).success,false);
 const saved=new SqliteMissionStore({operationsStore:store}).load().find(m=>m.missionId===created.missionId);assert.equal(saved.goalContract.revision,2);assert.equal(saved.gates[0].decision,'approve');
 console.log(JSON.stringify({mode,status:result.status,reads,conditionQuestionBatches:1,conditionQuestions:1,originalGoalPreserved:true,authorityUnchanged:true,actualCoreEBG:true,actualSQL:true,defaultPlanner:true}));
});
