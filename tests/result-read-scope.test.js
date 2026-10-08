import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {PersonalMandateBudget} from '../packages/core/src/personal-operations/mandate-budget.js';
import {MissionBudgetGate} from '../packages/core/src/personal-operations/mission-budget-gate.js';
import {localMandateFileRef} from '../packages/core/src/personal-operations/local-mandate-observation.js';
import {SqliteMissionStore} from '../packages/core/src/mission/sqlite-mission-store.js';
import {SqliteMemoryStore} from '../apps/growth-memory/src/db/sqlite-store.js';

for(const mode of ['ready','revoked','mid-read-revoked','final-check-revoked','expired','source-changed','guard-unavailable'])test(`actual completed Mission result preview: ${mode}`,async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-result-scope-')),sourcePath=join(root,'source.txt'),output=join(root,'result.json');
 const source='실제 지출액: 0원\n승인 여부: 미승인\n';await writeFile(sourcePath,source);
 const store=new PersonalOperationsStore({dbPath:join(root,'ops.sqlite')}),budget=new PersonalMandateBudget(store),gate=new MissionBudgetGate({store,budget});
 const quota=gate.createQuota({validFrom:'2020-01-01T00:00:00Z',expiresAt:'2099-01-01T00:00:00Z',maxCalls:2,scope:{accountRef:null,dataRefs:[sourcePath,output].map(path=>localMandateFileRef(path,root)),deniedDataRefs:[]}});
 const env={JARVIS_TEST_MODE:'1',JARVIS_MISSION_EXECUTIVE:'0',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'};
 const memory=new SqliteMemoryStore({dbPath:join(root,'growth.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')});
 const runtime=createAgRuntime({allowedRoots:[root],auditRoot:join(root,'audit'),env,taskEnv:env,workerDaemonEnabled:false,missionStore:new SqliteMissionStore({operationsStore:store}),memoryStore:memory});runtime.missionRuntime.executionBudget=gate;
 t.after(async()=>{runtime.close?.();runtime.coreFacade.cognition?.close();memory.close();store.close();await rm(root,{recursive:true,force:true});});
 const owner=runtime.personalOwnerSession.activate({durationMinutes:5,requestedBy:'synthetic-result-preview'}),objective="'source.txt' 파일에서 항목 '실제 지출액'의 '원' 단위 숫자, '승인 여부'의 승인 상태를 정리해 'result.json'에 JSON으로 저장하고 다시 읽어 확인해줘";
 const created=runtime.missionRuntime.createMission({objective,executionMandateId:quota.mandate.id,authorization:{mode:'trusted_session',ownerSessionId:owner.session.sessionId,grants:['read_only','local_reversible']},successCriteria:[`${objective} 목표가 실제 실행 결과로 확인되고 G 검증을 통과한다.`]});
 const completed=await runtime.missionRuntime.runMission(created.missionId);
 assert.equal(completed.status,'COMPLETED',JSON.stringify({status:completed.status,stopReason:completed.stopReason,lastError:completed.lastError,gates:completed.gates,errors:completed.observations.map(x=>x.error)}));assert.equal(completed.gates.length,0);
 const originalOutput=await readFile(output,'utf8');assert.equal(budget.summary(quota.mandate.id).usedOrHeldCalls,1);
 if(mode==='revoked')store.revokeMandate(quota.mandate.id);
 if(mode==='expired')store.clock=()=>new Date('2100-01-01T00:00:00Z');
 if(mode==='source-changed')await writeFile(sourcePath,'실제 지출액: 99원\n승인 여부: 승인\n');
 if(mode==='guard-unavailable')runtime.missionRuntime.executionBudget=null;
 const readGuard=gate.beforeResultRead.bind(gate);let checks=0;
 gate.beforeResultRead=(...args)=>{
  checks++;if((mode==='mid-read-revoked'&&checks===2)||(mode==='final-check-revoked'&&checks===7))store.revokeMandate(quota.mandate.id);
  return readGuard(...args);
 };
 const preview=await runtime.missionRuntime.getVerifiedFieldSummary(created.missionId);
 assert.equal(preview.status==='verified',mode==='ready',JSON.stringify(preview));
 if(mode==='ready'){assert.deepEqual(preview.fields.map(x=>x.value),['0','미승인']);assert.ok(checks>=8);}
 else assert.deepEqual(preview.fields,[]);
 if(mode==='final-check-revoked')assert.equal(checks,7);
 assert.equal((await runtime.missionRuntime.getMission(created.missionId)).status,'COMPLETED','historical completion is preserved');
 assert.equal(await readFile(output,'utf8'),originalOutput);assert.equal(budget.summary(quota.mandate.id).usedOrHeldCalls,1,'preview is not a new execution call');
});

test('preview permissions do not grant execution or outside file access',async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-result-guard-')),inside=join(root,'inside.txt'),outside=join(root,'outside.txt');await writeFile(inside,'permitted');await writeFile(outside,'private synthetic');
 const store=new PersonalOperationsStore({dbPath:join(root,'ops.sqlite')}),budget=new PersonalMandateBudget(store),gate=new MissionBudgetGate({store,budget});t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
 const quota=gate.createQuota({validFrom:'2020-01-01T00:00:00Z',expiresAt:'2099-01-01T00:00:00Z',maxCalls:2,scope:{accountRef:null,dataRefs:[localMandateFileRef(inside,root)],deniedDataRefs:[]}}),mission={executionMandateId:quota.mandate.id,missionId:'synthetic'};
 assert.equal(gate.beforeResultRead(mission,{workspaceRoot:root,path:inside}),localMandateFileRef(inside,root));
 assert.throws(()=>gate.beforeResultRead(mission,{workspaceRoot:root,path:outside}),/DATA_SCOPE_DENIED/);
 assert.throws(()=>gate.beforeResultRead(mission,{workspaceRoot:root,path:inside,kind:'write'}),/RESULT_ACCESS_INVALID/);
 assert.throws(()=>gate.beforeAction(mission),/RESERVATION_REQUIRED/);assert.equal(budget.summary(quota.mandate.id).usedOrHeldCalls,0);
});
