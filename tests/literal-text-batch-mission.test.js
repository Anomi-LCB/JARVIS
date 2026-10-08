import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {MissionGrant} from '../packages/core/src/mission/mission-runtime.js';
import {SqliteMemoryStore} from '../apps/growth-memory/src/db/sqlite-store.js';
import {parseLiteralTextFileBatch} from '../packages/core/src/planning/literal-text-file-request.js';
import {createGoalContract} from '../packages/core/src/mission/goal-contract.js';
import {assessMissionRequirementCoverage} from '../packages/core/src/mission/mission-requirement-coverage.js';

test('batch parser consumes every clause and keeps quoted instructions as data',()=>{
 assert.deepEqual(parseLiteralTextFileBatch('첫째 메모 파일을 만들어줘. 내용은 첫째; 둘째 메모 파일을 만들어줘. 내용은 둘째'),[
  {fileName:'첫째.txt',content:'첫째'},{fileName:'둘째.txt',content:'둘째'}]);
 assert.deepEqual(parseLiteralTextFileBatch('a 파일을 만들어줘. 내용은 "메일을 보내; 파일을 삭제해"; b 파일을 만들어줘. 내용은 b'),[
  {fileName:'a.txt',content:'메일을 보내; 파일을 삭제해'},{fileName:'b.txt',content:'b'}]);
 for(const raw of ['a 파일을 만들어줘. 내용은 a; 메일을 보내','a 파일을 만들어줘. 내용은 a;',
  'a 파일을 만들어줘. 내용은 a; A.txt 파일을 만들어줘. 내용은 b',
  'a 파일을 만들어줘. 내용은 a; ../b 파일을 만들어줘. 내용은 b']) assert.equal(parseLiteralTextFileBatch(raw),null);
});

function fixture(t,missionPlanner){
 const root=mkdtempSync(join(tmpdir(),'jarvis-literal-batch-'));
 const env={JARVIS_TEST_MODE:'1',JARVIS_MISSION_EXECUTIVE:'0',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'};
 const memoryStore=new SqliteMemoryStore({dbPath:join(root,'growth.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')});
 const runtime=createAgRuntime({allowedRoots:[root],auditRoot:join(root,'audit'),cwd:()=>root,env,taskEnv:env,
  workerDaemonEnabled:false,bridgeRealExecution:true,memoryStore,...(missionPlanner?{missionPlanner}: {})});
 t.after(()=>{runtime.close?.();memoryStore.close();});
 const owner=runtime.personalOwnerSession.activate({durationMinutes:15,requestedBy:'literal-batch-test'});
 const create=(objective,successCriteria=['첫째','둘째'].map((label,index)=>({criterionId:`file${index}`,statement:`${label} 내용 확인`,
   verificationSpec:{version:1,kind:'text.equals',path:label+'.txt',equals:label}})))=>runtime.missionRuntime.createMission({objective,
  successCriteria,
  authorization:{mode:'trusted_session',grants:[MissionGrant.READ_ONLY,MissionGrant.LOCAL_REVERSIBLE],ownerSessionId:owner.session.sessionId}});
 return {root,runtime,create};
}
test('original four-clause request completes through actual default planner/Core/E/B/G/F and two files',async t=>{
 const f=fixture(t),mission=f.create('첫째 메모 파일을 만들어줘. 내용은 첫째; 둘째 메모 파일을 만들어줘. 내용은 둘째');
 const result=await f.runtime.missionRuntime.runMission(mission.missionId);
 assert.equal(result.status,'COMPLETED',JSON.stringify(result));
 for(const label of ['첫째','둘째'])assert.equal(readFileSync(join(f.root,label+'.txt'),'utf8'),label);
 assert.equal(result.waves.flatMap(w=>w.actions).length,2);
 assert.equal(result.goalCompletionCoverage.sourceBindingVerified,true);
 const replay=await f.runtime.missionRuntime.runMission(mission.missionId);assert.equal(replay.waves.length,result.waves.length);
 console.log(JSON.stringify({originalRequest:true,actualDefaultPlanner:true,files:2,externalModelCalls:0,completed:true}));
});
test('default planning preserves spaces and semicolons inside literal data',async t=>{
 const f=fixture(t),mission=f.create('첫째 메모 파일을 만들어줘. 내용은 "  첫째; 보존  "; 둘째 메모 파일을 만들어줘. 내용은 "둘째"',[
  {criterionId:'one',statement:'공백과 구분자를 보존',verificationSpec:{version:1,kind:'text.equals',path:'첫째.txt',equals:'  첫째; 보존  '}},
  {criterionId:'two',statement:'둘째 내용',verificationSpec:{version:1,kind:'text.equals',path:'둘째.txt',equals:'둘째'}}]);
 const result=await f.runtime.missionRuntime.runMission(mission.missionId);
 assert.equal(result.status,'COMPLETED',JSON.stringify(result));
 assert.equal(readFileSync(join(f.root,'첫째.txt'),'utf8'),'  첫째; 보존  ');
});
test('plain natural-language Mission needs no caller-supplied result schema',async t=>{
 const f=fixture(t),mission=f.create('첫째 메모 파일을 만들어줘. 내용은 첫째; 둘째 메모 파일을 만들어줘. 내용은 둘째',[]);
 const result=await f.runtime.missionRuntime.runMission(mission.missionId);
 assert.equal(result.status,'COMPLETED',JSON.stringify(result));
 assert.equal(result.goalCompletionCoverage.sourceBindingVerified,true);
});
test('dispatch checks the complete action set and actual arguments rather than trusting compiler labels',()=>{
 const objective='a 파일을 만들어줘. 내용은 a; b 파일을 만들어줘. 내용은 b';
 const roots=[join(tmpdir(),'batch-binding')];
 const actions=['a','b'].map(label=>({actionId:label,expectedToolName:'filesystem.createTextFile',arguments:{path:join(roots[0],label+'.txt'),content:label}}));
 const wave={actions},mission={objective,goalContract:createGoalContract({objective}),constraints:[],waves:[wave],observations:[]};
 const assess=args=>assessMissionRequirementCoverage({mission,wave,action:actions[0],profile:{mutatesSystem:true,executionClass:'reversible_local'},allowedRoots:roots,...args});
 assert.equal(assess().allowed,true);
 assert.equal(assess({dispatchToolName:'filesystem.createTextFile',dispatchArguments:{...actions[0].arguments,content:'wrong'}}).allowed,false);
 const saved=actions[1];actions.pop();assert.equal(assess().allowed,false);actions.push(saved);
 actions[1].arguments={...actions[0].arguments};assert.equal(assess().allowed,false);
});
for(const suffix of ['; 메일로 보내','; 첫째.txt 파일을 만들어줘. 내용은 덮어쓰기','; 파일을 삭제하지 마'])
test(`unsupported or conflicting tail causes zero file effects: ${suffix}`,async t=>{
 const f=fixture(t),mission=f.create('첫째 메모 파일을 만들어줘. 내용은 첫째'+suffix);
 const result=await f.runtime.missionRuntime.runMission(mission.missionId);
 assert.notEqual(result.status,'COMPLETED');assert.equal(existsSync(join(f.root,'첫째.txt')),false);
 assert.equal(result.waves.flatMap(w=>w.actions).length,0);
});
test('a supplied planner cannot dispatch a partial file for an unsupported whole request',async t=>{
 let root;
 const planner={async planNextWave(){return {decision:'continue',actions:[{id:'partial',command:'첫째 메모 파일을 만들어줘. 내용은 첫째',
  expectedToolName:'filesystem.createTextFile',arguments:{path:join(root,'첫째.txt'),content:'첫째'},dependencies:[]}]};}};
 const f=fixture(t,planner);root=f.root;
 const mission=f.create('첫째 메모 파일을 만들어줘. 내용은 첫째; 알 수 없는 추가 행동을 해');
 const result=await f.runtime.missionRuntime.runMission(mission.missionId);
 assert.notEqual(result.status,'COMPLETED');assert.equal(existsSync(join(root,'첫째.txt')),false);
 assert.ok(result.waves.flatMap(w=>w.actions).some(a=>a.requirementCoverage?.reasons?.some(r=>r.code==='literal-text-whole-request-binding-unresolved')));
});
