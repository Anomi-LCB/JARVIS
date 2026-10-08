import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { X509Certificate } from 'node:crypto';
import { createConfiguredCoreServiceRuntime } from '../scripts/core-service-runtime.mjs';
import { createCoreServer } from '../packages/core/src/main.mjs';
import { CoreAdminScope } from '../packages/core/src/security/core-admin-auth.js';
import { startPcOutboundNodeService, createConfiguredPcOutboundNodeService } from '../packages/core/src/client/pc-outbound-service.js';
import { createPcOutboundTransport } from '../packages/core/src/client/pc-outbound-https.js';
import { createPcOutboundObserver } from '../apps/pc-agent/src/outbound-observer.js';
import { PcAgentExecutionClient } from '../packages/core/src/client/pc-agent-execution-client.js';
import { createPcAgentServer, PcAgentApiGuard } from '../apps/pc-agent/src/main.mjs';
import { listenOnFetchSafePort } from '../packages/shared/src/http.js';
import { IntegrationCredentialVault } from '../packages/core/src/personal-operations/integration-security.js';
import {PcLocalTaskScope} from '../apps/pc-agent/src/pc-local-task-scope.js';

const pem = name => readFileSync(new URL(`./fixtures/google-broker-tls/${name}.pem`, import.meta.url));
const fingerprint = new X509Certificate(pem('core')).fingerprint256;
const expiry = () => new Date(Date.now() + 60000).toISOString().replace(/\.\d{3}Z$/u, 'Z');
const enroll = (expectedGeneration = 0, allowedTaskIds = []) => ({ deviceId: 'pc-one', certificateFingerprint: fingerprint,
  expiresAt: expiry(), allowedTaskIds, expectedGeneration });

test('Core administrator queues explicitly selected device observation through real mutual TLS',async t=>{
 const f=await fixture(t),runtime=await f.open();
 assert.equal((await f.api(runtime,'/pc-nodes','POST',enroll())).status,201);
 const request={requestId:'device-api',operation:'device-observation',taskId:null};
 assert.equal((await f.api(runtime,'/pc-nodes/pc-one/observations','POST',request,'')).status,401);
 assert.equal((await f.api(runtime,'/pc-nodes/pc-one/observations','POST',{...request,taskId:'foreign'})).status,409);
 assert.equal((await f.api(runtime,'/pc-nodes/pc-one/observations','POST',request)).status,202);
 const transport=createPcOutboundTransport({url:`https://127.0.0.1:${runtime.pcOutboundService.address.port}/v1/pc/observe`,key:pem('core-key'),cert:pem('core'),ca:pem('ca')});f.channels.push(transport);
 const {observePcDevice}=await import('../apps/pc-agent/src/device-observation.js');
 await createPcOutboundObserver({transport,pcClient:{health:async()=>({})},deviceReader:()=>observePcDevice({hostPlatform:'linux'})}).tick();
 const result=await (await f.api(runtime,'/pc-nodes/observations/device-api')).json();
 assert.equal(result.deviceId,'pc-one');assert.equal(result.observationCurrent,true);assert.equal(result.observation.value.hardware,null);
 assert.equal(result.observation.value.accountIdentityVerified,false);assert.equal(result.observation.value.executionAuthority,false);
 await f.api(runtime,'/pc-nodes/pc-one/revoke','POST',{expectedGeneration:1});
 assert.equal((await (await f.api(runtime,'/pc-nodes/observations/device-api')).json()).observationCurrent,false);
});

test('actual administrator readiness API binds the observed PC and never grants execution',async t=>{
  const f=await fixture(t,{commandEnabled:true}),runtime=await f.open();
  assert.equal((await f.api(runtime,'/pc-nodes','POST',{...enroll(0,['task']),allowedArtifactTaskIds:['task']})).status,201);
  assert.equal((await f.api(runtime,'/pc-nodes/pc-one/command-scope','POST',{expectedGeneration:1,expectedRevision:0,allowedTaskIds:['task'],expiresAt:expiry()})).status,200);
  const scope=new PcLocalTaskScope({dbPath:join(f.root,'pc-readiness.sqlite'),managedCatalog:true});f.channels.push(scope);
  scope.replaceCatalog({expectedRevision:0,allowedTaskIds:['task'],allowedArtifactTaskIds:['task'],allowedCommandTaskIds:['task']});scope.replace({expectedRevision:1,allowedTaskIds:['task'],expiresAt:Date.now()+60000});
  const request={requestId:'ready-api',operation:'task-readiness',taskId:'task'};
  assert.equal((await f.api(runtime,'/pc-nodes/pc-one/observations','POST',request,'')).status,401);
  assert.equal((await f.api(runtime,'/pc-nodes/pc-one/observations','POST',{...request,taskId:'foreign'})).status,409);
  assert.equal((await f.api(runtime,'/pc-nodes/pc-one/observations','POST',request)).status,202);
  const transport=createPcOutboundTransport({url:`https://127.0.0.1:${runtime.pcOutboundService.address.port}/v1/pc/observe`,key:pem('core-key'),cert:pem('core'),ca:pem('ca')});f.channels.push(transport);
  await createPcOutboundObserver({transport,taskCatalog:scope,pcClient:{health:async()=>({status:'ok'})}}).tick();
  const result=await (await f.api(runtime,'/pc-nodes/observations/ready-api')).json();assert.equal(result.configurationReadiness.status,'configuration-matched');
  assert.equal(result.deviceId,'pc-one');assert.equal(result.configurationReadiness.executionAuthority,false);assert.equal(result.verifiedCompletion,false);
  await f.api(runtime,'/pc-nodes/pc-one/revoke','POST',{expectedGeneration:1});assert.equal((await (await f.api(runtime,'/pc-nodes/observations/ready-api')).json()).configurationReadiness.status,'not-matched');
});

test('actual administrator API queues only selected catalog pages and retains explicit unavailable PC records',async t=>{
  const f=await fixture(t),runtime=await f.open();
  assert.equal((await f.api(runtime,'/pc-nodes','POST',enroll(0,['known-task']))).status,201);
  const local=createPcAgentServer(runtime.pcAgent,{apiGuard:new PcAgentApiGuard({apiToken:'catalog-api-admin-token',executionToken:'catalog-api-execution-token'})});
  await listenOnFetchSafePort(local,{host:'127.0.0.1',port:0});
  f.channels.push({close:async()=>{local.closeAllConnections();await new Promise(r=>local.close(r));}});
  const transport=createPcOutboundTransport({url:`https://127.0.0.1:${runtime.pcOutboundService.address.port}/v1/pc/observe`,key:pem('core-key'),cert:pem('core'),ca:pem('ca')});
  f.channels.push(transport);
  const client=new PcAgentExecutionClient({baseUrl:`http://127.0.0.1:${local.address().port}`,executionToken:'catalog-api-execution-token'});
  const request={requestId:'catalog-api',operation:'task-catalog',taskId:null,offset:0,limit:100};
  assert.equal((await f.api(runtime,'/pc-nodes/pc-one/observations','POST',{...request,taskIds:['foreign-task']})).status,409);
  assert.equal((await f.api(runtime,'/pc-nodes/pc-one/observations','POST',request,'')).status,401);
  assert.equal((await f.api(runtime,'/pc-nodes/pc-one/observations','POST',request)).status,202);
  await createPcOutboundObserver({transport,pcClient:client,allowedTaskIds:['known-task']}).tick();
  const result=await (await f.api(runtime,'/pc-nodes/observations/catalog-api')).json();
  assert.equal(result.deviceId,'pc-one');assert.equal(result.observationCurrent,true);
  assert.deepEqual(result.observation.value.items,[{taskId:'known-task',title:'아직 실행 기록 없음',status:'UNKNOWN',available:false,dryRun:null}]);
  assert.equal(result.verifiedCompletion,false);
  assert.equal((await fetch(`http://127.0.0.1:${local.address().port}/tasks/known-task/summary`)).status,401);
  await f.api(runtime,'/pc-nodes/pc-one/revoke','POST',{expectedGeneration:1});
  assert.equal((await (await f.api(runtime,'/pc-nodes/observations/catalog-api')).json()).observationCurrent,false);
});

async function fixture(t, {commandEnabled=false}={}) {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-core-outbound-')); const runtimes = [], channels = [];
  const env = { JARVIS_TEST_MODE: '1', JARVIS_CORE_ROOT: root, JARVIS_TEST_AUDIT_ROOT: join(root, 'audit'),
    JARVIS_CORE_PORT: '0', JARVIS_CORE_ALLOWED_ROOTS: 'workspace', JARVIS_CORE_WORKER_DAEMON_ENABLED: '0',
    JARVIS_CORE_WORKER_DAEMON_AUTOSTART: '0', JARVIS_PERSONAL_IMPORT_ENABLED: '0', JARVIS_GOOGLE_SYNC_ENABLED: '0',
    JARVIS_PERSONAL_OPERATIONS_DB: join(root, 'operations.sqlite'), JARVIS_CORE_MISSION_STORE_BACKEND: 'sqlite',
    JARVIS_CORE_MISSION_AUTHORITY_ENABLED: '1', JARVIS_CORE_MISSION_AUTHORITY_EXPECTED_TOKEN: '0',
    JARVIS_CORE_ADMIN_TOKEN: 'synthetic-core-outbound-admin', JARVIS_CORE_PC_OUTBOUND_ENABLED: '1' };
  const factory = ({ authorityGuard }) => startPcOutboundNodeService({ dbPath: join(root, 'observations.sqlite'),
    commandTransport:commandEnabled,commandExecutionFenceRequired:commandEnabled,authorityGuard, tls: { key: pem('server-key'), cert: pem('server'), ca: pem('ca') } });
  const open = async overrides => {
    const runtime = await createConfiguredCoreServiceRuntime({ env: { ...env, ...overrides }, pcOutboundServiceFactory: factory });
    runtimes.push(runtime); await listenOnFetchSafePort(runtime.server, { host: '127.0.0.1', port: 0 });
    return runtime;
  };
  t.after(async () => { for (const channel of channels) await channel.close(); for (const runtime of runtimes) await runtime.close(); rmSync(root, { recursive: true, force: true }); });
  const api = (runtime, path, method = 'GET', body, token = env.JARVIS_CORE_ADMIN_TOKEN) => fetch(`http://127.0.0.1:${runtime.server.address().port}${path}`, {
    method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { root, open, api, channels };
}

test('actual Core APIs enroll, authorize fixed read scope, observe real PC health, revoke and retain explicit historical evidence', async t => {
  const f = await fixture(t), runtime = await f.open();
  assert.equal((await f.api(runtime, '/pc-nodes', 'GET', undefined, null)).status, 401);
  assert.equal((await f.api(runtime, '/pc-nodes/certificate', 'POST', {certificatePem:pem('core').toString()})).status,200);
  assert.equal((await f.api(runtime, '/pc-nodes/certificate', 'POST', {certificatePem:pem('core-key').toString()})).status,409);
  assert.equal((await f.api(runtime, '/pc-nodes', 'POST', {...enroll(),label:'검증 PC'})).status, 201);
  assert.equal((await (await f.api(runtime,'/pc-nodes')).json()).devices[0].label,'검증 PC');
  assert.deepEqual((await (await f.api(runtime,'/pc-nodes/pc-one/scope')).json()).allowedTaskIds,[]);
  assert.equal((await (await f.api(runtime, '/pc-nodes')).json()).devices[0].status, 'waiting');
  assert.equal((await f.api(runtime, '/pc-nodes', 'POST', enroll())).status, 409);
  const request = { requestId: 'health-one', operation: 'health', taskId: null };
  assert.equal((await f.api(runtime, '/pc-nodes/pc-one/observations', 'POST', request)).status, 202);
  const forbidden = await f.api(runtime, '/pc-nodes/pc-one/observations', 'POST', { requestId: 'private-task', operation: 'task-result', taskId: 'unselected' });
  assert.equal(forbidden.status, 409); assert.equal((await forbidden.json()).error.code, 'A_PC_OUTBOUND_READ_SCOPE_DENIED');
  const local = createPcAgentServer(runtime.pcAgent, { apiGuard: new PcAgentApiGuard({ apiToken: 'synthetic-pc-admin-token', executionToken: 'synthetic-pc-execution-token' }) });
  await listenOnFetchSafePort(local, { host: '127.0.0.1', port: 0 });
  f.channels.push({ close: () => new Promise(resolve => { local.closeAllConnections(); local.close(resolve); }) });
  const transport = createPcOutboundTransport({ url: `https://127.0.0.1:${runtime.pcOutboundService.address.port}/v1/pc/observe`,
    key: pem('core-key'), cert: pem('core'), ca: pem('ca') });
  f.channels.push(transport);
  const pcClient = new PcAgentExecutionClient({ baseUrl: `http://127.0.0.1:${local.address().port}`, executionToken: 'synthetic-pc-execution-token' });
  const observer = createPcOutboundObserver({ transport, pcClient }); await observer.tick();
  assert.equal((await f.api(runtime, '/pc-nodes/pc-one/observations', 'POST', { ...request, requestId:'old-authority-read' })).status, 202);
  const oldPacket = await transport.exchange('pull', {});
  const observed = await (await f.api(runtime, '/pc-nodes/observations/health-one')).json();
  assert.equal(observed.observation.value.module, 'B_PC_AGENT'); assert.equal(observed.observationCurrent, true);
  assert.equal(observed.verifiedCompletion, false);
  assert.equal((await (await f.api(runtime, '/pc-nodes')).json()).devices[0].status, 'connected');
  assert.equal((await f.api(runtime, '/pc-nodes/pc-one/revoke', 'POST', { expectedGeneration: 2 })).status, 409);
  assert.equal((await f.api(runtime, '/pc-nodes/pc-one/revoke', 'POST', { expectedGeneration: 1 })).status, 200);
  await assert.rejects(observer.tick(), /DEVICE_DENIED/u);
  const historical = await (await f.api(runtime, '/pc-nodes/observations/health-one')).json();
  assert.equal(historical.observationCurrent, false); assert.deepEqual(historical.observation, observed.observation);
  assert.equal((await f.api(runtime, '/pc-nodes', 'POST', { ...enroll(1), privateKey: 'must-not-be-accepted' })).status, 409);
  const token = runtime.missionExecutionAuthority.lease.token; transport.close(); await runtime.close();
  const restarted = await f.open({ JARVIS_CORE_MISSION_AUTHORITY_EXPECTED_TOKEN: String(token) });
  assert.equal((await (await f.api(restarted, '/pc-nodes')).json()).devices[0].status, 'revoked');
  assert.deepEqual((await (await f.api(restarted, '/pc-nodes/observations/health-one')).json()).observation, observed.observation);
  assert.equal((await (await f.api(restarted, '/pc-nodes/observations/health-one')).json()).observationCurrent, false);
  assert.equal((await f.api(restarted, '/pc-nodes', 'POST', enroll(1))).status, 201);
  const nextTransport = createPcOutboundTransport({ url: `https://127.0.0.1:${restarted.pcOutboundService.address.port}/v1/pc/observe`,
    key:pem('core-key'),cert:pem('core'),ca:pem('ca') }); f.channels.push(nextTransport);
  await assert.rejects(nextTransport.exchange('submit', { requestId:oldPacket.requestId, generation:oldPacket.generation,
    lease:oldPacket.lease, result:{status:'observed',value:{status:'ok'}} }), /AUTHORITY_CHANGED/u);
});

test('diagnostic token cannot enroll, revoke, queue or read private observations; lost authority blocks administration and PC polling', async t => {
  const f = await fixture(t), runtime = await f.open();
  const admin = createCoreServer(runtime.coreFacade, { integrationVault: new IntegrationCredentialVault({ platform: 'isolated-test' }), pcOutboundNodes: runtime.pcOutboundService.controller,
    adminToken: 'synthetic-admin', adminTokens: [{ token: 'synthetic-reader', tokenId: 'reader', scopes: [CoreAdminScope.READ_DIAGNOSTICS] }] });
  await listenOnFetchSafePort(admin, { host: '127.0.0.1', port: 0 });
  f.channels.push({ close: () => new Promise(resolve => { admin.closeAllConnections(); admin.close(resolve); }) });
  const read = (path, method = 'GET', body) => fetch(`http://127.0.0.1:${admin.address().port}${path}`, { method,
    headers: { authorization: 'Bearer synthetic-reader', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.equal((await read('/pc-nodes')).status, 200);
  for (const [path, method, body] of [['/pc-nodes/task-labels','POST',{taskIds:['task']}],['/pc-nodes/task-options','GET'],['/pc-nodes/certificate','POST',{certificatePem:pem('core').toString()}],['/pc-nodes/pc-one/scope','GET'],['/pc-nodes/pc-one/command-scope','GET'],['/pc-nodes/pc-one/command-scope','POST',{}],['/pc-nodes','POST',enroll()],['/pc-nodes/pc-one/revoke','POST',{ expectedGeneration: 1 }],
    ['/pc-nodes/pc-one/observations','POST',{ requestId:'read',operation:'health',taskId:null }],['/pc-nodes/observations/private','GET']]) {
    assert.equal((await read(path, method, body)).status, 403);
  }
  assert.equal((await f.api(runtime, '/pc-nodes', 'POST', enroll())).status, 201);
  runtime.missionExecutionAuthority.release();
  assert.equal((await f.api(runtime, '/pc-nodes/pc-one/observations', 'POST', { requestId:'read',operation:'health',taskId:null })).status, 409);
  assert.equal((await (await f.api(runtime, '/pc-nodes')).json()).authorityActive, false);
  const transport = createPcOutboundTransport({ url: `https://127.0.0.1:${runtime.pcOutboundService.address.port}/v1/pc/observe`,
    key:pem('core-key'),cert:pem('core'),ca:pem('ca') }); f.channels.push(transport);
  await assert.rejects(transport.exchange('pull', {}));
});

test('selected task scope is persistent, default-deny, and prior observations expire by server recording time', async t => {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-outbound-freshness-')); let time = Date.now();
  const { PcOutboundMailbox } = await import('../packages/core/src/client/pc-outbound-mailbox.js');
  const store = new PcOutboundMailbox({ dbPath:join(root,'test.sqlite'),clock:()=>time,freshnessMs:100 });
  t.after(() => { store.close(); rmSync(root,{recursive:true,force:true}); });
  store.enroll({deviceId:'selected',certificateFingerprint:fingerprint,expiresAt:time+10000,expectedGeneration:0,allowedTaskIds:['allowed']});
  assert.throws(() => store.enqueue({deviceId:'selected',requestId:'denied',operation:'task-result',taskId:'other'}), /READ_SCOPE_DENIED/u);
  store.enqueue({deviceId:'selected',requestId:'selected-read',operation:'task-result',taskId:'allowed'});
  const packet = store.pull(fingerprint);
  store.submit(fingerprint,{requestId:packet.requestId,lease:packet.lease,generation:packet.generation,
    result:{status:'observed',observedAt:'2099-01-01T00:00:00Z',value:{status:'completed'}}});
  assert.equal(store.result('selected-read').observationCurrent,true);
  assert.equal(Date.parse(store.result('selected-read').observationCurrentUntil),time+100);
  time+=101; assert.equal(store.result('selected-read').observationCurrent,false);
  assert.equal(store.status().devices[0].status,'waiting');
  store.enroll({deviceId:'selected',certificateFingerprint:fingerprint,expiresAt:time+10000,expectedGeneration:1,allowedTaskIds:[]});
  assert.throws(() => store.enqueue({deviceId:'selected',requestId:'revoked-scope',operation:'task-result',taskId:'allowed'}), /READ_SCOPE_DENIED/u);
});

test('production node configuration is opt-in, requires authority, and rejects public test TLS identities', async () => {
  assert.equal(await createConfiguredPcOutboundNodeService({ env: {} }), null);
  for(const env of [{JARVIS_CORE_PC_OUTBOUND_COMMAND_ENABLED:'1'},{JARVIS_CORE_PC_OUTBOUND_ENABLED:'1',JARVIS_CORE_PC_OUTBOUND_COMMAND_ENABLED:'yes'}])await assert.rejects(createConfiguredPcOutboundNodeService({env}),/COMMAND_CONFIG_INVALID/u);
  await assert.rejects(createConfiguredPcOutboundNodeService({ env: { JARVIS_CORE_PC_OUTBOUND_ENABLED:'1' } }), /AUTHORITY_REQUIRED/u);
  const filename = name => new URL(`./fixtures/google-broker-tls/${name}.pem`, import.meta.url).pathname.replace(/^\/([A-Z]:)/u, '$1');
  await assert.rejects(createConfiguredPcOutboundNodeService({ authorityGuard: () => {}, env: {
    JARVIS_CORE_PC_OUTBOUND_ENABLED:'1',JARVIS_CORE_PC_OUTBOUND_DB:'unused-db',JARVIS_CORE_PC_OUTBOUND_PORT:'4443',
    JARVIS_CORE_PC_OUTBOUND_TLS_CERT:filename('server'),JARVIS_CORE_PC_OUTBOUND_TLS_CA:filename('ca'),JARVIS_CORE_PC_OUTBOUND_TLS_KEY:'not-read-private-key'
  } }), /TEST_CERT_DENIED/u);
});

test('actual administrator command scope is opt-in, CAS protected, bounded and invalidates waiting delivery',async t=>{
  const f=await fixture(t,{commandEnabled:true}),runtime=await f.open();
  const enrollInput={...enroll(0,['allowed','read-only']),allowedArtifactTaskIds:['allowed']};
  assert.equal((await f.api(runtime,'/pc-nodes','POST',enrollInput)).status,201);
  const path='/pc-nodes/pc-one/command-scope';
  assert.equal((await f.api(runtime,path,'GET',undefined,null)).status,401);
  const before=await (await f.api(runtime,path)).json();assert.equal(before.revision,0);assert.equal(before.status,'not_configured');
  const input={expectedGeneration:1,expectedRevision:0,allowedTaskIds:['allowed'],expiresAt:new Date(Date.now()+30000).toISOString().replace(/\.\d{3}Z$/u,'Z')};
  const spec=await (await f.api(runtime,'/openapi.json')).json();assert.deepEqual(spec.paths[path.replace('pc-one','{deviceId}')].post.requestBody.content['application/json'].schema.required,['expectedGeneration','expectedRevision','allowedTaskIds','expiresAt']);
  for(const changed of [{allowedTaskIds:['read-only']},{allowedTaskIds:['unselected']},{expectedGeneration:2},{expiresAt:new Date(Date.now()+120000).toISOString().replace(/\.\d{3}Z$/u,'Z')},{allowedTaskIds:['allowed','allowed']},{privateKey:'denied'},{expectedRevision:undefined}]){
    const response=await f.api(runtime,path,'POST',{...input,...changed});assert.equal(response.status,409);
  }
  const parallel=await Promise.all([f.api(runtime,path,'POST',input),f.api(runtime,path,'POST',input)]);
  assert.deepEqual(parallel.map(r=>r.status).sort(),[200,409]);
  const conflict=parallel.find(r=>r.status===409);assert.equal((await conflict.json()).error.code,'A_PC_COMMAND_SCOPE_REVISION_CONFLICT');
  const current=await (await f.api(runtime,path)).json();assert.equal(current.revision,1);assert.equal(current.deviceConnectedVerified,false);assert.equal(current.executionAuthority,false);
  const commands=runtime.pcOutboundService.commandMailbox;
  const action={toolName:'filesystem.createTextFile',arguments:{path:'result.txt',content:'selected'}};
  const packet={taskId:'allowed',idempotencyKey:`mission_op_${'a'.repeat(32)}`,action,capabilityToken:{capabilityToken:'synthetic-not-real-B-authority'}};
  commands.enqueue({requestId:'selected-command',deviceId:'pc-one',kind:'prepare',taskId:'allowed',operationId:packet.idempotencyKey,action,body:{packet}});
  assert.equal((await f.api(runtime,path,'POST',{...input,expectedRevision:1,allowedTaskIds:[]})).status,200);
  assert.equal(commands.status('selected-command').state,'invalidated');
  assert.equal((await (await f.api(runtime,path)).json()).revision,2);
  const token=runtime.missionExecutionAuthority.lease.token;await runtime.close();
  const restarted=await f.open({JARVIS_CORE_MISSION_AUTHORITY_EXPECTED_TOKEN:String(token)});
  const restored=await (await f.api(restarted,path)).json();assert.equal(restored.revision,2);assert.deepEqual(restored.allowedTaskIds,[]);
});

test('command scope administration is absent when command transport is disabled',async t=>{
  const f=await fixture(t),runtime=await f.open();
  assert.equal((await f.api(runtime,'/pc-nodes','POST',enroll())).status,201);
  const response=await f.api(runtime,'/pc-nodes/pc-one/command-scope');assert.equal(response.status,409);
  assert.equal((await response.json()).error.code,'A_PC_OUTBOUND_COMMAND_NOT_CONFIGURED');
});


test('actual admin task options discovers a Core-created task but never grants device scope',async t=>{
  const f=await fixture(t),runtime=await f.open();
  const createdResponse=await f.api(runtime,'/tasks','POST',{rawText:'workspace/option.txt 파일을 만들어줘'});
  assert.equal(createdResponse.status,201);const created=await createdResponse.json();
  const response=await f.api(runtime,'/pc-nodes/task-options?limit=1');assert.equal(response.status,200);
  const first=await response.json();assert.equal(first.items.length,1);assert.equal(first.items[0].taskId,created.taskId);
  assert.equal(first.items[0].title,created.title);assert.equal(first.items[0].status,created.status);
  assert.equal(first.executionAuthority,false);assert.equal(first.verifiedCompletion,false);assert.equal(first.deviceAvailabilityVerified,false);
  assert.deepEqual(Object.keys(first.items[0]),['taskId','title','status']);assert.equal(runtime.pcOutboundService.controller.status().devices.length,0);
  const labelsResponse=await f.api(runtime,'/pc-nodes/task-labels','POST',{taskIds:[created.taskId,'unknown-task']});assert.equal(labelsResponse.status,200);
  const labels=await labelsResponse.json();assert.deepEqual(labels.items,[{taskId:created.taskId,title:created.title,found:true},{taskId:'unknown-task',title:null,found:false}]);
  assert.equal(labels.executionAuthority,false);assert.equal(labels.verifiedCompletion,false);
  assert.equal((await f.api(runtime,'/pc-nodes/task-labels','POST',{taskIds:[created.taskId]},null)).status,401);
  assert.equal((await f.api(runtime,'/pc-nodes/task-labels','POST',{taskIds:[created.taskId],extra:true})).status,409);
  assert.equal((await f.api(runtime,'/pc-nodes/task-options','GET',undefined,null)).status,401);
  assert.equal((await f.api(runtime,'/pc-nodes/task-options?limit=101')).status,409);
  assert.equal((await f.api(runtime,'/pc-nodes/task-options?limit=1&limit=2')).status,409);
  const second=await f.api(runtime,'/tasks','POST',{rawText:'workspace/second.txt 파일을 만들어줘'});assert.equal(second.status,201);
  assert.equal((await f.api(runtime,`/pc-nodes/task-options?offset=1&limit=1&snapshot=${first.snapshot}`)).status,409);
  runtime.missionExecutionAuthority.release();assert.equal((await f.api(runtime,'/pc-nodes/task-options')).status,409);
  assert.equal((await f.api(runtime,'/pc-nodes/task-labels','POST',{taskIds:[created.taskId]})).status,409);
});


test('actual executed Mission task options remain historical after SQLite Core restart',async t=>{
  const f=await fixture(t),runtime=await f.open();
  runtime.missionRuntime.planner={async planNextWave(){return {decision:'continue',summary:'독립 조회',actions:[{id:'catalog_read',title:'재시작 후 선택할 자료 목록',command:'작업 폴더 파일 목록 보여줘',expectedToolName:'filesystem.listFiles',dependencies:[],successSignal:'파일 목록 반환'}]};}};
  const mission=runtime.missionRuntime.createMission({objective:'작업 폴더 파일 목록을 확인해',successCriteria:['파일 목록 확인'],authorization:{grants:['read_only']}});
  const run=await runtime.missionRuntime.runMission(mission.missionId,{maxWaves:1});
  const action=run.waves?.[0]?.actions?.[0];assert.ok(action?.taskId,JSON.stringify(run));assert.equal(action.status,'succeeded',JSON.stringify(run));
  const beforeResponse=await f.api(runtime,'/pc-nodes/task-options');const before=await beforeResponse.json();assert.equal(beforeResponse.status,200,JSON.stringify(before));
  const item=before.items.find(item=>item.taskId===action.taskId);assert.equal(item.title,'재시작 후 선택할 자료 목록');assert.equal(item.recordSource,'current-core-mission');
  const token=runtime.missionExecutionAuthority.lease.token;await runtime.close();
  const restarted=await f.open({JARVIS_CORE_MISSION_AUTHORITY_EXPECTED_TOKEN:String(token)});
  assert.equal(restarted.coreFacade.getTask(action.taskId),undefined);
  const after=await (await f.api(restarted,'/pc-nodes/task-options')).json();
  const saved=after.items.find(item=>item.taskId===action.taskId);assert.ok(saved);assert.equal(saved.missionId,mission.missionId);assert.equal(saved.title,item.title);
  assert.equal(saved.status,'HISTORICAL');assert.equal(saved.recordSource,'saved-mission');assert.equal(after.executionAuthority,false);assert.equal(after.verifiedCompletion,false);
  assert.equal(restarted.pcOutboundService.controller.status().devices.length,0);
  assert.equal((await f.api(restarted,`/pc-nodes/task-options?offset=1&snapshot=${before.snapshot}`)).status,409);
});

test('actual administrator API exposes persisted reserved Mission stages without creating or authorizing tasks',async t=>{
 const f=await fixture(t),runtime=await f.open();
 const mission=runtime.missionRuntime.createMission({objective:'자료를 연구하고 보고서를 저장해',authorization:{grants:['read_only']}});
 const wave=runtime.missionRuntime.createWave(runtime.missionRuntime.missions.get(mission.missionId),{actions:[{id:'future_report',title:'실행 전에 준비할 보고서 업무',command:'result.txt 파일을 만들어줘',expectedToolName:'filesystem.createTextFile',arguments:{path:'result.txt',content:'private planned data'},dependencies:[],successSignal:'결과 재조회'}]});
 runtime.missionRuntime.persist('isolated-reservation-api');const id=wave.actions[0].reservedTaskId;
 const before=await (await f.api(runtime,'/pc-nodes/task-options')).json();
 assert.equal(before.items[0].taskId,id);assert.equal(before.items[0].status,'RESERVED');assert.equal(before.items[0].recordSource,'planned-mission');
 assert.equal(runtime.coreFacade.tasks.size,0);assert.equal(runtime.pcOutboundService.controller.status().devices.length,0);
 const labels=await (await f.api(runtime,'/pc-nodes/task-labels','POST',{taskIds:[id]})).json();assert.equal(labels.items[0].title,'실행 전에 준비할 보고서 업무');assert.equal(labels.executionAuthority,false);
 assert.doesNotMatch(JSON.stringify(before)+JSON.stringify(labels),/private planned data|arguments|capabilityToken/u);
 const token=runtime.missionExecutionAuthority.lease.token;await runtime.close();const reopened=await f.open({JARVIS_CORE_MISSION_AUTHORITY_EXPECTED_TOKEN:String(token)});
 const after=await (await f.api(reopened,'/pc-nodes/task-options')).json();assert.deepEqual(after.items,before.items);assert.equal(after.snapshot,before.snapshot);assert.equal(reopened.coreFacade.tasks.size,0);
});
