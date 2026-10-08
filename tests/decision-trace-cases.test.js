import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, relative, resolve, dirname, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { CognitiveRuntime } from '../packages/core/src/cognition/cognitive-runtime.js';
import { ExecutionResultVerifier } from '../apps/verification/src/verification-runtime.js';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { createApprovalDecision, ModuleId } from '../packages/shared/src/types.js';

const fixturePath = 'tests/fixtures/decision-trace-cases-v1.json';
const fixtureBytes = readFileSync(fixturePath);
const frozenSha256 = '695dfe395e76aea97fb3129c8846fd559d75e45ab155c0f78b7bf327abf5c135';
const sha = value => createHash('sha256').update(value).digest('hex');
const ref = value => sha(JSON.stringify(value));
assert.equal(sha(fixtureBytes), frozenSha256, 'Independent oracle changed after freezing');
const suite = JSON.parse(fixtureBytes);
const observations = [];
const testStartedAt = new Date().toISOString();

function fixture(t, id) {
  assert.equal(process.env.JARVIS_TEST_MODE, '1', 'Use scripts/run-tests.mjs for isolated execution');
  const root = mkdtempSync(join(tmpdir(), 'jarvis-decision-cases-'));
  const workspace = join(root, 'workspace-a');
  mkdirSync(workspace);
  writeFileSync(join(workspace, 'input.txt'), 'TRACE_PRIVATE_RESULT_MARKER\n');
  // Policy verification intentionally compares capability expiry with wall time.
  // Keep fixture-issued capabilities current without weakening that production check.
  let timestamp = Date.now();
  const clock = () => new Date(timestamp++);
  const storePath = join(root, 'trace.sqlite');
  const instances = [];
  const state = { root, workspace, storePath, clock, id, gCalls: 0, localReads: 0, rawIds: [], core: null };
  state.open = () => {
    const cognition = new CognitiveRuntime({ storePath, clock });
    instances.push(cognition);
    state.cognition = cognition;
    return cognition;
  };
  state.open();
  state.task = makeTask(state, 'a');
  t.after(() => {
    for (const cognition of instances) cognition.close();
    const child = relative(resolve(tmpdir()), resolve(root));
    assert.ok(child.startsWith('jarvis-decision-cases-') && !child.includes('..'));
    rmSync(root, { recursive: true, force: true });
  });
  return state;
}

function makeTask(f, suffix, { userId = 'synthetic-owner-a', conversationId = 'synthetic-conversation-a', remember = true } = {}) {
  const taskId = `${f.id}-task-${suffix}`;
  const request = { taskId, requestId: `${f.id}-request-${suffix}`, userId,
    metadata: { conversationId, learningFlags: { doNotRemember: !remember } },
    command: { rawText: 'TRACE_PRIVATE_REQUEST_MARKER' }, createdAt: f.clock().toISOString() };
  const task = { taskId, request, status: 'APPROVED',
    plan: { planId: `${f.id}-plan-${suffix}`, taskId, action: { toolName: 'filesystem.readText', arguments: { path: join(f.workspace, 'input.txt') } } },
    approvalCard: { approvalId: `${f.id}-approval-${suffix}` } };
  setPacket(f, task, suffix);
  f.rawIds.push(taskId, request.requestId, userId, conversationId, task.plan.planId, task.approvalCard.approvalId);
  return task;
}

function setPacket(f, task, suffix) {
  task.executionPacket = { packetId: `${f.id}-packet-${suffix}`, taskId: task.taskId, planId: task.plan.planId,
    approvalId: task.approvalCard.approvalId, action: task.plan.action, dryRun: false };
  f.rawIds.push(task.executionPacket.packetId);
}

function record(f, task = f.task, kind = 'request', decision = undefined) {
  f.cognition.planningContext({ taskRequest: task.request, intent: { confidence: 0.99 },
    route: { skill: { toolName: task.plan.action.toolName } }, workspaceRoot: f.workspace });
  return f.cognition.recordDecision(task, { kind, decision, workspaceRoot: f.workspace });
}

function trace(f, task = f.task, { workspaceRoot = f.workspace, taskRequest = task.request } = {}) {
  const result = f.cognition.decisionTrace({ taskId: task.taskId, taskRequest, workspaceRoot });
  assert.ok(result && Array.isArray(result.decisions) && Array.isArray(result.outcomes), 'Trace query must return actual rows');
  assert.equal(result.truncated, false, 'Tiny fixtures must not hide rows through truncation');
  return result;
}

async function execute(f, task = f.task, { fail = false, bind = true, observe = true, dryRun = false, suffix = 'one', verify = true, updateTaskStatus = true } = {}) {
  const packet = task.executionPacket;
  const toolName = task.plan.action.toolName;
  const startedAt = new Date().toISOString();
  let content = null, failure = null;
  try {
    f.localReads++;
    content = toolName === 'filesystem.listFiles'
      ? Buffer.from(JSON.stringify(readdirSync(fail ? join(f.workspace, 'missing-directory') : f.workspace)))
      : readFileSync(fail ? join(f.workspace, 'missing-file.txt') : join(f.workspace, 'input.txt'));
  } catch (error) { failure = { code: error.code }; }
  assert.equal(Boolean(failure), fail, 'The local stimulus must really fail/succeed');
  const execution = { status: failure ? 'FAILED' : 'COMPLETED',
    executionResult: { taskId: task.taskId, packetId: packet.packetId, status: failure ? 'failed' : 'success', success: !failure,
      startedAt, finishedAt: new Date().toISOString(), executedBy: { module: 'B_PC_AGENT', toolName },
      readOnly: true, rollbackAvailable: false, outputPaths: [], dryRun,
      ...(failure ? { error: failure } : { content: content.toString('utf8'), contentSha256: sha(content) }),
      safety: { adapterContract: { toolName, readOnly: true, rollback: false, evidence: ['files', 'sha256'] } } },
    evidence: { evidenceId: `${f.id}-evidence-${suffix}`, taskId: task.taskId, status: failure ? 'failed' : 'success', outputPaths: [],
      files: failure ? [] : (() => { const file = readFileSync(join(f.workspace, 'input.txt')); return [{ path: join(f.workspace, 'input.txt'), size: file.length, sha256: sha(file) }]; })(), shadow: { expectedChangesCount: 0 } } };
  let report;
  if (verify) {
    const checks = await new ExecutionResultVerifier().verify({ executionResult: execution.executionResult, evidence: execution.evidence });
    f.gCalls++;
    report = { verificationId: `${f.id}-verification-${suffix}`, taskId: task.taskId,
      status: checks.some(check => check.status === 'failed') ? 'failed' : 'passed', checks };
    assert.equal(report.status, fail ? 'failed' : 'passed', JSON.stringify(checks.filter(check => check.status === 'failed')));
    assert.ok(checks.length > 5, 'The actual G verifier must execute');
    f.rawIds.push(report.verificationId);
    if (bind) f.cognition.bindDecisionVerification(report, { task, execution, workspaceRoot: f.workspace });
  }
  f.rawIds.push(execution.evidence.evidenceId);
  const run = { taskId: task.taskId, success: !failure, packet, execution, executionVerification: report, dryRun,
    capability: { taskId: task.taskId, planId: task.plan.planId, approvalId: task.approvalCard.approvalId, scope: { toolName } } };
  if (updateTaskStatus) task.status = failure ? 'FAILED' : 'COMPLETED';
  if (observe) f.cognition.observeRun(run, task);
  return run;
}

function coreIn(f) {
  const runtime = createAgRuntime({ env: { JARVIS_TEST_MODE: '1', JARVIS_LLM_INTENT: '0', JARVIS_LLM_PLANNER: '0', JARVIS_LLM_CONTENT: '0' },
    allowedRoots: [f.workspace], auditRoot: join(f.root, 'audit'), cwd: () => f.workspace,
    cognitionRuntime: f.cognition, workerDaemonEnabled: false, clock: f.clock });
  const verify = runtime.verificationRuntime.verifyExecution.bind(runtime.verificationRuntime);
  runtime.verificationRuntime.verifyExecution = async (...args) => { f.gCalls++; return await verify(...args); };
  f.core = runtime;
  f.task = runtime.coreFacade.createTask('파일 목록 보여줘', { userId: 'synthetic-owner-a', metadata: { conversationId: 'synthetic-conversation-a' } });
  const task = f.task;
  f.rawIds.push(task.taskId, task.request.requestId, task.plan.planId, task.approvalCard.approvalId);
  return runtime;
}

function approval(f, task = f.task, decision = 'approve', extras = {}) {
  return createApprovalDecision({ taskId: task.taskId, approvalId: task.approvalCard.approvalId,
    decision, deviceId: 'synthetic-human-device', sourceModule: ModuleId.MOBILE, decidedAt: f.clock().toISOString(), ...extras });
}

function rowsWith(f, result, field, value, collection = 'decisions') {
  const expected = ref(value);
  assert.ok(result[collection].some(row => row[field] === expected), `Missing ${collection}.${field} bound to the actual source`);
}

function commonChecks(f, result, facts) {
  const tables = f.cognition.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
    .map(row => row.name).filter(name => /decision|trace/.test(name));
  assert.ok(tables.length >= 2, 'Inspect actual projection persistence, not only a response view');
  const persisted = tables.map(name => {
    assert.match(name, /^[a-z_]+$/);
    return f.cognition.db.prepare(`SELECT * FROM ${name}`).all();
  });
  const text = JSON.stringify({ result, persisted });
  for (const marker of suite.protocol.bodyMarkers) assert.equal(text.includes(marker), false, 'Source body copied into trace');
  for (const id of f.rawIds) assert.equal(text.includes(id), false, 'Source identifier stored verbatim');
  facts.add('raw-source-body');
  const boundaries = f.cognition.snapshot().boundaries;
  assert.equal(boundaries.executionAuthority, false);
  assert.equal(boundaries.backgroundModelCalls, false);
  facts.add('automatic-authority');
}

async function runCase(f, item) {
  const facts = new Set();
  let result;
  const claim = (name, assertion) => { assertion(); facts.add(name); };
  const requestFacts = (out, task = f.task) => {
    claim('request-reference', () => {
      const row = out.decisions.find(value => value.kind === 'request' && value.requestRef === ref(task.request.requestId));
      assert.ok(row); assert.equal(row.sourceRef, ref(task.request.requestId));
      assert.equal(row.statementRef, ref(task.request.command.rawText));
    });
    claim('task-reference', () => assert.equal(out.taskRef, ref(task.taskId)));
  };
  const currentFacts = (out, run, task = f.task) => {
    claim('current-execution-reference', () => rowsWith(f, out, 'packetRef', run.packet.packetId, 'outcomes'));
    claim('current-g-verification-reference', () => rowsWith(f, out, 'verificationRef', run.executionVerification.verificationId, 'outcomes'));
    for (const row of out.outcomes) {
      assert.ok(out.decisions.some(decision => decision.id === row.decisionRef));
      assert.equal(row.evidenceRef, ref(run.execution.evidence.evidenceId));
    }
  };

  switch (item.scenario) {
    case 'current-request-current-g-pass': {
      record(f); const run = await execute(f); result = trace(f); requestFacts(result); currentFacts(result, run);
      claim('plan-reference', () => rowsWith(f, result, 'planRef', f.task.plan.planId));
      claim('source-and-recording-time', () => { const decision = result.decisions.find(row => row.kind === 'request');
        assert.equal(decision.occurredAt, f.task.request.createdAt); assert.ok(Number.isFinite(Date.parse(decision.recordedAt))); });
      claim('inferred-life-decision', () => assert.ok(result.decisions.every(row => ['request', 'approve'].includes(row.kind))));
      break;
    }
    case 'success-without-g': {
      f.task.request.metadata.verification = { status: 'passed', verificationId: 'untrusted-metadata-verification' };
      record(f); const run = await execute(f, f.task, { bind: false, observe: false, verify: false });
      // The stimulus has a real local execution but deliberately supplies no G report to cognition.
      delete run.executionVerification;
      f.cognition.observeRun(run, f.task); result = trace(f); requestFacts(result);
      claim('metadata-promoted-to-verification', () => { assert.equal(result.outcomes.length, 0); assert.equal(f.gCalls, 0); });
      claim('unverified-success-promoted', () => assert.equal(result.counts.verifiedPass, 0));
      break;
    }
    case 'applied-approval-current-g-pass': {
      const runtime = coreIn(f);
      const decision = approval(f);
      assert.equal(runtime.coreFacade.submitApprovalDecision(decision).success, true);
      const run = await runtime.orchestrationWorker.runTask(f.task.taskId, { approvalDecision: decision });
      assert.equal(run.success, true, JSON.stringify(run.policyVerification?.checks?.filter(c => c.status === 'failed'))); result = trace(f); currentFacts(result, run);
      claim('applied-approval-reference', () => { rowsWith(f, result, 'approvalRef', decision.approvalId); rowsWith(f, result, 'sourceRef', decision); });
      claim('approval-linked-to-current-plan', () => {
        const applied = result.decisions.find(row => row.kind === 'approve'); assert.ok(applied); assert.equal(applied.planRef, ref(f.task.plan.planId)); });
      const wrongTask = runtime.coreFacade.createTask('파일 목록 보여줘');
      const before = trace(f, wrongTask);
      const wrong = runtime.coreFacade.submitApprovalDecision(approval(f, wrongTask, 'approve', { approvalId: 'synthetic-wrong-approval' }));
      assert.equal(wrong.success, false);
      claim('rejected-submission-recorded-as-applied-approval', () => assert.deepEqual(trace(f, wrongTask), before));
      const workerTask = runtime.coreFacade.createTask('파일 목록 보여줘');
      assert.equal((await runtime.orchestrationWorker.runTask(workerTask.taskId)).success, true);
      const workerTrace = trace(f, workerTask);
      claim('user-approval-distinguished-from-worker-approval', () => {
        const user = result.decisions.find(row => row.kind === 'approve');
        const worker = workerTrace.decisions.find(row => row.kind === 'approve');
        assert.ok(user && worker); assert.notEqual(user.origin, worker.origin);
      });
      break;
    }
    case 'explicit-replan-preserves-source-chain': {
      const runtime = coreIn(f), previousRequest = f.task.request.requestId, previousPlan = f.task.plan.planId;
      const before = trace(f);
      const decision = approval(f, f.task, 'edit', { editRequest: { rawText: '파일 목록을 보여줘' }, responseText: 'TRACE_PRIVATE_REASON_MARKER' });
      assert.equal(runtime.coreFacade.submitApprovalDecision(decision).success, true);
      assert.notEqual(f.task.request.requestId, previousRequest); assert.notEqual(f.task.plan.planId, previousPlan);
      const run = await runtime.orchestrationWorker.runTask(f.task.taskId); assert.equal(run.success, true, JSON.stringify(run.policyVerification?.checks?.filter(c => c.status === 'failed')));
      result = trace(f); const replan = result.decisions.find(row => row.kind === 'replan'); assert.ok(replan);
      claim('original-request-reference', () => rowsWith(f, result, 'requestRef', previousRequest));
      claim('revised-request-reference', () => rowsWith(f, result, 'requestRef', f.task.request.requestId));
      claim('reason-reference', () => { assert.equal(replan.responseRef, ref(decision.responseText)); assert.equal(replan.sourceRef, ref(decision)); });
      claim('previous-decision-preserved', () => { for (const original of before.decisions) assert.deepEqual(result.decisions.find(row => row.id === original.id), original); });
      claim('supersession-reference', () => assert.ok(before.decisions.some(row => row.id === replan.previousRef)));
      claim('outcome-linked-to-revised-plan', () => rowsWith(f, result, 'planRef', f.task.plan.planId, 'outcomes'));
      claim('outcome-linked-to-abandoned-plan', () => assert.ok(result.outcomes.every(row => row.planRef !== ref(previousPlan))));
      claim('raw-reason-body', () => assert.equal(JSON.stringify(result).includes('TRACE_PRIVATE_REASON_MARKER'), false));
      break;
    }
    case 'applied-rejection-no-execution': {
      const runtime = coreIn(f);
      assert.equal(runtime.coreFacade.submitApprovalDecision(approval(f, f.task, 'reject')).success, true);
      result = trace(f);
      claim('applied-rejection-reference', () => assert.ok(result.decisions.some(row => row.kind === 'reject')));
      claim('task-reference', () => assert.equal(result.taskRef, ref(f.task.taskId)));
      claim('rejection-promoted-to-execution-failure', () => assert.equal(result.counts.verifiedFail, 0));
      claim('rejection-promoted-to-success', () => { assert.equal(result.counts.verifiedPass, 0); assert.equal(f.gCalls, 0); });
      break;
    }
    case 'execution-failure-current-g-fail': {
      record(f); const run = await execute(f, f.task, { fail: true }); result = trace(f); requestFacts(result); currentFacts(result, run);
      claim('failed-outcome', () => assert.equal(result.outcomes[0].outcome, 'failed'));
      claim('failure-promoted-to-success', () => assert.equal(result.counts.verifiedPass, 0));
      break;
    }
    case 'preview-is-not-real-outcome': {
      record(f); await execute(f, f.task, { dryRun: true }); result = trace(f); requestFacts(result);
      claim('preview-promoted-to-real-outcome', () => assert.equal(result.outcomes.length, 0)); break;
    }
    case 'different-task-g-rejected': {
      record(f); const goodRun = await execute(f);
      const other = makeTask(f, 'b'); record(f, other);
      const attacked = await execute(f, other, { observe: false, bind: false, suffix: 'other' });
      attacked.executionVerification = goodRun.executionVerification;
      f.cognition.observeRun(attacked, other); result = trace(f, other);
      claim('different-task-verification-linked', () => assert.equal(result.outcomes.length, 0)); break;
    }
    case 'same-task-stale-plan-g-rejected': {
      record(f); const oldRun = await execute(f), original = trace(f);
      const oldPlan = f.task.plan.planId;
      f.task.request = { ...f.task.request, requestId: `${f.id}-revised-request` };
      f.task.plan = { ...f.task.plan, planId: `${f.id}-revised-plan` };
      f.task.approvalCard = { approvalId: `${f.id}-revised-approval` };
      setPacket(f, f.task, 'revised');
      record(f, f.task, 'replan', { ...approval(f, f.task, 'edit'), responseText: 'TRACE_PRIVATE_REASON_MARKER' });
      f.cognition.observeRun(oldRun, f.task);
      const complete = trace(f);
      claim('prior-verified-history-preserved', () => assert.deepEqual(complete.outcomes.filter(row => row.planRef === ref(oldPlan)), original.outcomes));
      const current = complete.outcomes.filter(row => row.planRef === ref(f.task.plan.planId));
      result = { ...complete, outcomes: current, counts: { verifiedPass: current.filter(row => row.outcome === 'passed').length, verifiedFail: current.filter(row => row.outcome === 'failed').length } };
      claim('stale-plan-verification-promoted', () => assert.equal(current.length, 0));
      claim('old-packet-linked-to-new-plan', () => assert.equal(current.some(row => row.packetRef === ref(oldRun.packet.packetId)), false));
      break;
    }
    case 'same-event-redelivery-and-restart': {
      record(f); const run = await execute(f), before = trace(f);
      record(f); f.cognition.observeRun(run, f.task); assert.deepEqual(trace(f), before);
      f.cognition.close(); f.open(); assert.deepEqual(trace(f), before);
      record(f); f.cognition.observeRun(run, f.task); result = trace(f);
      claim('duplicate-decision', () => assert.deepEqual(result.decisions, before.decisions));
      claim('duplicate-outcome', () => assert.deepEqual(result.outcomes, before.outcomes));
      claim('stable-source-reference', () => assert.deepEqual(result.decisions, before.decisions));
      claim('stable-outcome-reference', () => assert.deepEqual(result.outcomes, before.outcomes));
      facts.add('duplicateDoesNotGrow'); facts.add('consistentAfterRestart');
      break;
    }
    case 'other-owner-query-isolated': {
      record(f); await execute(f);
      result = trace(f, f.task, { taskRequest: { ...f.task.request, userId: 'synthetic-owner-b' } });
      claim('other-owner-source-reference', () => assert.equal(result.decisions.length, 0));
      claim('other-owner-outcome-reference', () => assert.equal(result.outcomes.length, 0)); break;
    }
    case 'same-name-other-workspace-query-isolated': {
      f.task.request.metadata.projectName = 'same-display-name'; record(f); await execute(f);
      result = trace(f, f.task, { workspaceRoot: join(f.root, 'workspace-b') });
      claim('other-project-source-reference', () => assert.equal(result.decisions.length, 0));
      claim('other-project-outcome-reference', () => assert.equal(result.outcomes.length, 0)); break;
    }
    case 'structured-do-not-remember': {
      f.task.request.metadata.learningFlags.doNotRemember = true;
      record(f); await execute(f); const before = trace(f);
      f.cognition.close(); f.open(); result = trace(f);
      assert.deepEqual(result, before); facts.add('consistentAfterRestart');
      claim('opted-out-source-reference', () => assert.equal(result.decisions.length, 0));
      claim('opted-out-outcome-reference', () => assert.equal(result.outcomes.length, 0)); break;
    }
    case 'failed-attempt-then-verified-retry': {
      const runtime = coreIn(f);
      assert.equal(runtime.coreFacade.submitApprovalDecision(approval(f)).success, true);
      setPacket(f, f.task, 'failed');
      const failed = await execute(f, f.task, { fail: true, suffix: 'failed', updateTaskStatus: false });
      runtime.coreFacade.recordExecutionFailure(f.task.taskId, { reason: 'synthetic-local-directory-missing', evidence: { packetId: failed.packet.packetId } });
      assert.equal(f.task.status, 'FAILED');
      const before = trace(f); assert.equal(before.counts.verifiedFail, 1);
      assert.equal(runtime.coreFacade.submitApprovalDecision(approval(f)).success, true);
      assert.equal(f.task.status, 'APPROVED'); setPacket(f, f.task, 'retry');
      const passed = await execute(f, f.task, { suffix: 'passed' }); result = trace(f);
      claim('distinct-attempt-references', () => assert.equal(new Set(result.outcomes.map(row => row.packetRef)).size, 2));
      claim('prior-failure-preserved', () => assert.ok(result.outcomes.some(row => row.id === before.outcomes[0].id && row.outcome === 'failed')));
      claim('current-g-verification-reference', () => rowsWith(f, result, 'verificationRef', passed.executionVerification.verificationId, 'outcomes'));
      claim('success-linked-to-new-attempt', () => assert.equal(result.outcomes.find(row => row.outcome === 'passed').packetRef, ref(passed.packet.packetId)));
      claim('failure-overwritten-by-success', () => assert.equal(result.outcomes.find(row => row.packetRef === ref(failed.packet.packetId)).outcome, 'failed'));
      claim('old-g-reused-for-retry', () => assert.notEqual(result.outcomes.find(row => row.outcome === 'passed').verificationRef, ref(failed.executionVerification.verificationId)));
      break;
    }
    default: assert.fail(`Unimplemented fixed scenario: ${item.scenario}`);
  }
  commonChecks(f, result, facts);
  assert.equal(result.counts.verifiedPass, item.expect.verifiedPassCount);
  assert.equal(result.counts.verifiedFail, item.expect.verifiedFailCount);
  if (item.expect.visibleDecisionCount !== undefined) assert.equal(result.decisions.length, item.expect.visibleDecisionCount);
  for (const name of [...(item.expect.requiredFacts ?? []), ...(item.expect.forbiddenFacts ?? [])]) assert.ok(facts.has(name), `Oracle fact was not asserted: ${name}`);
  for (const name of ['duplicateDoesNotGrow', 'consistentAfterRestart']) if (item.expect[name]) assert.ok(facts.has(name), `Oracle property was not asserted: ${name}`);
  return { facts: [...facts], counts: result.counts, realGCalls: f.gCalls, localFileReadAttempts: f.localReads,
    executionLayer: item.scenario === 'failed-attempt-then-verified-retry' ? 'core-approval-retry-with-isolated-projection-real-g'
      : f.core ? (f.gCalls ? 'configured-core-worker' : 'configured-core-decision-path')
        : f.gCalls ? 'isolated-projection-real-g' : 'isolated-projection-no-g-negative' };
}

for (const item of suite.cases) {
  test(`fixed decision trace: ${item.id}`, async t => {
    const startedAt = new Date().toISOString(), start = performance.now();
    const f = fixture(t, item.id);
    try {
      const evidence = await runCase(f, item);
      observations.push({ id: item.id, scenario: item.scenario, split: item.split, status: 'passed', startedAt,
        elapsedMs: performance.now() - start, ...evidence,
        cost: { additionalModelCalls: 0, inputTokens: 0, outputTokens: 0, usd: 0,
          basis: 'Local deterministic code and actual G only; no model adapter is selected. Isolated test runner disables LLM providers.' } });
    } catch (error) {
      observations.push({ id: item.id, scenario: item.scenario, split: item.split, status: 'failed', startedAt,
        elapsedMs: performance.now() - start, realGCalls: f.gCalls, localFileReadAttempts: f.localReads,
        error: { name: error.name, message: error.message, code: error.code ?? null } });
      throw error;
    }
  });
}

after(() => {
  assert.equal(sha(readFileSync(fixturePath)), frozenSha256, 'Frozen cases changed during evaluation');
  const requested = process.env.JARVIS_DECISION_TRACE_CASE_REPORT;
  if (!requested) return;
  const output = resolve(requested), artifacts = resolve('artifacts');
  const child = relative(artifacts, output);
  assert.ok(child && !child.startsWith('..') && !isAbsolute(child), 'Report must be under repository artifacts');
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify({ version: 'jarvis-decision-trace-evaluation-v1', startedAt: testStartedAt,
    finishedAt: new Date().toISOString(), fixturePath, fixtureSha256: frozenSha256,
    sampleCount: observations.length, passed: observations.filter(row => row.status === 'passed').length,
    failed: observations.filter(row => row.status === 'failed').length, results: observations,
    limitations: ['Synthetic local fixtures, not real personal data or external accounts.',
      'Structural trace cases do not assess natural-language decision extraction or long-term retrieval quality.',
      'Direct cognitive cases bind the real G report explicitly; Core integration cases exercise the actual worker hook.'] }, null, 2)}\n`);
});
