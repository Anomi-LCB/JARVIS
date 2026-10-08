import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {SqliteMissionStore} from '../packages/core/src/mission/sqlite-mission-store.js';
import {SqliteMemoryStore} from '../apps/growth-memory/src/db/sqlite-store.js';

for(const reference of ['그 파일','그것','앞서 작성한 파일'])test('unresolved local reference cannot authorize a planner-selected write: '+reference,async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-deictic-write-')),workspace=join(root,'workspace');await mkdir(workspace);
 const source=join(workspace,'seed.txt'),output=join(workspace,'unexpected.txt');await writeFile(source,'independent source');
 const store=new PersonalOperationsStore({dbPath:join(root,'ops.sqlite')}),memory=new SqliteMemoryStore({dbPath:join(root,'growth.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')});
 const runtime=createAgRuntime({allowedRoots:[workspace],auditRoot:join(root,'audit'),cwd:()=>workspace,memoryStore:memory,missionStore:new SqliteMissionStore({operationsStore:store}),workerDaemonEnabled:false,
  env:{JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'},
  missionPlanner:{async planNextWave(context){const req=context.mission.goalContract.requirements;
   const successful=context.observations.filter(o=>o.outcome==='success');
   if(successful.some(o=>o.toolName==='filesystem.createTextFile'))return {decision:'complete',actions:[],criteriaAssessment:context.mission.successCriteria.map(c=>({criterionId:c.criterionId,status:'satisfied',evidenceActionIds:successful.map(o=>o.actionId)}))};
   return {decision:'continue',actions:[
    {id:'read',command:'seed.txt 내용을 읽어줘',expectedToolName:'filesystem.readText',arguments:{path:source,maxChars:2000},requirementIds:[req[0].requirementId],dependencies:[]},
    {id:'write',command:'unexpected.txt 텍스트 파일을 만들어줘',expectedToolName:'filesystem.createTextFile',arguments:{path:output,content:'planner invented target'},requirementIds:[req[1].requirementId],dependencies:['read']}
   ]};
  }}});
 t.after(async()=>{runtime.coreFacade.cognition.close();store.close();memory.close();assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));await rm(root,{recursive:true,force:true});});
 const executed=[],worker=runtime.orchestrationWorker.runTask.bind(runtime.orchestrationWorker);
 runtime.orchestrationWorker.runTask=async(id,...args)=>{executed.push(runtime.coreFacade.getTask(id).plan.action.toolName);return worker(id,...args);};
 const objective=`'seed.txt'를 읽어; ${reference}을 저장해`,created=runtime.missionRuntime.createMission({objective,authorization:{grants:['read_only','local_reversible']},successCriteria:[{statement:'confirmed content only',verificationSpec:{version:1,kind:'text.equals',path:'unexpected.txt',equals:'planner invented target'}}]});
 const result=await runtime.missionRuntime.runMission(created.missionId);
 assert.deepEqual(executed,['filesystem.readText']);assert.equal(await readFile(source,'utf8'),'independent source');await assert.rejects(readFile(output),{code:'ENOENT'});
 assert.notEqual(result.status,'COMPLETED');
 const saved=new SqliteMissionStore({operationsStore:store}).load().find(m=>m.missionId===created.missionId);
 assert.equal(saved.goalContract.objective,objective);assert.equal(saved.waves[0].actions[1].attempts,0);
 assert.ok(saved.waves[0].actions[1].requirementCoverage.reasons.some(r=>['requirement-reference-unresolved','requirement-meaning-unresolved'].includes(r.code)));
 assert.match(saved.lastError.nextAction,/정확한 파일명/);
 console.log(JSON.stringify({reference,actualCoreEBG:true,actualSQL:true,executed,status:result.status,outputCreated:false}));
 const corrected="'seed.txt'를 읽어; 'unexpected.txt'를 저장해";
 const revised=runtime.missionRuntime.reviseMissionGoal(created.missionId,{objective:corrected,expectedRevision:1,idempotencyKey:'confirmed-target',reason:'사용자가 저장 대상 파일명을 명시함',successCriteria:[{statement:'confirmed content only',verificationSpec:{version:1,kind:'text.equals',path:'unexpected.txt',equals:'planner invented target'}}]});
 assert.equal(revised.status,'applied');
 const resumed=await runtime.missionRuntime.runMission(created.missionId);assert.equal(resumed.status,'COMPLETED',JSON.stringify(resumed));
 assert.equal(await readFile(output,'utf8'),'planner invented target');assert.equal(await readFile(source,'utf8'),'independent source');
 const current=new SqliteMissionStore({operationsStore:store}).load().find(m=>m.missionId===created.missionId);
 assert.equal(current.goalContract.objective,corrected);assert.equal(current.goalContract.revision,2);assert.equal(current.goalRevisionHistory[0].goalContract.objective,objective);
 assert.equal(executed.filter(tool=>tool==='filesystem.createTextFile').length,1);
 console.log(JSON.stringify({reference,confirmedRevision:2,status:resumed.status,actualFileVerified:true,writeCount:1}));
});
