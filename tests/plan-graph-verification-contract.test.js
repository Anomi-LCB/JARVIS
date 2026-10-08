import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { CoreOrchestrationWorker } from '../packages/core/src/orchestration/core-orchestration-worker.js';

// These are synthetic aggregation boundaries, not evidence of live tool success.
// Actual worker/node G wiring is covered separately by graph decision integration.
const observedAt = new Date().toISOString();
const observations = [];
const worker = { clock: () => new Date('2026-09-20T00:00:00Z') };
const report = (id, overrides = {}) => ({ taskId: 'synthetic-task', verificationId: id,
  status: 'passed', checks: [{ checkId: 'synthetic-postcondition', status: 'passed' }], ...overrides });
const target = (nodeId, verification = report(`verification-${nodeId}`)) => ({ nodeId, verification });
const task = (ids = ['action_1', 'action_2']) => ({ taskId: 'synthetic-task', plan: { planGraph: {
  nodes: ids.map(nodeId => ({ nodeId }))
} } });
const cases = [
  { id: 'complete-current-node-reports', expected: 'passed', targets: [target('action_1'), target('action_2')] },
  { id: 'wrong-task', expected: 'failed', guard: 'execution_verification_task_current',
    targets: [target('action_1', report('g1', { taskId: 'other-task' })), target('action_2')] },
  { id: 'empty-node', expected: 'failed', guard: 'execution_verification_checks_present',
    targets: [target('action_1', report('g1', { checks: [] })), target('action_2')] },
  { id: 'status-mismatch', expected: 'failed', guard: 'execution_verification_status_consistent',
    targets: [target('action_1', report('g1', { status: 'failed' })), target('action_2')] },
  { id: 'passed-with-failed-check', expected: 'failed', guard: 'execution_verification_status_consistent',
    targets: [target('action_1', report('g1', { checks: [{ checkId: 'failed-postcondition', status: 'failed' }] })), target('action_2')] },
  { id: 'genuine-node-postcondition-failure', expected: 'failed',
    targets: [target('action_1', report('g1', { status: 'failed', checks: [{ checkId: 'failed-postcondition', status: 'failed' }] })), target('action_2')],
    consistentFailure: true },
  { id: 'missing-action-target', expected: 'failed', guard: 'plan_graph_target_nodes_complete', targets: [target('action_1')] },
  { id: 'duplicate-action-target', expected: 'failed', guard: 'plan_graph_target_nodes_complete', targets: [target('action_1'), target('action_1')] },
  { id: 'unknown-action-target', expected: 'failed', guard: 'plan_graph_target_nodes_complete', targets: [target('action_1'), target('action_unknown')] },
  { id: 'empty-targets', expected: 'failed', guard: 'plan_graph_target_nodes_complete', targets: [] },
  { id: 'missing-verification-id', expected: 'failed', guard: 'execution_verification_identity_unique',
    targets: [target('action_1', report('')), target('action_2')] },
  { id: 'reused-verification-id', expected: 'failed', guard: 'execution_verification_identity_unique',
    targets: [target('action_1', report('same-id')), target('action_2', report('same-id'))] },
  { id: 'missing-node-report', expected: 'failed', guard: 'execution_verification_report_present',
    targets: [target('action_1', null), target('action_2')] },
  { id: 'malformed-node-checks', expected: 'failed', guard: 'execution_verification_checks_present',
    targets: [target('action_1', report('g1', { checks: [null] })), target('action_2')] },
  { id: 'missing-plan', expected: 'failed', guard: 'plan_graph_required_nodes_present', planIds: [], targets: [target('action_1')] },
  { id: 'duplicate-planned-node', expected: 'failed', guard: 'plan_graph_required_nodes_unique',
    planIds: ['action_1', 'action_1'], targets: [target('action_1'), target('action_2')] }
];

for (const item of cases) test(`PlanGraph aggregate contract: ${item.id}`, async () => {
  const started = performance.now();
  const value = await CoreOrchestrationWorker.prototype.verifyPlanGraphExecution.call(worker, task(item.planIds), item.targets);
  observations.push({ case: item.id, expected: item.expected, actual: value.status,
    passed: value.status === item.expected, durationMs: performance.now() - started,
    failedCheckIds: value.checks.filter(check => check.status === 'failed').map(check => check.checkId) });
  assert.equal(value.status, item.expected);
  if (item.guard) assert.ok(value.checks.some(check => check.status === 'failed' && check.checkId.endsWith(item.guard)));
  if (item.consistentFailure) assert.ok(value.checks.filter(check => check.checkId.endsWith('execution_verification_status_consistent'))
    .every(check => check.status === 'passed'), 'a genuine failed postcondition is preserved without inventing a status inconsistency');
});

test('concurrent nodes of a long task have distinct packet and G identities under a fixed clock', async () => {
  const verificationIds = [];
  const fixedWorker = { ...worker, verificationRuntime: { verifyExecution(value) { verificationIds.push(value.verificationId); return value; } } };
  const current = { taskId: 'task_' + 'long-shared-command-prefix'.repeat(4), plan: { planId: 'synthetic-plan' } };
  const basePacket = { taskId: current.taskId, planId: current.plan.planId, packetId: 'synthetic-base-packet', action: {} };
  const packetIds = [];
  for (const nodeId of ['action_1', 'action_2']) {
    const packet = CoreOrchestrationWorker.prototype.createNodeExecutionPacket.call(fixedWorker, { basePacket, node: { nodeId }, capabilityToken: {} });
    packetIds.push(packet.packetId);
    await CoreOrchestrationWorker.prototype.verifyExecution.call(fixedWorker, current,
      { executionResult: { packetId: packet.packetId }, evidence: {} }, {}, { contextId: nodeId });
  }
  assert.equal(new Set(packetIds).size, 2);
  assert.equal(new Set(verificationIds).size, 2);
  const retried = CoreOrchestrationWorker.prototype.createNodeExecutionPacket.call(fixedWorker, {
    basePacket: { ...basePacket, packetId: 'synthetic-retry-packet' }, node: { nodeId: 'action_1' }, capabilityToken: {}
  });
  assert.notEqual(retried.packetId, packetIds[0], 'new parent dispatch keeps its own node packet identity');
  observations.push({ case: 'concurrent-long-task-identities', expectedDistinctCount: 2,
    distinctPacketCount: new Set(packetIds).size, distinctVerificationCount: new Set(verificationIds).size,
    differentRetryPacket: retried.packetId !== packetIds[0], passed: true });
});

after(async () => {
  if (!process.env.JARVIS_PLAN_GRAPH_CONTRACT_REPORT) return;
  const path = resolve(process.env.JARVIS_PLAN_GRAPH_CONTRACT_REPORT);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ observedAt, completedAt: new Date().toISOString(),
    kind: 'synthetic-prototype-boundary-regression', modelCalls: 0, externalCalls: 0,
    results: observations }, null, 2) + '\n');
});
