import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createConfiguredCoreServiceRuntime} from '../../scripts/core-service-runtime.mjs';
import {IntegrationConnectorRegistry} from '../../packages/core/src/personal-operations/integration-security.js';
import {microsoftSourceContracts} from '../../packages/core/src/personal-operations/microsoft-source-reader.js';
import {createCoreServer} from '../../packages/core/src/main.mjs';
const [root,phase,provider,mode='ready']=process.argv.slice(2),contract=microsoftSourceContracts[provider];
const pagesMode=['pages','pages-extended','pages-extension-tampered'].includes(mode),extendMode=mode.startsWith('pages-ext');
assert.ok(root&&['create','recover'].includes(phase)&&contract);
const record={connectionId:'synthetic-restart',connectorId:contract.connectorId,status:'credentials-stored-unverified',authMethod:'oauth2',scopes:[contract.scope]},credentials={tenantId:provider==='outlook'?'common':'organizations',clientId:'synthetic-id',clientSecret:'synthetic-secret',refreshToken:'synthetic-refresh'};
let calls=0,graphPages=0;
const vault={list:()=>[{...record,scopes:[...record.scopes]}],credentialRevision:()=>createHash('sha256').update(JSON.stringify([record,credentials])).digest('hex'),withCredentials:async(id,run)=>run({...credentials},{...record}),save(){throw Error('FIXTURE_SECRET_WRITE_FORBIDDEN');}};
const service=await createConfiguredCoreServiceRuntime({env:{JARVIS_TEST_MODE:'0',JARVIS_CORE_ROOT:root,JARVIS_CORE_AUDIT_ROOT:join(root,'audit'),JARVIS_CORE_PORT:'0',JARVIS_CORE_ALLOWED_ROOTS:'workspace',JARVIS_CORE_WORKER_DAEMON_ENABLED:'0',JARVIS_CORE_WORKER_DAEMON_AUTOSTART:'0',JARVIS_PERSONAL_IMPORT_ENABLED:'0',JARVIS_GOOGLE_SYNC_ENABLED:'0',JARVIS_PERSONAL_OPERATIONS_DB:join(root,'ops.sqlite'),JARVIS_CORE_MISSION_STORE_BACKEND:'sqlite',JARVIS_CORE_MISSION_AUTHORITY_ENABLED:'1',JARVIS_CORE_MISSION_AUTHORITY_EXPECTED_TOKEN:phase==='create'?'0':'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'},integrationVault:vault,integrationRegistry:new IntegrationConnectorRegistry(),
 modelProviderFetch:async url=>{calls++;if(phase!=='create')throw Error('RECOVERY_PROVIDER_CALL_FORBIDDEN');if(String(url).includes('login.microsoftonline.com'))return Response.json({access_token:'synthetic.token',expires_in:3600,scope:contract.scope});
  graphPages++;const cursor=provider==='outlook'?`https://graph.microsoft.com/v1.0/me/messages?$select=id,subject,receivedDateTime&$skip=${graphPages}`:`https://graph.microsoft.com/v1.0/chats/19:synthetic@thread.v2/messages?$skiptoken=${graphPages}`;
  return Response.json({value:[{id:pagesMode?'page-'+graphPages:'one',subject:'합성 수집 메타데이터'}],...(pagesMode&&graphPages<3?{'@odata.nextLink':cursor}:{})});}});
let server;
try{
 const selection={provider,connectionId:record.connectionId,...(provider==='teams-chat'?{chatId:'19:synthetic@thread.v2'}:{})},binding={capabilityId:'source.collectMicrosoftMetadata',providerId:'microsoft-graph',accountRef:record.connectionId,deviceRef:null,scopes:[contract.scope]};
 service.capabilityPackageRegistry.recordAvailability({...binding,codeVersion:service.capabilityPackageRegistry.availabilityFor(binding).codeVersion,permissionRevision:vault.credentialRevision(),observedAt:new Date().toISOString(),accountStatus:mode==='no-current-connection'&&phase==='recover'?'missing':'connected',observedAccountRef:record.connectionId,deviceStatus:'not-required',grantedScopes:binding.scopes,verificationLevel:'live-probe',evidenceRef:'synthetic-fixture-not-real-probe'});
 if(phase==='create'){
  const owner=service.personalOwnerSession.activate({durationMinutes:5,requestedBy:'synthetic'}),created=service.missionRuntime.createMission({objective:pagesMode?'선택한 Microsoft 연결의 메타데이터를 전체 페이지 수집해.':'선택한 Microsoft 연결의 메타데이터를 한 페이지 수집해.',microsoftCollection:{...selection,...(extendMode?{maxPages:1}:{})},authorization:{mode:'trusted_session',ownerSessionId:owner.session.sessionId,grants:['read_only','high_impact']},metadata:{longTermMemory:false}});
  assert.ok(created.missionId,JSON.stringify(created));let run=await service.missionRuntime.runMission(created.missionId);
  let extended=false;
  for(let step=0;step<8;step++){
   if(run.status==='WAITING_APPROVAL'){assert.equal(service.missionRuntime.decideGate(created.missionId,run.pendingGates[0].gateId,{decision:'approve',decidedBy:'synthetic-test-owner'}).success,true);run=await service.missionRuntime.runMission(created.missionId);continue;}
   if(extendMode&&!extended&&run.stopReason==='microsoft-collection-page-limit'){
    const amendment=service.missionRuntime.extendMicrosoftCollectionLimit(created.missionId,{ownerSessionId:owner.session.sessionId,extensionId:'ms_limit_restart',expectedMaxPages:1,maxPages:3});
    assert.equal(amendment.microsoftCollectionPageLimit,3,JSON.stringify(amendment));extended=true;run=await service.missionRuntime.runMission(created.missionId);continue;
   }
   break;
  }
  assert.equal(run.status,'COMPLETED',JSON.stringify({status:run.status,reason:run.stopReason}));
  assert.equal(service.missionRuntime.getVerifiedMicrosoftCollectionResult(created.missionId).success,true);
  const taskCount=service.missionRuntime.store.db.prepare('SELECT count(*) AS n FROM microsoft_collection_task_receipts').get().n;assert.equal(taskCount,pagesMode?3:1);
  const body=service.missionRuntime.store.db.prepare('SELECT body FROM microsoft_collection_task_receipts').get().body;assert.doesNotMatch(body,/합성 수집 메타데이터|synthetic-secret|synthetic-refresh/);
  writeFileSync(join(root,'selection.json'),JSON.stringify({missionId:created.missionId,ownerSessionId:owner.session.sessionId}),{flag:'wx'});
  process.stdout.write(JSON.stringify({pid:process.pid,phase,calls,archiveRows:taskCount,status:run.status}));
 }else{
  const saved=JSON.parse(readFileSync(join(root,'selection.json'),'utf8')),mission=service.missionRuntime.missions.get(saved.missionId),action=mission.waves[0].actions[0];
  assert.equal(service.coreFacade.getTask(action.taskId)==null,true);
  assert.equal(service.missionRuntime.getVerifiedMicrosoftCollectionResult(saved.missionId).success,false,'old session must not disclose recovered content');
  const owner=service.personalOwnerSession.activate({durationMinutes:5,requestedBy:'synthetic'});
  if(mode==='revoked')record.status='revoked';
  if(mode==='changed-sql')service.missionRuntime.store.db.prepare('DELETE FROM personal_source_items').run();
  if(mode==='tampered-task')service.missionRuntime.store.db.prepare("UPDATE microsoft_collection_task_receipts SET signature='tampered'").run();
  if(mode==='missing-task')service.missionRuntime.store.db.prepare('DELETE FROM microsoft_collection_task_receipts').run();
  if(mode==='tampered-effect')service.missionRuntime.store.db.prepare("UPDATE microsoft_collection_effects SET signature='tampered'").run();
  if(mode==='goal-changed')mission.objective+=' 그리고 발송해.';
  if(mode==='auth-changed')mission.authorizationRevision++;
  if(mode==='verification-changed')mission.observations.find(o=>o.observationId===action.observationId).verification.verificationId='foreign';
  if(mode==='duplicate-task')mission.waves[0].actions.push({...action,actionId:'foreign'});
  if(mode==='owner-revoked')service.personalOwnerSession.revoke({reason:'synthetic'});
  if(mode==='pages-extension-tampered')mission.microsoftCollectionLimitExtensions[0].signature='tampered';
  const auth={ownerSessionId:mode==='old-owner'?saved.ownerSessionId:owner.session.sessionId};
  const result=service.missionRuntime.getVerifiedMicrosoftCollectionResult(saved.missionId,auth);assert.equal(result.success,['ready','pages','pages-extended'].includes(mode),JSON.stringify({mode,result}));
  if(!['ready','pages','pages-extended'].includes(mode))assert.equal(Object.hasOwn(result,'result'),false);
  server=createCoreServer(service.coreFacade,{adminToken:'synthetic-admin',missionRuntime:service.missionRuntime,ownerSessionManager:service.personalOwnerSession});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const url=`http://127.0.0.1:${server.address().port}/missions/${encodeURIComponent(saved.missionId)}/verified-microsoft-collection`;
  assert.equal((await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(auth)})).status,401);
  const headers={authorization:'Bearer synthetic-admin','content-type':'application/json'};
  assert.equal((await fetch(url,{method:'POST',headers,body:JSON.stringify({...auth,grant:'all'})})).status,400);
  const response=await fetch(url,{method:'POST',headers,body:JSON.stringify(auth)});assert.equal(response.headers.get('cache-control'),'no-store');const http=await response.json();assert.equal(http.success,['ready','pages','pages-extended'].includes(mode));
  if(!['ready','pages','pages-extended'].includes(mode))assert.equal(Object.hasOwn(http,'result'),false);
  assert.equal(calls,0,'recovered read must not contact token or Graph provider');
  process.stdout.write(JSON.stringify({pid:process.pid,phase,mode,calls,recoveredTaskNotInCore:true,status:result.status,httpStatus:response.status}));
 }
}finally{if(server)await new Promise(r=>server.close(r));await service.close();}
