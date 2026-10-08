import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {clarificationReadBinding,sameClarificationReadBinding} from '../packages/core/src/mission/mission-clarification.js';
import {createGoalContract} from '../packages/core/src/mission/goal-contract.js';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {SqliteMissionStore} from '../packages/core/src/mission/sqlite-mission-store.js';
import {SqliteMemoryStore} from '../apps/growth-memory/src/db/sqlite-store.js';
const inputQuestion='입력 파일의 이름은 무엇인가요?',outputQuestion='결과 파일의 이름은 무엇인가요?';
const sha=text=>createHash('sha256').update(text).digest('hex'),mission=objective=>({objective,goalContract:createGoalContract({objective}),gates:[]});
for(const mode of ['requested-read','unrequested-read','late-task-redirect','late-packet-redirect'])test('actual Core/E/PC/G and SQL clarification source boundary '+mode,async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-question-source-')),workspace=join(root,'workspace');await mkdir(workspace);await writeFile(join(workspace,'source.txt'),'unchanged source');await writeFile(join(workspace,'private.txt'),'private unrelated content');
 const store=new PersonalOperationsStore({dbPath:join(root,'ops.sqlite')}),memory=new SqliteMemoryStore({dbPath:join(root,'growth.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')});
 const extra='어느 자료를 포함할까요?';let reads=0,writes=0,planned=0,adapterReads=0,injections=0;
 const runtime=createAgRuntime({allowedRoots:[workspace],auditRoot:join(root,'audit'),cwd:()=>workspace,memoryStore:memory,missionStore:new SqliteMissionStore({operationsStore:store}),workerDaemonEnabled:false,
  env:{JARVIS_TEST_MODE:'1',JARVIS_MISSION_EXECUTIVE:'0',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'},missionPlanner:{async planNextWave(context){
   planned++;
   return {decision:'ask_user',questions:[inputQuestion,outputQuestion,extra],
    actions:context.mission.goalContract.requirements.slice(0,2).map((r,i)=>({id:'read-'+i,command:"'source.txt'를 읽어",expectedToolName:'filesystem.readText',arguments:{path:join(workspace,mode==='unrequested-read'?'private.txt':'source.txt')},requirementIds:[r.requirementId],dependencies:[],clarificationIndependent:true}))};
  }}});
 t.after(async()=>{runtime.coreFacade.cognition.close();store.close();memory.close();assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));await rm(root,{recursive:true,force:true});});
 if(mode==='late-task-redirect'){
  const original=runtime.missionRuntime.effectCoordinator.stage.bind(runtime.missionRuntime.effectCoordinator);
  runtime.missionRuntime.effectCoordinator.stage=async(m,a,task)=>{const hooks=await original(m,a,task);task.plan.action.arguments.path=join(workspace,'private.txt');injections++;return hooks;};
 }
 if(mode==='late-packet-redirect'){
  const original=runtime.missionRuntime.checkActionAvailability.bind(runtime.missionRuntime),calls=new Map();
  runtime.missionRuntime.checkActionAvailability=async(m,w,a,task,phase)=>{const result=await original(m,w,a,task,phase);if(phase==='dispatch'){const n=(calls.get(task.taskId)??0)+1;calls.set(task.taskId,n);if(n===3){task.plan.action.arguments.path=join(workspace,'private.txt');injections++;}}return result;};
 }
 const adapter=runtime.pcAgent.registry.get('filesystem.readText'),execute=adapter.execute.bind(adapter);
 adapter.execute=(...args)=>{adapterReads++;return execute(...args);};
 const run=runtime.orchestrationWorker.runTask.bind(runtime.orchestrationWorker);runtime.orchestrationWorker.runTask=(taskId,...args)=>{const tool=runtime.coreFacade.getTask(taskId)?.plan.action.toolName;if(tool==='filesystem.readText')reads++;if(tool==='filesystem.createTextFile')writes++;return run(taskId,...args);};
 const objective="'source.txt'를 읽어; 'source.txt'를 읽어; 'result.txt'를 저장해",created=runtime.missionRuntime.createMission({objective,
  successCriteria:[{statement:'actual final content',verificationSpec:{version:1,kind:'text.equals',path:'result.txt',equals:'verified result'}}],authorization:{grants:['read_only','local_reversible']}});
 const result=await runtime.missionRuntime.runMission(created.missionId);
 assert.equal(result.status,'WAITING_APPROVAL',JSON.stringify({status:result.status,reason:result.stopReason,error:result.lastError}));
 assert.equal(result.metrics.successfulActions,mode==='requested-read'?2:0);assert.equal(reads,mode==='requested-read'||mode==='late-packet-redirect'?2:0);assert.equal(writes,0);assert.equal(await readFile(join(workspace,'source.txt'),'utf8'),'unchanged source');
 assert.equal(result.pendingGates.length,1);assert.deepEqual(result.pendingGates[0].questions,[extra]);assert.equal(result.pendingGates[0].goalObjectiveSha256,sha(objective));await assert.rejects(readFile(join(workspace,'result.txt')),{code:'ENOENT'});
 assert.equal(adapterReads,mode==='requested-read'?2:0);
 assert.equal(injections,mode.startsWith('late-')?2:0);
 assert.ok(!JSON.stringify(result.observations).includes('private unrelated content'));
 const saved=new SqliteMissionStore({operationsStore:store}).load().find(m=>m.missionId===created.missionId);assert.equal(saved.status,result.status);assert.equal(saved.goalContract.objective,objective);
 console.log(JSON.stringify({mode,successfulActions:result.metrics.successfulActions,status:result.status,actualCoreEBG:true,actualSQL:true,reads,adapterReads,injections,writes,questions:result.pendingGates.map(g=>g.questions),planned}));
});

test('source binding rejects unresolved, stale, prohibited, unrelated and out-of-root reads',async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-read-source-unit-'));await writeFile(join(root,'source.txt'),'source');await writeFile(join(root,'other.txt'),'other');
 t.after(async()=>{assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));await rm(root,{recursive:true,force:true});});
 const args={path:join(root,'source.txt')},m=mission("'source.txt'를 읽어");
 const proof=clarificationReadBinding(m,'filesystem.readText',args,[root]);assert.ok(proof);assert.equal(proof.sourceBindings[0].sourceText,m.objective);
 for(const objective of ["그 파일을 읽어","'source.txt'를 읽지 마","'source.txt'를 읽고 다른 파일을 찾아"])
  assert.equal(clarificationReadBinding(mission(objective),'filesystem.readText',args,[root]),null);
 assert.equal(clarificationReadBinding(m,'filesystem.readText',{path:join(root,'other.txt')},[root]),null);
 assert.equal(clarificationReadBinding(m,'filesystem.readText',args,[join(root,'not-existing')]),null);
 m.objective="'other.txt'를 읽어";assert.equal(clarificationReadBinding(m,'filesystem.readText',args,[root]),null);
 assert.equal(sameClarificationReadBinding(proof,{...proof,physicalPath:'changed'}),false);
});
