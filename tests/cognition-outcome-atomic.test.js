import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {SqliteMemoryStore} from '../apps/growth-memory/src/db/sqlite-store.js';
import {MissionGrant} from '../packages/core/src/mission/mission-runtime.js';
import {execFileSync} from 'node:child_process';

for (const [boundary,trigger] of [
 ['outcome',"BEFORE INSERT ON cognitive_decision_outcomes"],
 ['episode',"BEFORE INSERT ON cognitive_episodes"],
 ['goal-update',"BEFORE UPDATE ON cognitive_goals WHEN NEW.status='COMPLETED'"]
]) test(`actual file cognition ${boundary} failure is atomic and storage retry calls B once`,async t=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-cognition-atomic-'));
 const memoryStore=new SqliteMemoryStore({dbPath:join(root,'growth.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')});
 const env={JARVIS_TEST_MODE:'1',JARVIS_MISSION_EXECUTIVE:'0',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'};
 const runtime=createAgRuntime({allowedRoots:[root],cwd:()=>root,auditRoot:join(root,'audit'),cognitionStorePath:join(root,'cognition.sqlite'),memoryStore,
  env,taskEnv:env,workerDaemonEnabled:false,bridgeRealExecution:true});
 t.after(()=>{runtime.close?.();memoryStore.close();runtime.coreFacade.cognition.close();});
 const cognition=runtime.coreFacade.cognition,db=cognition.db;
 db.exec(`CREATE TRIGGER test_episode_failure ${trigger} BEGIN SELECT RAISE(ABORT,'injected cognition write failure'); END`);
 const adapter=runtime.pcAgent.registry.get('filesystem.createTextFile'),execute=adapter.execute.bind(adapter);let calls=0;
 adapter.execute=async(...args)=>{calls++;return execute(...args);};
 const owner=runtime.personalOwnerSession.activate({durationMinutes:15,requestedBy:'cognition-atomic-test'});
 const created=runtime.missionRuntime.createMission({objective:'result 메모 파일을 만들어줘. 내용은 검증된 실제 자료',
  authorization:{mode:'trusted_session',grants:[MissionGrant.READ_ONLY,MissionGrant.LOCAL_REVERSIBLE],ownerSessionId:owner.session.sessionId}});
 const mission=await runtime.missionRuntime.runMission(created.missionId);
 assert.equal(mission.status,'COMPLETED',JSON.stringify({status:mission.status,reason:mission.stopReason}));
 assert.equal(readFileSync(join(root,'result.txt'),'utf8'),'검증된 실제 자료');assert.equal(calls,1);
 const outcomes=db.prepare('SELECT COUNT(*) AS n FROM cognitive_decision_outcomes').get().n;
 const episodes=db.prepare('SELECT COUNT(*) AS n FROM cognitive_episodes').get().n;
 console.log(JSON.stringify({boundary,actualVerifiedFile:true,failedWrite:{outcomes,episodes},adapterCalls:calls}));
 assert.equal(outcomes,0,'failed episode append must not leave a committed decision outcome');assert.equal(episodes,0);
 assert.equal(cognition.lastError.code,'A_COGNITION_STORAGE_FAILED');
 const reopen=()=>JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',
  "import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.argv[1],{readOnly:true});console.log(JSON.stringify({pid:process.pid,outcomes:db.prepare('SELECT COUNT(*) AS n FROM cognitive_decision_outcomes').get().n,episodes:db.prepare('SELECT COUNT(*) AS n FROM cognitive_episodes').get().n}));db.close();",join(root,'cognition.sqlite')],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','ignore']}));
 const failedReopen=reopen();assert.notEqual(failedReopen.pid,process.pid);assert.equal(failedReopen.outcomes,0);assert.equal(failedReopen.episodes,0);
 db.exec('DROP TRIGGER test_episode_failure');
 const original=runtime.orchestrationWorker.recentRuns().find(run=>run.executionVerification?.status==='passed');assert.ok(original);
 runtime.orchestrationWorker.storeRun(original);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cognitive_decision_outcomes').get().n,1);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cognitive_episodes').get().n,1);assert.equal(calls,1);
 assert.equal(cognition.lastError,null,'a confirmed committed retry restores current storage readiness');
 runtime.orchestrationWorker.storeRun(original);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cognitive_episodes').get().n,1);assert.equal(calls,1);
 console.log(JSON.stringify({storageRetriedWithoutB:true,outcomes:1,episodes:1,adapterCalls:calls}));
 const repairedReopen=reopen();assert.equal(repairedReopen.outcomes,1);assert.equal(repairedReopen.episodes,1);
 console.log(JSON.stringify({boundary,realProcessReopen:{failed:failedReopen,repaired:repairedReopen}}));
});
