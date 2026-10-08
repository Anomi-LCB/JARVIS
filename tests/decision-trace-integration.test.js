import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { createConfiguredCoreServiceRuntime } from '../scripts/core-service-runtime.mjs';
import { createCoreServer } from '../packages/core/src/main.mjs';
import { CoreAdminScope } from '../packages/core/src/security/core-admin-auth.js';
import { listenOnFetchSafePort } from '../packages/shared/src/http.js';
import { ApprovalDecision, createApprovalDecision, ModuleId } from '../packages/shared/src/types.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-decision-integration-'));
  const env = {
    JARVIS_TEST_MODE: '1', JARVIS_TEST_AUDIT_ROOT: root, JARVIS_CORE_ROOT: root,
    JARVIS_CORE_ALLOWED_ROOTS: root, JARVIS_CORE_ADMIN_TOKEN: 'decision-test-token',
    JARVIS_CORE_WORKER_DAEMON_ENABLED: '0', JARVIS_CORE_WORKER_DAEMON_AUTOSTART: '0',
    JARVIS_PERSONAL_IMPORT_ENABLED: '0', JARVIS_GOOGLE_SYNC_ENABLED: '0'
  };
  let runtime = await createConfiguredCoreServiceRuntime({ env });
  t.after(async () => {
    await runtime.close();
    const child = relative(resolve(tmpdir()), resolve(root));
    assert.ok(child.startsWith('jarvis-decision-integration-') && !child.includes('..'));
    await rm(root, { recursive: true, force: true });
  });
  return {
    root, get runtime() { return runtime; },
    async restart() { await runtime.close(); runtime = await createConfiguredCoreServiceRuntime({ env }); return runtime; }
  };
}

function trace(runtime, task, overrides = {}) {
  return runtime.coreFacade.cognition.decisionTrace({
    taskId: task.taskId, taskRequest: task.request,
    workspaceRoot: runtime.coreFacade.workspaceRoot, ...overrides
  });
}

function decision(task, value, options = {}) {
  return createApprovalDecision({
    approvalId: task.approvalCard.approvalId, taskId: task.taskId, decision: value,
    deviceId: 'synthetic-device', sourceModule: ModuleId.MOBILE, ...options
  });
}

test('actual worker and G link scoped decisions to a verified file result, deduplicate, and survive a configured Core restart', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'synthetic-input.txt'), 'synthetic local input');
  const task = f.runtime.coreFacade.createTask('파일 목록 보여줘', {
    userId: 'synthetic-owner', metadata: { conversationId: 'synthetic-conversation' }
  });
  const run = await f.runtime.orchestrationWorker.runTask(task.taskId, { deviceId: 'synthetic-worker' });
  assert.equal(run.success, true);
  assert.equal(run.executionVerification.status, 'passed');
  const recorded = trace(f.runtime, task);
  assert.deepEqual(recorded.decisions.map(row => row.kind), ['request', 'approve']);
  assert.equal(recorded.decisions.at(-1).origin, 'worker-generated');
  assert.equal(recorded.counts.verifiedPass, 1);
  assert.equal(recorded.counts.verifiedFail, 0);
  assert.equal(recorded.outcomes.length, 1);
  f.runtime.orchestrationWorker.storeRun(run);
  assert.deepEqual(trace(f.runtime, task), recorded);

  await f.restart();
  assert.equal(f.runtime.coreFacade.getTask(task.taskId), undefined);
  assert.deepEqual(trace(f.runtime, task), recorded);
  const address = await listenOnFetchSafePort(f.runtime.server, { host: '127.0.0.1', port: 0 });
  const path = `/cognition/decisions/${encodeURIComponent(task.taskId)}`;
  const base = `http://127.0.0.1:${address.port}${path}`;
  const url = `${base}?userId=synthetic-owner&conversationId=synthetic-conversation`;
  assert.equal((await fetch(url)).status, 401);
  const headers = { Authorization: 'Bearer decision-test-token' };
  assert.equal((await fetch(url, { method: 'POST', headers })).status, 405);
  const response = await fetch(url, { headers });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), recorded);
  for (const scope of ['userId=another-owner&conversationId=synthetic-conversation', 'userId=synthetic-owner&conversationId=other-conversation', '']) {
    const result = await (await fetch(`${base}?${scope}`, { headers })).json();
    assert.equal(result.decisions.length, 0);
    assert.equal(result.outcomes.length, 0);
  }
  assert.equal((await fetch(`${base}?userId=`, { headers })).status, 400);
  const serialized = JSON.stringify(recorded);
  for (const privateValue of [task.taskId, task.request.requestId, task.approvalCard.approvalId,
    run.packet.packetId, run.executionVerification.verificationId, f.root, 'synthetic-owner', 'synthetic-conversation']) {
    assert.equal(serialized.includes(privateValue), false, 'public trace contains hashes, not source identifiers');
  }
  const dbBytes = await readFile(f.runtime.options.cognitionStorePath);
  assert.equal(dbBytes.includes(Buffer.from('파일 목록 보여줘')), false);
});

test('only successfully applied decisions are recorded and caller-provided CORE origin cannot impersonate worker generation', async t => {
  const f = await fixture(t), core = f.runtime.coreFacade;
  const task = core.createTask('파일 목록 보여줘');
  const invalid = core.submitApprovalDecision(decision(task, ApprovalDecision.APPROVE, { approvalId: 'wrong-card' }));
  assert.equal(invalid.success, false);
  assert.deepEqual(trace(f.runtime, task).decisions.map(row => row.kind), ['request']);
  const submitted = decision(task, ApprovalDecision.APPROVE, { sourceModule: ModuleId.CORE, deviceId: 'core_worker' });
  assert.equal(core.submitApprovalDecision(submitted).success, true);
  assert.equal(core.submitApprovalDecision(submitted).reason, 'already-approved');
  const applied = trace(f.runtime, task);
  assert.deepEqual(applied.decisions.map(row => row.kind), ['request', 'approve']);
  assert.equal(applied.decisions.at(-1).origin, 'applied-submission');
  assert.equal(applied.outcomes.length, 0);
  const run = await f.runtime.orchestrationWorker.runTask(task.taskId, { approvalDecision: submitted });
  assert.equal(run.success, true);
  assert.equal(trace(f.runtime, task).counts.verifiedPass, 1);
  assert.equal(core.submitApprovalDecision(decision(task, ApprovalDecision.REJECT)).success, false);
  assert.equal(trace(f.runtime, task).decisions.length, 2, 'post-completion rejection is not applied');
});

test('actual replan preserves separate request lineage and rejects its stale approval card before recording a final rejection', async t => {
  const f = await fixture(t), core = f.runtime.coreFacade;
  const task = core.createTask('파일 목록 보여줘');
  const originalApproval = task.approvalCard.approvalId;
  const originalPlan = task.plan.planId;
  const edited = core.submitApprovalDecision(decision(task, ApprovalDecision.EDIT, {
    editRequest: { rawText: '현재 폴더의 파일 목록을 보여줘' }
  }));
  assert.equal(edited.success, true);
  assert.notEqual(task.plan.planId, originalPlan);
  let result = trace(f.runtime, task);
  assert.deepEqual(result.decisions.map(row => row.kind), ['request', 'replan']);
  assert.notEqual(result.decisions[0].planRef, result.decisions[1].planRef);
  assert.equal(core.submitApprovalDecision(decision(task, ApprovalDecision.APPROVE, { approvalId: originalApproval })).success, false);
  assert.equal(trace(f.runtime, task).decisions.length, 2);
  const rejection = decision(task, ApprovalDecision.REJECT);
  assert.equal(core.submitApprovalDecision(rejection).success, true);
  assert.equal(core.submitApprovalDecision(rejection).success, false);
  result = trace(f.runtime, task);
  assert.deepEqual(result.decisions.map(row => row.kind), ['request', 'replan', 'reject']);
  assert.equal(result.outcomes.length, 0);
  assert.equal(result.counts.verifiedPass, 0);
  await f.restart();
  assert.deepEqual(trace(f.runtime, task), result);
});

test('decision lookup requires diagnostics scope and always uses the server workspace', async t => {
  const f = await fixture(t), core = f.runtime.coreFacade;
  const task = core.createTask('파일 목록 보여줘');
  const server = createCoreServer(core, { adminToken: null, adminTokenHash: null, adminTokens: [
    { token: 'reader', scopes: [CoreAdminScope.READ_DIAGNOSTICS] },
    { token: 'worker-only', scopes: [CoreAdminScope.CONTROL_WORKER_DAEMON] }
  ] });
  t.after(async () => { if (server.listening) await new Promise(resolveClose => server.close(resolveClose)); });
  const address = await listenOnFetchSafePort(server, { host: '127.0.0.1', port: 0 });
  const url = `http://127.0.0.1:${address.port}/cognition/decisions/${encodeURIComponent(task.taskId)}`;
  assert.equal((await fetch(url, { headers: { Authorization: 'Bearer worker-only' } })).status, 403);
  const response = await fetch(`${url}?workspaceRoot=untrusted-client-workspace`, { headers: { Authorization: 'Bearer reader' } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), trace(f.runtime, task));
  assert.equal(trace(f.runtime, task, { workspaceRoot: 'another-workspace' }).decisions.length, 0);
});
