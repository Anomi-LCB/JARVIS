import test from 'node:test';
import { PcAgentRuntime } from '../apps/pc-agent/src/pc-agent-runtime.js';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { PcOutboundMailbox } from '../packages/core/src/client/pc-outbound-mailbox.js';
import { createPcOutboundServer, createPcOutboundTransport } from '../packages/core/src/client/pc-outbound-https.js';
import { createPcOutboundObserver } from '../apps/pc-agent/src/outbound-observer.js';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { createPcAgentServer, PcAgentApiGuard } from '../apps/pc-agent/src/main.mjs';
import { PcAgentExecutionClient } from '../packages/core/src/client/pc-agent-execution-client.js';
import { listenOnFetchSafePort } from '../packages/shared/src/http.js';
import { createConfiguredPcOutboundObserver } from '../scripts/pc-outbound-channel.mjs';
import { CapabilityTokenService } from '../apps/policy-security/src/policy-runtime.js';
import { ActionType, TaskStatus } from '../packages/shared/src/types.js';

const pem = name => readFileSync(new URL(`./fixtures/google-broker-tls/${name}.pem`, import.meta.url));
const peer = new X509Certificate(pem('core')).fingerprint256;
const otherPeer = new X509Certificate(pem('other')).fingerprint256;

test('operation observation excludes dispatch tickets and uncertain receipts',async()=>{
  for(const state of ['succeeded','uncertain']){
    let observation;
    const action={toolName:'filesystem.createTextFile',arguments:{path:'test.txt',content:'test'}};
    const observer=createPcOutboundObserver({allowedTaskIds:['task-one'],pcClient:{health:async()=>({}),readOperation:async()=>({
      operationId:`mission_op_${'a'.repeat(32)}`,taskId:'task-one',fingerprint:'0'.repeat(64),state,receipt:{status:'COMPLETED'},ticket:'must-stay-local',authorizationHash:'must-stay-local'})},
      transport:{exchange:async(method,payload)=>{if(method==='submit'){observation=payload.result.value;return {accepted:true};}
        return {requestId:'read',generation:1,lease:'lease',expiresAt:Date.now()+10000,request:{operation:'operation-receipt',taskId:'task-one',operationId:`mission_op_${'a'.repeat(32)}`,action}};}}});
    await observer.tick();assert.equal(observation.ticket,undefined);assert.equal(observation.authorizationHash,undefined);
    assert.equal(observation.executionAuthority,false);assert.deepEqual(observation.receipt,state==='succeeded'?{status:'COMPLETED'}:null);
  }
});
function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-outbound-'));
  let store = new PcOutboundMailbox({ dbPath: join(root, 'mailbox.sqlite'), ...options });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  store.enroll({ deviceId: 'pc-one', certificateFingerprint: peer, expiresAt: (options.clock?.() ?? Date.now()) + 60000,
    allowedTaskIds: ['task-one','not-selected','selected-task'] });
  return { root, get store() { return store; }, restart() { store.close(); store = new PcOutboundMailbox({ dbPath: join(root, 'mailbox.sqlite'), ...options }); } };
}
const enqueue = (store, requestId = 'read-one', operation = 'health', taskId = null) => store.enqueue({ requestId, deviceId: 'pc-one', operation, taskId });
const response = packet => ({ requestId: packet.requestId, generation: packet.generation, lease: packet.lease,
  result: { status: 'observed', value: { status: 'healthy' } } });

test('restart, expired lease and stale observer are fenced without granting effect execution', t => {
  let time = Date.now(); const f = fixture(t, { clock: () => time, leaseMs: 100 });
  enqueue(f.store); const first = f.store.pull(peer); f.restart();
  assert.equal(f.store.pull(peer), null);
  time += 101; const second = f.store.pull(peer);
  assert.equal(second.generation, first.generation + 1);
  assert.throws(() => f.store.submit(peer, response(first)), /STALE_LEASE/u);
  assert.deepEqual(f.store.submit(peer, response(second)), { accepted: true, duplicate: false });
  assert.deepEqual(f.store.submit(peer, response(second)), { accepted: true, duplicate: true });
  assert.throws(() => f.store.submit(peer, { ...response(second), result: { status: 'unavailable' } }), /RESULT_CONFLICT/u);
  f.restart(); assert.equal(f.store.result('read-one').observation.value.status, 'healthy');
  assert.equal(f.store.result('read-one').verifiedCompletion, false);
  assert.equal(f.store.result('read-one').executionAuthority, false);
});

test('revocation and identity rotation persist and invalidate queued and leased observations', t => {
  const f = fixture(t); enqueue(f.store); const first = f.store.pull(peer);
  f.store.revoke('pc-one'); f.restart();
  assert.throws(() => f.store.pull(peer), /DEVICE_DENIED/u);
  assert.throws(() => f.store.submit(peer, response(first)), /DEVICE_DENIED/u);
  f.store.enroll({ deviceId: 'pc-one', certificateFingerprint: otherPeer, expiresAt: Date.now() + 60000 });
  assert.throws(() => f.store.pull(peer), /DEVICE_DENIED/u);
  assert.equal(f.store.pull(otherPeer), null);
  assert.throws(() => enqueue(f.store), /REQUEST_CONFLICT/u);
});

test('read contract excludes writes, arbitrary paths and duplicate request substitution', t => {
  const f = fixture(t); enqueue(f.store);
  for (const operation of ['execute','cancel','shell','https://example.test','/operations/execute']) {
    assert.throws(() => enqueue(f.store, 'forbidden', operation), /READ_CONTRACT_INVALID/u);
  }
  assert.throws(() => enqueue(f.store, 'bad-task', 'task-result', '../secret'), /READ_CONTRACT_INVALID/u);
  assert.throws(() => enqueue(f.store, 'read-one', 'task-result', 'task-one'), /REQUEST_CONFLICT/u);
  assert.equal(enqueue(f.store).state, 'queued');
});

test('clock rollback cannot extend a lease or resurrect expired device identity', t => {
  let time = Date.now(); const f = fixture(t, { clock: () => time, leaseMs: 100 });
  enqueue(f.store); const packet = f.store.pull(peer); time += 200; f.store.pull(peer); time -= 200;
  assert.throws(() => f.store.submit(peer, response(packet)), /STALE_LEASE/u);
  time += 70000; assert.throws(() => f.store.pull(peer), /DEVICE_DENIED/u);
  time -= 70000; assert.throws(() => f.store.pull(peer), /DEVICE_DENIED/u);
});

test('real TLS outbound connection observes actual PC API, rejects unlisted certificate and preserves revocation', async t => {
  const f = fixture(t);
  const runtime = createAgRuntime({ allowedRoots: [f.root], auditRoot: join(f.root, 'audit'),
    signingSecret: 'outbound-test-signing-secret-with-sufficient-entropy', workerDaemonEnabled: false });
  let comparisonLimiterTime=Date.now();
  const local = createPcAgentServer(runtime.pcAgent, { apiGuard: new PcAgentApiGuard({
    clock:()=>new Date(comparisonLimiterTime),apiToken: 'outbound-test-admin-token-123456', executionToken: 'outbound-test-execution-token-123456' }) });
  await listenOnFetchSafePort(local, { host: '127.0.0.1', port: 0 });
  const relay = createPcOutboundServer({ mailbox: f.store, key: pem('server-key'), cert: pem('server'), ca: pem('ca') });
  await listenOnFetchSafePort(relay, { host: '127.0.0.1', port: 0 });
  const url = `https://127.0.0.1:${relay.address().port}/v1/pc/observe`;
  const transport = createPcOutboundTransport({ url, key: pem('core-key'), cert: pem('core'), ca: pem('ca') });
  const other = createPcOutboundTransport({ url, key: pem('other-key'), cert: pem('other'), ca: pem('ca') });
  t.after(async () => {
    transport.close(); other.close();
    await Promise.all([new Promise(resolve => relay.close(resolve)), new Promise(resolve => { local.closeAllConnections(); local.close(resolve); })]);
  });
  const pcClient = new PcAgentExecutionClient({ baseUrl: `http://127.0.0.1:${local.address().port}`,
    executionToken: 'outbound-test-execution-token-123456' });
  const observer = createPcOutboundObserver({ transport, pcClient });
  enqueue(f.store); assert.equal((await observer.tick()).status, 'observed');
  const health = await pcClient.health();
  assert.deepEqual(f.store.result('read-one').observation.value, { status: health.status, module: health.module, version: health.version });
  await assert.rejects(other.exchange('pull', {}), /DEVICE_DENIED/u);
  enqueue(f.store, 'private-result', 'task-result', 'not-selected');
  await observer.tick(); assert.equal(f.store.result('private-result').observation.status, 'unavailable');
  const taskId = 'selected-task';
  const action = { actionType: ActionType.CREATE_FILE, toolName: 'filesystem.createTextFile',
    arguments: { path: join(f.root, 'selected.txt'), content: 'independently observed local file' } };
  const issuer = new CapabilityTokenService({ signingSecret: 'outbound-test-signing-secret-with-sufficient-entropy' });
  const capabilityToken = issuer.issue({ taskId, planId: 'selected-plan', approvalId: 'selected-approval', action, allowedPaths: [f.root] });
  const localReceipt = await pcClient.receiveExecutionPacket({ packetId: 'selected-packet', taskId, planId: 'selected-plan',
    action, capabilityToken, requestedMode: 'execute', userConfirmation: { approvalId: 'selected-approval', confirmed: true, confirmedAt: new Date().toISOString() } });
  assert.equal(localReceipt.status, TaskStatus.COMPLETED);
  assert.equal(readFileSync(action.arguments.path, 'utf8'), action.arguments.content);
  const selectedObserver = createPcOutboundObserver({ transport, pcClient, allowedTaskIds: [taskId] });
  enqueue(f.store, 'selected-read', 'task-result', taskId); await selectedObserver.tick();
  assert.deepEqual(f.store.result('selected-read').observation.value, await pcClient.taskResult(taskId));
  assert.equal(f.store.result('selected-read').verifiedCompletion, false);
  f.store.enqueue({requestId:'selected-catalog',deviceId:'pc-one',operation:'task-catalog',taskId:null,offset:2,limit:100});
  await selectedObserver.tick();
  const catalog=f.store.result('selected-catalog');
  assert.equal(catalog.deviceId,'pc-one');assert.equal(catalog.observationCurrent,true);
  assert.deepEqual(catalog.observation.value,{items:[{taskId,title:'파일 작성',status:TaskStatus.COMPLETED,available:true,dryRun:false}],offset:2,totalEntries:3,hasMore:false,executionAuthority:false,verifiedCompletion:false});
  assert.doesNotMatch(JSON.stringify(catalog.observation.value),/selected\.txt|independently observed|capabilityToken|approvalId/u);
  f.store.enqueue({requestId:'catalog-local-denied',deviceId:'pc-one',operation:'task-catalog',taskId:null,offset:0,limit:1});
  await selectedObserver.tick();assert.equal(f.store.result('catalog-local-denied').observation.value.items[0].available,false);
  const sampleIds=[taskId,...Array.from({length:99},(_,i)=>`unknown-${i}`)];
  const expected=sampleIds.map((id,i)=>i===0?{taskId:id,title:'파일 작성',status:TaskStatus.COMPLETED,available:true,dryRun:false}:{taskId:id,title:'아직 실행 기록 없음',status:'UNKNOWN',available:false,dryRun:null}),measurements=[];
  for(let trial=0;trial<5;trial++){
    comparisonLimiterTime+=60001; // Test limiter window only; actual HTTP duration uses monotonic performance.now().
    const start=performance.now(),individual=[];
    for(const id of sampleIds)individual.push(await pcClient.taskSummary(id));
    const individualMs=performance.now()-start,batchStart=performance.now(),batch=await pcClient.taskSummaries(sampleIds),batchMs=performance.now()-batchStart;
    assert.deepEqual(individual,expected);assert.deepEqual(batch.items,expected);
    assert.equal(batch.executionAuthority,false);assert.equal(batch.verifiedCompletion,false);
    measurements.push({individualMs,batchMs,individualCalls:100,batchCalls:1});
  }
  console.log('CATALOG_BATCH_COMPARISON='+JSON.stringify({itemsPerRun:100,repetitions:5,quality:'all metadata values identical',rateLimit:'unchanged default; isolated guard clock advances between trials',measurements}));
  const batchUrl=`http://127.0.0.1:${local.address().port}/tasks/summaries`;
  const call=body=>fetch(batchUrl,{method:'POST',headers:{authorization:'Bearer outbound-test-execution-token-123456','content-type':'application/json'},body:JSON.stringify(body)});
  for(const body of [{taskIds:[]},{taskIds:['duplicate','duplicate']},{taskIds:Array.from({length:101},(_,i)=>`task-${i}`)},
    {taskIds:['../private']},{taskIds:[taskId],path:'secret'},['invalid']])assert.equal((await call(body)).status,400);
  assert.equal((await fetch(batchUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({taskIds:[taskId]})})).status,401);
  f.store.revoke('pc-one'); await assert.rejects(observer.tick(), /DEVICE_DENIED/u);
  assert.doesNotMatch(JSON.stringify(f.store.result('read-one')), /outbound-test-execution-token/u);
});

test('batch observer sends only local selections, validates ordering, and never falls back after a broken batch',async()=>{
  const taskIds=['one','unlisted','two'];
  for(const corruption of ['none','reordered','missing','authority','network']){
    let calls=0,singleCalls=0,result;
    const observer=createPcOutboundObserver({allowedTaskIds:['one','two'],pcClient:{health:async()=>({}),taskSummary:async()=>{singleCalls++;},taskSummaries:async selected=>{
      calls++;assert.deepEqual(selected,['one','two']);if(corruption==='network')throw new Error('private network path');
      let items=selected.map(taskId=>({taskId,title:'파일 작성',status:'COMPLETED',available:true,dryRun:false,secret:'do not forward'}));
      if(corruption==='reordered')items.reverse();if(corruption==='missing')items.pop();
      return {items,executionAuthority:corruption==='authority',verifiedCompletion:false};
    }},transport:{exchange:async(method,input)=>{
      if(method==='submit'){result=input.result;return {accepted:true};}
      return {requestId:'batch',generation:1,lease:'lease',expiresAt:Date.now()+10000,request:{operation:'task-catalog',taskId:null,taskIds,offset:0,totalEntries:3}};
    }}});
    await observer.tick();assert.equal(calls,1);assert.equal(singleCalls,0);
    assert.equal(result.status,corruption==='none'?'observed':'unavailable');
    assert.doesNotMatch(JSON.stringify(result),/secret|do not forward|private network path/u);
    if(corruption==='none'){assert.equal(result.value.items[1].available,false);assert.deepEqual(result.value.items.map(i=>i.taskId),taskIds);}
  }
});

test('one reverse scan retains latest terminal status, dry run and original order',()=>{
  const fake={packetJournal:{records:[{recordType:'packet_result',taskId:'a',toolName:'filesystem.createTextFile',status:'COMPLETED',dryRun:false},
    {recordType:'packet_result',taskId:'b',toolName:'filesystem.listFiles',status:'COMPLETED',dryRun:true},
    {recordType:'packet_result',taskId:'a',toolName:'workflow.execute',status:'BLOCKED',dryRun:false},
    {recordType:'packet_attempt_result',taskId:'a',status:'COMPLETED',dryRun:false}]}};
  const output=PcAgentRuntime.prototype.taskSummaries.call(fake,['b','a','missing']);
  assert.deepEqual(output.items,[{taskId:'b',title:'파일 목록 조회',status:'COMPLETED',available:true,dryRun:true},
    {taskId:'a',title:'복합 업무',status:'BLOCKED',available:true,dryRun:false},
    {taskId:'missing',title:'아직 실행 기록 없음',status:'UNKNOWN',available:false,dryRun:null}]);
});

test('selected task catalog is bound to original scope and rejects forged entries and private fields',t=>{
  const f=fixture(t);
  for(const patch of [{offset:-1,limit:1},{offset:0,limit:101},{offset:0,limit:1.2},{offset:0,limit:1,taskId:'task-one'}])
    assert.throws(()=>f.store.enqueue({requestId:'bad-catalog',deviceId:'pc-one',operation:'task-catalog',taskId:null,...patch}),/READ_CONTRACT_INVALID/u);
  assert.throws(()=>f.store.enqueue({requestId:'bad-health',deviceId:'pc-one',operation:'health',taskId:null,offset:0,limit:1}),/READ_CONTRACT_INVALID/u);
  f.store.enqueue({requestId:'catalog',deviceId:'pc-one',operation:'task-catalog',taskId:null,offset:0,limit:1});
  const packet=f.store.pull(peer);
  assert.deepEqual(packet.request.taskIds,['task-one']);
  const item={taskId:'task-one',title:'파일 작성',status:'COMPLETED',available:true,dryRun:false};
  const value={items:[item],offset:0,totalEntries:3,hasMore:true,executionAuthority:false,verifiedCompletion:false};
  const submit=val=>f.store.submit(peer,{requestId:packet.requestId,generation:packet.generation,lease:packet.lease,result:{status:'observed',value:val}});
  for(const mutation of [{...value,items:[{...item,taskId:'other-pc-task'}]},{...value,items:[{...item,path:'secret'}]},
    {...value,items:[]},{...value,hasMore:false},{...value,totalEntries:10},{...value,executionAuthority:true},{...value,verifiedCompletion:true}])
    assert.throws(()=>submit(mutation),/RESULT_INVALID/u);
  assert.equal(submit(value).accepted,true);
  f.restart();assert.equal(f.store.result('catalog').observation.value.items[0].taskId,'task-one');
  f.store.revoke('pc-one');assert.equal(f.store.result('catalog').observationCurrent,false);
});

test('lost acknowledgement repeats the same observation rather than the PC read', async () => {
  let reads = 0, pulls = 0, submissions = 0; const accepted = [];
  const transport = { async exchange(operation, input) {
    if (operation === 'pull') return pulls++ ? null : { requestId: 'read-one', lease: 'lease', generation: 1,
      expiresAt: Date.now() + 10000, request: { operation: 'health', taskId: null } };
    accepted.push(input); if (submissions++ === 0) throw new Error('A_PC_OUTBOUND_NETWORK'); return { accepted: true };
  } };
  const observer = createPcOutboundObserver({ transport, pcClient: { async health() { reads++; return { healthy: true }; } } });
  await assert.rejects(observer.tick(), /NETWORK/u);
  assert.equal((await observer.tick()).status, 'idle'); assert.equal(reads, 1);
  assert.deepEqual(accepted[0], accepted[1]);
});

test('two authority-side readers share one SQLite lease and cannot both dispatch it', t => {
  const f = fixture(t); const second = new PcOutboundMailbox({ dbPath: join(f.root, 'mailbox.sqlite') });
  try {
    enqueue(f.store);
    const firstLease = f.store.pull(peer); assert.equal(second.pull(peer), null);
    assert.equal(second.submit(peer, response(firstLease)).accepted, true);
    assert.equal(f.store.result('read-one').state, 'observed');
  } finally { second.close(); }
});

test('product entrypoint rejects missing configuration and public test TLS identities', () => {
  assert.throws(() => createConfiguredPcOutboundObserver({ env: {} }), /CONFIG_INCOMPLETE/u);
  const path = name => new URL(`./fixtures/google-broker-tls/${name}.pem`, import.meta.url).pathname.replace(/^\/([A-Z]:)/u, '$1');
  assert.throws(() => createConfiguredPcOutboundObserver({ env: {
    JARVIS_PC_OUTBOUND_URL: 'https://127.0.0.1:4443/v1/pc/observe',
    JARVIS_PC_OUTBOUND_TLS_KEY: path('core-key'), JARVIS_PC_OUTBOUND_TLS_CERT: path('core'),
    JARVIS_PC_OUTBOUND_TLS_CA: path('ca'), JARVIS_PC_OUTBOUND_LOCAL_URL: 'http://127.0.0.1:17776',
    JARVIS_PC_OUTBOUND_TOKEN_FILE: 'not-read-test-token-file'
  } }), /TEST_CERT_DENIED/u);
});
