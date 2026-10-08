import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join,resolve,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {planReadCriterionRoleClarification} from '../packages/core/src/mission/read-criterion-role-clarification.js';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
const objective="'source.txt'를 읽어; 'protected.txt'는 삭제하지 마";
test('original read/preserve request reads independently and asks one grouped criterion-role clarification',async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-read-role-'));let calls=0;
 await writeFile(join(root,'source.txt'),'합성 원문 3건');await writeFile(join(root,'protected.txt'),'보존해야 할 합성 자료');
 const env={JARVIS_TEST_MODE:'1',JARVIS_MISSION_EXECUTIVE:'0',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'};
 const runtime=createAgRuntime({allowedRoots:[root],cwd:()=>root,auditRoot:join(root,'audit'),env,taskEnv:env,workerDaemonEnabled:false,
  missionPlanner:{async planNextWave(context){calls++;return {decision:'continue',actions:[{id:'source-read',command:"'source.txt'를 읽어",expectedToolName:'filesystem.readText',arguments:{path:'source.txt'},dependencies:[],requirementIds:[context.mission.goalContract.requirements[0].requirementId]}],criteriaAssessment:[]};}}});
 t.after(async()=>{runtime.pcAgent.remoteOperationStore?.close();runtime.coreFacade.cognition.close();assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(basename(root).startsWith('jarvis-read-role-'));await rm(root,{recursive:true,force:true});});
 const criteria=[{statement:'원본 보존',verificationSpec:{version:1,kind:'text.equals',path:'source.txt',equals:'합성 원문 3건'}},{statement:'삭제 금지 자료 보존',verificationSpec:{version:1,kind:'text.equals',path:'protected.txt',equals:'보존해야 할 합성 자료'}}];
 const created=runtime.missionRuntime.createMission({objective,successCriteria:criteria,metadata:{longTermMemory:false},authorization:{grants:['read_only']},budgets:{maxPlannerCalls:2,maxActions:2}});
 const originalCriteria=structuredClone(created.successCriteria);
 for(const mutate of [
  m=>{m.goalContract.requirements[0].interpretation.target='protected.txt';},
  m=>{m.goalContract.requirements[0].sourceSpan.end++;},
  m=>{m.successCriteria[0].verificationSpec.path='../outside.txt';},
  m=>{m.successCriteria.forEach(c=>c.artifactRole='input');},
  m=>{m.constraints.push({statement:'외부로 발송'});},
  m=>{m.goalContract.unresolvedRequirementIds=['unknown'];},
  m=>{m.goalRevisionRequest={state:'pending'};},
  m=>{m.successCriteria[0].verificationSpec.kind='file.exists';}
 ]){const altered=structuredClone(created);mutate(altered);assert.equal(planReadCriterionRoleClarification({mission:altered,allowedRoots:[root]}),null);}
 const result=await runtime.missionRuntime.runMission(created.missionId);
 assert.equal(result.status,'WAITING_APPROVAL',JSON.stringify({status:result.status,reason:result.stopReason}));assert.equal(result.stopReason,'clarification-required');
 assert.equal(result.pendingGates.length,1);assert.equal(result.pendingGates[0].questions.length,2);
 const forged=structuredClone(result),g=forged.gates.find(g=>g.type==='clarification');g.status='approved';g.decision='approve';g.answers=['only one'];assert.equal(planReadCriterionRoleClarification({mission:forged,allowedRoots:[root]}).decision,'ask_user');g.answers=['one','two'];assert.equal(planReadCriterionRoleClarification({mission:forged,allowedRoots:[root]}),null);assert.equal(result.metrics.successfulActions,1);assert.equal(calls,0);
 assert.deepEqual(result.successCriteria,originalCriteria);assert.equal(result.objective,objective);
 assert.equal(result.waves.flatMap(w=>w.actions).every(a=>a.actualToolName==='filesystem.readText'&&a.operation.dispatch.arguments.path===join(root,'source.txt')),true);
 assert.equal(await readFile(join(root,'source.txt'),'utf8'),'합성 원문 3건');assert.equal(await readFile(join(root,'protected.txt'),'utf8'),'보존해야 할 합성 자료');
 const prior=structuredClone(result);prior.pendingGates=[];prior.gates=[];prior.observations[0].verification.status='failed';
 const historical=planReadCriterionRoleClarification({mission:prior,allowedRoots:[root]});assert.equal(historical.actions.length,0);assert.equal(historical.decision,'ask_user');
 t.diagnostic(JSON.stringify({status:result.status,reads:result.metrics.successfulActions,questions:result.pendingGates[0].questions.length,questionBatches:1,modelCalls:calls,fixedOriginalContractCompleted:false}));
});
