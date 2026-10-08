import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createConfiguredCoreServiceRuntime } from '../scripts/core-service-runtime.mjs';

const fixturePath = 'artifacts/research-heartbeat-20260924/graph-gate-cases-v1.json';
const fixtureSha256 = '463e87b43bdec6299b22d03839eb39e23c29b146b80548289f484f88ff8c3558';
const workerPath = 'packages/core/src/orchestration/core-orchestration-worker.js';
const evaluatedWorkerPath = process.env.JARVIS_GRAPH_GATE_SOURCE_PATH ?? workerPath;
const runnerPath = 'tests/plan-graph-node-gate.test.js';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(hash(readFileSync(fixturePath)), fixtureSha256, 'Independent oracle must stay frozen');
const suite = JSON.parse(readFileSync(fixturePath, 'utf8'));
const workerSha256 = hash(readFileSync(evaluatedWorkerPath));
const runnerSha256 = hash(readFileSync(runnerPath));
const startedAt = new Date().toISOString();
const cost = { externalAccountCalls: 0, additionalModelCalls: 0, inputTokens: 0, outputTokens: 0,
  externalModelUsd: 0, localComputeUsd: null, basis: 'Isolated deterministic local file tools; no model, network or external account calls.' };
const results = suite.cases.map(item => ({ id: item.id, scenario: item.scenario, status: 'not-run', cost }));
const sorted = values => [...values].sort();
const latch = () => { let release; const promise = new Promise(resolveValue => { release = resolveValue; }); return { promise, release }; };
async function bounded(promise, message) {
  let timer;
  // The audit also runs late in the full multi-file suite, where accumulated
  // worker pools can delay the two real B completions. A 30s bound fired there
  // before G was reached even though this fixture passes in isolation. Keep a
  // finite failure bound while allowing normal host contention to settle.
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 90000); })]); }
  finally { clearTimeout(timer); }
}
async function exists(path) { try { return (await stat(path)).isFile(); } catch { return false; } }

async function setup(t, item, observation) {
  assert.equal(process.env.JARVIS_TEST_MODE, '1', 'Run via scripts/run-tests.mjs');
  const root = await mkdtemp(join(tmpdir(), 'jarvis-graph-gate-'));
  const env = { JARVIS_TEST_MODE: '1', JARVIS_TEST_AUDIT_ROOT: root, JARVIS_CORE_ROOT: root,
    JARVIS_CORE_ALLOWED_ROOTS: root, JARVIS_CORE_ADMIN_TOKEN: 'synthetic-gate-token',
    JARVIS_CORE_WORKER_DAEMON_ENABLED: '0', JARVIS_CORE_WORKER_DAEMON_AUTOSTART: '0',
    JARVIS_PERSONAL_IMPORT_ENABLED: '0', JARVIS_GOOGLE_SYNC_ENABLED: '0', JARVIS_EXTERNAL_DEVICE_PROBES: '0',
    JARVIS_LLM_INTENT: '0', JARVIS_LLM_PLANNER: '0', JARVIS_LLM_CONTENT: '0' };
  const state = { root, runtime: null, executions: new Map(), injected: false,
    injectionNode: item.injection.nodeId, held: latch(), release: latch(), bothExecuted: latch() };
  t.after(async () => {
    state.release.release(); state.bothExecuted.release();
    await state.runtime?.close();
    const child = relative(resolve(tmpdir()), resolve(root));
    assert.ok(child.startsWith('jarvis-graph-gate-') && !child.startsWith('..') && !isAbsolute(child));
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(join(root, 'synthetic-input.txt'), 'Synthetic local graph verification input.');
  state.runtime = await createConfiguredCoreServiceRuntime({ env });
  const { coreFacade, orchestrationWorker: worker } = state.runtime;
  state.worker = worker;
  const writes = Boolean(item.expect.effectfulExecutedNodeIds);
  const command = item.graph.nodes.map(() => writes ? '파일 만들어' : '파일 목록 보여줘').join(' 그리고 ');
  const task = coreFacade.createTask(command, { userId: 'synthetic-gate-owner', metadata: { conversationId: item.id } });
  state.task = task;
  const nodes = task.plan.planGraph.nodes.filter(node => node.nodeId.startsWith('action_'));
  assert.deepEqual(nodes.map(node => node.nodeId), item.graph.nodes, 'Use actual Core decomposition before installing explicit oracle dependency topology');
  const readAction = writes && item.graph.parallelRootWave
    ? coreFacade.createTask('파일 목록 보여줘', { userId: 'synthetic-gate-owner' }).plan.action : null;
  state.paths = new Map();
  for (const node of nodes) {
    if (writes && !(item.graph.parallelRootWave && node.nodeId === 'action_3')) {
      assert.equal(node.toolName, 'filesystem.createTextFile');
      const outputPath = join(root, `synthetic-${node.nodeId}.txt`);
      state.paths.set(node.nodeId, outputPath);
      node.arguments = { ...node.arguments, path: outputPath, fileName: `synthetic-${node.nodeId}.txt`,
        content: `Synthetic output for ${item.id} ${node.nodeId}`, outputFormat: 'txt', targetDirectoryHint: 'workspace' };
      node.affectedItems = [outputPath];
    } else if (readAction) {
      Object.assign(node, { actionType: readAction.actionType, toolName: readAction.toolName,
        skillId: readAction.skillId, arguments: { ...readAction.arguments }, compensationRef: null });
    }
  }
  // Explicit fixture topology tests the executor, not arbitrary natural-language graph inference.
  const graph = task.plan.planGraph;
  graph.edges = [...graph.edges.filter(edge => !(edge.from?.startsWith('action_') && edge.to?.startsWith('action_'))),
    ...item.graph.edges.map(([from, to]) => ({ from, to, condition: 'success', dependencyType: 'hard_dependency' }))];
  graph.scheduler = coreFacade.localTaskPlanner.planGraphScheduleFor({ nodes: graph.nodes, edges: graph.edges,
    executionMode: item.graph.parallelRootWave ? 'parallel_ready' : 'sequential_safe' });
  if (item.graph.parallelRootWave) worker.maxPlanParallelism = Math.max(worker.maxPlanParallelism, 2);
  observation.topology = { nodes: item.graph.nodes, edges: item.graph.edges, fixtureTopologyInstalledBeforeApproval: true };
  if (item.injection.kind === 'missing-report') task.request.metadata.verification = { status: 'passed', source: 'untrusted-test-metadata' };

  const originalReceive = worker.pcAgent.receiveExecutionPacket.bind(worker.pcAgent);
  worker.pcAgent.receiveExecutionPacket = async (packet, options) => {
    const id = packet.planGraphNodeId;
    observation.dispatchedNodeIds.push(id);
    const execution = await originalReceive(packet, options);
    state.executions.set(id, execution);
    observation.bExecutions.push({ nodeId: id, status: execution.status, outputCount: execution.executionResult?.outputPaths?.length ?? 0,
      evidenceRef: execution.evidence?.evidenceId ? hash(execution.evidence.evidenceId) : null });
    if (item.injection.kind === 'missing-report' && id === state.injectionNode) execution.executionResult.summary = 'success-shaped synthetic summary';
    if (item.graph.parallelRootWave?.every(nodeId => state.executions.get(nodeId)?.status === 'COMPLETED')) state.bothExecuted.release();
    return execution;
  };
  const originalG = worker.verifyExecution.bind(worker);
  worker.verifyExecution = async (...args) => {
    const id = args[3]?.contextId;
    observation.gBoundaryCalls++;
    const entry = { nodeId: id, injected: id === state.injectionNode, kind: id === state.injectionNode ? item.injection.kind : 'actual-g', actualGCalled: false };
    observation.gObservations.push(entry);
    if (item.graph.parallelRootWave) {
      await bounded(state.bothExecuted.promise, 'Both real B actions must finish before either G returns');
      observation.bothInFlightCompletionsObserved = true;
    }
    if (id === state.injectionNode && item.injection.kind === 'missing-report') {
      state.injected = true; entry.returned = null; return null;
    }
    if (id === state.injectionNode && item.injection.kind === 'verification-exception') {
      state.injected = true; entry.errorCode = item.injection.errorCode;
      throw Object.assign(new Error(item.injection.errorCode), { code: item.injection.errorCode });
    }
    const outputPath = state.paths.get(id);
    const realFileFailure = id === state.injectionNode && outputPath
      && ['failed-report', 'failed-report-after-wave-barrier'].includes(item.injection.kind);
    let originalBytes;
    if (realFileFailure) {
      originalBytes = await readFile(outputPath);
      await rm(outputPath);
      assert.equal(await exists(outputPath), false, 'Actual file deletion fault must be observable by G');
      entry.kind = 'real-file-temporarily-removed-before-actual-g';
    }
    let report;
    try { entry.actualGCalled = true; observation.actualGCalls++; report = await originalG(...args); }
    finally {
      if (originalBytes) { await writeFile(outputPath, originalBytes); entry.syntheticFileRestoredAfterG = true; }
    }
    entry.actualStatus = report?.status ?? null;
    entry.actualFailedChecks = (report?.checks ?? []).filter(check => check.status === 'failed').map(check => check.checkId.split(':')[0]);
    if (realFileFailure) {
      assert.equal(report?.status, 'failed', 'Real G must reject the removed output');
      assert.ok(report.checks.some(check => check.status === 'failed' && check.checkId.startsWith('file_exists:')));
      state.injected = true;
    } else if (id === state.injectionNode) {
      assert.equal(report?.status, 'passed', 'The actual G baseline must pass before return-boundary fault injection');
      switch (item.injection.kind) {
        case 'delay-valid-report':
          state.injected = true; state.held.release(); await bounded(state.release.promise, 'Test latch was not released'); break;
        case 'failed-report':
          report = { ...report, status: 'failed', checks: [...report.checks,
            { checkId: 'synthetic_critical_postcondition', severity: 'critical', status: 'failed' }] };
          state.injected = true; break;
        case 'empty-passed-report': report = { ...report, checks: [] }; state.injected = true; break;
        case 'wrong-task-report': report = { ...report, taskId: 'different-synthetic-task' }; state.injected = true; break;
        default: assert.fail(`Unimplemented fault: ${item.injection.kind}`);
      }
    }
    entry.returned = { status: report?.status ?? null, checksCount: report?.checks?.length ?? 0,
      currentTask: report?.taskId === task.taskId, verificationRef: report?.verificationId ? hash(report.verificationId) : null };
    return report;
  };
  return state;
}

async function capture(state, run, observation) {
  const graph = run?.planGraphRun;
  observation.runSuccess = run?.success ?? null;
  observation.taskStatus = state.task.status;
  observation.nodeStates = (graph?.nodeRuns ?? []).map(node => ({ nodeId: node.nodeId, status: node.status,
    executionStatus: node.executionStatus, verificationStatus: node.verificationStatus,
    verificationGate: node.verificationGate ?? null }));
  observation.compensationTargetNodeIds = graph?.partialCompensation?.targetNodeIds ?? [];
  observation.compensationActionNodeIds = (graph?.partialCompensation?.actions ?? []).map(action => action.targetNodeId);
  observation.files = await Promise.all([...state.paths].map(async ([nodeId, path]) => ({ nodeId, present: await exists(path) })));
  observation.injectionObserved = state.injected;
  const trace = state.runtime.coreFacade.cognition.decisionTrace({ taskId: state.task.taskId,
    taskRequest: state.task.request, workspaceRoot: state.runtime.coreFacade.workspaceRoot });
  observation.wholeGraphVerifiedPassCount = trace?.counts?.verifiedPass ?? 0;
  observation.effectfulExecutedNodeIds = [...state.executions].filter(([,execution]) => execution.status === 'COMPLETED'
    && execution.executionResult?.changedItems?.length > 0).map(([nodeId]) => nodeId);
  observation.structuredPartialRunReturned = Boolean(graph && !run.success && Array.isArray(graph.nodeRuns));
  observation.failure = run?.failure?.reason ?? run?.error?.code ?? null;
}

function verify(state, run, item, observation) {
  const expected = item.expect, nodes = run?.planGraphRun?.nodeRuns ?? [];
  assert.equal(state.injected, true, 'Required stimulus must actually reach its G boundary');
  assert.equal(run?.success, expected.runSuccess);
  if (expected.dispatchedNodeIds) assert.deepEqual(observation.dispatchedNodeIds, expected.dispatchedNodeIds, 'Dependent dispatch gate');
  if (expected.dispatchedNodeIdsSet) assert.deepEqual(sorted(observation.dispatchedNodeIds), sorted(expected.dispatchedNodeIdsSet));
  for (const [key, status] of [['completedNodeIds','completed'],['failedNodeIds','failed'],['skippedNodeIds','skipped']]) {
    assert.deepEqual(sorted(nodes.filter(node => node.status === status).map(node => node.nodeId)), sorted(expected[key]), key);
  }
  assert.equal(observation.wholeGraphVerifiedPassCount, expected.wholeGraphVerifiedPassCount);
  for (const node of nodes.filter(node => observation.dispatchedNodeIds.includes(node.nodeId))) {
    const actual = state.executions.get(node.nodeId);
    assert.equal(node.executionStatus, actual.status, 'Actual B status must survive the G gate');
    assert.equal(node.artifactBundle.evidenceId, actual.evidence.evidenceId, 'Original B evidence identity must survive');
    assert.deepEqual(node.artifactBundle.outputPaths, actual.executionResult.outputPaths, 'Original B output paths must survive');
  }
  const skipped = new Set(expected.skippedNodeIds);
  assert.ok(observation.compensationTargetNodeIds.every(nodeId => !skipped.has(nodeId)), 'Undispatched descendants cannot be compensated');
  assert.ok(observation.compensationActionNodeIds.every(nodeId => !skipped.has(nodeId)));
  assert.equal(Boolean(run?.planGraphRun?.partialCompensation?.replay?.success), false, 'A plan is not an executed rollback');
  if (expected.dispatchedBeforeGRelease) assert.deepEqual(observation.dispatchedBeforeGRelease, expected.dispatchedBeforeGRelease);
  if (expected.failedNodeExecutionStatusPreserved) assert.equal(nodes.find(node => node.nodeId === item.injection.nodeId)?.executionStatus, expected.failedNodeExecutionStatusPreserved);
  if (expected.effectfulExecutedNodeIds) assert.deepEqual(sorted(observation.effectfulExecutedNodeIds), sorted(expected.effectfulExecutedNodeIds));
  if (expected.compensationEligibleNodeIds) assert.deepEqual(sorted(observation.compensationTargetNodeIds), sorted(expected.compensationEligibleNodeIds));
  for (const nodeId of expected.outputFilesPresentForNodes ?? []) assert.equal(observation.files.find(file => file.nodeId === nodeId)?.present, true);
  for (const nodeId of expected.outputFilesAbsentForNodes ?? []) assert.equal(observation.files.find(file => file.nodeId === nodeId)?.present, false);
  if (expected.undispatchedOutputAbsent) assert.ok(observation.files.filter(file => !observation.dispatchedNodeIds.includes(file.nodeId)).every(file => !file.present));
  if (expected.structuredPartialRunReturned) assert.equal(observation.structuredPartialRunReturned, true);
  if (expected.originalGErrorRetained) assert.ok(JSON.stringify(run.planGraphRun).includes(item.injection.errorCode), 'Original G error code must remain in partial-run diagnostics');
  if (expected.bothInFlightCompletionsObserved) assert.equal(observation.bothInFlightCompletionsObserved, true);
  if (expected.verificationReportMissingRecorded || expected.invalidReportRecorded || expected.failureClass) {
    const failed = nodes.find(node => node.nodeId === item.injection.nodeId);
    assert.equal(failed.verificationGate?.status, 'failed', 'Separate G gate diagnostics are required');
    assert.ok(failed.verificationGate?.reason);
    assert.equal(run.planGraphRun.verificationFailed, true);
  }
}

for (const [index, item] of suite.cases.entries()) {
  test(`Independent node G gate: ${item.id}`, async t => {
    const observation = results[index], start = performance.now();
    Object.assign(observation, { startedAt: new Date().toISOString(), status: 'running', dispatchedNodeIds: [],
      bExecutions: [], gObservations: [], gBoundaryCalls: 0, actualGCalls: 0 });
    let state, run;
    try {
      state = await setup(t, item, observation);
      const pending = state.worker.runTask(state.task.taskId, { deviceId: 'synthetic-gate-worker' });
      pending.catch(() => {});
      if (item.injection.kind === 'delay-valid-report') {
        try { await bounded(state.held.promise, 'The actual first G report did not reach the latch');
          observation.dispatchedBeforeGRelease = [...observation.dispatchedNodeIds]; }
        finally { state.release.release(); }
      }
      run = await pending;
      await capture(state, run, observation);
      verify(state, run, item, observation);
      observation.status = 'passed';
    } catch (error) {
      if (state) await capture(state, run, observation);
      observation.status = 'failed';
      observation.error = { name: error.name, code: error.code ?? null, message: error.message };
      throw error;
    } finally { observation.elapsedMs = performance.now() - start; observation.finishedAt = new Date().toISOString(); }
  });
}

after(() => {
  const fixtureUnchanged = hash(readFileSync(fixturePath)) === fixtureSha256;
  const workerUnchanged = hash(readFileSync(evaluatedWorkerPath)) === workerSha256;
  if (process.env.JARVIS_GRAPH_GATE_REPORT) {
    const output = resolve(process.env.JARVIS_GRAPH_GATE_REPORT), child = relative(resolve('artifacts'), output);
    assert.ok(child && !child.startsWith('..') && !isAbsolute(child) && output !== resolve(fixturePath));
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, JSON.stringify({ version: 'jarvis-plan-graph-node-gate-evaluation-v1', startedAt,
      finishedAt: new Date().toISOString(), fixturePath, fixtureSha256, workerPath, evaluatedWorkerPath, workerSha256, runnerPath, runnerSha256,
      fixtureUnchanged, workerUnchanged, status: !fixtureUnchanged || !workerUnchanged ? 'inconclusive' : results.every(row => row.status === 'passed') ? 'passed' : 'failed',
      planned: suite.cases.length, passed: results.filter(row => row.status === 'passed').length,
      failed: results.filter(row => row.status === 'failed').length, notRun: results.filter(row => row.status === 'not-run').length,
      results, limitations: ['Public independently defined acceptance fixture; not a hidden generalization evaluation.',
        'Real configured Core, local file adapter and G; explicit synthetic graph topology installed before approval.',
        'Missing, throwing, malformed, wrong-task and read-only failed G are return-boundary fault injections.',
        'Write G failures remove a synthetic output, call actual G, then restore exactly the synthetic bytes to inspect partial-effect retention.',
        'No external accounts, production services, personal files or model calls. Local CPU monetary cost is unmeasured.',
        'Compensation planning is observed; no rollback is replayed.'] }, null, 2) + '\n');
  }
  assert.equal(fixtureUnchanged, true); assert.equal(workerUnchanged, true, 'Worker changed while evaluating');
});
