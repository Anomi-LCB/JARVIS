import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createConfiguredCoreServiceRuntime } from '../scripts/core-service-runtime.mjs';

const fixturePath = 'tests/fixtures/decision-trace-graph-cases-v1.json';
const frozenSha256 = '2aa70dadcfeb0f95fe7f082fb0ab1f8a4a6779433f3fb0efc1e274dfe24cd17b';
const sha = input => createHash('sha256').update(input).digest('hex');
const ref = value => sha(JSON.stringify(value));
const fixtureBytes = readFileSync(fixturePath);
assert.equal(sha(fixtureBytes), frozenSha256, 'Independent graph oracle changed after freezing');
const suite = JSON.parse(fixtureBytes);
const observations = [];
const suiteStartedAt = new Date().toISOString();

async function fixture(t, id) {
  assert.equal(process.env.JARVIS_TEST_MODE, '1', 'Use scripts/run-tests.mjs for isolation');
  const root = await mkdtemp(join(tmpdir(), 'jarvis-graph-cases-'));
  const env = { JARVIS_TEST_MODE: '1', JARVIS_TEST_AUDIT_ROOT: root, JARVIS_CORE_ROOT: root,
    JARVIS_CORE_ALLOWED_ROOTS: root, JARVIS_CORE_ADMIN_TOKEN: 'synthetic-graph-token',
    JARVIS_CORE_WORKER_DAEMON_ENABLED: '0', JARVIS_CORE_WORKER_DAEMON_AUTOSTART: '0',
    JARVIS_PERSONAL_IMPORT_ENABLED: '0', JARVIS_GOOGLE_SYNC_ENABLED: '0',
    JARVIS_LLM_INTENT: '0', JARVIS_LLM_PLANNER: '0', JARVIS_LLM_CONTENT: '0' };
  await writeFile(join(root, 'graph-input.txt'), 'GRAPH_TRACE_PRIVATE_RESULT_MARKER');
  const f = { root, id, gCalls: 0, dispatched: [], verified: [], aggregateCalls: [], rawIds: [], task: null };
  f.runtime = await createConfiguredCoreServiceRuntime({ env });
  f.installObservers = () => {
    const runtime = f.runtime, worker = runtime.orchestrationWorker;
    const receive = worker.pcAgent.receiveExecutionPacket.bind(worker.pcAgent);
    worker.pcAgent.receiveExecutionPacket = async (packet, options) => {
      if (f.beforeDispatch) await f.beforeDispatch(packet, options);
      f.dispatched.push(packet);
      const execution = await receive(packet, options);
      f.rawIds.push(packet.packetId, execution?.evidence?.evidenceId);
      if (f.afterDispatch) await f.afterDispatch(packet, execution);
      return execution;
    };
    const g = worker.verifyExecution.bind(worker);
    worker.verifyExecution = async (...args) => {
      if (f.suppressG?.(...args)) return null;
      const verification = await g(...args);
      f.gCalls++;
      f.verified.push({ task: args[0], execution: args[1], capability: args[2], context: args[3], verification });
      if (verification?.verificationId) f.rawIds.push(verification.verificationId);
      return verification;
    };
    const aggregate = worker.verifyPlanGraphExecution.bind(worker);
    worker.verifyPlanGraphExecution = async (task, targets = []) => {
      const entry = { task, targets, report: null };
      f.aggregateCalls.push(entry);
      if (f.beforeAggregate) targets = await f.beforeAggregate(task, targets);
      entry.submittedTargets = targets;
      entry.report = await aggregate(task, targets);
      return entry.report;
    };
  };
  f.installObservers();
  f.create = (count = 2) => {
    const command = Array.from({ length: count }, () => '파일 목록 보여줘').join(' 그리고 ');
    const task = f.runtime.coreFacade.createTask(command, { userId: 'synthetic-graph-owner-a', metadata: { conversationId: 'synthetic-graph-conversation-a', marker: 'GRAPH_TRACE_PRIVATE_REQUEST_MARKER' } });
    const actions = task.plan.planGraph.nodes.filter(node => node.nodeId.startsWith('action_'));
    assert.equal(actions.length, count, 'Real planner must produce requested required action count');
    f.rawIds.push(task.taskId, task.request.requestId, task.plan.planId, task.approvalCard.approvalId, task.plan.planGraph.graphId);
    f.task = task;
    return task;
  };
  f.trace = (task = f.task, overrides = {}) => {
    const result = f.runtime.coreFacade.cognition.decisionTrace({ taskId: task.taskId, taskRequest: task.request,
      workspaceRoot: f.runtime.coreFacade.workspaceRoot, ...overrides });
    assert.ok(result && Array.isArray(result.outcomes));
    assert.equal(result.truncated, false);
    return result;
  };
  f.run = async options => await f.runtime.orchestrationWorker.runTask(f.task.taskId, { deviceId: 'synthetic-graph-worker', ...options });
  f.restart = async () => { await f.runtime.close(); f.runtime = await createConfiguredCoreServiceRuntime({ env }); };
  t.after(async () => {
    await f.runtime.close();
    const child = relative(resolve(tmpdir()), resolve(root));
    assert.ok(child.startsWith('jarvis-graph-cases-') && !child.includes('..') && !isAbsolute(child));
    await rm(root, { recursive: true, force: true });
  });
  return f;
}

function common(f, result) {
  const db = f.runtime.coreFacade.cognition.db;
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name).filter(name => /decision|trace/.test(name));
  assert.ok(tables.length >= 2);
  const rows = tables.map(name => { assert.match(name, /^[a-z_]+$/); return db.prepare(`SELECT * FROM ${name}`).all(); });
  const serialized = JSON.stringify({ result, rows });
  for (const marker of suite.protocol.bodyMarkers) assert.equal(serialized.includes(marker), false, 'Source body entered the new trace');
  for (const rawId of f.rawIds.filter(value => typeof value === 'string' && value.length > 0)) assert.equal(serialized.includes(rawId), false, 'Source ID was persisted verbatim');
  const boundaries = f.runtime.coreFacade.cognition.snapshot().boundaries;
  assert.equal(boundaries.executionAuthority, false);
  assert.equal(boundaries.backgroundModelCalls, false);
}

function requestFacts(f, result, facts) {
  const request = result.decisions.find(row => row.kind === 'request');
  assert.ok(request);
  assert.equal(request.requestRef, ref(f.task.request.requestId));
  assert.equal(request.sourceRef, ref(f.task.request.requestId));
  assert.equal(request.statementRef, ref(f.task.request.command.rawText));
  facts.add('request-reference');
}

function graphFacts(f, result, run, facts) {
  requestFacts(f, result, facts);
  assert.equal(result.outcomes.length, 1);
  const out = result.outcomes[0], graph = f.task.plan.planGraph;
  assert.equal(out.executionKind, 'plan-graph');
  assert.equal(out.planRef, ref(f.task.plan.planId));
  assert.equal(out.graphRef, ref(graph.graphId));
  facts.add('current-plan-reference');
  assert.equal(out.packetRef, ref(run.packet.packetId)); facts.add('current-base-attempt-reference');
  assert.equal(out.verificationRef, ref(run.executionVerification.verificationId)); facts.add('aggregate-g-reference');
  const actions = graph.nodes.filter(node => node.nodeId.startsWith('action_'));
  assert.equal(out.nodeProofs.length, actions.length);
  assert.deepEqual(out.nodeProofs.map(row => row.nodeRef).sort(), actions.map(node => ref(node.nodeId)).sort());
  assert.equal(new Set(out.nodeProofs.map(row => row.nodeRef)).size, actions.length);
  facts.add('each-required-node-exactly-once');
  for (const node of actions) {
    const packet = f.dispatched.find(packet => packet.planGraphNodeId === node.nodeId);
    assert.ok(packet, 'Node was not actually dispatched');
    const verified = f.verified.find(entry => entry.execution.executionResult.packetId === packet.packetId);
    assert.ok(verified, 'Node lacks actual worker G invocation');
    assert.equal(verified.verification.status, 'passed');
    const proof = out.nodeProofs.find(row => row.nodeRef === ref(node.nodeId));
    assert.equal(proof.packetRef, ref(packet.packetId));
    assert.equal(proof.verificationRef, ref(verified.verification.verificationId));
    assert.equal(proof.evidenceRef, ref(verified.execution.evidence.evidenceId));
    assert.equal(proof.outcome, 'passed');
  }
  facts.add('node-packet-and-g-and-evidence-references-match-actual-source'); facts.add('node-proof-passed-status');
  const request = result.decisions.find(row => row.kind === 'request');
  assert.equal(request.occurredAt, f.task.request.createdAt); assert.ok(Number.isFinite(Date.parse(request.recordedAt)));
  facts.add('source-and-recording-time'); facts.add('aggregate-status-alone-as-proof'); facts.add('invented-node-completion');
}

async function runCase(f, item) {
  const facts = new Set(); let result, run;
  const absent = (...names) => { assert.equal(result.outcomes.length, 0); for (const name of names) facts.add(name); };
  f.create(item.scenario === 'partial-execution-failure-before-all-node-g' ? 3 : 2);
  switch (item.scenario) {
    case 'current-two-actions-current-g-pass':
      run = await f.run(); assert.equal(run.success, true, JSON.stringify(run.failure));
      result = f.trace(); graphFacts(f, result, run, facts); break;
    case 'partial-execution-failure-before-all-node-g': {
      f.beforeDispatch = packet => {
        if (packet.planGraphNodeId === 'action_2') packet.action.arguments.directory = join(f.root, 'missing-required-directory');
      };
      run = await f.run(); result = f.trace(); requestFacts(f, result, facts);
      assert.equal(run.success, false);
      assert.equal(run.planGraphRun.failedNodeId, 'action_2');
      assert.equal(run.planGraphRun.nodeRuns.find(node => node.nodeId === 'action_1').status, 'completed');
      assert.equal(run.planGraphRun.nodeRuns.find(node => node.nodeId === 'action_3').status, 'skipped');
      assert.ok(!f.dispatched.some(packet => packet.planGraphNodeId === 'action_3'));
      assert.equal(f.aggregateCalls.length, 0);
      facts.add('undispatched-required-node-not-completed');
      absent('partial-failure-distinguished-from-g-verified-outcome', 'partial-success-promoted-to-whole-goal-success', 'execution-status-promoted-to-g-failure');
      break;
    }
    case 'required-node-g-absent': {
      f.suppressG = (_task, _execution, _capability, context) => context?.contextId === 'action_2';
      f.task.request.metadata.verification = { status: 'passed', nodeId: 'action_2', verificationId: 'synthetic-untrusted-node-g' };
      run = await f.run(); result = f.trace(); requestFacts(f, result, facts);
      assert.equal(f.dispatched.length, 2);
      assert.equal(f.verified.filter(entry => entry.context?.contextId === 'action_2').length, 0);
      absent('missing-node-g-filled-from-metadata', 'subset-promoted-to-full-coverage');
      break;
    }
    case 'different-node-execution-g-rejected': {
      f.beforeAggregate = (_task, targets) => {
        assert.equal(targets.length, 2); assert.notEqual(targets[0].verification.verificationId, targets[1].verification.verificationId);
        targets[1].verification = targets[0].verification;
        assert.notEqual(targets[0].execution, targets[1].execution); return targets;
      };
      run = await f.run(); result = f.trace();
      assert.equal(f.gCalls, 2); assert.equal(f.aggregateCalls.length, 1);
      absent('same-task-g-treated-as-any-node-g', 'wrong-node-evidence-linked');
      break;
    }
    case 'same-task-previous-plan-or-base-attempt-g-rejected': {
      run = await f.run(); assert.equal(run.success, true);
      const old = f.trace(); assert.equal(old.counts.verifiedPass, 1);
      const previousPlan = f.task.plan.planId, previousPacket = run.packet.packetId;
      f.task.plan = { ...f.task.plan, planId: `${previousPlan}-revised` };
      f.task.request = { ...f.task.request, requestId: `${f.task.request.requestId}-revised` };
      f.task.executionPacket = { ...f.task.executionPacket, planId: f.task.plan.planId, packetId: `${previousPacket}-revised` };
      f.runtime.coreFacade.cognition.recordDecision(f.task, { kind: 'request', workspaceRoot: f.runtime.coreFacade.workspaceRoot });
      f.runtime.coreFacade.cognition.observeRun({ ...run, packet: f.task.executionPacket }, f.task);
      const all = f.trace(); assert.deepEqual(all.outcomes.filter(out => out.planRef === ref(previousPlan)), old.outcomes);
      facts.add('prior-verified-graph-history-preserved');
      const current = all.outcomes.filter(out => out.planRef === ref(f.task.plan.planId) || out.packetRef === ref(f.task.executionPacket.packetId));
      result = { ...all, outcomes: current, counts: { ...all.counts, verifiedPass: current.filter(out => out.outcome === 'passed').length, verifiedFail: current.filter(out => out.outcome === 'failed').length } };
      absent('old-node-evidence-linked-to-new-attempt', 'matching-node-name-treated-as-fresh-proof');
      break;
    }
    case 'duplicate-one-node-does-not-cover-another': {
      f.beforeAggregate = (_task, targets) => {
        assert.equal(targets.length, 2); targets[1] = { ...targets[0] };
        assert.equal(targets[0].nodeId, targets[1].nodeId); return targets;
      };
      run = await f.run(); result = f.trace();
      assert.equal(f.gCalls, 2); assert.equal(f.aggregateCalls.length, 1);
      absent('duplicate-entry-count-treated-as-required-node-coverage', 'missing-node-proof-invented'); break;
    }
    case 'empty-proof-set-with-success-summary': {
      const packet = { taskId: f.task.taskId, planId: f.task.plan.planId, approvalId: f.task.approvalCard.approvalId,
        packetId: 'synthetic-empty-graph-packet', action: f.task.plan.action, dryRun: false };
      f.task.executionPacket = packet;
      const execution = { taskId: f.task.taskId, status: 'COMPLETED', executionResult: { taskId: f.task.taskId, packetId: packet.packetId,
        status: 'success', summary: 'GRAPH_TRACE_PRIVATE_RESULT_MARKER', evidence: { completedNodeIds: [] } }, evidence: { evidenceId: 'synthetic-empty-graph-evidence' } };
      const report = { taskId: f.task.taskId, verificationId: 'synthetic-empty-graph-g', status: 'passed', checks: [], nodeVerifications: [] };
      const cognition = f.runtime.coreFacade.cognition;
      cognition.bindDecisionGraphVerification(report, { task: f.task, execution, packet, verificationTargets: [], workspaceRoot: f.runtime.coreFacade.workspaceRoot });
      cognition.observeRun({ taskId: f.task.taskId, success: true, status: 'COMPLETED', packet, execution,
        executionVerification: report, planGraphRun: { success: true, nodeRuns: [] } }, f.task);
      result = f.trace(); requestFacts(f, result, facts); assert.equal(f.gCalls, 0); assert.equal(f.dispatched.length, 0);
      absent('empty-set-treated-as-vacuous-success', 'arbitrary-aggregate-id-treated-as-proof'); break;
    }
    case 'any-required-node-preview-excludes-real-aggregate': {
      f.beforeDispatch = (packet, options) => { if (packet.planGraphNodeId === 'action_1') { packet.dryRun = true; options.dryRun = true; } };
      run = await f.run(); result = f.trace(); requestFacts(f, result, facts);
      const first = f.dispatched.find(packet => packet.planGraphNodeId === 'action_1'); assert.equal(first?.dryRun, true);
      absent('preview-node-promoted-to-real-action', 'mixed-real-and-preview-promoted-to-whole-goal-success'); break;
    }
    case 'owner-workspace-and-conversation-queries-isolated': {
      run = await f.run(); assert.equal(run.success, true); const original = f.trace(); assert.equal(original.counts.verifiedPass, 1);
      const scopes = [
        { taskRequest: { ...f.task.request, userId: 'synthetic-graph-owner-b' } },
        { workspaceRoot: join(f.root, 'workspace-b') },
        { taskRequest: { ...f.task.request, metadata: { ...f.task.request.metadata, conversationId: 'synthetic-graph-conversation-b' } } }
      ];
      for (const scope of scopes) { result = f.trace(f.task, scope); assert.equal(result.decisions.length, 0); assert.equal(result.outcomes.length, 0); }
      assert.deepEqual(f.trace(), original); facts.add('original-scope-graph-remains-available');
      absent('other-scope-decision-reference', 'other-scope-node-proof', 'display-name-treated-as-identity'); break;
    }
    case 'same-graph-redelivery-and-restart': {
      run = await f.run(); assert.equal(run.success, true); const before = f.trace(); graphFacts(f, before, run, new Set());
      f.runtime.orchestrationWorker.storeRun(run); assert.deepEqual(f.trace(), before);
      await f.restart(); assert.deepEqual(f.trace(), before);
      f.runtime.coreFacade.cognition.recordDecision(f.task, { kind: 'request', workspaceRoot: f.runtime.coreFacade.workspaceRoot });
      f.runtime.coreFacade.cognition.observeRun(run, f.task); result = f.trace(); assert.deepEqual(result, before);
      for (const name of ['duplicateDoesNotGrow', 'consistentAfterRestart', 'stable-decision-reference', 'stable-aggregate-reference',
        'stable-node-proof-references-and-statuses', 'duplicate-decision', 'duplicate-aggregate-outcome', 'duplicate-node-proof']) facts.add(name);
      break;
    }
    case 'any-node-structured-opt-out-excludes-task-projection': {
      f.afterDispatch = (packet, execution) => {
        if (packet.planGraphNodeId === 'action_1') {
          assert.ok(execution.memoryEvent, 'Actual node execution must expose the existing memory event');
          execution.memoryEvent.learningFlags = { ...execution.memoryEvent.learningFlags, doNotRemember: true };
        }
      };
      run = await f.run(); assert.equal(f.dispatched.length, 2);
      const first = f.verified.find(entry => entry.context?.contextId === 'action_1');
      const last = f.verified.find(entry => entry.context?.contextId === 'action_2');
      assert.equal(first?.execution.memoryEvent.learningFlags.doNotRemember, true);
      assert.notEqual(last?.execution.memoryEvent?.learningFlags?.doNotRemember, true);
      result = f.trace(); assert.equal(result.decisions.length, 0);
      await f.restart(); assert.deepEqual(f.trace(), result); facts.add('consistentAfterRestart');
      absent('nonfinal-node-opt-out-overwritten-by-last-event', 'opted-out-task-projection-retained'); break;
    }
    case 'historical-completed-node-without-current-attestation': {
      // Reuse the existing completed-node execution representation with its G and execution
      // reconstructed from serialization, exactly the evidence available to a restored run.
      const first = await f.run(); assert.equal(first.success, true);
      const oldTargets = f.aggregateCalls.at(-1).targets;
      const historical = JSON.parse(JSON.stringify(oldTargets[0]));
      const oldTask = f.task, historicalOutcome = f.trace(oldTask);
      f.create(); const worker = f.runtime.orchestrationWorker;
      const executeNode = worker.executePlanNode.bind(worker);
      worker.executePlanNode = async (task, options) => {
        if (options.node.nodeId !== 'action_1') return await executeNode(task, options);
        return { nodeId: options.node.nodeId, status: 'completed', packet: historical.packet, capability: historical.capability,
          execution: historical.execution, executionVerification: historical.verification,
          artifactBundle: { nodeId: options.node.nodeId, status: 'completed', artifactVersion: 'a-plan-node-artifact-bundle-v1' } };
      };
      const dispatchBefore = f.dispatched.length;
      run = await f.run(); result = f.trace(); requestFacts(f, result, facts);
      assert.deepEqual(f.dispatched.slice(dispatchBefore).map(packet => packet.planGraphNodeId), ['action_2']);
      assert.deepEqual(f.trace(oldTask), historicalOutcome);
      facts.add('historical-node-attestation-unavailable-distinguished-from-new-proof');
      absent('cached-completed-status-promoted-to-current-attestation', 'unattested-recovery-promoted-to-whole-goal-success'); break;
    }
    default: assert.fail(`Scenario adapter not implemented: ${item.scenario}`);
  }
  common(f, result); facts.add('raw-source-body');
  assert.equal(result.counts.verifiedPass, item.expect.aggregateVerifiedPassCount);
  assert.equal(result.counts.verifiedFail, item.expect.aggregateVerifiedFailCount);
  assert.equal(result.outcomes.reduce((sum, out) => sum + (out.nodeProofs?.length ?? 0), 0), item.expect.nodeProofCount);
  if (item.expect.visibleDecisionCount !== undefined) assert.equal(result.decisions.length, item.expect.visibleDecisionCount);
  for (const name of [...item.expect.requiredFacts ?? [], ...item.expect.forbiddenFacts ?? []]) assert.ok(facts.has(name), `Oracle fact not asserted: ${name}`);
  for (const name of ['duplicateDoesNotGrow', 'consistentAfterRestart']) if (item.expect[name]) assert.ok(facts.has(name), `Oracle property not asserted: ${name}`);
  return { facts: [...facts], counts: result.counts, dispatchedNodeCount: f.dispatched.length, realGCalls: f.gCalls,
    executionLayer: 'configured-core-worker-real-filesystem-and-g' };
}

for (const item of suite.cases) {
  test(`fixed graph decision trace: ${item.id}`, async t => {
    const startedAt = new Date().toISOString(), start = performance.now();
    const f = await fixture(t, item.id);
    try {
      const evidence = await runCase(f, item);
      observations.push({ id: item.id, scenario: item.scenario, split: item.split, status: 'passed', startedAt,
        elapsedMs: performance.now() - start, ...evidence,
        cost: { additionalModelCalls: 0, inputTokens: 0, outputTokens: 0, usd: 0,
          basis: 'Isolated runtime disables LLM providers; actual local deterministic worker, filesystem, and G calls only.' } });
    } catch (error) {
      observations.push({ id: item.id, scenario: item.scenario, split: item.split, status: 'failed', startedAt,
        elapsedMs: performance.now() - start, realGCalls: f.gCalls, dispatchedNodeCount: f.dispatched.length,
        error: { name: error.name, message: error.message, code: error.code ?? null } });
      throw error;
    }
  });
}

after(() => {
  assert.equal(sha(readFileSync(fixturePath)), frozenSha256);
  const requested = process.env.JARVIS_DECISION_GRAPH_CASE_REPORT;
  if (!requested) return;
  const output = resolve(requested), child = relative(resolve('artifacts'), output);
  assert.ok(child && !child.startsWith('..') && !isAbsolute(child));
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify({ version: 'jarvis-decision-trace-graph-evaluation-v1', startedAt: suiteStartedAt,
    finishedAt: new Date().toISOString(), fixturePath, fixtureSha256: frozenSha256, sampleCount: observations.length,
    passed: observations.filter(row => row.status === 'passed').length, failed: observations.filter(row => row.status === 'failed').length,
    results: observations, limitations: ['Synthetic isolated local actions, not personal data or external accounts.',
      'Fixed structural graph cases do not assess arbitrary natural-language understanding or all recovery semantics.',
      'Counterexamples manipulate the actual worker aggregate boundary to exercise mismatched or absent evidence.'] }, null, 2)}\n`);
});
