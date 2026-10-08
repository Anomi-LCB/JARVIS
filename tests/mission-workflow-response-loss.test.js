import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { PcAgentExecutionClient } from '../packages/core/src/client/pc-agent-execution-client.js';

for (const scenario of ['before-headers', 'truncated-body', 'first-rename', 'last-rename', 'before-receipt', 'receipt-before-claim-release',
  'resume-first-rename', 'resume-last-rename', 'resume-before-receipt', 'resume-first-rename:input-change',
  'resume-first-rename:target-change', 'resume-first-rename:recipe-change', 'resume-first-rename:expired', 'resume-first-rename:substituted-arguments',
  'auto-first-rename', 'auto-last-rename', 'auto-before-receipt', 'auto-first-rename:grant-revoked',
  'auto-first-rename:policy-blocked', 'auto-first-rename:policy-escalated', 'auto-first-rename:cancelled', 'auto-first-rename:identity-changed',
  'auto-local-first-rename', 'auto-local-last-rename', 'auto-local-before-receipt',
  'auto-local-first-rename:grant-revoked', 'auto-local-first-rename:policy-blocked',
  'auto-local-first-rename:policy-escalated', 'auto-local-first-rename:cancelled', 'auto-local-first-rename:identity-changed',
  'auto-repeat-first-rename']) {
const [scenarioMode, resumeFault] = scenario.split(':');
const resumeRequested = scenarioMode.startsWith('resume-'), autoRequested = scenarioMode.startsWith('auto-');
const localRequested = scenarioMode.startsWith('auto-local-');
const repeatRequested = scenarioMode.startsWith('auto-repeat-');
const lossMode = scenarioMode.replace(/^(resume|auto)-(local-|repeat-)?/, '');
const resumedSuccessfully = (resumeRequested || autoRequested) && !resumeFault;
test(`interrupted actual workflow (${scenario}) reconciles or stays uncertain without redispatch`, { timeout: 30000 }, async t => {
  const duringPublication = lossMode.endsWith('rename') || lossMode === 'before-receipt';
  const afterReceipt = lossMode === 'receipt-before-claim-release';
  const processKill = duringPublication || afterReceipt;
  const root = await mkdtemp(join(tmpdir(), 'jarvis-workflow-http-loss-'));
  const workspace = join(root, 'workspace'); await mkdir(workspace);
  await writeFile(join(workspace, 'input.json'), '[{"total":7}]');
  const signingSecret = 'test-workflow-response-loss-signing-1234567890';
  const executionToken = 'test-workflow-response-loss-execution-1234567890';
  const options = { allowedRoots: [workspace], signingSecret,
    trustSigningSecret: 'synthetic-restart-continuity-trust-secret-1234567890', workerDaemonEnabled: false,
    env: { JARVIS_TEST_MODE: '1', JARVIS_LLM_INTENT: '0', JARVIS_LLM_PLANNER: '0', JARVIS_LLM_CONTENT: '0' } };
  const runtimeUrl = new URL('../apps/runtime-compose/src/create-runtime.js', import.meta.url).href;
  const serverUrl = new URL('../apps/pc-agent/src/main.mjs', import.meta.url).href;
  const httpUrl = new URL('../packages/shared/src/http.js', import.meta.url).href;
  const childFile = join(root, 'pc.mjs');
  await writeFile(childFile, `
    import { createAgRuntime } from ${JSON.stringify(runtimeUrl)};
    import { createPcAgentServer, PcAgentApiGuard } from ${JSON.stringify(serverUrl)};
    import { listenOnFetchSafePort } from ${JSON.stringify(httpUrl)};
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    if ((!process.argv.includes('restart') || process.argv.includes('repeat-resume')) && ${JSON.stringify(lossMode.endsWith('rename'))}) {
      const publish = fs.promises.link;
      fs.promises.link = async (source, destination) => {
        const result = await publish(source, destination);
        if (destination === (process.argv.includes('repeat-resume')
          ? ${JSON.stringify(join(workspace, 'extra.json'))}
          : ${JSON.stringify(join(workspace, lossMode === 'first-rename' ? 'output.json' : 'extra.json'))})) {
          process.send({ boundary: ${JSON.stringify(lossMode)} });
          await new Promise(() => {});
        }
        return result;
      };
      syncBuiltinESMExports();
    }
    const runtime = createAgRuntime(${JSON.stringify({ ...options, auditRoot: join(root, 'pc-audit') })});
    if (!process.argv.includes('restart') && ${JSON.stringify(afterReceipt)}) {
      runtime.pcAgent.remoteOperationBoundary = async boundary => {
        if (boundary === 'workflow-receipt-persisted') {
          process.send({ boundary: 'receipt-before-claim-release' }); await new Promise(() => {});
        }
      };
    }
    if (!process.argv.includes('restart') && ${JSON.stringify(lossMode === 'before-receipt')}) {
      runtime.pcAgent.evidenceCollector.collect = async () => {
        process.send({ boundary: 'before-receipt' }); await new Promise(() => {});
      };
    }
    const server = createPcAgentServer(runtime.pcAgent, { apiGuard: new PcAgentApiGuard({
      apiToken: 'test-response-loss-admin-1234567890', executionToken: ${JSON.stringify(executionToken)} }) });
    const cleanupRecovery = await runtime.pcAgent.recoverCompletedWorkflowCleanup();
    await listenOnFetchSafePort(server); process.send({ port: server.address().port, cleanupRecovery });
  `);
  let child, upstream, originalPacket, drops = 0, dispatches = 0, starts = 0, startupCleanup;
  const runtimes = [];
  const proxy = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      if (req.url === '/execution-packets') { dispatches++; originalPacket = JSON.parse(Buffer.concat(chunks)).packet; }
      const response = await fetch(upstream + req.url, { method: req.method,
        headers: { authorization: req.headers.authorization, 'content-type': 'application/json' },
        ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) });
      const bytes = Buffer.from(await response.arrayBuffer());
      if (req.url === '/execution-packets') {
        assert.equal(response.status, 200);
        const receipt = JSON.parse(bytes);
        assert.equal(receipt.status, 'COMPLETED');
        drops++;
        if (lossMode === 'truncated-body') {
          res.writeHead(200, { 'content-type': 'application/json', 'content-length': bytes.length });
          res.write(bytes.subarray(0, Math.min(64, bytes.length - 1)));
          // Flush a real incomplete body before ending the socket, rather than
          // merely returning a synthetic client error.
          setImmediate(() => res.destroy());
        } else res.destroy();
        return;
      }
      res.writeHead(response.status, { 'content-type': 'application/json' }); res.end(bytes);
    } catch (error) { res.destroy(error); }
  });
  async function stopPc() {
    if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
  }
  t.after(async () => {
    proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve));
    await stopPc();
    for (const runtime of runtimes) {
      runtime.pcAgent.remoteOperationStore?.close();
      await runtime.coreFacade.cognition?.close?.();
    }
    await rm(root, { recursive: true, force: true });
  });
  async function startPc() {
    // Deliberately omit JARVIS and credential variables from the parent environment.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|COMSPEC|USERPROFILE|APPDATA|LOCALAPPDATA)$/i.test(key)));
    const args = starts === 0 ? [] : starts === 1 && repeatRequested ? ['restart', 'repeat-resume'] : ['restart'];
    starts++;
    child = fork(childFile, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let errors = ''; child.stderr.on('data', chunk => { errors += chunk; }); child.stdout.resume();
    const result = await Promise.race([once(child, 'message').then(([message]) => message),
      once(child, 'exit').then(([code]) => { throw new Error(`PC exited ${code}: ${errors}`); })]);
    upstream = `http://127.0.0.1:${result.port}`;
    startupCleanup = result.cleanupRecovery;
  }
  await startPc(); await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const client = () => new PcAgentExecutionClient({ baseUrl: `http://127.0.0.1:${proxy.address().port}`, executionToken });
  const coreOptions = { ...options, auditRoot: join(root, 'core-audit'), cwd: () => workspace };
  const first = createAgRuntime(coreOptions); runtimes.push(first);
  first.orchestrationWorker.pcAgent = client();
  const created = first.missionRuntime.createMission({
    objective: "'input.json' JSON을 '원본'으로 읽고; '원본'의 개수가 1인지 검증하고; '원본'을 'output.json' JSON으로 저장해"
      + (duringPublication ? "; '원본'을 'extra.json' JSON으로 저장해" : ''),
    authorization: { grants: ['read_only', 'local_reversible'] },
    successCriteria: [{ statement: '합계 7이 저장된다.', verificationSpec: {
      version: 1, kind: 'json.value', path: 'output.json', pointer: '/0/total', equals: 7 } }] });
  const boundary = processKill ? once(child, 'message') : null;
  const running = first.missionRuntime.runMission(created.missionId);
  if (boundary) {
    assert.equal((await boundary)[0].boundary, lossMode);
    await stopPc(); // Actual B process death after create-only publication, before adapter returns.
  }
  const interrupted = await running;
  assert.equal(drops, processKill ? 0 : 1); assert.equal(dispatches, 1);
  assert.equal(interrupted.status, 'PAUSED', JSON.stringify(interrupted));
  assert.equal(interrupted.stopReason, 'action-recovery-required');
  const target = join(workspace, 'output.json');
  const bytes = await readFile(target), before = await stat(target);
  assert.deepEqual(JSON.parse(bytes), [{ total: 7 }]);
  const action = interrupted.waves[0].actions[0];
  assert.ok(action.operation.resumeAuthorization);
  assert.equal(JSON.stringify(action.operation.resumeAuthorization).includes(originalPacket.capabilityToken.capabilityToken), false);
  if (!processKill) {
    const receipt = await first.orchestrationWorker.pcAgent.taskResult(action.taskId);
    assert.equal(receipt.status, 'COMPLETED');
  }
  const journalPath = join(root, 'pc-audit', 'packet-journal.jsonl');
  const journal = await readFile(journalPath);
  if (!duringPublication) assert.ok(journal.toString().includes(action.taskId));
  await stopPc(); await startPc();
  const operationDb = new DatabaseSync(join(root, 'pc-audit', 'remote-operations.sqlite'), { readOnly: true });
  try {
    assert.equal(operationDb.prepare('SELECT count(*) AS n FROM remote_operation_claims').get().n, duringPublication ? 2 : 0);
    const publication = operationDb.prepare("SELECT state FROM remote_operations WHERE operation_id LIKE 'workflow_publish_%'").get();
    assert.ok(publication);
    assert.equal(publication.state === 'succeeded', !duringPublication);
  } finally { operationDb.close(); }
  if (afterReceipt) {
    assert.equal(startupCleanup.items.find(item => item.taskId === action.taskId)?.status, 'removed', JSON.stringify(startupCleanup));
    assert.equal((await readdir(workspace)).some(name => name.startsWith('.jarvis-workflow-stage-') || name.includes('.jarvis-publish-')), false);
  }
  if (duringPublication) {
    const observation = await client().taskPublication(action.taskId);
    assert.equal(observation.status, 'observed', JSON.stringify(observation));
    assert.equal(observation.contractBinding.status, 'bound');
    assert.match(observation.contractBinding.packetFingerprint, /^[a-f0-9]{64}$/);
    assert.equal(observation.executionAuthority, false); assert.equal(observation.completedReceipt, false);
    assert.deepEqual(observation.files.map(file => file.state), lossMode === 'first-rename' ? ['after', 'before'] : ['after', 'after']);
    const stages = (await readdir(workspace)).filter(name => name.startsWith('.jarvis-workflow-stage-'));
    assert.equal(stages.length, 1);
    const records = (await readFile(join(workspace, stages[0], 'publication-journal.jsonl'), 'utf8'))
      .trim().split('\n').map(line => JSON.parse(line));
    const stageJournalPath = join(workspace, stages[0], 'publication-journal.jsonl');
    const originalStageJournal = await readFile(stageJournalPath);
    const replaced = structuredClone(records); replaced[0].workflowId = 'substituted-after-restart';
    await writeFile(stageJournalPath, replaced.map(record => JSON.stringify(record)).join('\n') + '\n');
    const substituted = await client().taskPublication(action.taskId);
    assert.equal(substituted.status, 'conflict');
    assert.equal(substituted.contractBinding.reason, 'publication-contract-mismatch');
    assert.equal(substituted.executionAuthority, false);
    await writeFile(stageJournalPath, originalStageJournal);
    assert.equal((await client().taskPublication(action.taskId)).contractBinding.status, 'bound');
    const intent = records[0];
    assert.equal(intent.version, 'workflow-publication-journal-v1');
    assert.equal(intent.phase, 'prepared'); assert.equal(intent.taskId, action.taskId);
    assert.equal(typeof intent.packetId, 'string');
    assert.equal(intent.specSha256, createHash('sha256').update(JSON.stringify(action.operation.dispatch.arguments.spec)).digest('hex'));
    assert.deepEqual(intent.files.map(file => file.path), [target, join(workspace, 'extra.json')]);
    assert.ok(intent.files.every(file => file.existedBefore === false && file.beforeSha256 === null && file.changed === true));
    assert.equal(intent.files[0].afterSha256, createHash('sha256').update(bytes).digest('hex'));
    for (const file of intent.files) {
      assert.equal(createHash('sha256').update(await readFile(file.stagePath)).digest('hex'), file.afterSha256);
    }
    assert.deepEqual(records.map(record => record.phase), lossMode === 'first-rename'
      ? ['prepared', 'publishing'] : lossMode === 'before-receipt'
        ? ['prepared', 'publishing', 'published', 'publishing', 'published', 'all-files-published']
        : ['prepared', 'publishing', 'published', 'publishing']);
    if (lossMode !== 'before-receipt') assert.equal(records.at(-1).path, join(workspace, lossMode === 'first-rename' ? 'output.json' : 'extra.json'));
  }
  let fresh = createAgRuntime(coreOptions); runtimes.push(fresh);
  if (!autoRequested) fresh.missionRuntime.resumeWorkflowPublication = async () => false;
  if (localRequested) {
    // The interrupted execution above used an actual killed B process. Recover
    // its persisted state with the normal in-process executor, not the HTTP client.
    await stopPc();
    const local = createAgRuntime({ ...options, auditRoot: join(root, 'pc-audit') });
    runtimes.push(local);
    fresh.orchestrationWorker.pcAgent = local.pcAgent;
    assert.equal(fresh.orchestrationWorker.pcAgent instanceof PcAgentExecutionClient, false);
  } else fresh.orchestrationWorker.pcAgent = client();
  assert.equal(fresh.coreFacade.getTask(action.taskId), undefined);
  let redispatches = 0;
  fresh.orchestrationWorker.runTask = async () => { redispatches++; throw new Error('unexpected redispatch'); };
  let autoCalls = 0;
  if (autoRequested) {
    const resume = fresh.orchestrationWorker.pcAgent.resumeWorkflowPublication.bind(fresh.orchestrationWorker.pcAgent);
    fresh.orchestrationWorker.pcAgent.resumeWorkflowPublication = async packet => { autoCalls++; return resume(packet); };
    if (resumeFault === 'grant-revoked') fresh.missionRuntime.updateMission(created.missionId, { authorization: { grants: ['read_only'] } });
    if (resumeFault === 'policy-blocked') fresh.coreFacade.policyEngine.evaluatePlan = () => ({ decision: 'block' });
    if (resumeFault === 'policy-escalated') {
      const evaluate = fresh.coreFacade.policyEngine.evaluatePlan.bind(fresh.coreFacade.policyEngine);
      fresh.coreFacade.policyEngine.evaluatePlan = input => ({ ...evaluate(input), risk: { tier: 2 } });
    }
    if (resumeFault === 'cancelled') fresh.missionRuntime.cancelMission(created.missionId);
    if (resumeFault === 'identity-changed') {
      const internal = fresh.missionRuntime.missions.get(created.missionId);
      internal.waves[0].actions[0].operation.resumeAuthorization.packet.action.arguments.allowOverwrite = true;
      fresh.missionRuntime.touch(internal, 'synthetic-resume-identity-change');
    }
  }
  if (resumeRequested) {
    const denied = await fetch(`http://127.0.0.1:${proxy.address().port}/execution-packets/resume-workflow`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ packet: originalPacket, dryRun: false }) });
    assert.equal(denied.status, 401);
    if (resumeFault === 'input-change') await writeFile(join(workspace, 'input.json'), '[{"total":8}]');
    if (resumeFault === 'target-change') await writeFile(join(workspace, 'extra.json'), 'later user text');
    if (resumeFault === 'recipe-change') {
      const stage = (await readdir(workspace)).find(name => name.startsWith('.jarvis-workflow-stage-'));
      await writeFile(join(workspace, stage, 'recovery-recipe.json'), '{"version":"substituted"}');
    }
    const resumePacket = structuredClone(originalPacket);
    if (resumeFault === 'substituted-arguments') resumePacket.action.arguments.allowOverwrite = true;
    resumePacket.capabilityToken = fresh.policyRuntime.capabilities.issue({ taskId: resumePacket.taskId, planId: resumePacket.planId,
      approvalId: resumePacket.userConfirmation.approvalId, action: resumePacket.action, allowedPaths: [workspace],
      ...(resumeFault === 'expired' ? { ttlMs: 1 } : {}) });
    if (resumeFault === 'expired') await new Promise(resolve => setTimeout(resolve, 10));
    const resumed = await client().resumeWorkflowPublication(resumePacket);
    if (resumedSuccessfully) {
      assert.equal(resumed.status, 'COMPLETED', JSON.stringify(resumed));
      assert.equal(resumed.executionResult.evidence.workflow.resumedPublication.resumedFiles, lossMode === 'first-rename' ? 1 : 0);
      assert.equal(resumed.executionResult.evidence.workflow.resumedPublication.preservedFiles, lossMode === 'first-rename' ? 1 : 2);
      assert.equal((await readdir(workspace)).filter(name => name.startsWith('.jarvis-workflow-stage-')).length, 0);
    } else {
      assert.notEqual(resumed.status, 'COMPLETED');
      const expectedCode = { 'input-change': 'WORKFLOW_SOURCE_CHANGED_DURING_EXECUTION',
        'target-change': 'WORKFLOW_RESUME_PUBLICATION_CONFLICT', 'recipe-change': 'WORKFLOW_RESUME_RECIPE_CHANGED',
        expired: 'EXPIRED', 'substituted-arguments': 'B_IDEMPOTENCY_CONFLICT' }[resumeFault];
      assert.match(JSON.stringify(resumed), new RegExp(expectedCode));
    }
  }
  let repeatExtraMtime = null;
  if (repeatRequested) {
    const boundaryAgain = once(child, 'message');
    const interruptedAgain = fresh.missionRuntime.runMission(created.missionId);
    assert.equal((await boundaryAgain)[0].boundary, lossMode);
    await stopPc();
    const stateAgain = await interruptedAgain;
    assert.equal(stateAgain.status, 'PAUSED');
    assert.equal(stateAgain.metrics.workflowResumeCalls, 1);
    assert.deepEqual(JSON.parse(await readFile(join(workspace, 'extra.json'), 'utf8')), [{ total: 7 }]);
    repeatExtraMtime = (await stat(join(workspace, 'extra.json'))).mtimeMs;
    assert.equal((await readdir(workspace)).filter(name => name.includes('.jarvis-publish-')).length, 2);
    await startPc();
    fresh = createAgRuntime(coreOptions); runtimes.push(fresh);
    fresh.orchestrationWorker.pcAgent = client();
    const resumeAgain = fresh.orchestrationWorker.pcAgent.resumeWorkflowPublication.bind(fresh.orchestrationWorker.pcAgent);
    fresh.orchestrationWorker.pcAgent.resumeWorkflowPublication = async packet => { autoCalls++; return resumeAgain(packet); };
    fresh.orchestrationWorker.runTask = async () => { redispatches++; throw new Error('unexpected second redispatch'); };
  }
  const recovered = await fresh.missionRuntime.runMission(created.missionId);
  assert.equal(recovered.status, resumeFault === 'cancelled' ? 'CANCELLED' : duringPublication && !resumedSuccessfully ? 'PAUSED' : 'COMPLETED', JSON.stringify(recovered));
  if (autoRequested) {
    assert.equal(autoCalls, resumedSuccessfully ? repeatRequested ? 2 : 1 : 0);
    assert.equal(recovered.metrics.workflowResumeCalls ?? 0, resumedSuccessfully ? repeatRequested ? 2 : 1 : 0);
  }
  if (!duringPublication || resumedSuccessfully) assert.equal(recovered.waves[0].actions[0].recovery.source, 'pc-task-receipt');
  else if (resumeFault !== 'cancelled') {
    assert.equal(recovered.stopReason, 'action-recovery-required');
    assert.equal(recovered.waves[0].actions[0].recovery.error.publication.status, resumeFault === 'target-change' ? 'conflict' : 'observed');
    assert.equal(recovered.waves[0].actions[0].recovery.error.publication.contractBinding.status, 'bound');
    const extra = await readFile(join(workspace, 'extra.json')).catch(error => {
      assert.equal(error.code, 'ENOENT'); return null;
    });
    assert.equal(extra === null, lossMode === 'first-rename' && resumeFault !== 'target-change');
    if (extra) {
      if (resumeFault === 'target-change') assert.equal(extra.toString(), 'later user text');
      else assert.deepEqual(JSON.parse(extra), [{ total: 7 }]);
    }
    t.diagnostic(JSON.stringify({ actualBKill: true, boundary: lossMode,
      publishedFiles: lossMode === 'first-rename' ? 1 : 2, status: recovered.status,
      redispatches, dispatches, completedReceipt: false, durablePublicationIntent: true }));
  }
  assert.equal(redispatches, 0); assert.equal(dispatches, 1);
  if (afterReceipt) {
    const reconciledDb = new DatabaseSync(join(root, 'pc-audit', 'remote-operations.sqlite'), { readOnly: true });
    try {
      assert.equal(reconciledDb.prepare('SELECT count(*) AS n FROM remote_operation_claims').get().n, 0);
      assert.equal(reconciledDb.prepare("SELECT state FROM remote_operations WHERE operation_id LIKE 'workflow_publish_%'").get().state, 'succeeded');
    } finally { reconciledDb.close(); }
    assert.equal((await client().taskResult(action.taskId)).status, 'COMPLETED');
    t.diagnostic(JSON.stringify({ actualBKill: true, boundary: lossMode, status: recovered.status,
      redispatches, dispatches, completedReceipt: true, releasedClaims: 1 }));
  }
  assert.deepEqual(await readFile(target), bytes);
  assert.equal((await stat(target)).mtimeMs, before.mtimeMs);
  if (!resumeRequested && !resumedSuccessfully) {
    const afterJournal = await readFile(journalPath);
    if (!duringPublication) {
      assert.deepEqual(afterJournal.subarray(0, journal.length), journal);
      const marker = JSON.parse(afterJournal.subarray(journal.length).toString().trim());
      assert.equal(marker.recordType, 'workflow_cleanup_result');
      assert.equal(marker.taskId, action.taskId); assert.equal(marker.status, afterReceipt ? 'removed' : 'not-present');
    } else assert.deepEqual(afterJournal, journal);
  }
  else {
    const reconciledDb = new DatabaseSync(join(root, 'pc-audit', 'remote-operations.sqlite'), { readOnly: true });
    try { assert.equal(reconciledDb.prepare('SELECT count(*) AS n FROM remote_operation_claims').get().n, resumedSuccessfully ? 0 : 2); }
    finally { reconciledDb.close(); }
    if (resumedSuccessfully) {
      assert.deepEqual(JSON.parse(await readFile(join(workspace, 'extra.json'), 'utf8')), [{ total: 7 }]);
      assert.equal((await readdir(workspace)).some(name => name.includes('.jarvis-publish-')), false);
      if (repeatRequested) assert.equal((await stat(join(workspace, 'extra.json'))).mtimeMs, repeatExtraMtime);
    }
  }
  if (duringPublication && !resumeRequested && !autoRequested) {
    const denied = await fetch(`http://127.0.0.1:${proxy.address().port}/tasks/${encodeURIComponent(action.taskId)}/publication`);
    assert.equal(denied.status, 401);
    await writeFile(target, 'a later user edit');
    const conflict = await client().taskPublication(action.taskId);
    assert.equal(conflict.status, 'conflict'); assert.equal(conflict.files[0].state, 'conflict');
    assert.equal(await readFile(target, 'utf8'), 'a later user edit', 'observation never overwrites a later edit');
    const stage = (await readdir(workspace)).find(name => name.startsWith('.jarvis-workflow-stage-'));
    const publicationPath = join(workspace, stage, 'publication-journal.jsonl');
    const publicationBytes = await readFile(publicationPath);
    await writeFile(publicationPath, Buffer.concat([publicationBytes, Buffer.from('{truncated')]));
    const invalid = await client().taskPublication(action.taskId);
    assert.equal(invalid.status, 'unavailable'); assert.equal(invalid.reason, 'truncated-journal');
    assert.deepEqual(await readFile(publicationPath), Buffer.concat([publicationBytes, Buffer.from('{truncated')]));
  }
});
}
