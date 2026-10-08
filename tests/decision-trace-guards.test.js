import test from 'node:test';
import assert from 'node:assert/strict';
import { CognitiveRuntime } from '../packages/core/src/cognition/cognitive-runtime.js';

// Unit-level adversarial inputs only. Actual G and tool execution are covered by
// decision-trace-cases/integration; this fixture does not establish task success.
function fixture(t, owner = 'synthetic-owner') {
  const cognition = new CognitiveRuntime();
  t.after(() => cognition.close());
  const workspaceRoot = process.cwd();
  const task = { taskId: 'task synthetic', request: { requestId: 'request synthetic', userId: owner,
    metadata: { conversationId: 'conversation synthetic' }, command: { rawText: 'private synthetic request' } },
    plan: { planId: 'plan synthetic' }, approvalCard: { approvalId: 'approval synthetic' } };
  const packet = { taskId: task.taskId, planId: task.plan.planId, packetId: 'packet synthetic',
    capabilityToken: { taskId: task.taskId, planId: task.plan.planId, approvalId: task.approvalCard.approvalId } };
  task.executionPacket = packet;
  const execution = { status: 'COMPLETED', evidence: { evidenceId: 'evidence synthetic' }, executionResult: { ok: true } };
  const report = { taskId: task.taskId, verificationId: 'G synthetic', status: 'passed', checks: [{ status: 'passed' }] };
  const run = { taskId: task.taskId, success: true, packet, execution, executionVerification: report };
  cognition.recordDecision(task, { workspaceRoot });
  const bind = () => cognition.bindDecisionVerification(report, { task, execution, packet, workspaceRoot });
  const query = () => cognition.decisionTrace({ taskId: task.taskId, taskRequest: task.request, workspaceRoot });
  return { cognition, workspaceRoot, task, packet, execution, report, run, bind, query };
}

test('original dispatch cannot bind to a task replanned while verification was pending', t => {
  const f = fixture(t);
  f.task.plan = { planId: 'new plan' };
  f.task.executionPacket = { ...f.packet, planId: 'new plan', packetId: 'new packet' };
  assert.equal(f.bind(), false);
  f.cognition.observeRun(f.run, f.task);
  assert.equal(f.query().outcomes.length, 0);
});

test('mutating a bound report, execution or scope and cloning a report cannot create an outcome', async t => {
  const attacks = {
    report: f => { f.report.checks.push({ status: 'failed' }); },
    evidence: f => { f.execution.evidence.evidenceId = 'another evidence'; },
    result: f => { f.execution.executionResult.ok = false; },
    scope: f => { f.task.request.userId = 'different owner'; },
    clone: f => { f.run.executionVerification = structuredClone(f.report); }
  };
  for (const [name, mutate] of Object.entries(attacks)) await t.test(name, st => {
    const f = fixture(st);
    assert.equal(f.bind(), true);
    mutate(f);
    f.cognition.observeRun(f.run, f.task);
    assert.equal(f.query().outcomes.length, 0);
  });
});

test('a late structured opt-out removes only this scoped task projection', t => {
  const f = fixture(t);
  const other = structuredClone(f.task);
  other.request.userId = 'other owner';
  f.cognition.recordDecision(other, { workspaceRoot: f.workspaceRoot });
  assert.equal(f.bind(), true);
  f.run.learning = { memoryEvent: { learningFlags: { doNotRemember: true } } };
  f.cognition.observeRun(f.run, f.task);
  assert.equal(f.query().decisions.length, 0);
  assert.equal(f.query().outcomes.length, 0);
  const preserved = f.cognition.decisionTrace({ taskId: other.taskId, taskRequest: other.request, workspaceRoot: f.workspaceRoot });
  assert.equal(preserved.decisions.length, 1);
});

test('identifier whitespace is preserved while absent ownership never widens the query', t => {
  const f = fixture(t);
  const other = structuredClone(f.task);
  other.taskId += ' ';
  other.request.requestId += ' ';
  f.cognition.recordDecision(other, { workspaceRoot: f.workspaceRoot });
  const separate = f.cognition.decisionTrace({ taskId: other.taskId, taskRequest: other.request, workspaceRoot: f.workspaceRoot });
  assert.notEqual(separate.taskRef, f.query().taskRef);
  assert.notEqual(separate.decisions[0].requestRef, f.query().decisions[0].requestRef);
  assert.equal(separate.decisions.length, 1);
  for (const missing of [{}, { taskId: f.task.taskId }, { taskId: f.task.taskId, taskRequest: f.task.request }]) {
    assert.deepEqual(f.cognition.decisionTrace(missing), { error: 'scope-and-task-required' });
  }
});

test('execution opt-out is honored even when G failure prevented F ingestion', t => {
  const f = fixture(t);
  f.execution.memoryEvent = { learningFlags: { doNotRemember: true } };
  f.run.learning = null;
  f.report.status = 'failed';
  f.report.checks = [{ status: 'failed' }];
  f.bind();
  f.cognition.observeRun(f.run, f.task);
  assert.equal(f.query().decisions.length, 0);
  assert.equal(f.query().outcomes.length, 0);
});

test('new projection persistence failure cannot throw into an already completed action', t => {
  const f = fixture(t);
  f.bind();
  f.cognition.close();
  assert.doesNotThrow(() => f.cognition.observeRun(f.run, f.task));
  assert.equal(f.cognition.decisionTrace({ taskId: f.task.taskId, taskRequest: f.task.request, workspaceRoot: f.workspaceRoot }), null);
  assert.equal(f.cognition.lastError.code, 'A_COGNITION_STORAGE_FAILED');
});
