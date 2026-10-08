import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';import {PersonalLifecycleCases} from '../packages/core/src/personal-operations/lifecycle-cases.js';import {SqliteMemoryStore} from '../apps/growth-memory/src/db/sqlite-store.js';
import {readLifecycleCaseSnapshot} from '../packages/core/src/personal-operations/lifecycle-case-read.js';
import {captureLifecycleCase} from '../packages/core/src/mission/lifecycle-case-result.js';
import {createCoreServer} from '../packages/core/src/main.mjs';import {listenOnFetchSafePort} from '../packages/shared/src/http.js';
const objective='선택한 생활 업무의 로컬 기록과 마감을 조회해.';
async function setup(t){
 const root=mkdtempSync(join(tmpdir(),'jarvis-case-mission-')),store=new PersonalOperationsStore({dbPath:join(root,'ops.sqlite')}),cases=new PersonalLifecycleCases(store),memory=new SqliteMemoryStore({dbPath:join(root,'growth.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')});let current=true,onRead=null;
 const c=cases.create({requestId:'test',kind:'shipment',provider:'dhl',accountRef:'synthetic',providerRef:'receipt',title:'합성 배송',dueAt:'2026-10-06T00:00:00Z'}),request={caseId:c.id,expectedStoreId:cases.storeId,expectedRevision:c.revision},binding={capabilityId:'case.readLocalRecord',providerId:'core-local-case',accountRef:c.id,deviceRef:null,scopes:['case.read:selected']};
 const env={JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'};
 const runtime=createAgRuntime({env,taskEnv:env,memoryStore:memory,allowedRoots:[root],auditRoot:join(root,'audit'),workerDaemonEnabled:false,lifecycleCaseAccess:{resolveBinding:()=>({required:true,binding,permissionRevision:'case-1'}),authorizeRequest:r=>current&&r.caseId===c.id,authorizeVerification:r=>current&&r.caseId===c.id,readSnapshot:r=>{const snapshot=readLifecycleCaseSnapshot(cases,r);onRead?.();return snapshot;},readCurrentSnapshot:r=>readLifecycleCaseSnapshot(cases,r)}});
 t.after(()=>{runtime.coreFacade.cognition?.close();memory.close();store.close();rmSync(root,{recursive:true,force:true});});
 runtime.capabilityPackageRegistry.recordAvailability({...binding,codeVersion:runtime.capabilityPackageRegistry.availabilityFor(binding).codeVersion,permissionRevision:'case-1',observedAt:new Date().toISOString(),accountStatus:'connected',observedAccountRef:c.id,deviceStatus:'not-required',grantedScopes:binding.scopes,verificationLevel:'live-probe',evidenceRef:'synthetic-local'});
 const owner=runtime.personalOwnerSession.activate({durationMinutes:5,requestedBy:'synthetic'});const create=(extra={})=>runtime.missionRuntime.createMission({objective,lifecycleCase:request,authorization:{mode:'trusted_session',ownerSessionId:owner.session.sessionId,grants:['read_only','high_impact']},metadata:{longTermMemory:false},...extra});return {runtime,cases,c,request,create,revoke:()=>{current=false;},onRead:callback=>{onRead=callback;}};
}
test('bounded natural objective runs entire Mission with current record criterion',async t=>{
 const f=await setup(t),created=f.create({idempotencyKey:'same'});assert.ok(created.missionId,JSON.stringify(created));assert.equal(f.create({idempotencyKey:'same'}).missionId,created.missionId);
 const run=await f.runtime.missionRuntime.runMission(created.missionId);assert.equal(run.status,'COMPLETED',JSON.stringify({status:run.status,stopReason:run.stopReason,error:run.lastError,observations:run.observations,coverage:run.goalCompletionCoverage}));
 const result=f.runtime.missionRuntime.getVerifiedLifecycleCaseResult(created.missionId);assert.equal(result.status,'verified',JSON.stringify(result));assert.equal(result.result.title,'합성 배송');assert.equal(result.result.providerVerified,false);assert.equal(result.result.deadlineState,'elapsed');assert.equal(f.cases.get(f.c.id).revision,1);
});
for(const mode of ['changed-after-completion','revoked','cancelled','forged-receipt','foreign-action','goal-changed','failed-verification','foreign-verification-task','foreign-verification-id','failed-verification-check'])test('Mission final read refuses '+mode,async t=>{
 const f=await setup(t),created=f.create();assert.equal((await f.runtime.missionRuntime.runMission(created.missionId)).status,'COMPLETED');const mission=f.runtime.missionRuntime.missions.get(created.missionId),action=mission.waves[0].actions[0];
 if(mode==='changed-after-completion')f.cases.record(f.c.id,'cancel',{eventId:'changed',expectedRevision:1,reason:'synthetic'});
 if(mode==='revoked')f.revoke();if(mode==='cancelled')mission.status='CANCELLED';
 if(mode==='forged-receipt')f.runtime.coreFacade.getTask(action.taskId).executionResult.evidence.adapterEvidence.snapshot.title='forged';
 if(mode==='foreign-action')mission.waves[0].actions.push({...action,actionId:'foreign',expectedToolName:'mail.send'});
 if(mode==='goal-changed')mission.objective='선택한 업무를 취소해.';
 if(mode==='failed-verification')f.runtime.coreFacade.getTask(action.taskId).executionVerification.status='failed';
 if(mode==='foreign-verification-task')f.runtime.coreFacade.getTask(action.taskId).executionVerification.taskId='foreign-task';
 if(mode==='foreign-verification-id')f.runtime.coreFacade.getTask(action.taskId).executionVerification.verificationId='foreign-verification';
 if(mode==='failed-verification-check')f.runtime.coreFacade.getTask(action.taskId).executionVerification.checks.push({checkId:'synthetic-required-check',status:'failed'});
 assert.equal(f.runtime.missionRuntime.getVerifiedLifecycleCaseResult(created.missionId).success,false);
});
test('real cancellation during B read leaves Mission cancelled and result unpublished',async t=>{
 const f=await setup(t),created=f.create();f.onRead(()=>f.runtime.missionRuntime.cancelMission(created.missionId));const run=await f.runtime.missionRuntime.runMission(created.missionId);assert.equal(run.status,'CANCELLED',JSON.stringify(run));assert.equal(f.runtime.missionRuntime.getVerifiedLifecycleCaseResult(created.missionId).success,false);assert.equal(f.cases.get(f.c.id).revision,1);
});
test('unknown tails and arbitrary extra requirements never fall back to partial execution',async t=>{
 const f=await setup(t);for(const tail of [' 그리고 배송을 취소해.',' 메일로 보내.',' 환불 완료라고 표시해.'])assert.equal(f.create({objective:objective+tail}).error.code,'A_LIFECYCLE_CASE_REQUEST_UNSUPPORTED');
 assert.throws(()=>captureLifecycleCase(objective,{...f.request,endpoint:'https://other'}));
 const created=f.create({successCriteria:[{statement:'환불을 완료해'}]});const run=await f.runtime.missionRuntime.runMission(created.missionId);assert.notEqual(run.status,'COMPLETED');assert.equal(run.waves.flatMap(w=>w.actions).length,0);
});
test('actual authenticated HTTP Mission run/result and changed-source no disclosure',async t=>{
 const f=await setup(t),server=createCoreServer(f.runtime.coreFacade,{adminToken:'synthetic-admin',missionRuntime:f.runtime.missionRuntime,ownerSessionManager:f.runtime.personalOwnerSession});await listenOnFetchSafePort(server);t.after(()=>new Promise(r=>server.close(r)));const base=`http://127.0.0.1:${server.address().port}`,headers={authorization:'Bearer synthetic-admin','content-type':'application/json'};
 const owner=f.runtime.personalOwnerSession.status().session;
 const createdResponse=await fetch(base+'/missions',{method:'POST',headers,body:JSON.stringify({objective,lifecycleCase:f.request,authorization:{mode:'trusted_session',ownerSessionId:owner.sessionId,grants:['read_only','high_impact']},metadata:{longTermMemory:false}})});
 const created=await createdResponse.json();assert.equal(createdResponse.status,201,JSON.stringify(created));
 const run=await (await fetch(base+'/missions/'+created.missionId+'/run',{method:'POST',headers,body:'{}'})).json();assert.equal(run.status,'COMPLETED',JSON.stringify(run));
 const url=base+'/missions/'+created.missionId+'/verified-lifecycle-case';assert.equal((await fetch(url)).status,401);
 const response=await fetch(url,{headers});assert.equal(response.headers.get('cache-control'),'no-store');const result=await response.json();assert.equal(result.status,'verified',JSON.stringify(result));assert.equal(result.result.caseId,f.c.id);assert.equal(result.result.providerVerified,false);
 f.cases.record(f.c.id,'cancel',{eventId:'after',expectedRevision:1,reason:'synthetic'});const stale=await (await fetch(url,{headers})).json();assert.equal(stale.status,'unverified');assert.equal(Object.hasOwn(stale,'result'),false);assert.doesNotMatch(JSON.stringify(stale),/합성 배송|receipt|synthetic-admin/);
});
