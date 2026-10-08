import assert from 'node:assert/strict';import {join,resolve} from 'node:path';import {readFileSync,writeFileSync} from 'node:fs';import {pathToFileURL} from 'node:url';
const [root,phase,provider,packageRoot]=process.argv.slice(2),moduleRoot=packageRoot?resolve(packageRoot,'pc-agent-runtime'):process.cwd();
const {createConfiguredCoreServiceRuntime}=await import(pathToFileURL(resolve(moduleRoot,'scripts/core-service-runtime.mjs')));
const {IntegrationConnectorRegistry}=await import(pathToFileURL(resolve(moduleRoot,'packages/core/src/personal-operations/integration-security.js')));
const {microsoftSourceContracts}=await import(pathToFileURL(resolve(moduleRoot,'packages/core/src/personal-operations/microsoft-source-reader.js')));
const contract=microsoftSourceContracts[provider];assert.ok(root&&contract&&['create','recover'].includes(phase));let calls=0;
const record={connectionId:'synthetic-abandon',connectorId:contract.connectorId,authMethod:'oauth2',status:'credentials-stored-unverified',scopes:[contract.scope]};
const vault={save(){throw Error('FIXTURE_SECRET_WRITE_FORBIDDEN');},list:()=>[record],credentialRevision:()=> 'synthetic-revision',withCredentials:async(id,run)=>run({tenantId:provider==='outlook'?'common':'organizations',clientId:'synthetic',clientSecret:'synthetic',refreshToken:'synthetic'},record)};
const service=await createConfiguredCoreServiceRuntime({env:{JARVIS_TEST_MODE:'0',JARVIS_CORE_ROOT:root,JARVIS_CORE_AUDIT_ROOT:join(root,'audit'),JARVIS_CORE_PORT:'0',JARVIS_CORE_ALLOWED_ROOTS:'workspace',JARVIS_CORE_WORKER_DAEMON_ENABLED:'0',JARVIS_CORE_WORKER_DAEMON_AUTOSTART:'0',JARVIS_CORE_REMOTE_PC_EXECUTION_ENABLED:'0',JARVIS_PERSONAL_IMPORT_ENABLED:'0',JARVIS_GOOGLE_SYNC_ENABLED:'0',JARVIS_PERSONAL_OPERATIONS_DB:join(root,'ops.sqlite'),JARVIS_CORE_MISSION_STORE_BACKEND:'sqlite',JARVIS_CORE_MISSION_AUTHORITY_ENABLED:'1',JARVIS_CORE_MISSION_AUTHORITY_EXPECTED_TOKEN:phase==='create'?'0':'1',JARVIS_CORE_MISSION_AUTHORITY_RECOVERY_ONLY:phase==='recover'?'1':'0',JARVIS_CORE_MISSION_AUTHORITY_TTL_MS:'30000',JARVIS_CORE_ADMIN_TOKEN:'synthetic-admin',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'},integrationVault:vault,integrationRegistry:new IntegrationConnectorRegistry(),modelProviderFetch:async url=>{calls++;if(phase==='recover')throw Error('RECOVERY_PROVIDER_FORBIDDEN');if(String(url).includes('login.microsoftonline.com'))return Response.json({access_token:'synthetic.token',expires_in:3600,scope:contract.scope});throw Error('synthetic response lost before commit');}});
let closed=false;try{
 await new Promise(r=>service.server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${service.server.address().port}/personal-inbox/microsoft/abandon-uncommitted`,headers={authorization:'Bearer synthetic-admin','content-type':'application/json'};
 if(phase==='create'){
  const binding={capabilityId:'source.collectMicrosoftMetadata',providerId:'microsoft-graph',accountRef:record.connectionId,deviceRef:null,scopes:[contract.scope]};
  service.capabilityPackageRegistry.recordAvailability({...binding,codeVersion:service.capabilityPackageRegistry.availabilityFor(binding).codeVersion,permissionRevision:'synthetic-revision',observedAt:new Date().toISOString(),accountStatus:'connected',observedAccountRef:record.connectionId,deviceStatus:'not-required',grantedScopes:binding.scopes,verificationLevel:'live-probe',evidenceRef:'synthetic-not-real-probe'});
  const owner=service.personalOwnerSession.activate({durationMinutes:5,requestedBy:'synthetic'}),created=service.missionRuntime.createMission({objective:'선택한 Microsoft 연결의 메타데이터를 한 페이지 수집해.',microsoftCollection:{provider,connectionId:record.connectionId,...(provider==='teams-chat'?{chatId:'synthetic-chat'}:{})},authorization:{mode:'trusted_session',ownerSessionId:owner.session.sessionId,grants:['read_only']},metadata:{longTermMemory:false}});
  let result=await service.missionRuntime.runMission(created.missionId);assert.equal(result.status,'WAITING_APPROVAL');service.missionRuntime.decideGate(created.missionId,result.pendingGates[0].gateId,{decision:'approve',decidedBy:'synthetic'});result=await service.missionRuntime.runMission(created.missionId);assert.notEqual(result.status,'COMPLETED');
  const row=service.missionRuntime.store.db.prepare('SELECT * FROM microsoft_collection_effects').get();assert.equal(row.state,'uncertain');assert.equal(row.receipt,null);
  assert.equal((await fetch(url,{method:'POST',headers,body:JSON.stringify({operationId:row.operation_id})})).status,409);
  writeFileSync(join(root,'pending.json'),JSON.stringify({operationId:row.operation_id,missionId:created.missionId}),{flag:'wx'});
  try{await service.close();}catch(error){assert.match(error.message,/EFFECT_RECONCILIATION_REQUIRED/);}closed=true;
  console.log(JSON.stringify({pid:process.pid,phase,calls,status:result.status}));
 }else{
  const saved=JSON.parse(readFileSync(join(root,'pending.json'),'utf8'));
  assert.equal((await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(saved)})).status,401);
  assert.equal((await fetch(url,{method:'POST',headers,body:JSON.stringify(saved)})).status,400);
  const response=await fetch(url,{method:'POST',headers,body:JSON.stringify({operationId:saved.operationId})});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');const result=await response.json();assert.equal(result.status,'not-committed');assert.equal(result.completed,false);assert.equal(result.replayed,false);
  const replay=await (await fetch(url,{method:'POST',headers,body:JSON.stringify({operationId:saved.operationId})})).json();assert.equal(replay.replayed,true);
  assert.notEqual(service.missionRuntime.missions.get(saved.missionId).status,'COMPLETED');assert.equal(service.missionRuntime.store.db.prepare('SELECT COUNT(*) AS n FROM personal_source_items').get().n,0);assert.equal(calls,0);
  console.log(JSON.stringify({pid:process.pid,phase,calls,status:result.status,completed:false,replayed:true}));
 }
}finally{if(!closed)await service.close();}
