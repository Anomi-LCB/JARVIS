import assert from 'node:assert/strict';import {readFileSync,writeFileSync} from 'node:fs';import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
// Test-only selection: exercise the installed source graph, not repository imports.
const moduleUrl=path=>process.env.JARVIS_TEST_CASE_PACKAGE_ROOT
 ?pathToFileURL(join(process.env.JARVIS_TEST_CASE_PACKAGE_ROOT,path)).href:new URL('../../'+path,import.meta.url).href;
const {createConfiguredCoreServiceRuntime}=await import(moduleUrl('scripts/core-service-runtime.mjs'));
const {PersonalLifecycleCases}=await import(moduleUrl('packages/core/src/personal-operations/lifecycle-cases.js'));
const {lifecycleCaseMandateRef}=await import(moduleUrl('packages/core/src/personal-operations/lifecycle-case-read.js'));
const {listenOnFetchSafePort}=await import(moduleUrl('packages/shared/src/http.js'));
const [root,mode='create',mutation='none']=process.argv.slice(2),manifestPath=join(root,'manifest.json');
const env={JARVIS_TEST_MODE:'0',JARVIS_CORE_ROOT:root,JARVIS_CORE_AUDIT_ROOT:join(root,'audit'),JARVIS_CORE_PORT:'0',JARVIS_CORE_ALLOWED_ROOTS:'workspace',
 JARVIS_CORE_WORKER_DAEMON_ENABLED:'0',JARVIS_CORE_WORKER_DAEMON_AUTOSTART:'0',JARVIS_CORE_REMOTE_PC_EXECUTION_ENABLED:'0',JARVIS_PERSONAL_IMPORT_ENABLED:'0',JARVIS_GOOGLE_SYNC_ENABLED:'0',
 JARVIS_PERSONAL_OPERATIONS_DB:join(root,'operations.sqlite'),JARVIS_CORE_MISSION_STORE_BACKEND:'sqlite',JARVIS_CORE_MISSION_AUTHORITY_ENABLED:'1',JARVIS_CORE_MISSION_AUTHORITY_EXPECTED_TOKEN:mode==='create'?'0':'1',
 JARVIS_CORE_ADMIN_TOKEN:'synthetic-case-restart',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'};
let service;
try{
 service=await createConfiguredCoreServiceRuntime({env});const address=await listenOnFetchSafePort(service.server,{host:'127.0.0.1'}),base=`http://127.0.0.1:${address.port}`,store=service.personalOperations.store,cases=new PersonalLifecycleCases(store),headers={authorization:'Bearer synthetic-case-restart','content-type':'application/json'};
 assert.equal((await (await fetch(base+'/personal-operations/cases/context',{headers})).json()).missionConfigured,true);
 if(mode==='create'){
  const c=cases.create({requestId:'test',kind:'return',provider:'shopify',accountRef:'synthetic-account-private',providerRef:'synthetic-receipt-private',title:'새 프로세스에서 대조할 합성 반품',dueAt:null});
  const selection={caseId:c.id,expectedStoreId:cases.storeId,expectedRevision:1},owner=service.personalOwnerSession.activate({durationMinutes:5,grants:['read_only'],requestedBy:'isolated-restart'});
  const quota=service.missionRuntime.executionBudget.createQuota({validFrom:'2020-01-01T00:00:00Z',expiresAt:'2099-01-01T00:00:00Z',maxCalls:3,scope:{accountRef:null,dataRefs:[lifecycleCaseMandateRef(selection)],deniedDataRefs:[]}});
  const created=service.missionRuntime.createMission({objective:'선택한 생활 업무의 로컬 기록과 마감을 조회해.',lifecycleCase:selection,executionMandateId:quota.mandate.id,authorization:{mode:'trusted_session',ownerSessionId:owner.session.sessionId,grants:['read_only']},metadata:{longTermMemory:false}});
  const run=await service.missionRuntime.runMission(created.missionId);const raw=service.missionRuntime.missions.get(created.missionId),a=raw.waves[0]?.actions[0],t=service.coreFacade.getTask(a?.taskId);let readError=null;try{service.missionRuntime.lifecycleCaseDependencies(raw).beforeRead(a,t);}catch(e){readError=e.message;}
  assert.equal(run.status,'COMPLETED',JSON.stringify({status:run.status,error:run.lastError,stopReason:run.stopReason,readError}));
  const result=service.missionRuntime.getVerifiedLifecycleCaseResult(created.missionId);assert.equal(result.success,true,JSON.stringify(result));
  const saved=store.db.prepare('SELECT body FROM lifecycle_case_task_receipts').all();assert.equal(saved.length,1);assert.doesNotMatch(saved[0].body,/새 프로세스|synthetic-account-private|synthetic-receipt-private|synthetic-case-restart/);
  const key=service.trustKernel.status().keyProvider;assert.equal(key.persistent,true);assert.equal(key.protectedByOs,true);
  writeFileSync(manifestPath,JSON.stringify({missionId:created.missionId,selection,mandateId:quota.mandate.id,pid:process.pid}));process.send({ok:true,pid:process.pid,mode,receiptCount:1,providerVerified:false,nativeKeyProvider:key.provider});
 }else{
  const manifest=JSON.parse(readFileSync(manifestPath,'utf8')),mission=service.missionRuntime.missions.get(manifest.missionId),action=mission.waves[0].actions[0],url=base+'/missions/'+encodeURIComponent(manifest.missionId)+'/verified-lifecycle-case';
  assert.notEqual(manifest.pid,process.pid);assert.equal(service.coreFacade.getTask(action.taskId),undefined);
  assert.equal((await (await fetch(url,{headers})).json()).success,false);
  if(mutation==='source-changed')cases.record(manifest.selection.caseId,'cancel',{eventId:'changed',expectedRevision:1,reason:'synthetic'});
  if(mutation==='signature'){const row=store.db.prepare('SELECT task_id,body FROM lifecycle_case_task_receipts').get();store.db.prepare('UPDATE lifecycle_case_task_receipts SET body=? WHERE task_id=?').run(row.body.replace('"resultSha256":"','"resultSha256":"tampered'),row.task_id);}
  if(mutation==='missing')store.db.prepare('DELETE FROM lifecycle_case_task_receipts').run();
  if(mutation==='goal-changed'){mission.authorization.mode='per_action';mission.authorization.ownerSessionId=null;}
  if(mutation==='observation')mission.observations[0].verification.verificationId='other-verification';
  if(mutation==='cancelled-state')mission.status='CANCELLED';
  if(mutation==='authority')service.missionExecutionAuthority.recoveryOnly=true;
  if(mutation==='mandate')store.revokeMandate(manifest.mandateId);
  if(mutation==='availability'){
   const binding={capabilityId:'case.readLocalRecord',providerId:'core-local-case',accountRef:manifest.selection.caseId,deviceRef:null,scopes:['case.read:selected']};
   service.capabilityPackageRegistry.recordAvailability({...binding,codeVersion:service.capabilityPackageRegistry.availabilityFor(binding).codeVersion,permissionRevision:'revoked',observedAt:new Date().toISOString(),accountStatus:'revoked',observedAccountRef:manifest.selection.caseId,deviceStatus:'not-required',grantedScopes:[],verificationLevel:'live-probe',evidenceRef:'test-revocation'});
  }
  const owner=service.personalOwnerSession.activate({durationMinutes:5,grants:mutation==='grant'?['local_reversible']:['read_only'],requestedBy:'isolated-result-reader'});
  const unchanged=()=>JSON.stringify({authorization:mission.authorization,metrics:mission.metrics,status:mission.status,events:cases.get(manifest.selection.caseId).events.length,budget:service.missionRuntime.executionBudget.budget.summary(manifest.mandateId)}),before=unchanged();
  const response=await fetch(url,{method:'POST',headers,body:JSON.stringify({ownerSessionId:owner.session.sessionId})});assert.equal(response.status,200);const result=await response.json();
  if(mutation==='none'){assert.equal(result.success,true,JSON.stringify(result));assert.equal(result.result.title,'새 프로세스에서 대조할 합성 반품');assert.equal(result.providerVerified,false);}else{assert.equal(result.success,false,JSON.stringify(result));assert.equal(result.result,undefined);}
  assert.equal(unchanged(),before);
  const bad=await fetch(url,{method:'POST',headers,body:JSON.stringify({ownerSessionId:owner.session.sessionId,activate:true})});assert.equal(bad.status,400);
  process.send({ok:true,pid:process.pid,mode,mutation,verified:result.success,executedActions:mission.metrics.executedActions,providerVerified:false});
 }
}catch(error){process.send({ok:false,pid:process.pid,error:error.message});process.exitCode=1;}finally{if(service){service.server.closeAllConnections();await service.close();}process.disconnect();}
