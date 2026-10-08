import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {createConfiguredCoreServiceRuntime} from '../scripts/core-service-runtime.mjs';
import {IntegrationConnectorRegistry} from '../packages/core/src/personal-operations/integration-security.js';
import {microsoftSourceContracts} from '../packages/core/src/personal-operations/microsoft-source-reader.js';
import {createCoreServer} from '../packages/core/src/main.mjs';
import {captureMicrosoftCollection} from '../packages/core/src/mission/microsoft-collection-result.js';
const objective='선택한 Microsoft 연결의 메타데이터를 전체 페이지 수집해.';
for(const provider of ['outlook','teams-chat'])for(const mode of ['complete','limit','cycle','overlap','revoked','changed-sql','forged-past-G','expired-scope','tampered-scope','owner-revoked','goal-limit-changed','tight-limit','tight-complete','extend','extend-tampered','extend-stale','extend-revoked','extend-sql','extend-cancelled','extend-foreign-owner','extend-save-failed'])test(`actual Core/E/B/G paginated Mission ${provider} ${mode}`,async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-ms-pages-')),contract=microsoftSourceContracts[provider];
 const record={connectionId:'synthetic-pages',connectorId:contract.connectorId,status:'credentials-stored-unverified',authMethod:'oauth2',scopes:[contract.scope]};
 const vault={save(){throw Error('SECRET_WRITE_FORBIDDEN');},list:()=>[{...record,scopes:[...record.scopes]}],credentialRevision:()=> 'synthetic-v1',withCredentials:async(id,fn)=>fn({tenantId:provider==='outlook'?'common':'organizations',clientId:'synthetic',clientSecret:'synthetic-secret',refreshToken:'synthetic-refresh'},{...record})};
 let graph=0,tokens=0,service;
 const cursor=n=>provider==='outlook'?`https://graph.microsoft.com/v1.0/me/messages?$select=id,subject,receivedDateTime&$skip=${n}`:`https://graph.microsoft.com/v1.0/chats/19:synthetic@thread.v2/messages?$skiptoken=${n}`;
 t.after(async()=>{try{await service?.close();}catch(error){assert.ok(['revoked','cycle','overlap'].includes(mode));assert.equal(error.code,'A_CORE_AUTHORITY_EFFECT_RECONCILIATION_REQUIRED');}finally{assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(basename(root).startsWith('jarvis-ms-pages-'));await rm(root,{recursive:true,force:true});}});
 service=await createConfiguredCoreServiceRuntime({env:{JARVIS_TEST_MODE:'0',JARVIS_CORE_ROOT:root,JARVIS_CORE_AUDIT_ROOT:join(root,'audit'),JARVIS_CORE_PORT:'0',JARVIS_CORE_ALLOWED_ROOTS:'workspace',JARVIS_CORE_WORKER_DAEMON_ENABLED:'0',JARVIS_CORE_WORKER_DAEMON_AUTOSTART:'0',JARVIS_PERSONAL_IMPORT_ENABLED:'0',JARVIS_GOOGLE_SYNC_ENABLED:'0',JARVIS_PERSONAL_OPERATIONS_DB:join(root,'ops.sqlite'),JARVIS_CORE_MISSION_STORE_BACKEND:'sqlite',JARVIS_CORE_MISSION_AUTHORITY_ENABLED:'1',JARVIS_CORE_MISSION_AUTHORITY_EXPECTED_TOKEN:'0',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'},integrationVault:vault,integrationRegistry:new IntegrationConnectorRegistry(),modelProviderFetch:async url=>{
  if(String(url).includes('login.microsoftonline.com')){tokens++;return Response.json({access_token:'synthetic.token',expires_in:3600,scope:contract.scope});}
  graph++;
  if(graph===2&&mode==='revoked')record.status='revoked';
  return Response.json({value:mode==='overlap'&&graph===2?[{id:'one',subject:'overlap'}]:graph===2?[]:[{id:graph===1?'one':'three',subject:'synthetic page '+graph}],
   ...(graph<3?{'@odata.nextLink':cursor(mode==='cycle'&&graph===2?1:graph)}:{})});
 }});
 const binding={capabilityId:'source.collectMicrosoftMetadata',providerId:'microsoft-graph',accountRef:record.connectionId,deviceRef:null,scopes:[contract.scope]};
 service.capabilityPackageRegistry.recordAvailability({...binding,codeVersion:service.capabilityPackageRegistry.availabilityFor(binding).codeVersion,permissionRevision:'synthetic-v1',observedAt:new Date().toISOString(),accountStatus:'connected',observedAccountRef:record.connectionId,deviceStatus:'not-required',grantedScopes:binding.scopes,verificationLevel:'live-probe',evidenceRef:'synthetic-not-real-account'});
 const owner=service.personalOwnerSession.activate({durationMinutes:5,requestedBy:'synthetic'});
 const created=service.missionRuntime.createMission({objective,microsoftCollection:{provider,connectionId:record.connectionId,...(provider==='teams-chat'?{chatId:'19:synthetic@thread.v2'}:{}),maxPages:['limit','tight-limit','extend','extend-tampered','extend-stale','extend-revoked','extend-sql','extend-cancelled','extend-foreign-owner','extend-save-failed'].includes(mode)?1:mode==='tight-complete'?3:4},...(['tight-limit','tight-complete'].includes(mode)?{budgets:{maxWaves:mode==='tight-limit'?1:3,maxActions:mode==='tight-limit'?1:3}}:{}),authorization:{mode:'trusted_session',ownerSessionId:owner.session.sessionId,grants:['read_only','high_impact','local_write','external_commit']},metadata:{longTermMemory:false}});
 assert.ok(created.missionId,JSON.stringify(created));let run,approvals=0,injected=false,extended=false;
 const archive=service.missionRuntime.microsoftCollectionAccess.archiveCompletedAction;
 service.missionRuntime.microsoftCollectionAccess.archiveCompletedAction=(...args)=>{const result=archive(...args);
  if(graph===1&&!injected){
   injected=true;
   if(mode==='changed-sql')service.missionRuntime.store.db.prepare('DELETE FROM personal_source_items').run();
   if(mode==='forged-past-G')service.missionRuntime.missions.get(created.missionId).observations[0].verification.status='failed';
   const current=service.missionRuntime.missions.get(created.missionId);
   if(mode==='expired-scope')current.gates[0].approvalExpiresAt='2000-01-01T00:00:00.000Z';
   if(mode==='tampered-scope')current.gates[0].microsoftPaginationScope.requestSha256='foreign';
   if(mode==='owner-revoked')service.personalOwnerSession.revoke({reason:'synthetic'});
   if(mode==='goal-limit-changed')current.microsoftCollection.maxPages=100;
  }
 return result;};
 for(let i=0;i<10;i++){
  run=await service.missionRuntime.runMission(created.missionId,{maxWaves:1});
  if(mode==='owner-revoked'&&graph===1)break;
  if(run.status==='WAITING_APPROVAL'){for(const g of run.pendingGates){if(approvals===0){assert.match(g.question,/최대 [134]페이지/u);assert.equal(g.microsoftPaginationScope.maxPages,['limit','tight-limit','extend','extend-tampered','extend-stale','extend-revoked','extend-sql','extend-cancelled','extend-foreign-owner','extend-save-failed'].includes(mode)?1:mode==='tight-complete'?3:4);}
   assert.equal(service.missionRuntime.decideGate(created.missionId,g.gateId,{decision:'approve',decidedBy:'synthetic-owner'}).success,true);approvals++;}continue;}
  if(mode.startsWith('extend')&&!extended&&run.stopReason==='microsoft-collection-page-limit'){
   const original=structuredClone(service.missionRuntime.missions.get(created.missionId).microsoftCollection);
   const extension={ownerSessionId:owner.session.sessionId,extensionId:'ms_limit_synthetic',expectedMaxPages:1,maxPages:3};
   if(mode==='extend-revoked')service.personalOwnerSession.revoke({reason:'synthetic'});
   if(mode==='extend-sql')service.missionRuntime.store.db.prepare('DELETE FROM personal_source_items').run();
   if(mode==='extend-stale')extension.expectedMaxPages=2;
   if(mode==='extend-cancelled')service.missionRuntime.cancelMission(created.missionId,{reason:'synthetic'});
   if(mode==='extend-foreign-owner')extension.ownerSessionId='foreign-owner';
   const save=service.missionRuntime.store.save;
   if(mode==='extend-save-failed')service.missionRuntime.store.save=()=>{throw Error('SYNTHETIC_SAVE_FAILED');};

   let changed;
   if(mode==='extend'){
    const server=createCoreServer(service.coreFacade,{adminToken:'synthetic-limit-admin',missionRuntime:service.missionRuntime,ownerSessionManager:service.personalOwnerSession});
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    try{
     const url=`http://127.0.0.1:${server.address().port}/missions/${encodeURIComponent(created.missionId)}/extend-microsoft-collection`;
     const headers={authorization:'Bearer synthetic-limit-admin','content-type':'application/json'};
     assert.equal((await fetch(url,{method:'POST',body:JSON.stringify(extension)})).status,401);
     assert.equal((await fetch(url,{method:'POST',headers:{authorization:headers.authorization},body:JSON.stringify(extension)})).status,415);
     assert.equal((await fetch(url,{method:'POST',headers,body:JSON.stringify({...extension,ignored:'unsafe'})})).status,409);
     const response=await fetch(url,{method:'POST',headers,body:JSON.stringify(extension)});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');changed=await response.json();
    }finally{await new Promise(r=>server.close(r));}
   }else changed=service.missionRuntime.extendMicrosoftCollectionLimit(created.missionId,extension);
   extended=true;service.missionRuntime.store.save=save;
   if(['extend-revoked','extend-stale','extend-sql','extend-cancelled','extend-foreign-owner','extend-save-failed'].includes(mode)){assert.ok(changed.error,JSON.stringify(changed));assert.equal(graph,1);if(mode==='extend-save-failed'){assert.equal(service.missionRuntime.microsoftCollectionLimit(service.missionRuntime.missions.get(created.missionId)),1);assert.equal(service.missionRuntime.missions.get(created.missionId).stopReason,'microsoft-collection-page-limit');}break;}
   assert.equal(changed.microsoftCollectionPageLimit,3,JSON.stringify(changed));assert.deepEqual(changed.microsoftCollection,original);
   assert.equal(graph,1);assert.equal(service.missionRuntime.extendMicrosoftCollectionLimit(created.missionId,extension).microsoftCollectionPageLimit,3);
   assert.equal(service.missionRuntime.missions.get(created.missionId).microsoftCollectionLimitExtensions.length,1);
   assert.ok(service.missionRuntime.extendMicrosoftCollectionLimit(created.missionId,{...extension,maxPages:4}).error);
   if(mode==='extend-tampered')service.missionRuntime.missions.get(created.missionId).microsoftCollectionLimitExtensions[0].signature='forged';
   continue;
  }
  if(run.status==='COMPLETED'||run.stopReason!=='run-wave-limit-reached')break;
 }
 const proof=service.missionRuntime.getVerifiedMicrosoftCollectionResult(created.missionId);
 if(['complete','tight-complete','expired-scope','tampered-scope','extend'].includes(mode)){
  assert.equal(run.status,'COMPLETED',JSON.stringify({status:run.status,reason:run.stopReason,obs:run.observations,criteria:run.verificationSummary}));
  assert.equal(approvals,['complete','tight-complete'].includes(mode)?1:2);assert.equal(proof.success,true,JSON.stringify(proof));assert.equal(proof.allPages,true);assert.equal(proof.result.pages.length,3);assert.equal(proof.result.verification.observedItemCount,2);
  assert.equal(service.missionRuntime.store.db.prepare('SELECT count(*) AS n FROM microsoft_collection_task_receipts').get().n,3);
  assert.equal(graph,3);assert.equal(run.metrics.plannerAttempts,0);
 }else{
  assert.notEqual(run.status,'COMPLETED');assert.equal(proof.success,false);
  if(['limit','tight-limit'].includes(mode)){assert.equal(graph,1);assert.equal(run.stopReason,'microsoft-collection-page-limit');}
  if(['changed-sql','forged-past-G','owner-revoked','goal-limit-changed','extend-tampered','extend-stale','extend-revoked','extend-sql','extend-cancelled','extend-foreign-owner','extend-save-failed'].includes(mode))assert.equal(graph,1);
  if(['cycle','overlap'].includes(mode)){assert.equal(run.metrics.successfulActions,1);assert.equal(service.missionRuntime.store.db.prepare('SELECT count(*) AS n FROM personal_source_items').get().n,1);assert.equal(service.missionRuntime.store.db.prepare("SELECT body FROM personal_source_items WHERE provider_id='one'").get().body.includes('synthetic page 1'),true);}
 }
 t.diagnostic(JSON.stringify({provider,mode,status:run.status,reason:run.stopReason,graph,tokens,approvals,completedActions:run.metrics.successfulActions,realAccountVerified:false}));
});
test('whole-page goal never drops extra clauses or accepts altered limits, cursors or getters',()=>{
 const selection={provider:'outlook',connectionId:'synthetic'};
 for(const suffix of [' 그리고 발송해.',' 단, 저장하지 마.'])assert.throws(()=>captureMicrosoftCollection(objective+suffix,selection));
 for(const maxPages of [0,101,1.2,'20',null])assert.throws(()=>captureMicrosoftCollection(objective,{...selection,maxPages}));
 assert.throws(()=>captureMicrosoftCollection(objective,{...selection,cursor:'https://graph.microsoft.com/v1.0/me/messages'}));
 let reads=0;const getter={...selection};Object.defineProperty(getter,'maxPages',{enumerable:true,get(){reads++;return 20;}});
 assert.throws(()=>captureMicrosoftCollection(objective,getter));assert.equal(reads,0);
});
