import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {SqliteMissionStore} from '../packages/core/src/mission/sqlite-mission-store.js';
import {SqliteMemoryStore} from '../apps/growth-memory/src/db/sqlite-store.js';

const end=Date.parse('2026-10-10T14:59:59.999Z');
for(const mode of ['within','exact-boundary','expired','shadow-expired','completion-expired','proof-missing','source-changed','restart-replay'])test('actual Core/E/PC/G date-only deadline '+mode,async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-date-only-')),workspace=join(root,'workspace'),output=join(workspace,'result.txt');await mkdir(workspace);
 let now=Date.parse('2026-10-07T00:00:00.000Z'),runtime;
 const clock=()=>new Date(now),store=new PersonalOperationsStore({dbPath:join(root,'ops.sqlite'),clock}),memory=new SqliteMemoryStore({dbPath:join(root,'growth.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups'),clock});
 const options={allowedRoots:[workspace],auditRoot:join(root,'audit'),clock,memoryStore:memory,missionStore:new SqliteMissionStore({operationsStore:store}),workerDaemonEnabled:false,
  env:{JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'},missionPlanner:{async planNextWave(context){
   const success=context.observations.filter(o=>o.outcome==='success');
   return success.length?{decision:'complete',actions:[],criteriaAssessment:context.mission.successCriteria.map(c=>({criterionId:c.criterionId,status:'satisfied',evidenceActionIds:success.map(o=>o.actionId)}))}:
    {decision:'continue',actions:[{id:'write',command:'result.txt 텍스트 파일을 만들어줘',expectedToolName:'filesystem.createTextFile',arguments:{path:output,content:'date-only verified'},dependencies:[],requirementIds:[context.mission.goalContract.requirements[0].requirementId]}]};
  }}};
 runtime=createAgRuntime(options);
 t.after(async()=>{runtime?.coreFacade.cognition.close();store.close();memory.close();assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));await rm(root,{recursive:true,force:true});});
 const created=runtime.missionRuntime.createMission({objective:"2026-10-10까지 'result.txt' 파일을 만들어줘",successCriteria:[{statement:'exact file',verificationSpec:{version:1,kind:'text.equals',path:'result.txt',equals:'date-only verified'}}],authorization:{grants:['read_only','local_reversible']}});
 const adapter=runtime.pcAgent.registry.get('filesystem.createTextFile'),shadow=adapter.shadow.bind(adapter);let shadows=0;
 adapter.shadow=async(...args)=>{const result=await shadow(...args);if(++shadows===2&&mode==='shadow-expired')now=end+1;return result;};
 const complete=runtime.missionRuntime.completeMission.bind(runtime.missionRuntime);
 runtime.missionRuntime.completeMission=(mission,result)=>{
  if(mode==='completion-expired')now=end+1;
  if(mode==='proof-missing')delete mission.waves[0].actions[0].deadlineTemporalVerification;
  if(mode==='source-changed')mission.objective="2026-10-11까지 'result.txt' 파일을 만들어줘";
  return complete(mission,result);
 };
 if(mode==='exact-boundary')now=end;if(mode==='expired')now=end+1;
 const result=await runtime.missionRuntime.runMission(created.missionId),success=['within','exact-boundary','restart-replay'].includes(mode);
 assert.equal(result.status==='COMPLETED',success,JSON.stringify({status:result.status,error:result.lastError,reason:result.stopReason}));
 if(['expired','shadow-expired'].includes(mode))await assert.rejects(readFile(output),{code:'ENOENT'});
 else assert.equal(await readFile(output,'utf8'),'date-only verified');
 const saved=new SqliteMissionStore({operationsStore:store}).load().find(m=>m.missionId===created.missionId);
 assert.equal(saved.status,result.status);
 if(success){assert.equal(saved.completion.deadlineTiming.deadlineAt,new Date(end).toISOString());assert.equal(saved.completion.deadlineTiming.dateOnlyPolicy,'end-of-local-calendar-date');assert.equal(saved.completion.deadlineTiming.timeZone,'Asia/Seoul');}
 if(mode==='restart-replay'){
  const before=await stat(output);runtime.coreFacade.cognition.close();runtime=createAgRuntime(options);
  const restored=await runtime.missionRuntime.runMission(created.missionId);
  assert.equal(restored.status,'COMPLETED');assert.equal((await stat(output)).mtimeMs,before.mtimeMs);
  assert.deepEqual(restored.completion.deadlineTiming,saved.completion.deadlineTiming);
 }
 console.log(JSON.stringify({actualCoreEBG:true,actualSQL:true,mode,status:result.status,deadlineAt:saved.completion?.deadlineTiming?.deadlineAt??null}));
});
