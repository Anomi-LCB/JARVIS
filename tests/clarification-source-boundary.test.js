import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {resolveClarificationContext} from '../packages/core/src/mission/clarification-context.js';
import {createGoalContract} from '../packages/core/src/mission/goal-contract.js';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {SqliteMissionStore} from '../packages/core/src/mission/sqlite-mission-store.js';
import {SqliteMemoryStore} from '../apps/growth-memory/src/db/sqlite-store.js';
const inputQuestion='입력 파일의 이름은 무엇인가요?',outputQuestion='결과 파일의 이름은 무엇인가요?';
const sha=text=>createHash('sha256').update(text).digest('hex'),mission=objective=>({objective,goalContract:createGoalContract({objective}),gates:[]});
test('repeated exact targets preserve all source bindings instead of asking again',()=>{
 const m=mission("'source.txt'를 읽어; 'source.txt'를 읽어; 'result.txt'를 저장해"),r=resolveClarificationContext(m,{questions:[inputQuestion,outputQuestion]});
 assert.deepEqual(r.questions,[]);assert.deepEqual(r.resolved.map(x=>x.answer),['source.txt','result.txt']);
 assert.deepEqual(r.resolved[0].requirementIds,m.goalContract.requirements.slice(0,2).map(r=>r.requirementId));
 for(const binding of r.resolved[0].sourceBindings)assert.equal(m.objective.slice(binding.sourceSpan.start,binding.sourceSpan.end),binding.sourceText);
});
for(const [id,objective] of [
 ['distinct-targets',"'a.txt'를 읽어; 'b.txt'를 읽어"],
 ['different-case',"'Case.txt'를 읽어; 'case.txt'를 읽어"],
 ['different-space',"'a b.txt'를 읽어; 'a  b.txt'를 읽어"],
 ['unknown-target',"'a.txt'를 읽어; 그 파일을 읽어"],
 ['compound-read',"'a.txt'를 읽고 다른 파일도 찾아 정리해"]
])test('ambiguous global input question is not resolved from only some clauses: '+id,()=>{
 const r=resolveClarificationContext(mission(objective),{questions:[inputQuestion]});assert.deepEqual(r.resolved,[]);assert.deepEqual(r.questions,[inputQuestion]);
});
test('changed objective cannot reuse facts or cached answers from a stale goal contract',()=>{
 const m=mission("'old.txt'를 읽어"),question='어느 자료를 포함할까요?';
 m.gates=[{type:'clarification',status:'approved',goalRevision:1,gateId:'old',question,responseText:'old.txt'}];
 m.objective="'new.txt'를 읽어";
 assert.deepEqual(resolveClarificationContext(m,{questions:[inputQuestion,question]}).resolved,[]);
});
test('gate objective binding stops old answers after same revision objective replacement',()=>{
 const m=mission("'new.txt'를 읽어"),question='어느 자료를 포함할까요?';
 m.gates=[{type:'clarification',status:'approved',goalRevision:1,goalObjectiveSha256:sha("'old.txt'를 읽어"),gateId:'old',question,responseText:'old.txt'}];
 assert.deepEqual(resolveClarificationContext(m,{questions:[question]}).resolved,[]);
});
for(const shape of ['mapped','free-text'])test('legacy gate without original objective proof cannot answer a current question: '+shape,()=>{
 const m=mission("'new.txt'를 읽어"),question='어느 자료를 포함할까요?';
 m.gates=[{type:'clarification',status:'approved',goalRevision:1,gateId:'legacy',
  ...(shape==='mapped'?{questions:[question],answers:['old.txt']}:{question,responseText:'old.txt'})}];
 const result=resolveClarificationContext(m,{questions:[question]});
 assert.deepEqual(result.resolved,[]);assert.deepEqual(result.questions,[question]);
});
test('bound free-text answer remains reusable without a new question or execution authority',()=>{
 const m=mission("'new.txt'를 읽어"),question='어느 자료를 포함할까요?';
 m.gates=[{type:'clarification',status:'approved',goalRevision:1,gateId:'bound',
  goalObjectiveSha256:sha(m.objective),question,responseText:'new.txt'}];
 const result=resolveClarificationContext(m,{questions:[question]});
 assert.deepEqual(result.questions,[]);assert.equal(result.resolved[0].answer,'new.txt');
 assert.equal(result.resolved[0].source,'user-answer');assert.equal(m.gates.length,1);
});
for(const mode of ['all-source-known','one-unknown-question','same-revision-stale-gate','same-revision-legacy-gate','restored-empty-answer','restored-number-answer','restored-whitespace-answer'])test('actual Core/E/PC/G and SQL clarification source boundary '+mode,async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-question-source-')),workspace=join(root,'workspace');await mkdir(workspace);await writeFile(join(workspace,'source.txt'),'unchanged source');
 const store=new PersonalOperationsStore({dbPath:join(root,'ops.sqlite')}),memory=new SqliteMemoryStore({dbPath:join(root,'growth.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')});
 const extra='어느 자료를 포함할까요?';let reads=0,writes=0,planned=0;
 const runtime=createAgRuntime({allowedRoots:[workspace],auditRoot:join(root,'audit'),cwd:()=>workspace,memoryStore:memory,missionStore:new SqliteMissionStore({operationsStore:store}),workerDaemonEnabled:false,
  env:{JARVIS_TEST_MODE:'1',JARVIS_MISSION_EXECUTIVE:'0',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'},missionPlanner:{async planNextWave(context){
   planned++;
   const consumed=context.observations.some(o=>o.category==='clarification_context');
   const supplied=context.observations.some(o=>o.category==='clarification_context'&&o.data?.resolvedQuestions?.some(q=>q.question===extra&&q.answer==='source.txt만 포함'));
   if(!consumed||(mode!=='all-source-known'&&!(mode.startsWith('restored-')&&supplied)))return {decision:'ask_user',questions:[inputQuestion,outputQuestion,...(mode==='all-source-known'?[]:[extra])],
    actions:context.observations.some(o=>o.toolName==='filesystem.readText')?[]:context.mission.goalContract.requirements.slice(0,2).map((r,i)=>({id:'read-'+i,command:"'source.txt'를 읽어",expectedToolName:'filesystem.readText',arguments:{path:join(workspace,'source.txt')},requirementIds:[r.requirementId],dependencies:[],clarificationIndependent:true}))};
   if(!context.observations.some(o=>o.toolName==='filesystem.createTextFile'&&o.outcome==='success'))return {decision:'continue',actions:[{id:'write',command:"'result.txt'를 저장해",expectedToolName:'filesystem.createTextFile',arguments:{path:join(workspace,'result.txt'),content:'verified result'},requirementIds:[context.mission.goalContract.requirements[2].requirementId],dependencies:[]}]};
   return {decision:'complete',actions:[],criteriaAssessment:context.mission.successCriteria.map(c=>({criterionId:c.criterionId,status:'satisfied',evidenceActionIds:context.observations.filter(o=>o.outcome==='success'&&o.actionId).map(o=>o.actionId)}))};
  }}});
 t.after(async()=>{runtime.pcAgent.remoteOperationStore?.close();runtime.coreFacade.cognition.close();store.close();memory.close();assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));await rm(root,{recursive:true,force:true});});
 const run=runtime.orchestrationWorker.runTask.bind(runtime.orchestrationWorker);runtime.orchestrationWorker.runTask=(taskId,...args)=>{const tool=runtime.coreFacade.getTask(taskId)?.plan.action.toolName;if(tool==='filesystem.readText')reads++;if(tool==='filesystem.createTextFile')writes++;return run(taskId,...args);};
 const objective="'source.txt'를 읽어; 'source.txt'를 읽어; 'result.txt'를 저장해",created=runtime.missionRuntime.createMission({objective,
  successCriteria:[{statement:'actual final content',verificationSpec:{version:1,kind:'text.equals',path:'result.txt',equals:'verified result'}}],authorization:{grants:['read_only','local_reversible']}});
 if(mode==='same-revision-stale-gate'||mode==='same-revision-legacy-gate'){
  const internal=runtime.missionRuntime.missions.get(created.missionId);
  internal.gates.push({gateId:'stale-approved',type:'clarification',status:'approved',goalRevision:1,
   ...(mode==='same-revision-stale-gate'?{goalObjectiveSha256:sha('different original request')}:{}),question:extra,responseText:'unrelated.txt'});
 }
 if(mode.startsWith('restored-')){
  const internal=runtime.missionRuntime.missions.get(created.missionId);
  internal.gates.push({gateId:'malformed-approved',type:'clarification',status:'approved',goalRevision:1,goalObjectiveSha256:sha(objective),
   questions:[extra],answers:[mode==='restored-number-answer'?42:mode==='restored-empty-answer'?'':'   ']});
 }
 const result=await runtime.missionRuntime.runMission(created.missionId);
 const countsWhileWaiting={reads,writes};
 assert.equal(result.status,mode==='all-source-known'?'COMPLETED':'WAITING_APPROVAL',JSON.stringify({status:result.status,reason:result.stopReason,error:result.lastError}));
 assert.equal(reads,2);assert.equal(writes,mode==='all-source-known'?1:0);assert.equal(await readFile(join(workspace,'source.txt'),'utf8'),'unchanged source');
 if(mode==='all-source-known'){assert.equal(result.pendingGates.length,0);assert.equal(await readFile(join(workspace,'result.txt'),'utf8'),'verified result');}
 else{assert.equal(result.pendingGates.length,1);assert.deepEqual(result.pendingGates[0].questions,[extra]);assert.equal(result.pendingGates[0].goalObjectiveSha256,sha(objective));await assert.rejects(readFile(join(workspace,'result.txt')),{code:'ENOENT'});}
 const saved=new SqliteMissionStore({operationsStore:store}).load().find(m=>m.missionId===created.missionId);assert.equal(saved.status,result.status);assert.equal(saved.goalContract.objective,objective);
 if(mode==='same-revision-legacy-gate'){
  assert.equal(saved.gates.find(g=>g.gateId==='stale-approved').goalObjectiveSha256,undefined);
  assert.deepEqual(resolveClarificationContext(saved,{questions:[extra]}).questions,[extra]);
  assert.deepEqual(resolveClarificationContext(saved,{questions:[extra]}).resolved,[]);
 }
 if(mode.startsWith('restored-')){
  const historical=saved.gates.find(g=>g.gateId==='malformed-approved');
  const expected=mode==='restored-number-answer'?42:mode==='restored-empty-answer'?'':'   ';
  assert.deepEqual(historical.answers,[expected]);
  assert.deepEqual(resolveClarificationContext(saved,{questions:[extra]}).questions,[extra]);
  const repeated=await runtime.missionRuntime.runMission(created.missionId);
  assert.equal(repeated.pendingGates[0].gateId,result.pendingGates[0].gateId);assert.equal(reads,2);assert.equal(writes,0);
  const approved=runtime.missionRuntime.decideGate(created.missionId,result.pendingGates[0].gateId,{decision:'approve',answers:['source.txt만 포함']});
  assert.equal(approved.success,true);
  const complete=await runtime.missionRuntime.runMission(created.missionId);
  assert.equal(complete.status,'COMPLETED',JSON.stringify({reason:complete.stopReason,error:complete.lastError}));
  assert.equal(reads,2);assert.equal(writes,1);assert.equal(await readFile(join(workspace,'result.txt'),'utf8'),'verified result');
  const final=new SqliteMissionStore({operationsStore:store}).load().find(m=>m.missionId===created.missionId);
  assert.deepEqual(final.gates.find(g=>g.gateId==='malformed-approved').answers,[expected]);
  console.log(JSON.stringify({mode,afterValidAnswer:complete.status,reads,writes,preservedHistoricalAnswer:true}));
 }
 console.log(JSON.stringify({mode,status:result.status,actualCoreEBG:true,actualSQL:true,...countsWhileWaiting,questions:result.pendingGates.map(g=>g.questions),planned}));
});
