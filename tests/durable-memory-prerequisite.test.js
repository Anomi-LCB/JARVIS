import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {SqliteMissionStore} from '../packages/core/src/mission/sqlite-mission-store.js';
import {SqliteMemoryStore} from '../apps/growth-memory/src/db/sqlite-store.js';
for(const mode of ['ready','missing','volatile','closed','generation','query-only'])test(`SQL workflow persistent growth prerequisite: ${mode}`,async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-memory-prereq-'));
 const operations=new PersonalOperationsStore({dbPath:join(root,'operations.sqlite')});
 const memoryStore=mode==='missing'?null:new SqliteMemoryStore({dbPath:mode==='volatile'?':memory:':join(root,'growth.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')});
 const runtime=createAgRuntime({missionStore:new SqliteMissionStore({operationsStore:operations}),memoryStore,allowedRoots:[root],auditRoot:join(root,'audit'),workerDaemonEnabled:false,
  env:{JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'}});
 t.after(async()=>{runtime.coreFacade.cognition.close();operations.close();if(mode!=='closed')memoryStore?.close();await rm(root,{recursive:true,force:true});});
 if(mode==='closed')memoryStore.close();
 if(mode==='generation')runtime.growthRuntime.memoryGeneration+=1;
 if(mode==='query-only')memoryStore.db.exec('PRAGMA query_only=ON');
 const readiness=runtime.missionRuntime.effectCoordinator.memoryReadiness({plan:{action:{toolName:'workflow.execute'}}});
 assert.equal(readiness.required,true);assert.equal(readiness.available,mode==='ready');
 if(mode!=='ready'){
  assert.equal(readiness.code,'A_MISSION_DURABLE_MEMORY_UNAVAILABLE');
  assert.match(readiness.nextAction,/영속 성장 기억 저장소/);
  assert.equal(JSON.stringify(readiness).includes(root),false,'private database path is not user guidance');
 }
 assert.deepEqual(runtime.missionRuntime.effectCoordinator.memoryReadiness({plan:{action:{toolName:'filesystem.listFiles'}}}),{required:false,available:true});
});
