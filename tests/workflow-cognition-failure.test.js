import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {SqliteMissionStore} from '../packages/core/src/mission/sqlite-mission-store.js';
import {SqliteMemoryStore} from '../apps/growth-memory/src/db/sqlite-store.js';

test('persistent cognition failure after real multi-operation workflow cannot report mission completion or redispatch',async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-workflow-cognition-')),runtimes=[];
 const options={allowedRoots:[root],auditRoot:join(root,'audit'),cognitionStorePath:join(root,'cognition.sqlite'),workerDaemonEnabled:false,
  env:{JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'}};
 t.after(async()=>{for(const r of runtimes)r.coreFacade.cognition.close();await rm(root,{recursive:true,force:true});});
 await writeFile(join(root,'input.json'),'[{"total":7}]');const runtime=createAgRuntime(options);runtimes.push(runtime);
 runtime.coreFacade.cognition.db.exec("CREATE TRIGGER cognition_failure BEFORE INSERT ON cognitive_episodes BEGIN SELECT RAISE(ABORT,'synthetic-workflow-cognition-failure'); END");
 const adapter=runtime.pcAgent.registry.get('workflow.execute'),execute=adapter.execute.bind(adapter);let calls=0;
 adapter.execute=async(...args)=>{calls++;return execute(...args);};
 const mission=runtime.missionRuntime.createMission({objective:"'input.json' JSON을 '원본'으로 읽고; '원본'의 개수가 1인지 검증하고; '원본'을 'output.json' JSON으로 저장해",authorization:{grants:['read_only','local_reversible']},successCriteria:[{statement:'합계7',verificationSpec:{version:1,kind:'json.value',path:'output.json',pointer:'/0/total',equals:7}}]});
 const first=await runtime.missionRuntime.runMission(mission.missionId);
 assert.equal(calls,1);assert.equal(JSON.parse(await readFile(join(root,'output.json'),'utf8'))[0].total,7);
 assert.equal(runtime.coreFacade.cognition.db.prepare('SELECT count(*) AS n FROM cognitive_episodes').get().n,0);
 assert.notEqual(first.status,'COMPLETED','memory failure must not be hidden by a successful file result');
 const fresh=createAgRuntime(options);runtimes.push(fresh);let redispatches=0;
 fresh.orchestrationWorker.runTask=async()=>{redispatches++;throw Error('must reconcile original result');};
 const resumed=await fresh.missionRuntime.runMission(mission.missionId);
 assert.notEqual(resumed.status,'COMPLETED');assert.equal(redispatches,0);
 t.diagnostic(JSON.stringify({workflowCalls:calls,restartDispatches:redispatches,initialStatus:first.status,resumedStatus:resumed.status,remainingReason:resumed.stopReason}));
});

for(const boundary of ['episode','outcome','goal','changed-artifact','tampered-intent','missing-intent'])test(`SQL workflow ${boundary} memory recovery preserves original evidence without B replay`,async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-workflow-cognition-sql-')),runtimes=[],stores=[],memories=[];
 t.after(async()=>{runtimes.forEach(r=>r.coreFacade.cognition.close());stores.forEach(s=>s.close());memories.forEach(s=>s.close());await rm(root,{recursive:true,force:true});});
 const open=()=>{const operations=new PersonalOperationsStore({dbPath:join(root,'operations.sqlite')});stores.push(operations);const memoryStore=new SqliteMemoryStore({dbPath:join(root,'growth.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')});memories.push(memoryStore);const runtime=createAgRuntime({memoryStore,missionStore:new SqliteMissionStore({operationsStore:operations}),allowedRoots:[root],auditRoot:join(root,'audit'),cognitionStorePath:join(root,'cognition.sqlite'),workerDaemonEnabled:false,env:{JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'}});runtimes.push(runtime);return runtime;};
 await writeFile(join(root,'input.json'),'[{"total":7}]');const runtime=open();
 const trigger=boundary==='episode'?'BEFORE INSERT ON cognitive_episodes':boundary==='outcome'?'BEFORE INSERT ON cognitive_decision_outcomes':"BEFORE UPDATE ON cognitive_goals WHEN NEW.status='COMPLETED'";
 runtime.coreFacade.cognition.db.exec(`CREATE TRIGGER cognition_failure ${trigger} BEGIN SELECT RAISE(ABORT,'synthetic-workflow-cognition-failure'); END`);
 const adapter=runtime.pcAgent.registry.get('workflow.execute'),execute=adapter.execute.bind(adapter);let calls=0;adapter.execute=async(...a)=>{calls++;return execute(...a);};
 const mission=runtime.missionRuntime.createMission({objective:"'input.json' JSON을 '원본'으로 읽고; '원본'의 개수가 1인지 검증하고; '원본'을 'output.json' JSON으로 저장해",authorization:{grants:['read_only','local_reversible']},successCriteria:[{statement:'합계7',verificationSpec:{version:1,kind:'json.value',path:'output.json',pointer:'/0/total',equals:7}}]});
 assert.equal((await runtime.missionRuntime.runMission(mission.missionId)).status,'PAUSED');assert.equal(calls,1);
 const fresh=open();let dispatches=0;fresh.orchestrationWorker.runTask=async()=>{dispatches++;throw Error('must not repeat B');};
 fresh.coreFacade.cognition.db.exec('DROP TRIGGER cognition_failure');
 if(boundary==='changed-artifact')await writeFile(join(root,'output.json'),'[{"total":99}]');
 if(boundary==='tampered-intent')stores.at(-1).db.prepare("UPDATE workflow_cognition_intents SET body='{}'").run();
 if(boundary==='missing-intent')stores.at(-1).db.prepare('DELETE FROM workflow_cognition_intents').run();
 const repaired=await fresh.missionRuntime.runMission(mission.missionId);
 if(['changed-artifact','tampered-intent','missing-intent'].includes(boundary)){
  assert.equal(repaired.status,'PAUSED');assert.equal(dispatches,0);assert.equal(fresh.coreFacade.cognition.db.prepare('SELECT count(*) AS n FROM cognitive_episodes').get().n,0);
  return;
 }
 assert.equal(repaired.status,'COMPLETED',JSON.stringify({status:repaired.status,reason:repaired.stopReason,recovery:repaired.waves[0]?.actions[0]?.recovery,observations:repaired.observations.map(o=>({outcome:o.outcome,error:o.error}))}));
 assert.equal(dispatches,0);assert.equal(fresh.coreFacade.cognition.db.prepare('SELECT count(*) AS n FROM cognitive_episodes').get().n,1);
 assert.equal(JSON.parse(await readFile(join(root,'output.json'),'utf8'))[0].total,7);
 const repeated=open();repeated.orchestrationWorker.runTask=async()=>{throw Error('duplicate dispatch');};
 assert.equal((await repeated.missionRuntime.runMission(mission.missionId)).status,'COMPLETED');assert.equal(repeated.coreFacade.cognition.db.prepare('SELECT count(*) AS n FROM cognitive_episodes').get().n,1);
 t.diagnostic(JSON.stringify({boundary,workflowCalls:calls,recoveryDispatches:dispatches,episodes:1}));
});
