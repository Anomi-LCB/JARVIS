import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep,basename} from 'node:path';
import {createConfiguredCoreServiceRuntime} from '../scripts/core-service-runtime.mjs';
import {PersonalSourceInbox} from '../packages/core/src/personal-operations/source-inbox.js';
import {selectedSourceMandateRef} from '../packages/core/src/personal-operations/selected-source-stream.js';
import {listenOnFetchSafePort} from '../packages/shared/src/http.js';

for(const [remote,authorityEnabled] of [[false,false],[false,true],[true,true]])test('configured service selected source: remote PC='+remote+', authority='+authorityEnabled,async t=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-core-source-'));let service,remoteCalls=0;
 const remoteServer=createServer((q,r)=>{remoteCalls++;r.writeHead(503);r.end();});
 const remoteAddress=await listenOnFetchSafePort(remoteServer,{host:'127.0.0.1'});
 t.after(async()=>{if(service){service.server.closeAllConnections();await service.close();}remoteServer.closeAllConnections();await new Promise(r=>remoteServer.close(r));assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep)&&basename(root).startsWith('jarvis-core-source-'));rmSync(root,{recursive:true,force:true});});
 const env={JARVIS_TEST_MODE:'1',JARVIS_CORE_ROOT:root,JARVIS_TEST_AUDIT_ROOT:join(root,'audit'),JARVIS_CORE_PORT:'0',
  JARVIS_CORE_ALLOWED_ROOTS:'workspace',JARVIS_CORE_WORKER_DAEMON_ENABLED:'0',JARVIS_CORE_WORKER_DAEMON_AUTOSTART:'0',
  JARVIS_PERSONAL_IMPORT_ENABLED:'0',JARVIS_GOOGLE_SYNC_ENABLED:'0',JARVIS_PERSONAL_OPERATIONS_DB:join(root,'operations.sqlite'),
  JARVIS_CORE_MISSION_STORE_BACKEND:'sqlite',JARVIS_CORE_MISSION_AUTHORITY_ENABLED:authorityEnabled?'1':'0',JARVIS_CORE_MISSION_AUTHORITY_EXPECTED_TOKEN:'0',
  JARVIS_CORE_REMOTE_PC_EXECUTION_ENABLED:remote?'1':'0',JARVIS_PC_AGENT_API_URL:`http://127.0.0.1:${remoteAddress.port}`,JARVIS_PC_AGENT_EXECUTION_TOKEN:'synthetic-remote-pc-token'};
 service=await createConfiguredCoreServiceRuntime({env});
 const address=await listenOnFetchSafePort(service.server,{host:'127.0.0.1'}),base=`http://127.0.0.1:${address.port}`;
 const inbox=new PersonalSourceInbox(service.personalOperations.store);
 const page={provider:'outlook',account:'synthetic-owner',scope:'Mail.ReadBasic',observedAt:'2026-10-07T00:00:00Z',items:[{id:'one',title:'서비스 실제 조회 자료'}]};
 const selection={provider:'outlook',streamRef:inbox.ingest(page).stream};
 const quota=service.missionRuntime.executionBudget.createQuota({validFrom:'2020-01-01T00:00:00Z',expiresAt:'2099-01-01T00:00:00Z',maxCalls:3,scope:{accountRef:null,dataRefs:[selectedSourceMandateRef(selection)],deniedDataRefs:[]}});
 const owner=service.personalOwnerSession.activate({durationMinutes:5,requestedBy:'isolated-service-test'});
 const created=service.missionRuntime.createMission({objective:'선택한 연결의 저장 자료 전체를 조회해.',selectedSource:selection,executionMandateId:quota.mandate.id,
  authorization:{mode:'trusted_session',ownerSessionId:owner.session.sessionId,grants:['read_only','high_impact']},metadata:{longTermMemory:false}});
 assert.ok(created.missionId,JSON.stringify(created));
 const result=await service.missionRuntime.runMission(created.missionId);
 assert.equal(result.status,'COMPLETED',JSON.stringify({status:result.status,stopReason:result.stopReason,lastError:result.lastError,observations:result.observations,waves:result.waves}));
 assert.equal(remoteCalls,0);
 const delivered=service.missionRuntime.getVerifiedSelectedSourceResult(created.missionId);
 assert.equal(delivered.success,true,JSON.stringify(delivered));assert.equal(delivered.result.items[0].title,page.items[0].title);
 assert.equal(service.orchestrationWorker.executorForPacket({action:{toolName:'source.readSelectedInbox'}}),service.pcAgent);
 assert.equal(service.orchestrationWorker.executorForPacket({action:{toolName:'filesystem.createTextFile'}}),remote?service.remotePcAgent:service.pcAgent);
 assert.equal((await fetch(base+'/personal-inbox/selected-source',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(selection)})).status,401);
 const streams=await fetch(base+'/personal-inbox/streams',{headers:{authorization:'Bearer local-core-admin'}});
 assert.equal((await streams.json()).missionEnabled,true);
 const diagnostics=await fetch(base+'/admin/diagnostics',{headers:{authorization:'Bearer local-core-admin'}});
 const authStatus=(await diagnostics.json()).adminAuth;
 assert.ok(authStatus.tokenRecords.every(record=>record.role!=='selected-source-worker'),'one-shot read credentials are discarded after delivery');
 const sourceAudit=authStatus.recentAudit.filter(a=>a.route==='/personal-inbox/selected-source'&&a.allowed);
 assert.ok(sourceAudit.length>=3);
 assert.ok(sourceAudit.every(a=>a.role==='selected-source-worker'&&a.requiredScope==='core:selected-source:read'));
 const binding={capabilityId:'source.readSelectedInbox',providerId:'core-inbox',accountRef:selection.streamRef,deviceRef:null,scopes:['selected.metadata.read']};
 const prior=service.capabilityPackageRegistry.availabilityFor(binding);
 await new Promise(r=>setTimeout(r,2));
 service.capabilityPackageRegistry.recordAvailability({...binding,codeVersion:prior.codeVersion,permissionRevision:'explicit-revocation',observedAt:new Date().toISOString(),
  accountStatus:'revoked',observedAccountRef:selection.streamRef,deviceStatus:'not-required',grantedScopes:[],verificationLevel:'live-probe',evidenceRef:'test:explicit-revocation'});
 assert.equal(service.missionRuntime.getVerifiedSelectedSourceResult(created.missionId).success,false);
 await service.orchestrationWorker.capabilityAvailabilityGuard.resolver({toolName:'source.readSelectedInbox',action:{arguments:selection}});
 assert.equal(service.capabilityPackageRegistry.availabilityFor(binding).accountStatus,'revoked','a local SQL probe cannot resurrect revoked access');
 if(remote)service.missionExecutionAuthority.release();
 else service.personalOwnerSession.revoke({reason:'test-revocation'});
 assert.equal(service.missionRuntime.getVerifiedSelectedSourceResult(created.missionId).success,false);
});
