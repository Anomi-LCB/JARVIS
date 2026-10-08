import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfiguredCoreServiceRuntime } from '../scripts/core-service-runtime.mjs';
import { listenOnFetchSafePort } from '../packages/shared/src/http.js';
import { ClaudeCliTaskPlanner } from '../packages/core/src/planning/claude-cli-task-planner.js';
import { IntentParser } from '../packages/core/src/intent/intent-parser.js';
import { ApprovalDecision, createApprovalDecision, createTaskRequest, ModuleId } from '../packages/shared/src/types.js';

test('real local worker evidence enters cognition, survives restart and changes the next plan context; endpoint is read-only and authenticated', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-cognition-integration-'));
  const env = { JARVIS_TEST_MODE: '1', JARVIS_TEST_AUDIT_ROOT: root, JARVIS_CORE_ALLOWED_ROOTS: root,
    JARVIS_CORE_ADMIN_TOKEN: 'cognition-test', JARVIS_CORE_WORKER_DAEMON_ENABLED: '0', JARVIS_CORE_WORKER_DAEMON_AUTOSTART: '0',
    JARVIS_PERSONAL_IMPORT_ENABLED: '0', JARVIS_GOOGLE_SYNC_ENABLED: '0' };
  let runtime;
  try {
    await writeFile(join(root, 'input.txt'), '실제 파일');
    runtime = await createConfiguredCoreServiceRuntime({ env });
    const task = runtime.coreFacade.createTask('파일 목록 보여줘');
    const prediction = task.plan.cognitiveContext.expectedVerificationPass;
    const run = await runtime.orchestrationWorker.runTask(task.taskId, { deviceId: 'cognition-test' });
    assert.equal(run.success, true);
    const state = runtime.coreFacade.cognitiveStatus();
    assert.equal(state.memory.episodeCount, 1, JSON.stringify({ verification: run.executionVerification?.status, state }));
    assert.equal(state.recentOutcomes[0].prediction, prediction);
    const provenance=state.recentOutcomes[0].provenance;
    assert.equal(provenance.historicalVerificationStatus,'passed');
    assert.equal(provenance.currentArtifactVerified,false);assert.equal(provenance.executionAuthority,false);
    assert.deepEqual(provenance.validity,{validUntil:null,basis:'unspecified'});
    assert.deepEqual(provenance.revisionHistory,[{action:'observe-verification',at:provenance.observedAt}]);
    assert.ok(provenance.sourceTaskRef&&provenance.sourceVerificationRef&&provenance.usageScopeRef);
    assert.equal(provenance.revisionMode,'append-only-observation');
    runtime.orchestrationWorker.storeRun(run);
    assert.equal(runtime.coreFacade.cognitiveStatus().memory.episodeCount, 1);
    const identity = state.identity.id;
    await runtime.close();
    runtime = await createConfiguredCoreServiceRuntime({ env });
    assert.equal(runtime.coreFacade.cognitiveStatus().identity.id, identity);
    assert.equal(runtime.coreFacade.cognitiveStatus().memory.episodeCount, 1);
    const next = runtime.coreFacade.createTask('파일 목록 보여줘');
    assert.equal(next.plan.cognitiveContext.observedAttempts, 1);
    assert.deepEqual(next.plan.cognitiveContext.memoryEvidence,[provenance]);
    const other=runtime.coreFacade.createTask('파일 목록 보여줘',{metadata:{conversationId:'other-thread'}});
    assert.deepEqual(other.plan.cognitiveContext.memoryEvidence,[]);
    assert.deepEqual(runtime.coreFacade.cognitiveStatus().recentOutcomes[0].provenance,provenance);
    assert.equal(next.plan.cognitiveContext.predictionBasis, 'smoothed-recent-verification-history');
    const address = await listenOnFetchSafePort(runtime.server, { host: '127.0.0.1', port: 0 });
    const url = `http://127.0.0.1:${address.port}/cognition`;
    assert.equal((await fetch(url)).status, 401);
    const headers = { Authorization: 'Bearer cognition-test' };
    assert.equal((await fetch(url, { method: 'POST', headers })).status, 405);
    const response = await fetch(url, { headers });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.identity.id, identity);
    assert.equal(payload.consciousness, 'unestablished');
    assert.equal(payload.boundaries.executionAuthority, false);
    assert.equal(JSON.stringify(payload).includes(root), false);
  } finally { await runtime?.close(); await rm(root, { recursive: true, force: true }); }
});

test('cognitive history reaches the actual model prompt and changes cache identity without changing authority', () => {
  const prompts = [];
  const planner = new ClaudeCliTaskPlanner({ runner: prompt => { prompts.push(prompt); return '{}'; }, clarifyEnabled: false });
  planner.decompositionCache.clear();
  const command = '문서를 작성하고 뉴스도 검색해줘';
  const request = createTaskRequest({ rawText: command });
  const intent = new IntentParser().parse(command, { requestId: request.requestId });
  const context = { mode: 'evidence-sensitive', observedAttempts: 2, verificationFailures: 1, authority: 'advisory-only' };
  planner.createPlan(request, intent, { planningContext: { cognition: context }, contextSnapshot: { snapshotId: 'cog-test' } });
  assert.ok(prompts.some(prompt => prompt.includes('"verificationFailures":1') && prompt.includes('advisory-only')));
  planner.pendingCognitiveContext = context;
  const before = planner.decompositionCacheKey(command);
  planner.pendingCognitiveContext = { ...context, verificationFailures: 2 };
  assert.notEqual(planner.decompositionCacheKey(command), before);
  planner.pendingCognitiveContext = null;
});

test('a rejected approval remains cancelled in cognitive attention after restarting Core', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-cognition-rejected-'));
  const env = { JARVIS_TEST_MODE: '1', JARVIS_TEST_AUDIT_ROOT: root, JARVIS_CORE_ALLOWED_ROOTS: root,
    JARVIS_CORE_ADMIN_TOKEN: 'cognition-rejected-test', JARVIS_CORE_WORKER_DAEMON_ENABLED: '0', JARVIS_CORE_WORKER_DAEMON_AUTOSTART: '0',
    JARVIS_PERSONAL_IMPORT_ENABLED: '0', JARVIS_GOOGLE_SYNC_ENABLED: '0' };
  let runtime;
  try {
    runtime = await createConfiguredCoreServiceRuntime({ env });
    const task = runtime.coreFacade.createTask('파일 목록 보여줘');
    assert.equal(runtime.coreFacade.cognitiveStatus().attention.focus.length, 1);
    const rejection = runtime.coreFacade.submitApprovalDecision(createApprovalDecision({
      approvalId: task.approvalCard.approvalId, taskId: task.taskId,
      decision: ApprovalDecision.REJECT, deviceId: 'cognition-test', sourceModule: ModuleId.CORE
    }));
    assert.equal(rejection.success, true);
    assert.equal(rejection.status, 'CANCELLED');
    assert.equal(runtime.coreFacade.cognitiveStatus().attention.focus.length, 0);
    await runtime.close();
    runtime = await createConfiguredCoreServiceRuntime({ env });
    assert.equal(runtime.coreFacade.cognitiveStatus().attention.focus.length, 0,
      'a cancelled task must not return as remembered WAITING_APPROVAL after restart');
    assert.equal(runtime.coreFacade.cognitiveStatus().memory.episodeCount, 0,
      'approval rejection is not verified execution experience');
  } finally { await runtime?.close(); await rm(root, { recursive: true, force: true }); }
});
