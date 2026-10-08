import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,symlinkSync,renameSync,existsSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {PersonalMandateBudget} from '../packages/core/src/personal-operations/mandate-budget.js';
import {MissionBudgetGate} from '../packages/core/src/personal-operations/mission-budget-gate.js';
import {localMandateFileRef} from '../packages/core/src/personal-operations/local-mandate-observation.js';
import {withMissionMandateFence} from '../packages/core/src/personal-operations/mission-mandate-fence.js';
import {SqliteMissionStore} from '../packages/core/src/mission/sqlite-mission-store.js';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {MissionGrant} from '../packages/core/src/mission/mission-runtime.js';
import {SqliteMemoryStore} from '../apps/growth-memory/src/db/sqlite-store.js';

function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'jarvis-local-scope-'));
 const store=new PersonalOperationsStore({dbPath:join(root,'scope.sqlite')}),budget=new PersonalMandateBudget(store),gate=new MissionBudgetGate({store,budget});
 const cleanup=[];t.after(()=>{for(const close of cleanup)close();store.close();rmSync(root,{recursive:true,force:true});});return {root,store,budget,gate,cleanup};
}
const dates={validFrom:'2020-01-01T00:00:00Z',expiresAt:'2099-01-01T00:00:00Z',maxCalls:2};
for(const mode of ['ready','outside','exception','alias-changed'])test(`actual Core/E/B/G scoped local file Mission: ${mode}`,async t=>{
 const f=fixture(t);let output=join(f.root,'output.txt'),approved=output;
 if(mode==='alias-changed'){
  mkdirSync(join(f.root,'a'));mkdirSync(join(f.root,'b'));symlinkSync(join(f.root,'a'),join(f.root,'alias'),'junction');
  output=join(f.root,'alias','output.txt');approved=join(f.root,'a','output.txt');
 }
 const allowedRef=localMandateFileRef(approved,f.root);
 const quota=f.gate.createQuota({...dates,scope:{accountRef:null,dataRefs:[mode==='outside'?localMandateFileRef(join(f.root,'different.txt'),f.root):allowedRef],deniedDataRefs:mode==='exception'?[allowedRef]:[]}});
 const env={JARVIS_TEST_MODE:'1',JARVIS_MISSION_EXECUTIVE:'0',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'};
 const planner={async planNextWave(c){if(c.observations.some(o=>o.outcome==='success'))return {decision:'complete',actions:[],criteriaAssessment:c.mission.successCriteria.map(x=>({criterionId:x.criterionId,status:'satisfied',evidenceActionIds:c.observations.map(o=>o.actionId)}))};return {decision:'continue',actions:[{id:'write',command:'output 텍스트 파일을 만들어줘',expectedToolName:'filesystem.createTextFile',arguments:{path:output,content:'synthetic scoped data'},dependencies:[],requirementIds:c.mission.goalContract.requirements.map(r=>r.requirementId)}]};}};
 const memoryStore=new SqliteMemoryStore({dbPath:join(f.root,'growth.sqlite'),reviewDir:join(f.root,'reviews'),backupDir:join(f.root,'backups')});
 const runtime=createAgRuntime({allowedRoots:[f.root],auditRoot:join(f.root,'audit'),cwd:()=>f.root,env,taskEnv:env,workerDaemonEnabled:false,missionPlanner:planner,memoryStore,missionStore:new SqliteMissionStore({operationsStore:f.store})});
 runtime.missionRuntime.executionBudget=f.gate;
 f.cleanup.push(()=>{runtime.close?.();runtime.coreFacade.cognition?.close();memoryStore.close();});
 if(mode==='alias-changed'){
  const adapter=runtime.pcAgent.registry.get('filesystem.createTextFile'),shadow=adapter.shadow.bind(adapter);let n=0;
  adapter.shadow=async(...args)=>{const result=await shadow(...args);if(++n===2){renameSync(join(f.root,'alias'),join(f.root,'old-alias'));symlinkSync(join(f.root,'b'),join(f.root,'alias'),'junction');}return result;};
 }
 const owner=runtime.personalOwnerSession.activate({durationMinutes:5,requestedBy:'scope-test'});
 const created=runtime.missionRuntime.createMission({objective:"'output.txt' 파일을 저장해",executionMandateId:quota.mandate.id,
  authorization:{mode:'trusted_session',ownerSessionId:owner.session.sessionId,grants:[MissionGrant.READ_ONLY,MissionGrant.LOCAL_REVERSIBLE]},
  successCriteria:[{statement:'실제 파일 내용',verificationSpec:{version:1,kind:'text.equals',path:mode==='alias-changed'?'a/output.txt':'output.txt',equals:'synthetic scoped data'}}]});
 const result=await runtime.missionRuntime.runMission(created.missionId);
 if(mode==='ready'){
  assert.equal(result.status,'COMPLETED',JSON.stringify(result));assert.equal(readFileSync(output,'utf8'),'synthetic scoped data');
  assert.equal(result.gates.length,0);assert.equal(f.budget.summary(quota.mandate.id).usedOrHeldCalls,1);
 }else{
  assert.notEqual(result.status,'COMPLETED');assert.equal(existsSync(output),false);assert.equal(existsSync(approved),false);
 }
 console.log(JSON.stringify({actualCoreEBG:true,mode,status:result.status,outputExists:existsSync(output)}));
});

test('unknown tool and planner-supplied data claims cannot bypass observed packet semantics',t=>{
 const f=fixture(t),ref=localMandateFileRef(join(f.root,'file.txt'),f.root),quota=f.gate.createQuota({...dates,scope:{accountRef:null,dataRefs:[ref],deniedDataRefs:[]}});
 const mission={missionId:'synthetic',executionMandateId:quota.mandate.id};f.gate.beforeRun(mission);
 for(const action of [{toolName:'email.send',arguments:{dataRefs:[ref]}},{toolName:'filesystem.createTextFile',arguments:{path:'file.txt',content:'x',dataRefs:[ref]}}]){
  assert.throws(()=>f.gate.beforeAction(mission,{packet:{action},workspaceRoot:f.root}),/OBSERVATION_UNSUPPORTED/);
 }
});

test('a physical alias changing during async original guard is rejected even when both identities were delegated',async t=>{
 const f=fixture(t);mkdirSync(join(f.root,'a'));mkdirSync(join(f.root,'b'));symlinkSync(join(f.root,'a'),join(f.root,'alias'),'junction');
 const refs=['a','b'].map(dir=>localMandateFileRef(join(f.root,dir,'out.txt'),f.root));
 const quota=f.gate.createQuota({...dates,scope:{accountRef:null,dataRefs:refs,deniedDataRefs:[]}}),mission={missionId:'synthetic',executionMandateId:quota.mandate.id};f.gate.beforeRun(mission);
 const hooks=withMissionMandateFence({mission,gate:f.gate,executor:{supportsTrustedLocalMissionEffects:()=>true},workspaceRoot:f.root,hooks:{async beforeExecute(){renameSync(join(f.root,'alias'),join(f.root,'old-alias'));symlinkSync(join(f.root,'b'),join(f.root,'alias'),'junction');return ()=>{};}}});
 await assert.rejects(hooks.beforeExecute({action:{toolName:'filesystem.createTextFile',arguments:{path:'alias/out.txt',content:'x'}}}),/FILE_IDENTITY_CHANGED/);
});
