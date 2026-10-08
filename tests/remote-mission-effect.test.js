import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync,writeFileSync,mkdirSync,chownSync,chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import test from 'node:test';
import { CapabilityTokenService } from '../apps/policy-security/src/policy-runtime.js';
import { PcAgentExecutionClient } from '../packages/core/src/client/pc-agent-execution-client.js';
import { ActionType } from '../packages/shared/src/types.js';
import { RemoteOperationStore } from '../apps/pc-agent/src/remote-operation-store.js';
import { missionProgressMessage } from '../src/ui/mission-view-state.js';
import { actionArgumentsBinding } from '../packages/shared/src/action-arguments-binding.js';

const executionToken = 'synthetic-remote-operation-http-execution-token';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-remote-effect-')), children = new Set();
  t.after(async () => { for (const child of children) if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGKILL'); await done; }
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep) && root.includes('jarvis-remote-effect-')); rmSync(root, { recursive: true, force: true }); });
  return { root, children, calls: () => existsSync(join(root, 'remote-adapter.jsonl')) ? readFileSync(join(root, 'remote-adapter.jsonl'), 'utf8').trim().split('\n').length : 0 };
}
async function launch(f, role, mode = 'normal', endpoint = '0') {
  const child = fork(new URL('./fixtures/remote-mission-effect-child.mjs', import.meta.url), [role, f.root, mode, endpoint,f.rootScopeSha256??''], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    ...(f.osBoundary?{uid:role==='b'?2002:1000,gid:role==='b'?2002:1000}:{}) });
  f.children.add(child); let stderr = ''; child.stderr.on('data', data => { stderr += data; });
  const queue = [], waiters = [];
  child.on('message', item => {
    if(item.type==='pc-observer-config'){f.pcObserver.send({...item,type:'observe-artifact'});return;}
    waiters.length ? waiters.shift()(item) : queue.push(item);
  });
  async function next() { const item = queue.length ? queue.shift() : await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error(`child timeout ${stderr}`)), 15000); waiters.push(value => { clearTimeout(timer); done(value); }); });
    if (item.type === 'error') throw new Error(`${item.message}\n${item.stack}`); return item; }
  const ready = await next(); assert.equal(ready.type, 'ready');
  if(role==='b'){f.pcObserver=child;f.rootScopeSha256=ready.rootScopeSha256;}
  return { ...ready, child, next, async run() { child.send('run'); return next(); }, async resume() { child.send('continue'); return next(); },
    async kill() { const done = once(child, 'exit'); child.kill('SIGKILL'); await done; f.children.delete(child); } };
}
const details = response => JSON.stringify({ status: response.result?.status, stopReason: response.result?.stopReason,
  error: response.result?.observations?.map(item => item.error), recovery: response.result?.waves[0]?.actions[0]?.recovery, effect: response.effect?.state,artifactDiagnostics:response.artifactDiagnostics });

for(const wrong of [false,true])test(`actual outbound command channel original Mission; wrong=${wrong}`,async t=>{
  const f=fixture(t),b=await launch(f,'b');
  const core=await launch(f,'core',`artifact-pc-observer-command-channel${wrong?'-wrong-equals':''}`,b.url),done=await core.run();
  assert.equal(f.calls(),1,details(done));assert.equal(done.effect.state,'succeeded',details(done));
  assert.equal(done.effect.intent.request.executorBinding.kind,'pc-outbound-command');
  assert.equal(done.pendingFollowups,0);assert.equal(done.growthCount,1);assert.equal(done.workCount,1);
  assert.equal(done.artifactDiagnostics.length,0,'No Core artifact reader');
  assert.equal(done.result.status,wrong?'BLOCKED':'COMPLETED',details(done));
  assert.equal(done.verificationScope,'same-process-remote-filesystem.createTextFile');
  if(!wrong)assert.equal(done.result.verificationSummary.criteria[0].checks[0].checkId,'current_remote_typed_criterion');
});

test('actual Mission requires PC in-process final mutation validation',async t=>{
  const f=fixture(t),b=await launch(f,'b');
  const done=await (await launch(f,'core','artifact-pc-observer-command-channel-mutation-fenced',b.url)).run();
  assert.equal(done.result.status,'COMPLETED',details(done));assert.equal(f.calls(),1);assert.equal(done.effect.state,'succeeded');
  assert.equal(done.effect.intent.request.executorBinding.kind,'pc-outbound-command');
  assert.equal(done.effect.intent.request.executorBinding.mutationFenceRequired,true);
  assert.equal(done.result.verificationSummary.criteria[0].checks[0].checkId,'current_remote_typed_criterion');
  assert.equal(done.growthCount,1);assert.equal(done.workCount,1);assert.equal(done.pendingFollowups,0);
});

test('actual Core SQL authority admits only final-fenced outbound Mission',async t=>{
  const f=fixture(t),b=await launch(f,'b');
  const done=await (await launch(f,'core','artifact-pc-observer-command-channel-mutation-fenced-core-authority',b.url)).run();
  assert.equal(done.result.status,'COMPLETED',details(done));assert.equal(f.calls(),1);assert.equal(done.effect.state,'succeeded');
  assert.equal(done.effect.intent.request.executorBinding.mutationFenceRequired,true);
  assert.equal(done.growthCount,1);assert.equal(done.workCount,1);assert.equal(done.pendingFollowups,0);
});

for(const tamper of [false,true])test(`outbound command response loss then Core process recovery; tamper=${tamper}`,async t=>{
  const f=fixture(t),b=await launch(f,'b','drop-response');
  const first=await (await launch(f,'core','artifact-pc-observer-command-channel',b.url)).run();
  assert.equal(first.result.status,'PAUSED',details(first));assert.equal(f.calls(),1);
  if(tamper)writeFileSync(join(f.root,'workspace/result.txt'),'changed after effect');
  const done=await (await launch(f,'core','resume-artifact-pc-observer-command-channel',b.url)).run();
  assert.equal(f.calls(),1,details(done));
  assert.equal(done.effect.intent.request.executorBinding.kind,'pc-outbound-command');
  if(tamper){assert.notEqual(done.result.status,'COMPLETED',details(done));assert.equal(done.growthCount,0);assert.equal(done.workCount,0);}
  else {assert.equal(done.result.status,'COMPLETED',details(done));assert.equal(done.growthCount,1);assert.equal(done.workCount,1);assert.equal(done.pendingFollowups,0);}
});

for(const scenario of ['normal','wrong-facts','revoke-between'])test(`OS actual B four files complete original Mission; scenario=${scenario}`,{skip:process.platform!=='linux'||process.getuid?.()!==0},async t=>{
  const wrong=scenario==='wrong-facts',revoked=scenario==='revoke-between';
  const f=fixture(t);f.osBoundary=true;chmodSync(f.root,0o755);chownSync(f.root,1000,1000);
  const pcRoot=join(f.root,'workspace');mkdirSync(pcRoot,{mode:0o700});chownSync(pcRoot,2002,2002);
  mkdirSync(join(f.root,'b'),{mode:0o700});chownSync(join(f.root,'b'),2002,2002);
  for(const name of ['remote-adapter.jsonl','pc-observer.jsonl']){writeFileSync(join(f.root,name),'');chownSync(join(f.root,name),2002,2002);}
  const b=await launch(f,'b'),core=await launch(f,'core',`artifact-pc-observer-os-boundary-four-files${scenario==='normal'?'':`-${scenario}`}`,b.url),done=await core.run();
  assert.equal(done.coreDirectRead,'EACCES');assert.equal(done.coreUid,1000);assert.equal(done.coreCapabilities,'0000000000000000');
  assert.equal(f.calls(),4,details(done));assert.equal(done.result.goalContract.requirements.length,4);
  const observerReads=readFileSync(join(f.root,'pc-observer.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  assert.ok(observerReads.every(item=>item.pid===b.pid));assert.equal(new Set(observerReads.map(item=>item.taskId)).size,4);
  assert.equal(done.allGrowthCount,4);assert.equal(done.allWorkCount,4);assert.equal(done.pendingFollowups,0);
  if(revoked){assert.notEqual(done.result.status,'COMPLETED');assert.ok(done.result.verificationSummary.criteria[0].reasons.includes('remote-consistency-current-observation-unavailable'),details(done));}
  else if(wrong){assert.notEqual(done.result.status,'COMPLETED');assert.ok(done.result.verificationSummary.criteria[0].reasons.includes('criterion-artifact-facts-or-provenance-mismatch'),details(done));assert.ok(done.result.observations.some(item=>item.error?.reasons?.some(reason=>reason.includes('criterion-artifact-facts-or-provenance-mismatch'))),details(done));}
  else {assert.equal(done.result.status,'COMPLETED',details(done));assert.equal(done.result.verificationSummary.criteria[0].checks[0].checkId,'current_remote_artifact_consistency');}
  const values=['source','report','table','card'].map(kind=>JSON.parse(readFileSync(join(pcRoot,`${kind}.json`),'utf8')));
  assert.equal(values[0].facts.total,42);assert.equal(values[3].facts.total,wrong?99:42);
  console.log(JSON.stringify({scenario:'actual-B-four-files',injection:scenario,wrong,missionStatus:done.result.status,directRead:done.coreDirectRead,adapterCalls:f.calls(),growth:done.allGrowthCount,work:done.allWorkCount,criteria:done.result.verificationSummary,reconciliations:done.artifactReconciliations}));
});

for(const format of ['text','json','csv','json-multi','json-multi-revoke-between'])for(const wrong of [false,true])test(`OS denies Core file access while current remote typed criterion checks actual content; format=${format}; wrong equals=${wrong}`,{
  skip:process.platform!=='linux'||process.getuid?.()!==0
},async t=>{
  const f=fixture(t);f.osBoundary=true;chmodSync(f.root,0o755);chownSync(f.root,1000,1000);
  const pcRoot=join(f.root,'workspace');mkdirSync(pcRoot,{mode:0o700});chownSync(pcRoot,2002,2002);
  mkdirSync(join(f.root,'b'),{mode:0o700});chownSync(join(f.root,'b'),2002,2002);
  // B's call audit is separate from its private artifact directory.
  writeFileSync(join(f.root,'remote-adapter.jsonl'),'');chownSync(join(f.root,'remote-adapter.jsonl'),2002,2002);
  writeFileSync(join(f.root,'pc-observer.jsonl'),'');chownSync(join(f.root,'pc-observer.jsonl'),2002,2002);
  const b=await launch(f,'b'),core=await launch(f,'core',`artifact-pc-observer-os-boundary-criterion-${format}${wrong?'-wrong-equals':''}`,b.url),done=await core.run();
  assert.equal(done.coreDirectRead,'EACCES');assert.equal(done.coreUid,1000);assert.equal(done.coreCapabilities,'0000000000000000');assert.equal(f.calls(),1);
  assert.equal(done.verificationScope,'same-process-remote-filesystem.createTextFile');
  assert.equal(done.growthCount,1);assert.equal(done.workCount,1);assert.equal(done.pendingFollowups,0);
  assert.equal(done.artifactReconciliations,2,'execution verification plus one fresh completion observation');
  if(format.includes('revoke-between')){assert.notEqual(done.result.status,'COMPLETED','scope revocation between criteria forbids completion');
    assert.ok(done.result.observations.some(item=>item.error?.reasons?.some(reason=>/remote-criterion-(?:observation-invalidated|current-observation-unavailable)/u.test(reason))));}
  else if(wrong){assert.notEqual(done.result.status,'COMPLETED','wrong expected content must not complete');
    assert.ok(done.result.observations.some(item=>item.error?.reasons?.some(reason=>reason.includes('criterion-value-mismatch'))),
      'current remote bytes independently reject the requested wrong value');}
  else {assert.equal(done.result.status,'COMPLETED',details(done));
    assert.ok(done.result.verificationSummary.criteria.every(item=>item.checks[0].checkId==='current_remote_typed_criterion'));
    if(format==='json-multi')assert.equal(done.result.verificationSummary.criteria.length,2);}
  assert.equal(readFileSync(join(pcRoot,'result.txt'),'utf8'),format.startsWith('json')?'{"report":{"count":2,"label":"서울"}}':format==='csv'?'title,count\n"서울,목회",2\n':'actual remote durable effect');
  console.log(JSON.stringify({scenario:'os-isolated-core-pc-baseline',format,wrong,coreUid:done.coreUid,coreCapabilities:done.coreCapabilities,
    artifactReconciliations:done.artifactReconciliations,directRead:done.coreDirectRead,executionVerificationScope:done.verificationScope,missionStatus:done.result.status,
    stopReason:done.result.stopReason,criteria:done.result.verificationSummary,growthCount:done.growthCount,
    workCount:done.workCount,pendingFollowups:done.pendingFollowups,adapterCalls:f.calls()}));
});

for(const mode of ['normal','lost','tampered','revoked'])test(`actual PC process owns artifact observer; mode=${mode}`,async t=>{
  const lost=['lost','tampered'].includes(mode);
  const f=fixture(t),b=await launch(f,'b',lost?'drop-response':'normal'),core=await launch(f,'core',mode==='revoked'?'artifact-pc-observer-revoke':'artifact-pc-observer',b.url);
  let done=await core.run();
  if(lost){assert.equal(done.result.status,'PAUSED',details(done));
    if(mode==='tampered')writeFileSync(join(f.root,'workspace/result.txt'),'changed after B effect');
    done=await (await launch(f,'core','resume-artifact-pc-observer',b.url)).run();}
  if(['tampered','revoked'].includes(mode)){
    assert.notEqual(done.result.status,'COMPLETED',details(done));assert.equal(f.calls(),1);assert.equal(done.growthCount,0);assert.equal(done.workCount,0);
    assert.equal(done.effect.state,mode==='tampered'?'uncertain':'succeeded');
    assert.equal(done.pendingFollowups,mode==='revoked'?1:0);assert.deepEqual(done.artifactDiagnostics,[]);return;
  }
  assert.equal(done.result.status,'COMPLETED',details(done));assert.equal(f.calls(),1);
  assert.equal(done.effect.state,'succeeded');assert.equal(done.growthCount,1);assert.equal(done.workCount,1);assert.equal(done.pendingFollowups,0);
  assert.deepEqual(done.artifactDiagnostics,[],'Core does not instantiate its artifact reader');
  const reads=readFileSync(join(f.root,'pc-observer.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  assert.ok(reads.length>=2);assert.ok(reads.every(read=>read.pid===b.pid&&read.pid!==core.pid),'all journal/byte observer reads in actual B process');
  assert.equal(done.effect.intent.request.remoteArtifactIntent.binding.rootScopeSha256,b.rootScopeSha256);
});

for(const changed of [false,true])test(`actual B lost response recovers via new remote G and durable memories; changed bytes=${changed}`,async t=>{
  const f=fixture(t),b=await launch(f,'b','drop-response'),core=await launch(f,'core','artifact',b.url),first=await core.run();
  assert.equal(first.result.status,'PAUSED',details(first));assert.equal(first.effect.state,'uncertain');assert.equal(f.calls(),1);
  assert.equal(first.effect.intent.request.remoteArtifactIntent.binding.version,'remote-artifact-binding-v2');
  if(changed)writeFileSync(join(f.root,'workspace/result.txt'),'changed after real B receipt');
  const done=await (await launch(f,'core','resume-artifact',b.url)).run();
  assert.equal(done.result.status,changed?'PAUSED':'COMPLETED',details(done));assert.equal(f.calls(),1);
  if(changed){assert.equal(done.effect.state,'uncertain');assert.equal(done.growthCount,0);assert.equal(done.workCount,0);}
  else{assert.equal(done.effect.state,'succeeded');assert.equal(done.growthCount,1);assert.equal(done.workCount,1);assert.equal(done.pendingFollowups,0);
    assert.equal(done.result.waves[0].actions[0].recovery.source,'pc-outbound-verified-artifact');}
});
for(const revoked of [false,true])test(`normal B effect uses remote artifact G before learning; revoked=${revoked}`,async t=>{
  const f=fixture(t),b=await launch(f,'b'),core=await launch(f,'core',revoked?'artifact-revoke':'artifact',b.url),done=await core.run();
  assert.equal(f.calls(),1);assert.equal(done.effect.state,'succeeded');
  if(revoked){assert.notEqual(done.result.status,'COMPLETED',details(done));assert.equal(done.growthCount,0);assert.equal(done.workCount,0);assert.equal(done.pendingFollowups,1);}
  else{assert.equal(done.result.status,'COMPLETED',details(done));assert.equal(done.growthCount,1);assert.equal(done.workCount,1);assert.equal(done.pendingFollowups,0);
    assert.equal(done.verificationScope,'same-process-remote-filesystem.createTextFile');
    assert.ok(done.artifactDiagnostics.length>0,'normal verification independently queried B journal and bytes');}
});

test('actual Core child and HTTP B child complete one durable file with distinct databases', async t => {
  const f = fixture(t), b = await launch(f, 'b'), core = await launch(f, 'core', 'normal', b.url), done = await core.run();
  assert.equal(done.result.status, 'COMPLETED', details(done)); assert.equal(done.effect.state, 'succeeded');
  assert.equal(done.effect.intent.request.executorBinding.kind, 'pc-http-loopback'); assert.equal(f.calls(), 1);
  assert.equal(done.pendingFollowups, 0); assert.equal(done.growthCount, 1); assert.equal(done.workCount, 1);
  assert.equal(readFileSync(join(f.root, 'workspace/result.txt'), 'utf8'), 'actual remote durable effect');
  assert.ok(existsSync(join(f.root, 'core-operations.sqlite'))); assert.ok(existsSync(join(f.root, 'b/remote-operations.sqlite')));
});

for(const channel of ['loopback','outbound'])test(`actual lost HTTP response is reconciled after Core restart without a second B dispatch (${channel})`, async t => {
  const f = fixture(t), b = await launch(f, 'b', 'drop-response'), core = await launch(f, 'core', 'normal', b.url), failed = await core.run();
  assert.equal(failed.result.status, 'PAUSED', details(failed)); assert.equal(failed.effect.state, 'uncertain'); assert.equal(f.calls(), 1);
  const recovered = await (await launch(f, 'core', channel==='outbound'?'resume-outbound':'resume', b.url)).run();
  assert.equal(recovered.result.status, 'COMPLETED', details(recovered)); assert.equal(f.calls(), 1);
  assert.equal(recovered.growthCount, 1); assert.equal(recovered.workCount, 1); assert.equal(recovered.pendingFollowups, 0);
});

for (const mode of ['file-effect', 'b-journal', 'receipt']) {
  test(`actual B child kill at ${mode} never repeats the file effect`, async t => {
    const f = fixture(t), b = await launch(f, 'b', mode), core = await launch(f, 'core', 'normal', b.url), running = core.run();
    assert.equal((await b.next()).boundary, mode); await b.kill();
    const failed = await running; assert.equal(failed.result.status, 'PAUSED', details(failed)); assert.equal(f.calls(), 1);
    const restarted = await launch(f, 'b', 'normal', String(new URL(b.url).port));
    const recovered = await (await launch(f, 'core', 'resume', restarted.url)).run();
    assert.equal(recovered.result.status, mode === 'file-effect' ? 'PAUSED' : 'COMPLETED', details(recovered)); assert.equal(f.calls(), 1);
  });
}

for (const mode of ['prepared', 'remote-prepared', 'receipt-persisted']) {
  test(`actual Core child kill at ${mode} preserves remote operation identity`, async t => {
    const f = fixture(t), b = await launch(f, 'b'), core = await launch(f, 'core', mode, b.url);
    assert.equal((await core.run()).boundary, mode); await core.kill();
    const recovered = await (await launch(f, 'core', 'resume', b.url)).run();
    assert.equal(recovered.result.status, mode === 'remote-prepared' ? 'PAUSED' : 'COMPLETED', details(recovered));
    assert.equal(f.calls(), mode === 'remote-prepared' ? 0 : 1);
  });
}

function packet(f, suffix = 'a', target = `${suffix}.txt`) {
  const action = { actionType: ActionType.CREATE_FILE, toolName: 'filesystem.createTextFile', arguments: { path: join(f.root, 'workspace', target), content: `effect ${suffix}` } };
  const taskId = `task_remote_${suffix}`, approvalId = `approval_${suffix}`, planId = `plan_${suffix}`;
  const issuer = new CapabilityTokenService({ signingSecret: 'synthetic-remote-operation-capability-key-no-production-secret' });
  return { packetId: `packet_${suffix}`, taskId, planId, action, requestedMode: 'execute', idempotencyKey: `mission_op_${suffix.padEnd(32, '0')}`,
    capabilityToken: issuer.issue({ taskId, planId, approvalId, action, allowedPaths: [join(f.root, 'workspace')] }), userConfirmation: { confirmed: true, approvalId, confirmedAt: new Date().toISOString() } };
}
const identity = packet => ({ operationId: packet.idempotencyKey, taskId: packet.taskId, action: packet.action });
async function execute(client, packet, prepared) { return client.request('/operations/execute', { method: 'POST', body: { packet, ticket: prepared.ticket, generation: prepared.generation } }); }

for (const mutation of ['path', 'content', 'allowOverwrite', 'encoding', 'scope', 'approvalId', 'planId']) {
  test(`signed capability rejects ${mutation} replacement before the first remote prepare`, async t => {
    const f = fixture(t), b = await launch(f, 'b'), client = new PcAgentExecutionClient({ baseUrl: b.url, executionToken });
    const original = packet(f), changed = structuredClone(original);
    if (mutation === 'path') changed.action.arguments.path = join(f.root, 'workspace', 'unapproved.txt');
    else if (mutation === 'content') changed.action.arguments.content = 'unapproved content';
    else if (mutation === 'allowOverwrite') changed.action.arguments.allowOverwrite = true;
    else if (mutation === 'encoding') changed.action.arguments.encoding = 'utf16le';
    else if (mutation === 'scope') changed.capabilityToken.scope.allowedPaths = [f.root];
    else if (mutation === 'approvalId') changed.userConfirmation.approvalId = 'another_approval';
    else changed.planId = 'another_plan';
    await assert.rejects(client.prepareOperation(changed));
    assert.equal(f.calls(), 0);
    const ready = await client.prepareOperation(original);
    assert.equal((await execute(client, original, ready)).status, 'COMPLETED');
    assert.equal(f.calls(), 1); assert.equal(readFileSync(original.action.arguments.path, 'utf8'), original.action.arguments.content);
  });
}

test('durable B rejects legacy unbound scopes and a signed path outside its narrower E grant', async t => {
  const f = fixture(t), b = await launch(f, 'b'), client = new PcAgentExecutionClient({ baseUrl: b.url, executionToken });
  const issuer = new CapabilityTokenService({ signingSecret: 'synthetic-remote-operation-capability-key-no-production-secret' });
  const legacy = packet(f); delete legacy.capabilityToken.scope.executionBinding;
  legacy.capabilityToken.capabilityToken = issuer.signToken(legacy.capabilityToken);
  await assert.rejects(client.prepareOperation(legacy), { code: 'B_OPERATION_ARGUMENT_BINDING_MISMATCH' });
  const outside = packet(f, 'b'); outside.capabilityToken.scope.allowedPaths = [join(f.root, 'workspace', 'narrower-scope')];
  outside.capabilityToken.capabilityToken = issuer.signToken(outside.capabilityToken);
  await assert.rejects(client.prepareOperation(outside), { code: 'B_OPERATION_SIGNED_PATH_SCOPE_MISMATCH' });
  assert.equal(f.calls(), 0);
  const positive = packet(f, 'c');
  positive.action.arguments = { content: positive.action.arguments.content, path: positive.action.arguments.path };
  const ready = await client.prepareOperation(positive);
  assert.equal((await execute(client, positive, ready)).status, 'COMPLETED'); assert.equal(f.calls(), 1);
});

test('signed argument binding canonicalizes all JSON keys without silently losing unsupported values', () => {
  assert.deepEqual(actionArgumentsBinding({ a: { x: 1, y: [true, null] }, b: 'v' }), actionArgumentsBinding({ b: 'v', a: { y: [true, null], x: 1 } }));
  const circular = {}; circular.self = circular;
  const accessor = Object.defineProperty({}, 'value', { enumerable: true, get() { throw new Error('must not execute accessor'); } });
  const hidden = Object.defineProperty({}, 'value', { value: 1 });
  for (const invalid of [{ a: undefined }, { a: NaN }, { a: Infinity }, { a: -0 }, { a: 1n }, { a: new Date() }, { a: () => 1 }, circular, accessor, hidden, [1, , 2], { [Symbol('secret')]: 1 }]) {
    assert.equal(actionArgumentsBinding(invalid), null);
  }
});

test('Core cancellation while B is prepared confirms remote cancellation with no file effect', async t => {
  const f = fixture(t), b = await launch(f, 'b'), core = await launch(f, 'core', 'cancel-remote-prepared', b.url);
  assert.equal((await core.run()).boundary, 'remote-prepared');
  const done = await core.resume();
  assert.equal(f.calls(), 0); assert.equal(done.result.status, 'CANCELLED');
  const client = new PcAgentExecutionClient({ baseUrl: b.url, executionToken });
  const remote = await client.readOperation({ operationId: done.effect.operation_id, taskId: done.effect.intent.request.taskId, action: done.effect.intent.request.action });
  assert.equal(remote.state, 'cancelled'); assert.equal(done.effect.state, 'failed');
  assert.equal(done.growthCount, 0); assert.equal(done.workCount, 0);
  assert.equal(done.result.waves[0].actions[0].status, 'skipped');
  assert.equal(done.result.waves[0].actions[0].recovery.required, false);
  assert.equal(done.result.metrics.executedActions, 0); assert.equal(done.pendingFollowups, 0);
});

for (const mode of ['revise-remote-prepared', 'shutdown-remote-prepared']) {
  test(`Core ${mode} fences the prepared B operation before an actual effect`, async t => {
    const f = fixture(t), b = await launch(f, 'b'), core = await launch(f, 'core', mode, b.url);
    assert.equal((await core.run()).boundary, 'remote-prepared');
    const done = await core.resume(), client = new PcAgentExecutionClient({ baseUrl: b.url, executionToken });
    assert.equal(f.calls(), 0); assert.equal(done.effect.state, 'failed'); assert.equal(done.effect.receipt.notDispatched, true);
    assert.equal((await client.readOperation({ operationId: done.effect.operation_id, taskId: done.effect.intent.request.taskId, action: done.effect.intent.request.action })).state, 'cancelled');
    assert.equal(done.result.status, 'PAUSED'); assert.equal(done.result.waves[0].actions[0].recovery.required, false);
    assert.equal(done.result.metrics.executedActions, 0); assert.equal(done.pendingFollowups, 0);
    assert.equal(done.growthCount, 0); assert.equal(done.workCount, 0);
  });
}

test('a prepared B ticket rejects replacement by another valid E approval for the same task and arguments', async t => {
  const f = fixture(t), b = await launch(f, 'b'), client = new PcAgentExecutionClient({ baseUrl: b.url, executionToken });
  const original = packet(f), ready = await client.prepareOperation(original), replacement = structuredClone(original);
  replacement.planId = 'different_plan'; replacement.userConfirmation.approvalId = 'different_approval'; replacement.packetId = 'different_packet';
  const issuer = new CapabilityTokenService({ clock: () => new Date(Date.now() + 10), signingSecret: 'synthetic-remote-operation-capability-key-no-production-secret' });
  replacement.capabilityToken = issuer.issue({ taskId: replacement.taskId, planId: replacement.planId, approvalId: replacement.userConfirmation.approvalId,
    action: replacement.action, allowedPaths: [join(f.root, 'workspace')] });
  await assert.rejects(client.prepareOperation(replacement), { code: 'B_OPERATION_AUTHORIZATION_BINDING_MISMATCH' });
  await assert.rejects(execute(client, replacement, ready), { code: 'B_OPERATION_AUTHORIZATION_BINDING_MISMATCH' }); assert.equal(f.calls(), 0);
  assert.equal((await execute(client, original, ready)).status, 'COMPLETED'); assert.equal(f.calls(), 1);
});

test('older B rows without authorization binding remain readable and cancellable but cannot acquire a new ticket', t => {
  const f = fixture(t), path = join(f.root, 'legacy-b.sqlite');
  let store = new RemoteOperationStore({ path });
  const input = { operationId: 'mission_op_' + 'a'.repeat(32), taskId: 'task', fingerprint: 'a'.repeat(64), resourceKey: 'file:r', authorizationHash: 'b'.repeat(64) };
  const ticket = store.prepare(input); store.db.exec('ALTER TABLE remote_operations DROP COLUMN authorization_hash'); store.close();
  store = new RemoteOperationStore({ path });
  try {
    assert.equal(store.public(store.bound(input)).state, 'prepared');
    assert.throws(() => store.prepare(input), { code: 'B_OPERATION_AUTHORIZATION_BINDING_MISMATCH' });
    assert.throws(() => store.claim(input, ticket.ticket, ticket.generation), { code: 'B_OPERATION_AUTHORIZATION_BINDING_MISMATCH' });
    assert.equal(store.cancel(input).cancellationConfirmed, true);
  } finally { store.close(); }
});

test('remote cancel and renewed ticket fence stale requests while preserving a positive route', async t => {
  const f = fixture(t), b = await launch(f, 'b'), client = new PcAgentExecutionClient({ baseUrl: b.url, executionToken });
  const p = packet(f), first = await client.prepareOperation(p), second = await client.prepareOperation(p);
  assert.notEqual(first.ticket, second.ticket);
  await assert.rejects(execute(client, p, first), { code: 'B_OPERATION_CLAIM_REJECTED' }); assert.equal(f.calls(), 0);
  const cancelled = await client.cancelOperation(identity(p)); assert.equal(cancelled.cancellationConfirmed, true);
  await assert.rejects(execute(client, p, second), { code: 'B_OPERATION_CLAIM_REJECTED' }); assert.equal(f.calls(), 0);
  const positive = packet(f, 'b'), ready = await client.prepareOperation(positive), result = await execute(client, positive, ready);
  assert.equal(result.status, 'COMPLETED'); assert.equal(f.calls(), 1);
  const legacy = await client.receiveExecutionPacket(p); assert.equal(legacy.blockedReason, 'B_MISSION_OPERATION_PROTOCOL_REQUIRED');
});

test('a stale ticket cannot poison the original packet before its current ticket executes', async t => {
  const f = fixture(t), b = await launch(f, 'b'), client = new PcAgentExecutionClient({ baseUrl: b.url, executionToken });
  const p = packet(f), first = await client.prepareOperation(p), current = await client.prepareOperation(p);
  const stale = await execute(client, p, first).catch(error => ({ status: 'REJECTED', code: error.code }));
  assert.notEqual(stale.status, 'COMPLETED'); assert.equal(f.calls(), 0);
  assert.equal((await execute(client, p, current)).status, 'COMPLETED'); assert.equal(f.calls(), 1);
  assert.equal((await client.readOperation(identity(p))).state, 'succeeded');
});

test('two simultaneous HTTP execute requests for one ticket produce one actual effect', async t => {
  const f = fixture(t), b = await launch(f, 'b'), client = new PcAgentExecutionClient({ baseUrl: b.url, executionToken });
  const p = packet(f), ready = await client.prepareOperation(p);
  const results = await Promise.allSettled([execute(client, p, ready), execute(client, p, ready)]);
  assert.ok(results.some(item => item.status === 'fulfilled' && item.value.status === 'COMPLETED'), JSON.stringify(results));
  assert.equal(f.calls(), 1); assert.equal((await client.readOperation(identity(p))).state, 'succeeded');
});

test('remote B cancellation during a claimed operation fences the late adapter and never reports confirmed cancellation', async t => {
  const f = fixture(t), b = await launch(f, 'b', 'claimed'), client = new PcAgentExecutionClient({ baseUrl: b.url, executionToken });
  const p = packet(f), ready = await client.prepareOperation(p), running = execute(client, p, ready);
  assert.equal((await b.next()).boundary, 'claimed');
  const cancelled = await client.cancelOperation(identity(p)); assert.equal(cancelled.state, 'uncertain'); assert.equal(cancelled.cancellationConfirmed, false);
  b.child.send('continue'); const result = await running;
  assert.notEqual(result.status, 'COMPLETED'); assert.equal(f.calls(), 0);
  assert.equal((await client.readOperation(identity(p))).state, 'uncertain');
});

test('remote operation routes reject unauthenticated, forged-capability and changed-target requests', async t => {
  const f = fixture(t), b = await launch(f, 'b'), client = new PcAgentExecutionClient({ baseUrl: b.url, executionToken });
  const p = packet(f), ready = await client.prepareOperation(p);
  const unauth = await fetch(`${b.url}/operations/execute`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ packet: p, ...ready }) });
  assert.equal(unauth.status, 401);
  const changed = structuredClone(p); changed.action.arguments.path = join(f.root, 'workspace/wrong.txt');
  await assert.rejects(execute(client, changed, ready)); assert.equal(f.calls(), 0);
  const forged = packet(f, 'b'); forged.capabilityToken.capabilityToken += 'tampered';
  await assert.rejects(client.prepareOperation(forged)); assert.equal(f.calls(), 0);
});

test('a prepared ticket survives B restart and its cancellation remains final across another restart', async t => {
  const f = fixture(t), b = await launch(f, 'b'), client = new PcAgentExecutionClient({ baseUrl: b.url, executionToken });
  const p = packet(f), ready = await client.prepareOperation(p); await b.kill();
  const restarted = await launch(f, 'b', 'normal', String(new URL(b.url).port));
  assert.equal((await client.readOperation(identity(p))).state, 'prepared');
  assert.equal((await client.cancelOperation(identity(p))).cancellationConfirmed, true); await restarted.kill();
  await launch(f, 'b', 'normal', String(new URL(b.url).port));
  await assert.rejects(execute(client, p, ready), { code: 'B_OPERATION_CLAIM_REJECTED' }); assert.equal(f.calls(), 0);
  assert.equal((await client.readOperation(identity(p))).state, 'cancelled');
});

test('capability revoked after remote claim is checked again immediately before the file effect', async t => {
  const f = fixture(t), b = await launch(f, 'b', 'revoke-at-claim'), client = new PcAgentExecutionClient({ baseUrl: b.url, executionToken });
  const p = packet(f), ready = await client.prepareOperation(p), result = await execute(client, p, ready);
  assert.notEqual(result.status, 'COMPLETED'); assert.equal(f.calls(), 0);
  assert.equal((await client.readOperation(identity(p))).state, 'uncertain');
});

test('an observed expired B ticket cannot revive after wall clock rollback', t => {
  const f = fixture(t); let now = 1000;
  const store = new RemoteOperationStore({ path: join(f.root, 'clock.sqlite'), clock: () => new Date(now) });
  try {
  const input = { operationId: 'mission_op_' + 'a'.repeat(32), taskId: 'task', fingerprint: 'a'.repeat(64), resourceKey: 'file:r', authorizationHash: 'b'.repeat(64) };
  const prepared = store.prepare(input, { ttlMs: 20 }); now = 1021;
  assert.throws(() => store.claim(input, prepared.ticket, prepared.generation), { code: 'B_OPERATION_CLAIM_REJECTED' });
  now = 1001; assert.throws(() => store.claim(input, prepared.ticket, prepared.generation), { code: 'B_OPERATION_CLAIM_REJECTED' });
  } finally { store.close(); }
});

test('different remote operation IDs cannot claim one resource while its first effect is unresolved', async t => {
  const f = fixture(t), b = await launch(f, 'b', 'claimed'), client = new PcAgentExecutionClient({ baseUrl: b.url, executionToken });
  const first = packet(f, 'a', 'Shared.txt'), second = packet(f, 'b', process.platform === 'win32' ? 'shared.txt' : 'Shared.txt');
  const firstTicket = await client.prepareOperation(first), secondTicket = await client.prepareOperation(second);
  const running = execute(client, first, firstTicket); assert.equal((await b.next()).boundary, 'claimed');
  await assert.rejects(execute(client, second, secondTicket), { code: 'B_OPERATION_RESOURCE_UNRESOLVED' }); assert.equal(f.calls(), 0);
  b.child.send('continue'); assert.equal((await running).status, 'COMPLETED'); assert.equal(f.calls(), 1);
  assert.equal(readFileSync(first.action.arguments.path, 'utf8'), 'effect a');
});


test('actual Mission reports local PC scope mismatch without a file effect or false completion',async t=>{
  const f=fixture(t),b=await launch(f,'b');
  const done=await (await launch(f,'core','artifact-pc-observer-command-channel-local-scope-denied',b.url)).run();
  assert.equal(f.calls(),0,details(done));assert.notEqual(done.result.status,'COMPLETED',details(done));
  const recovery=done.result.waves[0].actions[0].recovery;
  assert.equal(recovery.error.causeCode,'A_PC_COMMAND_LOCAL_SCOPE_DENIED',details(done));
  assert.match(recovery.error.nextAction,/PC/u);assert.equal(done.growthCount,0);assert.equal(done.workCount,0);
  assert.equal(existsSync(join(f.root,'workspace','result.txt')),false);
});

for(const reason of ['missing','ungranted','expired'])test(`actual Mission retains precise PC readiness next action: ${reason}`,async t=>{
  const f=fixture(t),b=await launch(f,'b');
  const done=await (await launch(f,'core',`artifact-pc-observer-command-channel-local-readiness-${reason}`,b.url)).run();
  assert.equal(f.calls(),0,details(done));assert.notEqual(done.result.status,'COMPLETED',details(done));
  const recovery=done.result.waves[0].actions[0].recovery;
  assert.equal(recovery.error.causeCode,'A_PC_COMMAND_LOCAL_SCOPE_DENIED',details(done));
  assert.match(recovery.error.nextAction,reason==='missing'?/명령 후보로 등록/u:reason==='expired'?/기간이 끝났/u:/허용 종료 시각/u);
  assert.equal(recovery.error.localScopeReason,{missing:'B_PC_COMMAND_LOCAL_CATALOG_MISSING',ungranted:'B_PC_COMMAND_LOCAL_PERMISSION_MISSING',expired:'B_PC_COMMAND_LOCAL_PERMISSION_EXPIRED'}[reason]);
  assert.match(missionProgressMessage(done.result),reason==='missing'?/명령 후보로 등록/u:reason==='expired'?/기간이 끝났/u:/허용 종료 시각/u);
  console.log(JSON.stringify({uiRecoveryEvidence:true,reason,missionId:done.result.missionId,status:done.result.status,stopReason:done.result.stopReason,uncertainEffectCount:done.result.uncertainEffectCount,recovery}));
  assert.match(recovery.error.nextAction,/기존 실행 기록/u);assert.equal(done.growthCount,0);assert.equal(done.workCount,0);
  assert.equal(existsSync(join(f.root,'workspace','result.txt')),false);
});


for(const scenario of ['normal','permission-after-readiness','catalog-after-prepare','expiry-after-prepare','core-permission-after-readiness'])test(`same PC managed readiness does not authorize a later changed Mission: ${scenario}`,async t=>{
 const f=fixture(t),b=await launch(f,'b');
 const done=await(await launch(f,'core',`artifact-pc-observer-command-channel-mutation-fenced-managed-preflight-${scenario}`,b.url)).run();
 assert.equal(done.preflightObservation.configurationReadiness.status,'configuration-matched',details(done));
 assert.equal(done.preflightObservation.configurationReadiness.executionAuthority,false);
 assert.equal(done.preflightObservation.configurationReadiness.verifiedCompletion,false);
 assert.equal(done.preflightObservation.deviceId,'reconcile-pc');
 assert.equal(done.preflightObservation.configurationReadiness.taskId,done.result.waves[0].actions[0].taskId);
 if(scenario==='normal'){
  assert.equal(done.result.status,'COMPLETED',details(done));assert.equal(f.calls(),1);assert.equal(done.growthCount,1);assert.equal(done.workCount,1);
  assert.equal(done.result.verificationSummary.criteria[0].checks[0].checkId,'current_remote_typed_criterion');
  assert.equal(readFileSync(join(f.root,'workspace','result.txt'),'utf8'),'actual remote durable effect');
 }else{
  assert.notEqual(done.result.status,'COMPLETED',details(done));assert.equal(f.calls(),0);assert.equal(done.growthCount,0);assert.equal(done.workCount,0);
  assert.equal(existsSync(join(f.root,'workspace','result.txt')),false);
  if(scenario==='core-permission-after-readiness')console.log(JSON.stringify({uiRecoveryEvidence:true,reason:'core-permission',missionId:done.result.missionId,status:done.result.status,stopReason:done.result.stopReason,uncertainEffectCount:done.result.uncertainEffectCount,recovery:done.result.waves[0].actions[0].recovery}));
  assert.match(missionProgressMessage(done.result),scenario==='core-permission-after-readiness'?/PC.*실행 범위/:scenario==='permission-after-readiness'?/허용 종료 시각/:scenario==='catalog-after-prepare'?/명령 후보로 등록/:/기간이 끝났/);
 }
 console.log(JSON.stringify({managedPreflightEvidence:true,scenario,observedConfiguration:'matched',missionStatus:done.result.status,adapterCalls:f.calls(),growth:done.growthCount,work:done.workCount,completionVerified:done.result.verificationStatus}));
});


for(const tamper of [false,true])test(`managed PC response loss recovers original Mission without duplicate effect: tamper=${tamper}`,async t=>{
 const f=fixture(t),b=await launch(f,'b');
 const first=await(await launch(f,'core','artifact-pc-observer-command-channel-mutation-fenced-managed-preflight-lost-reply',b.url)).run();
 assert.equal(first.preflightObservation.configurationReadiness.status,'configuration-matched');assert.equal(first.result.status,'PAUSED',details(first));
 assert.equal(f.calls(),1);assert.equal(first.growthCount,0);assert.equal(first.workCount,0);
 if(tamper)writeFileSync(join(f.root,'workspace','result.txt'),'changed after lost response');
 const done=await(await launch(f,'core','resume-artifact-pc-observer-command-channel-mutation-fenced-managed-preflight-normal',b.url)).run();
 assert.equal(done.result.missionId,first.result.missionId);assert.equal(f.calls(),1,details(done));
 assert.equal(done.effect.effectId,first.effect.effectId);
 if(tamper){assert.notEqual(done.result.status,'COMPLETED',details(done));assert.equal(done.growthCount,0);assert.equal(done.workCount,0);}
 else{assert.equal(done.result.status,'COMPLETED',details(done));assert.equal(done.growthCount,1);assert.equal(done.workCount,1);assert.equal(done.pendingFollowups,0);}
 console.log(JSON.stringify({managedPreflightRecovery:true,tamper,initialStatus:first.result.status,finalStatus:done.result.status,adapterCalls:f.calls(),growth:done.growthCount,work:done.workCount,sameMission:true,sameEffect:true}));
});

test('HTTP B receipt survives Core cognition failure and termination; replay stores memory without redispatch',async t=>{
 const f=fixture(t),b=await launch(f,'b'),core=await launch(f,'core','cognition-failure',b.url);
 assert.equal((await core.run()).boundary,'cognition-failed');await core.kill();assert.equal(f.calls(),1);
 const repaired=await(await launch(f,'core','cognition-resume',b.url)).run();assert.equal(repaired.result.status,'COMPLETED',details(repaired));
 assert.equal(repaired.cognitionEpisodes,1);assert.equal(repaired.pendingFollowups,0);assert.equal(f.calls(),1);
 const repeated=await(await launch(f,'core','cognition-resume',b.url)).run();assert.equal(repeated.cognitionEpisodes,1);assert.equal(f.calls(),1);
});
