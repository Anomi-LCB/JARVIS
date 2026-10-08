import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {SqliteMissionStore} from '../packages/core/src/mission/sqlite-mission-store.js';
import {SqliteMemoryStore} from '../apps/growth-memory/src/db/sqlite-store.js';

for(const mode of ['different-target','protected-target','protected-directory-alias','prohibition-alias'])test('explicit save prohibition is enforced on its actual target: '+mode,async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-targeted-prohibition-')),workspace=join(root,'workspace');await mkdir(workspace);
 const protectedDir=join(workspace,'protected');await mkdir(protectedDir);const protectedFile=join(protectedDir,'keep.txt'),source=join(workspace,'seed.txt'),output=join(workspace,'result.txt');
 await writeFile(source,'independent source');await writeFile(protectedFile,'protected original');
 let protectedName='protected/keep.txt',requestedName='result.txt',target=output;
 if(mode==='protected-target')target=protectedFile;
 if(mode==='protected-directory-alias'||mode==='prohibition-alias'){
  const alias=join(workspace,'alias');await symlink(protectedDir,alias,process.platform==='win32'?'junction':'dir');
  if(mode==='protected-directory-alias'){target=join(alias,'keep.txt');requestedName='alias/keep.txt';}else protectedName='alias/keep.txt';
 }
 const store=new PersonalOperationsStore({dbPath:join(root,'ops.sqlite')}),memory=new SqliteMemoryStore({dbPath:join(root,'growth.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')});
 const runtime=createAgRuntime({allowedRoots:[workspace],auditRoot:join(root,'audit'),cwd:()=>workspace,memoryStore:memory,missionStore:new SqliteMissionStore({operationsStore:store}),workerDaemonEnabled:false,
  env:{JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'},missionPlanner:{async planNextWave(context){const req=context.mission.goalContract.requirements,success=context.observations.filter(o=>o.outcome==='success');
   if(success.some(o=>o.toolName==='filesystem.createTextFile'))return {decision:'complete',actions:[],criteriaAssessment:context.mission.successCriteria.map(c=>({criterionId:c.criterionId,status:'satisfied',evidenceActionIds:success.map(o=>o.actionId)}))};
   return {decision:'continue',actions:[
    {id:'read',command:'seed.txt 내용을 읽어줘',expectedToolName:'filesystem.readText',arguments:{path:source,maxChars:2000},requirementIds:[req[0].requirementId],dependencies:[]},
    {id:'write',command:'result.txt 텍스트 파일을 만들어줘',expectedToolName:'filesystem.createTextFile',arguments:{path:target,content:'permitted result'},requirementIds:[req[1].requirementId],constraintRequirementIds:[req[2].requirementId],dependencies:['read']},
    // Independently read the protected bytes after the requested effect for the
    // caller's explicit unchanged-content criterion; this is not another write.
    {id:'verify-protected',command:'protected/keep.txt 내용을 읽어줘',expectedToolName:'filesystem.readText',arguments:{path:protectedFile,maxChars:2000},requirementIds:[],dependencies:['write']}
   ]};
  }}});
 t.after(async()=>{runtime.coreFacade.cognition.close();store.close();memory.close();assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));await rm(root,{recursive:true,force:true});});
 const executed=[],worker=runtime.orchestrationWorker.runTask.bind(runtime.orchestrationWorker);runtime.orchestrationWorker.runTask=async(id,...args)=>{executed.push(runtime.coreFacade.getTask(id).plan.action.toolName);return worker(id,...args);};
 const objective=`'seed.txt'를 읽어; '${requestedName}'를 저장해; '${protectedName}'는 저장하지 마`;
 const created=runtime.missionRuntime.createMission({objective,authorization:{grants:['read_only','local_reversible']},successCriteria:[
  {statement:'requested output',verificationSpec:{version:1,kind:'text.equals',path:'result.txt',equals:'permitted result'}},
  {statement:'prohibited target unchanged',artifactRole:'input',verificationSpec:{version:1,kind:'text.equals',path:'protected/keep.txt',equals:'protected original'}}
 ]});
 const result=await runtime.missionRuntime.runMission(created.missionId),allowed=['different-target','prohibition-alias'].includes(mode);
 assert.equal(result.status==='COMPLETED',allowed,JSON.stringify({mode,status:result.status,reason:result.stopReason,error:result.lastError,coverage:result.goalCompletionCoverage,verification:result.verificationSummary}));
 assert.equal(await readFile(protectedFile,'utf8'),'protected original');assert.equal(await readFile(source,'utf8'),'independent source');
 if(allowed){assert.deepEqual(executed,['filesystem.readText','filesystem.createTextFile','filesystem.readText']);assert.equal(await readFile(output,'utf8'),'permitted result');}
 else{assert.deepEqual(executed,['filesystem.readText']);await assert.rejects(readFile(output),{code:'ENOENT'});}
 const saved=new SqliteMissionStore({operationsStore:store}).load().find(m=>m.missionId===created.missionId);assert.equal(saved.status,result.status);assert.equal(saved.goalContract.objective,objective);
 if(mode==='protected-directory-alias'){
  const reasons=saved.waves[0].actions[1].requirementCoverage.reasons;
  assert.ok(reasons.some(r=>r.code==='external-action-conflicts-with-prohibition'));
  assert.equal(reasons.some(r=>r.code==='external-action-target-not-independently-bound'),false,'the requested alias is explicitly bound; its physical protected target is the blocker');
 }
 console.log(JSON.stringify({mode,actualCoreEBG:true,actualSQL:true,executed,status:result.status,protectedUnchanged:true}));
});
