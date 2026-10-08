import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createConfiguredCoreServiceRuntime} from '../../scripts/core-service-runtime.mjs';
import {PersonalSourceInbox} from '../../packages/core/src/personal-operations/source-inbox.js';
import {selectedSourceMandateRef} from '../../packages/core/src/personal-operations/selected-source-stream.js';
import {listenOnFetchSafePort} from '../../packages/shared/src/http.js';
const [root,mode='create',mutation='none']=process.argv.slice(2),manifestPath=join(root,'manifest.json');
const env={JARVIS_TEST_MODE:'0',JARVIS_CORE_ROOT:root,JARVIS_CORE_AUDIT_ROOT:join(root,'audit'),JARVIS_CORE_PORT:'0',
 JARVIS_CORE_ALLOWED_ROOTS:'workspace',JARVIS_CORE_WORKER_DAEMON_ENABLED:'0',JARVIS_CORE_WORKER_DAEMON_AUTOSTART:'0',JARVIS_CORE_REMOTE_PC_EXECUTION_ENABLED:'0',
 JARVIS_PERSONAL_IMPORT_ENABLED:'0',JARVIS_GOOGLE_SYNC_ENABLED:'0',JARVIS_PERSONAL_OPERATIONS_DB:join(root,'operations.sqlite'),
 JARVIS_CORE_MISSION_STORE_BACKEND:'sqlite',JARVIS_CORE_MISSION_AUTHORITY_ENABLED:'1',JARVIS_CORE_MISSION_AUTHORITY_EXPECTED_TOKEN:mode==='create'?'0':'1',
 JARVIS_CORE_ADMIN_TOKEN:'synthetic-restart-owner',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'};
let service;
try{
 service=await createConfiguredCoreServiceRuntime({env});const address=await listenOnFetchSafePort(service.server,{host:'127.0.0.1'}),base=`http://127.0.0.1:${address.port}`;
 const store=service.personalOperations.store,inbox=new PersonalSourceInbox(store);
 const page={provider:'outlook',account:'synthetic-restart-account',scope:'Mail.ReadBasic',observedAt:'2026-10-07T00:00:00Z',items:[{id:'one',title:'새 프로세스에서 대조할 자료'}]};
 const headers={authorization:'Bearer synthetic-restart-owner','content-type':'application/json'};
 if(mode==='create'){
  const selection={provider:'outlook',streamRef:inbox.ingest(page).stream};
  const quota=service.missionRuntime.executionBudget.createQuota({validFrom:'2020-01-01T00:00:00Z',expiresAt:'2099-01-01T00:00:00Z',maxCalls:3,scope:{accountRef:null,dataRefs:[selectedSourceMandateRef(selection)],deniedDataRefs:[]}});
  const owner=service.personalOwnerSession.activate({durationMinutes:5,requestedBy:'isolated-restart-test'});
  const created=service.missionRuntime.createMission({objective:'선택한 연결의 저장 자료 전체를 조회해.',selectedSource:selection,executionMandateId:quota.mandate.id,
   authorization:{mode:'trusted_session',ownerSessionId:owner.session.sessionId,grants:['read_only','high_impact']},metadata:{longTermMemory:false}});
  const result=await service.missionRuntime.runMission(created.missionId);assert.equal(result.status,'COMPLETED',JSON.stringify(result.lastError));
  const native=service.trustKernel.status().keyProvider;assert.equal(native.persistent,true,JSON.stringify(native));assert.equal(native.protectedByOs,true,JSON.stringify(native));
  const saved=store.db.prepare('SELECT body FROM selected_source_task_receipts').all();assert.equal(saved.length,1);
  assert.ok(saved.every(r=>!r.body.includes(page.items[0].title)&&!r.body.includes('synthetic-restart-owner')&&!r.body.includes('synthetic-restart-account')));
  writeFileSync(manifestPath,JSON.stringify({missionId:created.missionId,selection,mandateId:quota.mandate.id,pid:process.pid}));
  process.send({ok:true,pid:process.pid,mode,receiptCount:saved.length,nativeKeyProvider:native.provider});
 }else{
  const manifest=JSON.parse(readFileSync(manifestPath,'utf8')),mission=service.missionRuntime.missions.get(manifest.missionId),action=mission.waves[0].actions[0];
  assert.notEqual(manifest.pid,process.pid);assert.equal(service.coreFacade.getTask(action.taskId),undefined);
  const before=await fetch(`${base}/missions/${manifest.missionId}/verified-selected-source`,{headers});assert.equal((await before.json()).success,false);
  const history=await (await fetch(base+'/personal-inbox/selected-source-history',{method:'POST',headers,body:JSON.stringify({...manifest.selection,limit:50})})).json();
  assert.equal(history.total,1);assert.equal(history.items[0].missionId,manifest.missionId);assert.equal(history.currentResultVerified,false);
  assert.doesNotMatch(JSON.stringify(history),/새 프로세스에서 대조할 자료|synthetic-restart-account|synthetic-restart-owner/);
  if(mutation==='source-changed')inbox.ingest({...page,observedAt:'2026-10-07T00:01:00Z',items:[{id:'one',title:'다른 내용으로 정정된 자료'}]});
  if(mutation==='signature'){const row=store.db.prepare('SELECT task_id,body FROM selected_source_task_receipts').get();store.db.prepare('UPDATE selected_source_task_receipts SET body=? WHERE task_id=?').run(row.body.replace('outlook','gmail'),row.task_id);}
  if(mutation==='missing')store.db.prepare('DELETE FROM selected_source_task_receipts').run();
  if(mutation==='goal-changed'){mission.authorization.mode='per_action';mission.authorization.ownerSessionId=null;}
  if(mutation==='observation')mission.observations[0].evidenceId='forged-evidence';
  if(mutation==='mandate')store.revokeMandate(manifest.mandateId);
  if(mutation==='availability'){
   const binding={capabilityId:'source.readSelectedInbox',providerId:'core-inbox',accountRef:manifest.selection.streamRef,deviceRef:null,scopes:['selected.metadata.read']};
   service.capabilityPackageRegistry.recordAvailability({...binding,codeVersion:service.capabilityPackageRegistry.availabilityFor(binding).codeVersion,
    permissionRevision:'revoked-after-restart',observedAt:new Date().toISOString(),accountStatus:'revoked',observedAccountRef:manifest.selection.streamRef,
    deviceStatus:'not-required',grantedScopes:[],verificationLevel:'live-probe',evidenceRef:'test:revoke-before-recovery'});
  }
  const owner=service.personalOwnerSession.activate({durationMinutes:5,requestedBy:'isolated-restart-reader',grants:mutation==='grant'?['local_reversible']:['read_only']});
  const authorizationBefore=JSON.stringify(mission.authorization),metricsBefore=JSON.stringify(mission.metrics);
  const response=await fetch(`${base}/missions/${manifest.missionId}/verified-selected-source`,{method:'POST',headers,body:JSON.stringify({ownerSessionId:owner.session.sessionId})});
  assert.equal(response.status,200);const result=await response.json();
  if(mutation==='none'){assert.equal(result.success,true,JSON.stringify(result));assert.equal(result.result.total,1);assert.equal(result.result.items[0].title,page.items[0].title);}
  else{assert.equal(result.success,false,JSON.stringify(result));assert.equal(result.result,undefined);}
  assert.equal(JSON.stringify(mission.authorization),authorizationBefore);assert.equal(JSON.stringify(mission.metrics),metricsBefore);
  const diagnostics=await fetch(base+'/admin/diagnostics',{headers});const auth=(await diagnostics.json()).adminAuth;
  assert.equal(auth.recentAudit.filter(a=>a.route==='/personal-inbox/selected-source').length,0,'recovery does not execute a new B read');
  process.send({ok:true,pid:process.pid,mode,mutation,verified:result.success,executedActions:mission.metrics.executedActions,resultItems:result.result?.total??0});
 }
}catch(error){process.send({ok:false,pid:process.pid,error:error.message});process.exitCode=1;}
finally{if(service){service.server.closeAllConnections();await service.close();}process.disconnect();}
