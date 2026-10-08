import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { CognitiveRuntime } from '../packages/core/src/cognition/cognitive-runtime.js';

function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-cognition-test-'));
  const storePath = join(root, 'cognition.sqlite');
  const opened = [];
  let now = Date.parse('2026-09-14T00:00:00.000Z');
  const open = () => {
    const runtime = new CognitiveRuntime({ storePath, clock: () => new Date(now++), ...options });
    opened.push(runtime);
    return runtime;
  };
  t.after(() => {
    for (const runtime of opened) runtime.close();
    const child = relative(resolve(tmpdir()), resolve(root));
    assert.ok(child.startsWith('jarvis-cognition-test-') && !child.includes('..'));
    rmSync(root, { recursive: true, force: true });
  });
  return { root, storePath, open, runtime: open() };
}

function planningInput(taskId, overrides = {}) {
  return {
    taskRequest: {
      taskId, userId: 'owner-1', metadata: { conversationId: 'conversation-1' },
      command: { rawText: 'PRIVATE_COMMAND_MARKER 반드시 원문을 저장하지 않음' }
    },
    intent: { confidence: 0.9 },
    route: { skill: { toolName: 'filesystem.listFiles' } },
    workspaceRoot: 'C:/isolated-cognition-workspace',
    ...overrides
  };
}

function verifiedRun(runtime, taskId, { passed = true, tool = 'filesystem.listFiles' } = {}) {
  const packet = { packetId: `packet_${taskId}`, taskId, planId: `plan_${taskId}` };
  const item = {
    task: { taskId, request: { ...planningInput(taskId).taskRequest, requestId: `request_${taskId}` }, approvalCard: { approvalId: `approval_${taskId}` }, executionPacket: packet,
      status: passed ? 'COMPLETED' : 'FAILED', plan: { planId: packet.planId, action: { toolName: tool } } },
    run: {
      taskId,
      success: passed,
      packet,
      capability: { taskId, planId: packet.planId, approvalId: `approval_${taskId}` },
      execution: { status: 'COMPLETED', evidence: { evidenceId: `evidence_${taskId}` }, executionResult: { content: 'PRIVATE_RESULT_MARKER' } },
      executionVerification: {
        taskId, verificationId: `verification_${taskId}`, status: passed ? 'passed' : 'failed',
        checks: [{ checkId: 'artifact_contents', status: passed ? 'passed' : 'failed' }]
      }
    }
  };
  runtime.recordDecision(item.task, { workspaceRoot: planningInput(taskId).workspaceRoot });
  runtime.bindDecisionVerification(item.run.executionVerification, { task: item.task, execution: item.run.execution, packet, workspaceRoot: planningInput(taskId).workspaceRoot });
  return item;
}

test('identity, verified experience and unfinished goals survive closing and reopening the real SQLite store', t => {
  const f = fixture(t);
  const runtime = f.runtime;
  const identity = runtime.snapshot().identity.id;
  runtime.planningContext(planningInput('completed-1'));
  const completed = verifiedRun(runtime, 'completed-1');
  assert.equal(runtime.observeRun(completed.run, completed.task).recorded, true);
  runtime.planningContext(planningInput('unfinished-1'));
  runtime.close();

  const restored = f.open();
  const snapshot = restored.snapshot();
  assert.equal(snapshot.identity.id, identity);
  assert.equal(snapshot.memory.episodeCount, 1);
  assert.deepEqual(snapshot.attention.focus.map(goal => goal.taskId), [restored.taskKey('unfinished-1')]);
  assert.equal(snapshot.attention.focus[0].continuity, 'remembered-needs-reconciliation');
  const context = restored.planningContext(planningInput('next-task'));
  assert.equal(context.cognition.observedAttempts, 1);
  assert.equal(restored.observeRun(completed.run, completed.task).recorded, false, 'reopened runtime has no current worker binding; persisted history remains readable');
  assert.equal(restored.snapshot().memory.episodeCount, 1);
});

test('verification histories are isolated by owner, conversation, workspace and tool', t => {
  const { runtime } = fixture(t);
  const original = planningInput('original');
  runtime.planningContext(original);
  const failed = verifiedRun(runtime, 'original', { passed: false });
  assert.equal(runtime.observeRun(failed.run, failed.task).recorded, true);
  assert.equal(runtime.planningContext(planningInput('same-scope')).cognition.verificationFailures, 1);

  const variants = [
    { taskRequest: { ...original.taskRequest, taskId: 'other-owner', userId: 'owner-2' } },
    { taskRequest: { ...original.taskRequest, taskId: 'other-conversation', metadata: { conversationId: 'conversation-2' } } },
    { workspaceRoot: 'C:/different-workspace' },
    { route: { skill: { toolName: 'filesystem.readText' } } }
  ];
  for (const [index, change] of variants.entries()) {
    const context = runtime.planningContext(planningInput(`isolated-${index}`, change));
    assert.equal(context.cognition.observedAttempts, 0, JSON.stringify(change));
    assert.equal(context.planningGuardrails.length, 0, JSON.stringify(change));
  }
});

test('bounded attention favors unresolved failures and uncertain interpretation without claiming execution control', t => {
  const { runtime } = fixture(t, { attentionLimit: 2 });
  runtime.planningContext(planningInput('routine', { intent: { confidence: 0.99 } }));
  runtime.planningContext(planningInput('uncertain', { intent: { confidence: 0.2 } }));
  runtime.planningContext(planningInput('failed', { intent: { confidence: 0.95 } }));
  runtime.updateTask({ taskId: 'failed', status: 'FAILED' });
  runtime.planningContext(planningInput('finished', { intent: { confidence: 0 } }));
  runtime.updateTask({ taskId: 'finished', status: 'COMPLETED' });
  const snapshot = runtime.snapshot({ tasks: [{ taskId: 'failed', status: 'FAILED' }] });
  assert.equal(snapshot.attention.activeConsidered, 3);
  assert.deepEqual(snapshot.attention.focus.map(goal => goal.taskId), ['failed', 'uncertain'].map(id => runtime.taskKey(id)));
  assert.equal(snapshot.attention.focus[0].continuity, 'current-runtime');
  assert.equal(snapshot.attention.executionSchedulingChanged, false);
  assert.equal(snapshot.boundaries.executionAuthority, false);
});

test('actual verification outcome is compared with the prediction made before execution', t => {
  const { runtime } = fixture(t);
  const expected = runtime.planningContext(planningInput('prediction', { intent: { confidence: 0.8 } }));
  assert.equal(expected.cognition.expectedVerificationPass, 0.8);
  const failed = verifiedRun(runtime, 'prediction', { passed: false });
  assert.equal(runtime.observeRun(failed.run, failed.task).recorded, true);
  const outcome = runtime.snapshot().recentOutcomes[0];
  assert.equal(outcome.prediction, 0.8);
  assert.equal(outcome.outcome, 0);
  assert.equal(outcome.prediction_error, 0.8);

  const next = runtime.planningContext(planningInput('followup'));
  assert.equal(next.cognition.mode, 'evidence-sensitive');
  assert.equal(next.cognition.verificationFailures, 1);
  assert.equal(next.cognition.expectedVerificationPass, 1 / 3);
  assert.equal(next.cognition.calibratedProbability, false);
  assert.match(next.planningGuardrails[0].sourceFailureId, /^[a-f0-9]{64}$/);
  assert.notEqual(next.planningGuardrails[0].sourceFailureId, 'verification_prediction');
  assert.equal(next.planningGuardrails[0].condition.toolName, 'filesystem.listFiles');
  assert.equal(next.planningGuardrails[0].applyMode, 'preflight_warning');
});

test('routine decisions require a tool route and sufficiently confident interpretation', t => {
  const { runtime } = fixture(t);
  assert.equal(runtime.planningContext(planningInput('known')).cognition.mode, 'routine');
  assert.equal(runtime.planningContext(planningInput('ambiguous', { intent: { confidence: 0.2 } })).cognition.mode, 'evidence-sensitive');
  assert.equal(runtime.planningContext(planningInput('unrouted', { route: null })).cognition.mode, 'evidence-sensitive');
});

test('an older unresolved failure remains in attention after more than 256 routine goals arrive', t => {
  const { runtime } = fixture(t, { attentionLimit: 2 });
  runtime.planningContext(planningInput('older-failure', { intent: { confidence: 0.99 } }));
  runtime.updateTask({ taskId: 'older-failure', status: 'FAILED' });
  for (let i = 0; i < 260; i++) runtime.planningContext(planningInput(`new-routine-${i}`, { intent: { confidence: 0.99 } }));
  assert.equal(runtime.snapshot().attention.focus[0].taskId, runtime.taskKey('older-failure'));
});

test('replaying an identical verified completion records one episode and does not inflate subsequent history', t => {
  const { runtime } = fixture(t);
  runtime.planningContext(planningInput('replayed'));
  const completed = verifiedRun(runtime, 'replayed');
  assert.equal(runtime.observeRun(completed.run, completed.task).recorded, true);
  assert.equal(runtime.observeRun(completed.run, completed.task).duplicate, true);
  for (let i = 0; i < 4; i++) assert.equal(runtime.observeRun(structuredClone(completed.run), structuredClone(completed.task)).recorded, false, 'copied reports cannot stand in for bound worker evidence');
  assert.equal(runtime.snapshot().memory.episodeCount, 1);
  assert.equal(runtime.planningContext(planningInput('after-replay')).cognition.observedAttempts, 1);
});

test('missing, mismatched and contradictory verification cannot become successful experience', async t => {
  const cases = [
    ['dummy execution', item => { item.run.execution = { status: 'COMPLETED', executionResult: { execution: 'dummy' } }; delete item.run.executionVerification; }],
    ['no verification', item => { delete item.run.executionVerification; }],
    ['unknown verification', item => { item.run.executionVerification.status = 'unknown'; }],
    ['wrong report task', item => { item.run.executionVerification.taskId = 'unrelated-task'; }],
    ['missing report ID', item => { delete item.run.executionVerification.verificationId; }],
    ['missing execution evidence', item => { delete item.run.execution.evidence; }],
    ['empty checks', item => { item.run.executionVerification.checks = []; }],
    ['failed check in passed report', item => { item.run.executionVerification.checks[0].status = 'failed'; }],
    ['failed report without failed checks', item => { item.run.executionVerification.status = 'failed'; }],
    ['unsuccessful run', item => { item.run.success = false; }],
    ['failed execution marked passed', item => { item.run.execution.status = 'FAILED'; }],
    ['route changed after prediction', item => { item.task.plan.action.toolName = 'email.send'; }]
  ];
  for (const [name, alter] of cases) await t.test(name, sub => {
    const { runtime } = fixture(sub);
    runtime.planningContext(planningInput('rejected'));
    const item = verifiedRun(runtime, 'rejected');
    alter(item);
    assert.equal(runtime.observeRun(item.run, item.task).recorded, false);
    assert.equal(runtime.snapshot().memory.episodeCount, 0);
  });
});

test('dry runs at every supported execution envelope are excluded from experience', async t => {
  const cases = [
    ['run', item => { item.run.dryRun = true; }],
    ['packet', item => { item.run.packet.dryRun = true; }],
    ['execution', item => { item.run.execution.dryRun = true; }],
    ['execution result', item => { item.run.execution.executionResult.dryRun = true; }],
    ['evidence', item => { item.run.execution.evidence.dryRun = true; }]
  ];
  for (const [name, alter] of cases) await t.test(name, sub => {
    const { runtime } = fixture(sub);
    runtime.planningContext(planningInput('dry'));
    const item = verifiedRun(runtime, 'dry');
    alter(item);
    assert.equal(runtime.observeRun(item.run, item.task).recorded, false);
    assert.equal(runtime.snapshot().memory.episodeCount, 0);
  });
});

test('state stores structured outcomes without raw command, result text or consciousness assertions', t => {
  const f = fixture(t);
  f.runtime.planningContext(planningInput('private'));
  const item = verifiedRun(f.runtime, 'private');
  f.runtime.observeRun(item.run, item.task);
  const snapshot = f.runtime.snapshot({ registeredTools: ['filesystem.listFiles', 'filesystem.listFiles', 'email.send'] });
  assert.equal(snapshot.consciousness, 'unestablished');
  assert.equal(snapshot.memory.rawContentStored, false);
  assert.equal(snapshot.capabilityAwareness.registeredToolCount, 2);
  assert.equal(snapshot.capabilityAwareness.registrationIsLiveConnection, false);
  f.runtime.close();
  const databaseText = readFileSync(f.storePath).toString('utf8');
  assert.equal(databaseText.includes('PRIVATE_COMMAND_MARKER'), false);
  assert.equal(databaseText.includes('PRIVATE_RESULT_MARKER'), false);
});

test('Korean task and evidence IDs support learning while source command slugs never persist or appear in snapshots', t => {
  const f = fixture(t);
  const privateSlug = '급여명세서를요약해줘_PRIVATE_TASK_SLUG';
  const taskId = `task_${privateSlug}_20260914`;
  f.runtime.planningContext(planningInput(taskId));
  const item = verifiedRun(f.runtime, taskId, { passed: false });
  assert.equal(f.runtime.observeRun(item.run, item.task).recorded, true);
  const snapshot = f.runtime.snapshot({ tasks: [item.task] });
  assert.equal(snapshot.memory.episodeCount, 1);
  assert.equal(snapshot.attention.focus[0].taskId, f.runtime.taskKey(taskId));
  assert.equal(snapshot.attention.focus[0].continuity, 'current-runtime');
  assert.equal(JSON.stringify(snapshot).includes(privateSlug), false);
  const next = f.runtime.planningContext(planningInput('후속계획'));
  assert.equal(next.cognition.verificationFailures, 1);
  assert.match(next.planningGuardrails[0].sourceFailureId, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(next).includes(privateSlug), false);
  f.runtime.close();
  const databaseText = readFileSync(f.storePath).toString('utf8');
  assert.equal(databaseText.includes(privateSlug), false);
  assert.equal(databaseText.includes(taskId), false);
  assert.equal(databaseText.includes(item.run.executionVerification.verificationId), false);
  const restored = f.open();
  assert.equal(restored.snapshot().memory.episodeCount, 1);
  assert.equal(restored.observeRun(item.run, item.task).recorded, false);
  assert.equal(restored.planningContext(planningInput('재시작후속계획')).cognition.verificationFailures, 1);
});

test('auxiliary storage failure cannot cause a verified external action to throw or retry', t => {
  const { runtime } = fixture(t);
  runtime.planningContext(planningInput('storage-failed'));
  const item = verifiedRun(runtime, 'storage-failed');
  runtime.close();
  assert.doesNotThrow(() => runtime.observeRun(item.run, item.task));
  const snapshot = runtime.snapshot();
  assert.equal(snapshot.storage.status, 'degraded');
  assert.equal(snapshot.storage.error.code, 'A_COGNITION_STORAGE_FAILED');
  assert.equal(snapshot.memory.episodeCount, null);
});
