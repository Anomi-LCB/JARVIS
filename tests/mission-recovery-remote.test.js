import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { PcAgentExecutionClient } from '../packages/core/src/client/pc-agent-execution-client.js';
import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { startPcOutboundNodeService } from '../packages/core/src/client/pc-outbound-service.js';
import { createPcOutboundTransport } from '../packages/core/src/client/pc-outbound-https.js';
import { createPcOutboundObserver } from '../apps/pc-agent/src/outbound-observer.js';
import { MissionGrant } from '../packages/core/src/mission/mission-runtime.js';

for(const channel of ['loopback','outbound-mtls'])test(`a restarted PC process serves its durable receipt to a fresh Core without redispatch (${channel})`, { timeout: 30000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-remote-recovery-'));
  let child,relay,transport,observerTimer;
  t.after(async () => {
    clearInterval(observerTimer);transport?.close();await relay?.close();
    if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    await rm(root, { recursive: true, force: true });
  });
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const target = join(workspace, 'receipt.txt');
  const signingSecret = 'test-remote-recovery-signing-secret-1234567890';
  const executionToken = 'test-remote-recovery-execution-token-1234567890';
  const runtimeUrl = new URL('../apps/runtime-compose/src/create-runtime.js', import.meta.url).href;
  const serverUrl = new URL('../apps/pc-agent/src/main.mjs', import.meta.url).href;
  const httpUrl = new URL('../packages/shared/src/http.js', import.meta.url).href;
  const childFile = join(root, 'pc-service.mjs');
  await writeFile(childFile, `
    import { createAgRuntime } from ${JSON.stringify(runtimeUrl)};
    import { createPcAgentServer, PcAgentApiGuard } from ${JSON.stringify(serverUrl)};
    import { listenOnFetchSafePort } from ${JSON.stringify(httpUrl)};
    const runtime = createAgRuntime(${JSON.stringify({ allowedRoots: [workspace], auditRoot: join(root, 'pc-audit'), signingSecret, env: { JARVIS_TEST_MODE: '1' }, workerDaemonEnabled: false })});
    const server = createPcAgentServer(runtime.pcAgent, { apiGuard: new PcAgentApiGuard({ apiToken: 'test-admin-remote-recovery-1234567890', executionToken: ${JSON.stringify(executionToken)} }) });
    await listenOnFetchSafePort(server);
    process.send({ port: server.address().port });
  `);
  async function startPc() {
    child = fork(childFile, [], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let errorText = '';
    child.stderr.on('data', chunk => { errorText += chunk; });
    child.stdout.resume();
    const result = await Promise.race([
      once(child, 'message').then(([message]) => message),
      once(child, 'exit').then(([code]) => { throw new Error(`PC child exited ${code}: ${errorText}`); })
    ]);
    return new PcAgentExecutionClient({ baseUrl: `http://127.0.0.1:${result.port}`, executionToken });
  }
  const planner = { async planNextWave(context) {
    if (context.observations.length) return { decision: 'complete', summary: '실제 산출물 검증 완료', actions: [],
      criteriaAssessment: context.mission.successCriteria.map(c => ({ criterionId: c.criterionId, status: 'satisfied', evidenceActionIds: context.observations.filter(o => o.outcome === 'success').map(o => o.actionId), reason: '실제 파일과 G 검증' })) };
    return { decision: 'continue', summary: '파일 작성', criteriaAssessment: [], actions: [{ id: 'create', title: '영속 실행 기록', command: 'receipt 메모 파일을 만들어줘. 내용은 프로세스 복구 확인', expectedToolName: 'filesystem.createTextFile', arguments: { path: target, content: '프로세스 복구 확인' }, dependencies: [], successSignal: 'receipt.txt 생성' }] };
  } };
  const options = { allowedRoots: [workspace], auditRoot: join(root, 'core-audit'), signingSecret, cwd: () => workspace,
    env: { JARVIS_TEST_MODE: '1' }, missionPlanner: planner, workerDaemonEnabled: false };
  const first = createAgRuntime(options);
  first.orchestrationWorker.pcAgent = await startPc();
  let checkpoint;
  const save = first.missionRuntime.store.save.bind(first.missionRuntime.store);
  first.missionRuntime.store.save = (missions, metadata) => {
    if (!checkpoint && metadata.reason.startsWith('mission-action-running:')) checkpoint = structuredClone(missions);
    return save(missions, metadata);
  };
  const created = first.missionRuntime.createMission({ objective: 'receipt.txt 파일을 만들어줘.', successCriteria: ['receipt.txt 생성'],
    authorization: { grants: [MissionGrant.READ_ONLY, MissionGrant.LOCAL_REVERSIBLE] } });
  const completed = await first.missionRuntime.runMission(created.missionId);
  assert.equal(completed.status, 'COMPLETED', JSON.stringify(completed));
  assert.ok(checkpoint);
  const before = await stat(target);
  const bytes = await readFile(target);
  const undoPath = join(root, 'pc-audit', 'undo-journal.jsonl');
  const undoBefore = await readFile(undoPath);
  const exited = once(child, 'exit'); child.kill(); await exited;
  save(checkpoint, { reason: 'test-crash-before-core-observation' });
  const fresh = createAgRuntime(options);
  fresh.orchestrationWorker.pcAgent = await startPc();
  const originalTaskId = checkpoint[0].waves[0].actions[0].taskId;
  if(channel==='outbound-mtls'){
    const pem=name=>readFileSync(new URL(`./fixtures/google-broker-tls/${name}.pem`,import.meta.url));
    relay=await startPcOutboundNodeService({dbPath:join(root,'outbound.sqlite'),authorityGuard:()=>({token:1}),tls:{key:pem('server-key'),cert:pem('server'),ca:pem('ca')}});
    relay.controller.enroll({deviceId:'recovery-pc',label:'합성 복구 PC',certificateFingerprint:new X509Certificate(pem('core')).fingerprint256,expiresAt:new Date(Date.now()+60000).toISOString().replace(/\.\d{3}Z$/u,'Z'),allowedTaskIds:[originalTaskId],expectedGeneration:0});
    transport=createPcOutboundTransport({url:`https://127.0.0.1:${relay.address.port}/v1/pc/observe`,key:pem('core-key'),cert:pem('core'),ca:pem('ca')});
    const observer=createPcOutboundObserver({transport,pcClient:fresh.orchestrationWorker.pcAgent,allowedTaskIds:[originalTaskId]});
    observerTimer=setInterval(()=>void observer.tick().catch(()=>{}),25);
    fresh.orchestrationWorker.pcAgent=relay.createReceiptClient('recovery-pc');
  }
  assert.equal(fresh.coreFacade.getTask(originalTaskId), undefined);
  let redispatches = 0;
  fresh.orchestrationWorker.runTask = async () => { redispatches++; throw new Error('Unexpected redispatch'); };
  const recovered = await fresh.missionRuntime.runMission(created.missionId);
  assert.equal(recovered.status, 'COMPLETED', JSON.stringify(recovered));
  assert.equal(recovered.waves[0].actions[0].recovery.source, 'pc-task-receipt');
  assert.equal(recovered.waves[0].actions[0].taskId, originalTaskId);
  assert.equal(redispatches, 0);
  assert.deepEqual(await readFile(target), bytes);
  assert.equal((await stat(target)).mtimeMs, before.mtimeMs);
  assert.deepEqual(await readFile(undoPath), undoBefore);
});
