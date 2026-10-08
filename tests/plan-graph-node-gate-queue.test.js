import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createConfiguredCoreServiceRuntime } from '../scripts/core-service-runtime.mjs';

const workerPath = process.env.JARVIS_GRAPH_GATE_SOURCE_PATH ?? 'packages/core/src/orchestration/core-orchestration-worker.js';
const runnerPath = 'tests/plan-graph-node-gate-queue.test.js';
const hash = value => createHash('sha256').update(value).digest('hex');
const workerSha256 = hash(readFileSync(workerPath));
const runnerSha256 = hash(readFileSync(runnerPath));
const startedAt = new Date().toISOString();
const retryCode = 'A_WORKER_PLAN_GRAPH_VERIFICATION_RETRY_SUPPRESSED';
const cost = { externalAccountCalls: 0, additionalModelCalls: 0, inputTokens: 0, outputTokens: 0,
  externalModelUsd: 0, localComputeUsd: null };
const cases = [
  { id: 'queue-node-g-failure', kind: 'node', count: 2 },
  { id: 'queue-aggregate-g-failure', kind: 'aggregate', count: 2 },
  { id: 'same-task-prior-node-report', kind: 'prior-node', count: 3 }
];
const results = cases.map(item => ({ id: item.id, status: 'not-run', cost }));
async function exists(path) { try { return (await stat(path)).isFile(); } catch { return false; } }

async function setup(t, item, row) {
  assert.equal(process.env.JARVIS_TEST_MODE, '1', 'Run only through scripts/run-tests.mjs');
  const root = await mkdtemp(join(tmpdir(), 'jarvis-graph-gate-queue-'));
  const state = { root, runtime: null, task: null, paths: [], firstReport: null, injected: false };
  t.after(async () => {
    await state.runtime?.close();
    const child = relative(resolve(tmpdir()), resolve(root));
    assert.ok(child.startsWith('jarvis-graph-gate-queue-') && !child.startsWith('..') && !isAbsolute(child));
    await rm(root, { recursive: true, force: true });
  });
  const env = { JARVIS_TEST_MODE: '1', JARVIS_TEST_AUDIT_ROOT: root, JARVIS_CORE_ROOT: root,
    JARVIS_CORE_ALLOWED_ROOTS: root, JARVIS_CORE_ADMIN_TOKEN: 'synthetic-queue-gate-token',
    JARVIS_CORE_WORKER_DAEMON_ENABLED: '0', JARVIS_CORE_WORKER_DAEMON_AUTOSTART: '0',
    JARVIS_PERSONAL_IMPORT_ENABLED: '0', JARVIS_GOOGLE_SYNC_ENABLED: '0', JARVIS_EXTERNAL_DEVICE_PROBES: '0',
    JARVIS_LLM_INTENT: '0', JARVIS_LLM_PLANNER: '0', JARVIS_LLM_CONTENT: '0' };
  state.runtime = await createConfiguredCoreServiceRuntime({ env });
  const { coreFacade, orchestrationWorker: worker } = state.runtime;
  state.worker = worker;
  state.task = coreFacade.createTask(Array(item.count).fill('파일 만들어').join(' 그리고 '),
    { userId: 'synthetic-queue-owner', metadata: { conversationId: item.id } });
  const nodes = state.task.plan.planGraph.nodes.filter(node => node.nodeId.startsWith('action_'));
  assert.equal(nodes.length, item.count);
  for (const node of nodes) {
    assert.equal(node.toolName, 'filesystem.createTextFile');
    const outputPath = join(root, `synthetic-${node.nodeId}.txt`);
    state.paths.push({ nodeId: node.nodeId, path: outputPath });
    node.arguments = { ...node.arguments, path: outputPath, fileName: `synthetic-${node.nodeId}.txt`,
      content: `Synthetic queue output ${item.id} ${node.nodeId}`, outputFormat: 'txt', targetDirectoryHint: 'workspace' };
    node.affectedItems = [outputPath];
  }
  const originalReceive = worker.pcAgent.receiveExecutionPacket.bind(worker.pcAgent);
  worker.pcAgent.receiveExecutionPacket = async (...args) => {
    row.dispatchedNodeIds.push(args[0].planGraphNodeId);
    const execution = await originalReceive(...args);
    row.bExecutions.push({ nodeId: args[0].planGraphNodeId, status: execution.status,
      outputCount: execution.executionResult?.outputPaths?.length ?? 0 });
    return execution;
  };
  const originalG = worker.verifyExecution.bind(worker);
  worker.verifyExecution = async (...args) => {
    const nodeId = args[3]?.contextId;
    row.nodeGCalls++;
    let bytes, outputPath;
    if (item.kind === 'node' && nodeId === 'action_1') {
      outputPath = state.paths[0].path;
      bytes = await readFile(outputPath);
      await rm(outputPath);
      assert.equal(await exists(outputPath), false, 'Real G must observe the synthetic output missing');
    }
    let report;
    try { row.actualGCalls++; report = await originalG(...args); }
    finally { if (bytes) await writeFile(outputPath, bytes); }
    row.nodeGReports.push({ nodeId, taskCurrent: report.taskId === state.task.taskId, status: report.status,
      expectedVerificationRef: args[3]?.verificationId ? hash(args[3].verificationId) : null,
      actualVerificationRef: hash(report.verificationId) });
    if (bytes) {
      assert.equal(report.status, 'failed');
      assert.ok(report.checks.some(check => check.checkId.startsWith('file_exists:') && check.status === 'failed'));
      state.injected = true;
      row.injection = 'Real synthetic output removed before actual G, then identical bytes restored; no rollback executed.';
    } else if (item.kind === 'prior-node') {
      assert.equal(report.status, 'passed', 'Real current-node G must pass before the stale-report injection');
      if (nodeId === 'action_1') state.firstReport = report;
      if (nodeId === 'action_2') {
        assert.ok(state.firstReport);
        assert.equal(state.firstReport.taskId, report.taskId);
        assert.notEqual(state.firstReport.verificationId, report.verificationId);
        state.injected = true;
        row.injection = 'Return-boundary fault: reuse actual action_1 G report for action_2 within the same task.';
        row.returnedStaleVerificationRef = hash(state.firstReport.verificationId);
        return state.firstReport;
      }
    }
    return report;
  };
  const originalAggregate = worker.verifyPlanGraphExecution.bind(worker);
  worker.verifyPlanGraphExecution = async (...args) => {
    row.aggregateGCalls++;
    const report = await originalAggregate(...args);
    row.actualAggregateStatus = report.status;
    if (item.kind !== 'aggregate') return report;
    assert.equal(report.status, 'passed', 'Real aggregate must pass before return-boundary fault injection');
    state.injected = true;
    row.injection = 'Return-boundary fault: critical aggregate-only failure after every actual node G passed.';
    return { ...report, status: 'failed', checks: [...report.checks,
      { checkId: 'synthetic_aggregate_postcondition', severity: 'critical', status: 'failed' }] };
  };
  return state;
}

function queueSnapshot(result) {
  return { processed: result.processed, reason: result.reason ?? null, retrySuppressed: result.retrySuppressed ?? null,
    item: result.item ? { status: result.item.status, attempts: result.item.attempts,
      retrySuppressed: result.item.retrySuppressed, lastError: result.item.lastError } : null };
}

async function capture(state, row) {
  row.injectionObserved = state.injected;
  row.taskStatus = state.task?.status ?? null;
  row.taskGraphVerificationFailed = state.task?.planGraphRun?.verificationFailed === true;
  row.files = await Promise.all(state.paths.map(async item => ({ nodeId: item.nodeId, present: await exists(item.path) })));
}

async function verifyQueueRetrySuppression(state, row, item) {
  const { worker, task } = state;
  const firstItem = worker.enqueueTask(task.taskId, { maxAttempts: 3, baseBackoffMs: 1 });
  const first = await worker.runNext();
  row.queueStages.push({ stage: 'initial-execution', ...queueSnapshot(first) });
  row.initialRunSuccess = first.run?.success ?? null;
  row.initialGraphVerificationFailed = first.run?.planGraphRun?.verificationFailed ?? null;
  assert.equal(state.injected, true);
  assert.equal(first.run?.success, false);
  assert.equal(first.run?.planGraphRun?.verificationFailed, true);
  assert.equal(task.status, 'FAILED');
  assert.equal(task.planGraphRun?.verificationFailed, true, 'Persisted task state must protect a newly enqueued item');
  assert.equal(first.item.status, 'failed');
  assert.equal(first.item.attempts, 1);
  assert.equal(first.item.retrySuppressed, true);
  assert.equal(first.item.lastError, retryCode);
  const expectedNodes = item.kind === 'node' ? ['action_1'] : ['action_1', 'action_2'];
  assert.deepEqual(row.dispatchedNodeIds, expectedNodes);
  assert.ok(row.bExecutions.every(result => result.status === 'COMPLETED'));
  const counts = { dispatches: row.dispatchedNodeIds.length, nodeG: row.nodeGCalls, aggregateG: row.aggregateGCalls, runs: worker.runs.length };
  // Advance the query time instead of sleeping, so a wrongly scheduled retry cannot hide behind backoff.
  const next = await worker.runNext({ now: new Date(Date.now() + 60_000).toISOString() });
  row.queueStages.push({ stage: 'after-backoff-horizon', ...queueSnapshot(next) });
  assert.equal(next.processed, false);
  const newItem = worker.enqueueTask(task.taskId, { maxAttempts: 3, baseBackoffMs: 1 });
  assert.notEqual(newItem.queueId, firstItem.queueId, 'This must exercise a distinct newly enqueued queue item');
  const renewed = await worker.runNext();
  row.queueStages.push({ stage: 'same-task-new-item', ...queueSnapshot(renewed) });
  assert.equal(renewed.processed, true);
  assert.equal(renewed.retrySuppressed, true);
  assert.equal(renewed.reason, retryCode);
  assert.equal(renewed.item.status, 'failed');
  assert.equal(renewed.item.retrySuppressed, true);
  assert.equal(renewed.item.lastError, retryCode);
  assert.deepEqual({ dispatches: row.dispatchedNodeIds.length, nodeG: row.nodeGCalls,
    aggregateG: row.aggregateGCalls, runs: worker.runs.length }, counts, 'Retries must not redispatch B, reverify or create a second run');
  row.additionalDispatchesAfterRetryAttempts = row.dispatchedNodeIds.length - counts.dispatches;
  row.sameTaskNewQueueIdDistinct = true;
  await capture(state, row);
  for (const file of row.files) assert.equal(file.present, expectedNodes.includes(file.nodeId), 'Keep actual partial effects and do not create undispatched outputs');
}

for (const [index, item] of cases.entries()) {
  test(`Node G gate supplementary regression: ${item.id}`, async t => {
    const row = results[index], started = performance.now();
    Object.assign(row, { status: 'running', startedAt: new Date().toISOString(), dispatchedNodeIds: [],
      bExecutions: [], nodeGCalls: 0, actualGCalls: 0, aggregateGCalls: 0, nodeGReports: [], queueStages: [] });
    let state;
    try {
      state = await setup(t, item, row);
      if (item.kind !== 'prior-node') await verifyQueueRetrySuppression(state, row, item);
      else {
        const run = await state.worker.runTask(state.task.taskId, { deviceId: 'synthetic-queue-worker' });
        row.runSuccess = run.success;
        row.nodeStates = run.planGraphRun?.nodeRuns.map(node => ({ nodeId: node.nodeId, status: node.status,
          executionStatus: node.executionStatus, verificationGate: node.verificationGate }));
        assert.equal(state.injected, true);
        assert.equal(run.success, false);
        assert.equal(run.planGraphRun?.verificationFailed, true);
        assert.deepEqual(row.dispatchedNodeIds, ['action_1', 'action_2']);
        const failedNode = run.planGraphRun.nodeRuns.find(node => node.nodeId === 'action_2');
        assert.equal(failedNode.status, 'failed');
        assert.equal(failedNode.executionStatus, 'COMPLETED');
        assert.equal(failedNode.verificationGate.status, 'failed');
        assert.equal(failedNode.verificationGate.reason, 'report-invalid');
        assert.equal(row.aggregateGCalls, 0, 'Reject stale evidence before the graph aggregate phase');
        await capture(state, row);
        assert.deepEqual(row.files.map(file => file.present), [true, true, false]);
      }
      row.status = 'passed';
    } catch (error) {
      if (state) await capture(state, row);
      row.status = 'failed';
      row.error = { name: error.name, code: error.code ?? null, message: error.message };
      throw error;
    } finally { row.elapsedMs = performance.now() - started; row.finishedAt = new Date().toISOString(); }
  });
}

after(() => {
  const workerUnchanged = hash(readFileSync(workerPath)) === workerSha256;
  if (process.env.JARVIS_GRAPH_GATE_QUEUE_REPORT) {
    const output = resolve(process.env.JARVIS_GRAPH_GATE_QUEUE_REPORT), child = relative(resolve('artifacts'), output);
    assert.ok(child && !child.startsWith('..') && !isAbsolute(child));
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, JSON.stringify({ version: 'jarvis-plan-graph-node-gate-supplementary-v1', startedAt,
      finishedAt: new Date().toISOString(), workerPath, workerSha256, workerUnchanged, runnerPath, runnerSha256,
      status: !workerUnchanged ? 'inconclusive' : results.every(row => row.status === 'passed') ? 'passed' : 'failed',
      planned: cases.length, passed: results.filter(row => row.status === 'passed').length,
      failed: results.filter(row => row.status === 'failed').length, notRun: results.filter(row => row.status === 'not-run').length,
      results, limitations: ['Supplementary regressions developed after the candidate patch; not part of the independently frozen eight-case comparison.',
        'Configured Core, actual PC file creation and node G in isolated temporary roots. No network, models, real accounts or production services.',
        'Aggregate failure and prior-node-report reuse are explicitly synthetic return-boundary faults.',
        'Queue retry and re-enqueue are tested within one runtime; crash/restart recovery is not evaluated.',
        'Partial output preservation is checked, but no compensation is executed. Local compute monetary cost is unmeasured.'] }, null, 2) + '\n');
  }
  assert.equal(workerUnchanged, true, 'Worker changed while evaluating');
});
