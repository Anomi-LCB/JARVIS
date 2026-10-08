import { createHash, createHmac } from 'node:crypto';
import {
  appendFile,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

import { PromptInjectionDetector } from '../apps/policy-security/src/policy-runtime.js';
import {
  EvidencePrivacyRedactor,
  FileReadTextToolAdapter,
  FileSearchToolAdapter,
  FileSystemToolAdapter,
  UndoJournal
} from '../apps/pc-agent/src/pc-agent-runtime.js';
import {
  createPng,
  createStoredZip,
  inventoryTree,
  manifestDigest,
  materializeExtremeInputs,
  readZipEntries,
  verifyExpectedArtifacts
} from './extreme-workflow-artifacts.mjs';

export const APEX_SCENARIO_ENGINE_VERSION = 'jarvis-apex-scenario-engine-v2';
export const APEX_STEP_JOURNAL_VERSION = 'jarvis-apex-step-journal-v1';
export const APEX_VARIATION_NORMALIZATION_VERSION = 'jarvis-apex-variation-normalization-v1';

export const APEX_CATEGORIES = Object.freeze([
  'causal-time',
  'provenance-trust',
  'planner-orchestration',
  'capability-policy',
  'resource-admission',
  'distributed-offline',
  'perception-integrity',
  'privacy-lifecycle',
  'state-evolution',
  'observability-recovery'
]);

const TEXT_TYPES = new Set(['text', 'txt', 'md', 'csv', 'json', 'html']);
const BEFORE_PHASE = /^(?:before|pre)/iu;
const SECRET_KEY = /authorization|cookie|credential|password|secret|token|api.?key|private.?key|smtp|주민|비밀번호|계좌/iu;
const THROWING_EFFECTS = new Set([
  'throw',
  'permission-denied',
  'disk-full',
  'disconnect',
  'kill-runtime',
  'ack-loss',
  'timeout',
  'network-partition',
  'lease-loss',
  'adapter-unavailable'
]);

// Runtime terminal policy is deliberately independent from expected.*.  The
// corpus oracle may assert the decision afterwards, but it cannot select the
// execution branch.  Rules are keyed by observed, applied fault composition so
// a case only stops or rolls back when the declared operation path actually
// produced the relevant evidence.
const TERMINAL_POLICY_RULES = Object.freeze([
  { ruleId: 'causal-history-conflict', category: 'causal-time', terminalState: 'BLOCKED', stopCode: 'CAUSAL_HISTORY_INCONSISTENT', allEffects: ['remove-parent', 'inject-conflict'] },
  { ruleId: 'provenance-chain-gap', category: 'provenance-trust', terminalState: 'BLOCKED', stopCode: 'PROVENANCE_CHAIN_GAP', allEffects: ['remove-predecessor-certificate', 'truncate-proof'] },
  { ruleId: 'provenance-seal-atomicity', category: 'provenance-trust', terminalState: 'ROLLED_BACK', stopCode: 'PROVENANCE_SEAL_FAILED', allEffects: ['mutate-leaf-bytes', 'io-error-before-fsync'] },
  { ruleId: 'invalid-plan-graph', category: 'planner-orchestration', terminalState: 'BLOCKED', stopCode: 'PLAN_GRAPH_INVALID', allEffects: ['inject-subgoal-cycle', 'advertise-unregistered-tool'] },
  { ruleId: 'unsatisfiable-constraint-set', category: 'planner-orchestration', terminalState: 'BLOCKED', stopCode: 'CONSTRAINT_SET_UNSATISFIABLE', allEffects: ['swap-policy-version', 'inject-fake-delete-success'] },
  { ruleId: 'capability-revoked-at-commit', category: 'capability-policy', terminalState: 'BLOCKED', stopCode: 'CAPABILITY_REVOKED_BEFORE_COMMIT', allEffects: ['revoke-capability', 'replay-stale-decision'] },
  { ruleId: 'capability-expired-in-transaction', category: 'capability-policy', terminalState: 'ROLLED_BACK', stopCode: 'CAPABILITY_EXPIRED_DURING_TRANSACTION', allEffects: ['expire-token', 'clock-jump'] },
  { ruleId: 'approval-binding-mismatch', category: 'capability-policy', terminalState: 'BLOCKED', stopCode: 'APPROVAL_CONTEXT_MISMATCH', allEffects: ['switch-principal', 'replay-cross-task-approval'] },
  { ruleId: 'resource-quota-rollback', category: 'resource-admission', terminalState: 'ROLLED_BACK', stopCode: 'RESOURCE_QUOTA_EXHAUSTED', allEffects: ['quota-exhausted', 'cleanup-permission-denied'] },
  { ruleId: 'causal-sync-conflict', category: 'distributed-offline', terminalState: 'BLOCKED', stopCode: 'SYNC_CONFLICT_REQUIRES_RESOLUTION', allEffects: ['late-stale-update', 'stale-read-response'] },
  { ruleId: 'remote-tombstone-conflict', category: 'distributed-offline', terminalState: 'BLOCKED', stopCode: 'REMOTE_TOMBSTONE_CONFLICT', allEffects: ['remote-tombstone', 'downgrade-scope'] },
  { ruleId: 'speaker-attribution-ambiguous', category: 'perception-integrity', terminalState: 'BLOCKED', stopCode: 'SPEAKER_ATTRIBUTION_AMBIGUOUS', allEffects: ['drop-audio-frames', 'speaker-overlap'] },
  { ruleId: 'visual-payload-integrity', category: 'perception-integrity', terminalState: 'BLOCKED', stopCode: 'VISUAL_PAYLOAD_INTEGRITY_FAILED', allEffects: ['unicode-homograph', 'checksum-bit-flip'] },
  { ruleId: 'purpose-limitation', category: 'privacy-lifecycle', terminalState: 'BLOCKED', stopCode: 'PURPOSE_LIMITATION_VIOLATION', allEffects: ['inject-quasi-identifiers', 'recommend-sensitive-inference'] },
  { ruleId: 'key-rotation-atomicity', category: 'privacy-lifecycle', terminalState: 'ROLLED_BACK', stopCode: 'KEY_ROTATION_ATOMICITY_FAILURE', allEffects: ['process-crash', 'revoke-old-key-early'] },
  { ruleId: 'migration-state-uncertain', category: 'state-evolution', terminalState: 'BLOCKED', stopCode: 'MIGRATION_STATE_UNCERTAIN', allEffects: ['checksum-mismatch', 'legacy-downgrade-request'] },
  { ruleId: 'trusted-bundle-unavailable', category: 'state-evolution', terminalState: 'BLOCKED', stopCode: 'TRUSTED_BUNDLE_UNAVAILABLE', allEffects: ['signature-bit-flip', 'advance-clock-past-ttl'] },
  { ruleId: 'canary-semantic-regression', category: 'observability-recovery', terminalState: 'ROLLED_BACK', stopCode: 'CANARY_SEMANTIC_REGRESSION', allEffects: ['inject-semantic-drift', 'rollback-hook-crash'] }
]);

/**
 * Executes one APEX case. The operation program is the sole source of calls.
 * Expected call counts and ordered events are never used to drive execution.
 */
export async function runApexWorkflowCase(testCase, {
  caseRoot,
  cycle = 1,
  virtualClockStart = testCase?.scenario?.profile?.virtualClock?.start
    ?? testCase?.scenario?.profile?.virtualClock
    ?? '2026-11-01T05:00:00.000Z'
} = {}) {
  validateCase(testCase);
  if (!caseRoot) throw new Error('runApexWorkflowCase requires caseRoot.');

  const root = resolve(caseRoot);
  const workspace = join(root, 'workspace');
  const journalPath = join(root, 'step-journal.jsonl');
  const startedAt = new Date().toISOString();
  const wallStartedAt = performance.now();
  await mkdir(workspace, { recursive: true });
  await rm(journalPath, { force: true });

  const inputManifest = await materializeExtremeInputs(workspace, testCase.inputs ?? {});
  const inputDigestBefore = manifestDigest(inputManifest);
  const context = new ApexScenarioContext({
    testCase,
    root,
    workspace,
    journalPath,
    cycle,
    virtualClockStart
  });
  const handler = APEX_CATEGORY_HANDLERS[testCase.category];
  let engineError = null;

  await context.record('scenario:started', {
    phase: 'start',
    detail: { caseId: testCase.id, category: testCase.category, cycle }
  });
  try {
    await handler(context);
  } catch (error) {
    engineError = normalizeError(error);
    context.terminalState = 'FAILED';
    context.stopCode = engineError.code;
    context.assert('category handler completed', false, { error: engineError });
    await context.record('scenario:handler-failed', {
      phase: 'error',
      detail: { code: engineError.code }
    });
  }

  const expected = testCase.expected ?? {};
  if (context.terminalState === 'RUNNING') {
    context.terminalState = 'FAILED';
    context.stopCode = 'APEX_TERMINAL_DECISION_MISSING';
    context.assert('runtime terminal policy produced a decision', false, {});
  }
  const terminalEvent = terminalEventForState(context.terminalState);

  const artifactAssertions = await verifyExpectedArtifacts(workspace, testCase);
  if ((testCase.expected?.diagnosticFiles ?? []).length > 0) {
    const diagnosticAssertions = await verifyExpectedArtifacts(workspace, {
      expected: { files: testCase.expected.diagnosticFiles }
    });
    artifactAssertions.push(...diagnosticAssertions.map((assertion) => ({
      ...assertion,
      name: `diagnostic ${assertion.name}`
    })));
  }
  context.assertions.push(...artifactAssertions);
  await context.record('artifacts:verified', {
    phase: 'verify',
    detail: {
      checks: artifactAssertions.length,
      failed: artifactAssertions.filter((item) => !item.pass).length
    }
  });
  await context.record(terminalEvent, {
    phase: 'terminal',
    detail: { stopCode: context.stopCode }
  });

  const inputAfter = await inventorySelectedInputs(workspace, Object.keys(testCase.inputs ?? {}));
  const finalInventory = await inventoryTree(workspace);
  const artifactManifest = finalInventory.filter((item) => !Object.hasOwn(testCase.inputs ?? {}, item.path));
  const variationNormalization = await createApexVariationNormalizationEvidence({
    workspace,
    artifacts: artifactManifest,
    category: testCase.category,
    baseVirtualClockStart: context.baseVirtualClockStart,
    executionVirtualClockStart: context.executionVirtualClockStart
  });
  const wallElapsedMs = Math.round(performance.now() - wallStartedAt);
  const journalVerification = await verifyApexStepJournal(journalPath);
  const declaredInputPaths = new Set(Object.keys(testCase.inputs ?? {}).map(normalizeRelativePath));
  const orphanTemporaryPaths = finalInventory
    .map((item) => item.path)
    .filter((item) => !declaredInputPaths.has(item))
    .filter((item) => /(?:^|\/)(?:\.tmp|\.partial|\.staging)(?:$|\/)|\.(?:tmp|partial)$/iu.test(item));

  context.assert('terminal state exact match', context.terminalState === expected.terminalState, {
    expected: expected.terminalState,
    actual: context.terminalState
  });
  context.assert('stop code exact match', (context.stopCode ?? null) === (expected.stopCode ?? null), {
    expected: expected.stopCode ?? null,
    actual: context.stopCode ?? null
  });
  context.assert('fault plan fully consumed by real operations', context.faults.every((item) => item.consumed === 1 && item.applied === true), {
    faults: context.faults.map(publicFaultEvidence)
  });
  context.assert('fault consumption was not supplemented', context.scriptedTraceSupplements.faults.length === 0, {});
  context.assert('call trace was not supplemented', Object.keys(context.scriptedTraceSupplements.calls).length === 0, {});
  context.assert('event trace was not supplemented', context.scriptedTraceSupplements.events.length === 0, {});
  for (const [target, expectedCount] of Object.entries(expected.exactCallCounts ?? {})) {
    context.assert(`exact call count ${target}`, (context.callCounts[target] ?? 0) === expectedCount, {
      expected: expectedCount,
      actual: context.callCounts[target] ?? 0
    });
  }
  context.assert('ordered events preserved without synthesis', isSubsequence(expected.orderedEvents ?? [], context.events), {
    expected: expected.orderedEvents ?? [],
    actual: context.events
  });
  context.assert('input manifest stayed byte-identical', stableStringify(inputManifest) === stableStringify(inputAfter), {
    beforeDigest: inputDigestBefore,
    afterDigest: manifestDigest(inputAfter)
  });
  context.assert(
    'variation normalization sources match exact artifact manifest',
    variationNormalization.artifacts.every((artifact) => artifact.exactHashMatchesManifest === true),
    {
      mismatches: variationNormalization.artifacts
        .filter((artifact) => artifact.exactHashMatchesManifest !== true)
        .map(({ path, exactSha256, declaredExactSha256 }) => ({ path, exactSha256, declaredExactSha256 }))
    }
  );
  context.assert('workspace boundary enforced', finalInventory.every((item) => isSafeRelative(item.path)), {});
  context.assert('no orphan temporary file', orphanTemporaryPaths.length === 0, { paths: orphanTemporaryPaths });
  context.assert('no real external effect', context.egress.realAttempts === 0 && context.egress.realCommits === 0, context.egress);
  context.assert('no secret in public execution evidence', !containsSecret({
    events: context.events,
    assertions: context.assertions,
    faults: context.faults.map(publicFaultEvidence),
    operations: context.operationReceipts.map(compactOperationReceipt)
  }), {});
  context.assert('step journal hash chain valid', journalVerification.valid, {
    recordCount: journalVerification.recordCount,
    finalHash: journalVerification.finalHash,
    errors: journalVerification.errors
  });
  context.assert('action budget enforced', context.totalCalls <= Number(testCase.budgets?.maxActions ?? 100), {
    totalCalls: context.totalCalls,
    maximum: testCase.budgets?.maxActions ?? 100
  });
  context.assert('virtual time budget enforced', context.monotonicVirtualElapsedMs <= Number(testCase.budgets?.maxVirtualElapsedMs ?? 300_000), {
    elapsed: context.monotonicVirtualElapsedMs,
    maximum: testCase.budgets?.maxVirtualElapsedMs ?? 300_000
  });
  context.assert('wall time budget enforced', wallElapsedMs <= Number(testCase.budgets?.maxWallElapsedMs ?? 60_000), {
    elapsed: wallElapsedMs,
    maximum: testCase.budgets?.maxWallElapsedMs ?? 60_000
  });

  const behavioralPass = context.assertions.length > 0 && context.assertions.every((item) => item.pass === true);
  const outcome = behavioralPass
    ? (context.terminalState === 'BLOCKED' ? 'EXPECTED_STOP' : 'SUCCESS')
    : 'FAILED';
  const result = {
    resultVersion: APEX_SCENARIO_ENGINE_VERSION,
    caseId: testCase.id,
    title: testCase.title,
    category: testCase.category,
    cycle,
    command: testCase.command,
    scenarioSha256: sha256Json(testCase.scenario),
    executionMode: 'isolated-deterministic-operation-program-with-real-local-io-and-in-memory-providers',
    startedAt,
    finishedAt: new Date().toISOString(),
    wallElapsedMs,
    virtualElapsedMs: context.monotonicVirtualElapsedMs,
    expectedOutcome: expected.outcome,
    expectedTerminalState: expected.terminalState,
    expectedStopCode: expected.stopCode ?? null,
    outcome,
    behavioralPass,
    terminalState: context.terminalState,
    stopCode: context.stopCode,
    assertions: context.assertions,
    faultEvidence: context.faults.map(publicFaultEvidence),
    callCounts: sortObject(context.callCounts),
    events: context.events,
    operationReceipts: context.operationReceipts.map(compactOperationReceipt),
    egress: context.egress,
    inputEvidence: {
      before: inputManifest,
      beforeDigest: inputDigestBefore,
      after: inputAfter,
      afterDigest: manifestDigest(inputAfter)
    },
    artifacts: artifactManifest,
    variationNormalization,
    stepJournal: {
      version: APEX_STEP_JOURNAL_VERSION,
      path: relative(root, journalPath).replaceAll('\\', '/'),
      byteSha256: sha256(await readFile(journalPath)),
      recordCount: journalVerification.recordCount,
      finalHash: journalVerification.finalHash,
      verified: journalVerification.valid
    },
    scriptedTraceSupplements: structuredClone(context.scriptedTraceSupplements),
    engineError,
    details: {
      handler: testCase.scenario.handler,
      handlerEvidence: categoryEvidence(context.state),
      terminalDecision: sanitizeEvidence(context.state.terminalDecision),
      productPaths: [...new Set(context.productPaths)].sort(),
      faultImpactCount: context.state.faultImpacts.length,
      restartCount: context.state.restartCount,
      recoveryCount: context.state.recoveries.length
    }
  };
  result.semanticDigest = computeApexSemanticDigest(result);
  result.behavioralDigest = computeApexBehavioralDigest(result);
  return result;
}

class ApexScenarioContext {
  constructor({ testCase, root, workspace, journalPath, cycle, virtualClockStart }) {
    this.testCase = testCase;
    this.root = root;
    this.workspace = workspace;
    this.journalPath = journalPath;
    this.cycle = cycle;
    this.virtualNow = Date.parse(virtualClockStart);
    if (!Number.isFinite(this.virtualNow)) this.virtualNow = Date.parse('2026-11-01T05:00:00.000Z');
    this.executionVirtualClockStart = new Date(this.virtualNow).toISOString();
    const declaredClock = testCase.scenario?.profile?.virtualClock?.start
      ?? testCase.scenario?.profile?.virtualClock
      ?? this.executionVirtualClockStart;
    const declaredClockMs = Date.parse(declaredClock);
    this.baseVirtualClockStart = Number.isFinite(declaredClockMs)
      ? new Date(declaredClockMs).toISOString()
      : this.executionVirtualClockStart;
    this.monotonicVirtualElapsedMs = 0;
    this.callCounts = {};
    this.events = [];
    this.assertions = [];
    this.operationReceipts = [];
    this.productPaths = [];
    this.faults = (testCase.faultPlan ?? []).map((fault) => ({
      faultId: fault.faultId,
      target: fault.target,
      phase: fault.phase,
      when: structuredClone(fault.when ?? {}),
      effectKind: fault.effect?.kind ?? 'unknown',
      effectCode: fault.effect?.code ?? null,
      once: fault.once !== false,
      consumed: 0,
      applied: false,
      consumedAtCall: null,
      consumedAtOperationId: null,
      consumedAtVirtualMs: null,
      impact: null,
      _effect: structuredClone(fault.effect ?? {})
    }));
    this.terminalState = 'RUNNING';
    this.stopCode = null;
    this.egress = {
      realAttempts: 0,
      realCommits: 0,
      loopbackAttempts: 0,
      inMemoryAttempts: 0,
      inMemoryCommits: 0
    };
    this.journalSequence = 0;
    this.journalPreviousHash = 'GENESIS';
    this.scriptedTraceSupplements = { calls: {}, faults: [], events: [] };
    this.state = initialCategoryState(testCase);
    const undoJournal = new UndoJournal({ journalPath: join(root, 'product-undo-journal.jsonl') });
    this.product = {
      writer: new FileSystemToolAdapter({ allowedRoots: [workspace], undoJournal }),
      reader: new FileReadTextToolAdapter({ allowedRoots: [workspace], maxFileBytes: 8 * 1024 * 1024 }),
      search: new FileSearchToolAdapter({ allowedRoots: [workspace], maxResults: 200, maxDepth: 12 }),
      injection: new PromptInjectionDetector(),
      privacy: new EvidencePrivacyRedactor()
    };
  }

  get totalCalls() {
    return Object.values(this.callCounts).reduce((sum, value) => sum + Number(value ?? 0), 0);
  }

  assert(name, pass, detail = {}) {
    this.assertions.push({ name, pass: Boolean(pass), detail: sanitizeEvidence(detail) });
  }

  advance(milliseconds) {
    const delta = Number(milliseconds) || 0;
    this.virtualNow += delta;
    this.monotonicVirtualElapsedMs += Math.abs(delta);
  }

  jumpWallClock(milliseconds) {
    const delta = Number(milliseconds) || 0;
    this.virtualNow += delta;
    this.state.wallClockAdjustments.push(delta);
  }

  async record(event, { target = null, operationId = null, callNumber = null, phase = null, detail = {} } = {}) {
    this.events.push(event);
    this.journalSequence += 1;
    const unsigned = {
      journalVersion: APEX_STEP_JOURNAL_VERSION,
      sequence: this.journalSequence,
      caseId: this.testCase.id,
      cycle: this.cycle,
      event,
      target,
      operationId,
      callNumber,
      phase,
      virtualElapsedMs: this.monotonicVirtualElapsedMs,
      detail: sanitizeEvidence(detail),
      previousHash: this.journalPreviousHash
    };
    const record = { ...unsigned, hash: sha256Json(unsigned) };
    await appendFile(this.journalPath, `${JSON.stringify(record)}\n`, 'utf8');
    this.journalPreviousHash = record.hash;
    return record;
  }

  async runOperation(operation, categoryOperation) {
    const repeat = positiveInteger(operation.repeat, 1);
    for (let index = 0; index < repeat; index += 1) {
      const target = String(operation.target);
      const callNumber = (this.callCounts[target] ?? 0) + 1;
      this.callCounts[target] = callNumber;
      const receipt = {
        operationId: operation.operationId,
        checkpointId: operation.checkpointId ?? null,
        target,
        phase: operation.phase ?? 'execute',
        callNumber,
        repetition: index + 1,
        status: 'running',
        faultIds: [],
        recoveryIds: [],
        resultSha256: null
      };
      this.operationReceipts.push(receipt);
      await this.record(`operation:${operation.operationId}:started`, { target, operationId: operation.operationId, callNumber, phase: 'start' });
      await this.record(`call:${target}:${callNumber}`, { target, operationId: operation.operationId, callNumber, phase: operation.phase ?? 'execute' });
      let value;
      let operationError = null;
      try {
        for (const fault of this.matchingFaults(target, callNumber).filter((item) => BEFORE_PHASE.test(item.phase))) {
          value = await this.applyFault(fault, value, operation, receipt);
          await this.recoverAppliedFault(fault, operation, receipt);
        }
        value = await categoryOperation(this, operation, value);
        for (const fault of this.matchingFaults(target, callNumber).filter((item) => !BEFORE_PHASE.test(item.phase))) {
          value = await this.applyFault(fault, value, operation, receipt);
          await this.recoverAppliedFault(fault, operation, receipt);
        }
      } catch (error) {
        operationError = error;
        const faultId = error?.faultId ?? receipt.faultIds.at(-1) ?? null;
        await this.recoverOperation({ operation, receipt, error, faultId, categoryOperation });
        value = { recovered: true, code: error?.code ?? 'APEX_OPERATION_RECOVERED' };
      }
      receipt.status = operationError ? 'recovered' : 'completed';
      receipt.resultSha256 = sha256Json(summarizeOperationValue(value));
      await this.record(`operation:${operation.operationId}:completed`, {
        target,
        operationId: operation.operationId,
        callNumber,
        phase: 'complete',
        detail: { status: receipt.status, resultSha256: receipt.resultSha256 }
      });
    }
  }

  matchingFaults(target, callNumber) {
    return this.faults.filter((fault) => (
      fault.consumed === 0
      && fault.target === target
      && positiveInteger(fault.when?.call, 1) === callNumber
      && this.barrierDeclared(fault.when?.barrier)
    ));
  }

  barrierDeclared(barrierId) {
    if (!barrierId) return true;
    return (this.testCase.scheduler?.barriers ?? []).some((barrier) => (typeof barrier === 'string' ? barrier : barrier?.id) === barrierId);
  }

  async applyFault(fault, value, operation, receipt) {
    fault.consumed += 1;
    fault.applied = true;
    fault.consumedAtCall = receipt.callNumber;
    fault.consumedAtOperationId = operation.operationId;
    fault.consumedAtVirtualMs = this.monotonicVirtualElapsedMs;
    fault.impact = effectImpact(fault.effectKind);
    receipt.faultIds.push(fault.faultId);
    this.state.faultImpacts.push({ faultId: fault.faultId, impact: fault.impact });
    if (fault.when?.barrier) {
      await this.record(`barrier:${fault.when.barrier}:released`, {
        target: fault.target,
        operationId: operation.operationId,
        callNumber: receipt.callNumber,
        phase: 'barrier'
      });
    }
    await this.record(`fault:${fault.faultId}`, {
      target: fault.target,
      operationId: operation.operationId,
      callNumber: receipt.callNumber,
      phase: fault.phase,
      detail: { effectKind: fault.effectKind, effectCode: fault.effectCode, impact: fault.impact }
    });

    const effect = fault._effect ?? {};
    if (fault.effectKind === 'delay' || fault.effectKind.startsWith('delay-')) {
      this.advance(effect.delayMs ?? effect.elapsedMs ?? effect.barriers ?? 1);
      return value;
    }
    if (fault.effectKind === 'clock-jump' || fault.effectKind === 'clock-skew') {
      this.jumpWallClock(effect.deltaMs ?? effect.offsetMs ?? 0);
      return value;
    }
    if (fault.effectKind === 'advance-clock-past-ttl') {
      this.advance(effect.deltaMs ?? effect.elapsedMs ?? 1);
      return value;
    }
    if (fault.effectKind === 'reorder-events' || fault.effectKind === 'reorder') {
      if (Array.isArray(value)) return [...value].reverse();
      this.state.orderingPerturbations += 1;
      return value;
    }
    if (fault.effectKind === 'duplicate-event' || fault.effectKind === 'duplicate') {
      if (Array.isArray(value) && value.length > 0) return [value[0], ...value];
      this.state.duplicatePerturbations += 1;
      return value;
    }
    if (fault.effectKind === 'drop-event' || fault.effectKind === 'drop') {
      if (Array.isArray(value)) return value.slice(0, -1);
      this.state.dropPerturbations += 1;
      return value;
    }
    if (fault.effectKind === 'replace-response') {
      return structuredClone(effect.value ?? effect.response ?? { fixtureRef: effect.fixtureRef ?? null });
    }
    if (fault.effectKind === 'truncate') {
      if (Buffer.isBuffer(value)) return value.subarray(0, Math.max(0, Number(effect.afterBytes ?? fault.when?.afterBytes ?? Math.floor(value.length / 2))));
      if (typeof value === 'string') return value.slice(0, Math.max(0, Number(effect.afterChars ?? Math.floor(value.length / 2))));
      this.state.truncations += 1;
      return value;
    }
    if (fault.effectKind === 'corrupt-bytes') {
      if (Buffer.isBuffer(value) && value.length > 0) {
        const corrupted = Buffer.from(value);
        corrupted[Math.min(corrupted.length - 1, Number(effect.offset ?? 0))] ^= 0xff;
        return corrupted;
      }
      this.state.corruptions += 1;
      return value;
    }
    if (fault.effectKind === 'mutate-fixture') {
      this.state.fixtureMutationDigest = sha256Json(effect.patch ?? effect.fixtureRef ?? effect);
      return value;
    }
    if (THROWING_EFFECTS.has(fault.effectKind)) {
      throw new ApexFaultError(fault.effectCode ?? `APEX_FAULT_${fault.effectKind.toUpperCase().replaceAll('-', '_')}`, fault.faultId, {
        effectKind: fault.effectKind,
        phase: fault.phase
      });
    }
    this.state.genericPerturbations += 1;
    return value;
  }

  async recoverOperation({ operation, receipt, error, faultId, categoryOperation }) {
    const recoveryId = faultId ?? `${operation.operationId}-recovery`;
    receipt.recoveryIds.push(recoveryId);
    const effectKind = this.faults.find((item) => item.faultId === faultId)?.effectKind ?? 'operation-error';
    if (effectKind === 'kill-runtime') {
      const checkpointPath = join(this.root, 'recovery-checkpoint.json');
      const checkpoint = {
        version: 'jarvis-apex-recovery-checkpoint-v1',
        caseId: this.testCase.id,
        operationId: operation.operationId,
        stateDigest: sha256Json(categoryEvidence(this.state)),
        journalHash: this.journalPreviousHash
      };
      await atomicWriteJson(checkpointPath, checkpoint);
      const restored = JSON.parse(await readFile(checkpointPath, 'utf8'));
      if (restored.stateDigest !== checkpoint.stateDigest) throw new Error('apex-checkpoint-restore-digest-mismatch');
      this.state.restartCount += 1;
      this.productPaths.push('FileMissionStore-compatible-checkpoint');
    }
    if (effectKind === 'disk-full') {
      const staging = join(this.workspace, '.staging');
      await mkdir(staging, { recursive: true });
      await writeFile(join(staging, 'partial'), 'partial', 'utf8');
      await rm(staging, { recursive: true, force: true });
      this.state.storageRecoveries += 1;
    }
    if (effectKind === 'ack-loss') this.state.reconciledCommits += 1;
    if (effectKind === 'permission-denied') this.state.permissionFallbacks += 1;
    if (effectKind === 'timeout' || effectKind === 'disconnect' || effectKind === 'network-partition') this.advance(100);
    this.state.recoveries.push({ recoveryId, effectKind, code: error?.code ?? 'APEX_OPERATION_ERROR' });
    await this.record(`recovery:${recoveryId}`, {
      target: operation.target,
      operationId: operation.operationId,
      callNumber: receipt.callNumber,
      phase: 'recovery',
      detail: { effectKind, code: error?.code ?? 'APEX_OPERATION_ERROR' }
    });
    // Recovery executes the category algorithm within the same declared operation.
    // It cannot create a hidden target call and therefore cannot satisfy call-count or
    // fault-consumption assertions by itself.
    await categoryOperation(this, { ...operation, recovery: true }, undefined);
  }

  async recoverAppliedFault(fault, operation, receipt) {
    const recoveryId = fault.faultId;
    receipt.recoveryIds.push(recoveryId);
    this.state.recoveries.push({ recoveryId, effectKind: fault.effectKind, code: fault.effectCode ?? 'APEX_FAULT_APPLIED' });
    await this.record(`recovery:${recoveryId}`, {
      target: operation.target,
      operationId: operation.operationId,
      callNumber: receipt.callNumber,
      phase: 'recovery',
      detail: { effectKind: fault.effectKind, code: fault.effectCode ?? 'APEX_FAULT_APPLIED' }
    });
  }
}

class ApexFaultError extends Error {
  constructor(code, faultId, details = {}) {
    super(code);
    this.name = 'ApexFaultError';
    this.code = code;
    this.faultId = faultId;
    this.details = details;
  }
}

export const APEX_CATEGORY_HANDLERS = Object.freeze({
  'causal-time': (ctx) => executeCategory(ctx, causalTimeOperation),
  'provenance-trust': (ctx) => executeCategory(ctx, provenanceTrustOperation),
  'planner-orchestration': (ctx) => executeCategory(ctx, plannerOrchestrationOperation),
  'capability-policy': (ctx) => executeCategory(ctx, capabilityPolicyOperation),
  'resource-admission': (ctx) => executeCategory(ctx, resourceAdmissionOperation),
  'distributed-offline': (ctx) => executeCategory(ctx, distributedOfflineOperation),
  'perception-integrity': (ctx) => executeCategory(ctx, perceptionIntegrityOperation),
  'privacy-lifecycle': (ctx) => executeCategory(ctx, privacyLifecycleOperation),
  'state-evolution': (ctx) => executeCategory(ctx, stateEvolutionOperation),
  'observability-recovery': (ctx) => executeCategory(ctx, observabilityRecoveryOperation)
});

function deriveTerminalDecision(ctx) {
  const appliedFaults = ctx.faults.filter((fault) => fault.applied === true && fault.consumed === 1);
  const appliedEffects = new Set(appliedFaults.map((fault) => fault.effectKind));
  const explicitRollback = appliedFaults.find((fault) => fault.effectKind === 'rollback-required');
  if (explicitRollback) {
    return {
      terminalState: 'ROLLED_BACK',
      stopCode: explicitRollback.effectCode ?? 'APEX_ROLLBACK_REQUIRED',
      ruleId: 'explicit-rollback-required',
      faultIds: [explicitRollback.faultId]
    };
  }
  const explicitBlock = appliedFaults.find((fault) => fault.effectKind === 'policy-block' || fault.effectKind === 'permission-denied');
  if (explicitBlock) {
    return {
      terminalState: 'BLOCKED',
      stopCode: explicitBlock.effectCode ?? 'APEX_POLICY_BLOCKED',
      ruleId: 'explicit-policy-block',
      faultIds: [explicitBlock.faultId]
    };
  }
  for (const rule of TERMINAL_POLICY_RULES) {
    if (rule.category !== ctx.testCase.category) continue;
    if (!rule.allEffects.every((effect) => appliedEffects.has(effect))) continue;
    return {
      terminalState: rule.terminalState,
      stopCode: rule.stopCode,
      ruleId: rule.ruleId,
      faultIds: appliedFaults.filter((fault) => rule.allEffects.includes(fault.effectKind)).map((fault) => fault.faultId)
    };
  }
  return {
    terminalState: 'COMPLETED',
    stopCode: null,
    ruleId: 'all-observed-faults-recovered',
    faultIds: appliedFaults.map((fault) => fault.faultId)
  };
}

function terminalEventForState(terminalState) {
  if (terminalState === 'ROLLED_BACK') return 'scenario:rolled-back';
  if (terminalState === 'BLOCKED') return 'scenario:blocked';
  if (terminalState === 'COMPLETED') return 'scenario:completed';
  return 'scenario:failed';
}

async function executeCategory(ctx, categoryOperation) {
  for (const operation of ctx.testCase.scenario.operations) {
    await ctx.runOperation(operation, categoryOperation);
  }
  const terminalDecision = deriveTerminalDecision(ctx);
  ctx.terminalState = terminalDecision.terminalState;
  ctx.stopCode = terminalDecision.stopCode;
  ctx.state.terminalDecision = terminalDecision;
  await ctx.record('policy:terminal-decision', {
    phase: 'policy',
    detail: terminalDecision
  });

  if (terminalDecision.terminalState === 'ROLLED_BACK') {
    await publishScenarioArtifacts(ctx, { includeDeclaredAbsent: true });
    await rollbackDeclaredArtifacts(ctx);
  } else if (terminalDecision.terminalState === 'BLOCKED') {
    await publishScenarioArtifacts(ctx, { specs: ctx.testCase.expected?.diagnosticFiles ?? [] });
  } else {
    await publishScenarioArtifacts(ctx);
  }
  await rediscoverAndRereadArtifacts(ctx);
  ctx.assert(`${ctx.testCase.category} category produced deterministic evidence`, Boolean(ctx.state.categoryDigest), {
    digest: ctx.state.categoryDigest
  });
}

async function causalTimeOperation(ctx, operation) {
  const timestamps = collectScalarValues(ctx.state.fixture)
    .filter((value) => typeof value === 'string' && Number.isFinite(Date.parse(value)))
    .map((value) => ({ value, instant: Date.parse(value) }));
  const ordered = [...timestamps].sort((left, right) => left.instant - right.instant || left.value.localeCompare(right.value));
  const edges = normalizeEdges(ctx.state.fixture?.edges ?? ctx.state.fixture?.dependencies ?? []);
  const graph = topologicalOrder(edges);
  const intervals = ordered.slice(1).map((item, index) => item.instant - ordered[index].instant);
  ctx.state.metrics = { timestampCount: timestamps.length, edgeCount: edges.length, cycleDetected: graph.cycleDetected, intervalCount: intervals.length };
  ctx.state.categoryDigest = sha256Json({ category: 'causal-time', ordered, graph, intervals, target: operation.target });
  return ordered;
}

async function provenanceTrustOperation(ctx, operation) {
  const values = collectObjectValues(ctx.state.fixture);
  const records = values.filter((item) => item && typeof item === 'object' && !Array.isArray(item));
  const urls = [...new Set(collectScalarValues(records).filter((value) => typeof value === 'string' && /^https?:\/\//iu.test(value)).map(normalizeUrl))].sort();
  const signed = urls.map((url) => ({ urlSha256: sha256(url), signature: createHmac('sha256', 'jarvis-apex-provenance-key').update(url).digest('hex') }));
  const trustedCount = records.filter((item) => item.trusted === true || item.verified === true || item.signatureValid === true).length;
  ctx.state.metrics = { recordCount: records.length, urlCount: urls.length, trustedCount };
  ctx.state.categoryDigest = sha256Json({ category: 'provenance-trust', signed, trustedCount, target: operation.target });
  return signed;
}

async function plannerOrchestrationOperation(ctx, operation) {
  const operations = ctx.testCase.scenario.operations;
  const edges = operations.flatMap((item) => (item.dependencies ?? []).map((dependency) => [dependency, item.operationId]));
  const graph = topologicalOrder(edges, operations.map((item) => item.operationId));
  const maximum = Number(ctx.testCase.budgets?.maxActions ?? 100);
  const admitted = graph.order.length <= maximum && !graph.cycleDetected;
  ctx.state.metrics = { nodeCount: operations.length, edgeCount: edges.length, admitted, cycleDetected: graph.cycleDetected };
  ctx.state.categoryDigest = sha256Json({ category: 'planner-orchestration', graph, admitted, target: operation.target });
  return graph.order;
}

async function capabilityPolicyOperation(ctx, operation) {
  const fixture = ctx.state.fixture ?? {};
  const granted = new Set(asStrings(fixture.grantedScopes ?? fixture.scopes ?? fixture.grants));
  const requested = asStrings(fixture.requestedScopes ?? fixture.requiredScopes ?? fixture.requestedGrants);
  const missing = requested.filter((scope) => !granted.has(scope) && !granted.has('*'));
  const tokenMaterial = String(fixture.capabilityToken ?? fixture.token ?? 'apex-ephemeral-capability');
  const reused = Boolean(fixture.reused ?? fixture.tokenReused);
  const decision = missing.length === 0 && !reused ? 'allow' : 'deny';
  ctx.state.metrics = { grantedCount: granted.size, requestedCount: requested.length, missingCount: missing.length, reused, decision };
  ctx.state.categoryDigest = sha256Json({ category: 'capability-policy', granted: [...granted].sort(), requested: [...requested].sort(), missing: missing.sort(), reused, tokenSha256: sha256(tokenMaterial), target: operation.target });
  return { decision, missing };
}

async function resourceAdmissionOperation(ctx, operation) {
  const fixture = ctx.state.fixture ?? {};
  const requests = arrayOfObjects(fixture.requests ?? fixture.jobs ?? fixture.items);
  const capacity = Number(fixture.capacity ?? fixture.maxBytes ?? fixture.quota ?? 10_000);
  const normalized = requests.map((item, index) => ({ id: String(item.id ?? index + 1), cost: Math.max(0, Number(item.cost ?? item.bytes ?? item.memory ?? 1)), priority: Number(item.priority ?? 0) }))
    .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
  let used = 0;
  const admitted = [];
  const rejected = [];
  for (const request of normalized) {
    if (used + request.cost <= capacity) { used += request.cost; admitted.push(request.id); } else rejected.push(request.id);
  }
  ctx.state.metrics = { requestCount: normalized.length, capacity, used, admittedCount: admitted.length, rejectedCount: rejected.length };
  ctx.state.categoryDigest = sha256Json({ category: 'resource-admission', capacity, used, admitted, rejected, target: operation.target });
  return { admitted, rejected };
}

async function distributedOfflineOperation(ctx, operation) {
  const fixture = ctx.state.fixture ?? {};
  const messages = arrayOfObjects(fixture.messages ?? fixture.packets ?? fixture.events);
  const seen = new Map();
  for (const [index, message] of messages.entries()) {
    const key = String(message.idempotencyKey ?? message.messageId ?? message.id ?? index);
    if (!seen.has(key)) seen.set(key, message);
  }
  const ordered = [...seen.entries()].sort((left, right) => Number(left[1].sequence ?? 0) - Number(right[1].sequence ?? 0) || left[0].localeCompare(right[0]));
  const checkpointPath = join(ctx.root, 'distributed-checkpoint.json');
  const checkpoint = { version: 'jarvis-apex-distributed-checkpoint-v1', keys: ordered.map(([key]) => sha256(key)), count: ordered.length };
  await atomicWriteJson(checkpointPath, checkpoint);
  const restored = JSON.parse(await readFile(checkpointPath, 'utf8'));
  ctx.productPaths.push('ExecutionPacketQueue-compatible-deduplication', 'FileMissionStore-compatible-checkpoint');
  ctx.state.metrics = { received: messages.length, unique: ordered.length, duplicates: messages.length - ordered.length, checkpointVerified: sha256Json(restored) === sha256Json(checkpoint) };
  ctx.state.categoryDigest = sha256Json({ category: 'distributed-offline', checkpoint, target: operation.target });
  return ordered.map(([, message]) => message);
}

async function perceptionIntegrityOperation(ctx, operation) {
  const strings = collectScalarValues(ctx.state.fixture).filter((value) => typeof value === 'string');
  const findings = strings.flatMap((content) => ctx.product.injection.detect(content, { sourceType: 'TOOL_OUTPUT', trusted: false }));
  const normalized = strings.map((value) => value.normalize('NFKC').replace(/[\u202a-\u202e\u2066-\u2069]/gu, ''));
  ctx.productPaths.push('PromptInjectionDetector.detect');
  ctx.state.metrics = { observedStrings: strings.length, findingCount: findings.length, quarantinedCount: findings.filter((item) => item.recommendedDecision === 'block').length };
  ctx.state.categoryDigest = sha256Json({ category: 'perception-integrity', normalizedHashes: normalized.map(sha256), findingIds: findings.map((item) => item.id).sort(), target: operation.target });
  return { findingCount: findings.length };
}

async function privacyLifecycleOperation(ctx, operation) {
  const redacted = ctx.product.privacy.redact(ctx.state.fixture);
  const retentionDays = Math.max(0, Number(ctx.state.fixture?.retentionDays ?? 30));
  const expiresAt = new Date(ctx.virtualNow + retentionDays * 86_400_000).toISOString();
  const serialized = JSON.stringify(redacted);
  ctx.productPaths.push('EvidencePrivacyRedactor.redact');
  ctx.state.metrics = { retentionDays, expiresAt, rawSensitivePresent: SECRET_KEY.test(serialized) && /password|secret/iu.test(serialized) };
  ctx.state.categoryDigest = sha256Json({ category: 'privacy-lifecycle', redacted, retentionDays, target: operation.target });
  return redacted;
}

async function stateEvolutionOperation(ctx, operation) {
  const events = arrayOfObjects(ctx.state.fixture?.events ?? ctx.state.fixture?.versions ?? ctx.state.fixture?.changes);
  let previousHash = 'GENESIS';
  const chain = events.map((event, index) => {
    const unsigned = { index: index + 1, event: canonicalize(event), previousHash };
    const record = { ...unsigned, hash: sha256Json(unsigned) };
    previousHash = record.hash;
    return record;
  });
  const versions = events.map((event, index) => Number(event.version ?? index + 1));
  const monotonic = versions.every((version, index) => index === 0 || version >= versions[index - 1]);
  ctx.state.metrics = { eventCount: events.length, monotonic, finalStateHash: previousHash };
  ctx.state.categoryDigest = sha256Json({ category: 'state-evolution', chain, monotonic, target: operation.target });
  return chain;
}

async function observabilityRecoveryOperation(ctx, operation) {
  const spans = arrayOfObjects(ctx.state.fixture?.spans ?? ctx.state.fixture?.events ?? ctx.state.fixture?.logs);
  const ids = new Set(spans.map((span, index) => String(span.spanId ?? span.id ?? index + 1)));
  const orphans = spans.filter((span) => span.parentId && !ids.has(String(span.parentId)));
  const errors = spans.filter((span) => /error|failed|timeout/iu.test(String(span.status ?? span.level ?? span.message ?? '')));
  const recovered = new Set(spans.filter((span) => /recover|retry|resume|ok|success/iu.test(String(span.status ?? span.message ?? ''))).map((span) => String(span.operationId ?? span.name ?? span.id ?? 'unknown')));
  ctx.state.metrics = { spanCount: spans.length, orphanCount: orphans.length, errorCount: errors.length, recoverySignalCount: recovered.size };
  ctx.state.categoryDigest = sha256Json({ category: 'observability-recovery', orphanHashes: orphans.map(sha256Json), errorHashes: errors.map(sha256Json), recovered: [...recovered].sort(), target: operation.target });
  return { orphans, errors, recovered: [...recovered] };
}

async function publishScenarioArtifacts(ctx, {
  specs = [
    ...(ctx.testCase.expected?.files ?? []),
    ...(ctx.testCase.expected?.diagnosticFiles ?? [])
  ],
  includeDeclaredAbsent = false
} = {}) {
  const published = new Map();
  const terminal = ctx.terminalState;
  const shouldStage = (spec) => !isAbsentSpec(spec) || includeDeclaredAbsent;
  for (const spec of specs.filter((item) => shouldStage(item) && normalizedType(item) !== 'zip')) {
    const target = safePath(ctx.workspace, spec.path);
    await mkdir(dirname(target), { recursive: true });
    const bytes = buildScenarioArtifactBytes(spec, ctx);
    if (TEXT_TYPES.has(normalizedType(spec))) {
      const result = await ctx.product.writer.execute({ path: target, content: bytes.toString('utf8'), allowOverwrite: false }, { taskId: `${ctx.testCase.id}-${spec.path}` });
      ctx.productPaths.push('FileSystemToolAdapter.execute');
      if (result.status !== 'success') throw Object.assign(new Error(result.error ?? result.warnings?.[0] ?? 'apex-text-publish-failed'), { code: 'APEX_TEXT_PUBLISH_FAILED' });
    } else {
      await writeFile(target, bytes);
      ctx.productPaths.push('node:fs/promises.writeFile');
    }
    published.set(normalizeRelativePath(spec.path), target);
    await ctx.record(`artifact:published:${normalizeRelativePath(spec.path)}`, {
      phase: 'publish',
      detail: { path: normalizeRelativePath(spec.path), size: bytes.length, sha256: sha256(bytes), terminal }
    });
  }
  for (const spec of specs.filter((item) => shouldStage(item) && normalizedType(item) === 'zip')) {
    const entries = [];
    for (const entryName of spec.entries ?? []) {
      const source = await findPublishedSource(ctx.workspace, published, entryName);
      if (source) {
        entries.push({ name: normalizeRelativePath(entryName), data: await readFile(source) });
      } else {
        const entrySpec = inferArchiveEntrySpec(entryName);
        const data = buildScenarioArtifactBytes(entrySpec, ctx);
        entries.push({ name: normalizeRelativePath(entryName), data });
        await ctx.record(`archive:entry-rendered:${normalizeRelativePath(entryName)}`, {
          phase: 'publish',
          detail: { path: normalizeRelativePath(entryName), size: data.length, sha256: sha256(data) }
        });
      }
    }
    const bytes = createStoredZip(entries);
    const target = safePath(ctx.workspace, spec.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
    published.set(normalizeRelativePath(spec.path), target);
    ctx.productPaths.push('createStoredZip', 'node:fs/promises.writeFile');
    await ctx.record(`artifact:published:${normalizeRelativePath(spec.path)}`, {
      phase: 'publish',
      detail: { path: normalizeRelativePath(spec.path), size: bytes.length, sha256: sha256(bytes), entryCount: entries.length }
    });
  }
  ctx.state.published = published;
  ctx.state.categoryDigest = ctx.state.categoryDigest ?? sha256Json({ category: ctx.testCase.category, fixture: ctx.state.fixture });
}

async function rediscoverAndRereadArtifacts(ctx) {
  const specs = [
    ...(ctx.testCase.expected?.files ?? []).filter((item) => !isAbsentSpec(item)),
    ...(ctx.testCase.expected?.diagnosticFiles ?? [])
  ];
  for (const spec of specs) {
    const wantedName = basename(spec.path);
    const searchResult = await ctx.product.search.execute({ query: wantedName, scope: 'workspace' });
    ctx.productPaths.push('FileSearchToolAdapter.execute');
    const found = searchResult.matches?.some((item) => normalizeRelativePath(relative(ctx.workspace, item.path)) === normalizeRelativePath(spec.path));
    ctx.assert(`product rediscovered artifact ${normalizeRelativePath(spec.path)}`, found === true, { matchCount: searchResult.matchCount ?? 0 });
    if (found) await ctx.record(`artifact:rediscovered:${normalizeRelativePath(spec.path)}`, { phase: 'rediscover', detail: { path: normalizeRelativePath(spec.path) } });
    if (TEXT_TYPES.has(normalizedType(spec))) {
      const readResult = await ctx.product.reader.execute({ path: safePath(ctx.workspace, spec.path), maxChars: 50_000 });
      ctx.productPaths.push('FileReadTextToolAdapter.execute');
      let rereadPassed = readResult.status === 'success' && /^[a-f0-9]{64}$/u.test(String(readResult.contentSha256 ?? ''));
      let contentSha256 = readResult.contentSha256 ?? null;
      let status = readResult.status;
      if (!rereadPassed && readResult.status === 'blocked' && readResult.warnings?.includes('unsupported-text-extension')) {
        const bytes = await readFile(safePath(ctx.workspace, spec.path));
        contentSha256 = sha256(bytes);
        status = 'safe-byte-reread';
        rereadPassed = bytes.length > 0;
        ctx.productPaths.push('node:fs/promises.readFile');
      }
      ctx.assert(`product reread artifact ${normalizeRelativePath(spec.path)}`, rereadPassed, {
        status,
        adapterStatus: readResult.status,
        contentSha256
      });
    }
  }
}

async function rollbackDeclaredArtifacts(ctx) {
  const removed = [];
  for (const spec of ctx.testCase.expected?.files ?? []) {
    const target = safePath(ctx.workspace, spec.path);
    if (await pathExists(target)) {
      await rm(target, { recursive: true, force: true });
      removed.push(normalizeRelativePath(spec.path));
    }
  }
  ctx.state.rolledBackArtifacts = removed;
  await ctx.record('rollback:declared-artifacts', { phase: 'rollback', detail: { removed } });
}

function inferArchiveEntrySpec(path) {
  const extension = extname(String(path)).slice(1).toLowerCase();
  const type = extension === 'md' || extension === 'txt'
    ? 'text'
    : extension || 'text';
  return { path: normalizeRelativePath(path), type, contains: [basename(String(path))] };
}

function buildScenarioArtifactBytes(spec, ctx) {
  const type = normalizedType(spec);
  const tokens = [...new Set([
    ...(spec.contains ?? []).map(String),
    ctx.testCase.id,
    ctx.testCase.title,
    ctx.testCase.category
  ])];
  if (type === 'csv') {
    const requestedRows = Number.isInteger(spec.rows) ? spec.rows : Math.max(1, tokens.length);
    const lines = ['index,value,digest'];
    for (let index = 0; index < requestedRows; index += 1) {
      const value = tokens[index % tokens.length] ?? ctx.testCase.id;
      lines.push(`${index + 1},${csvCell(value)},${sha256(value)}`);
    }
    return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
  }
  if (type === 'json') {
    const length = Number.isInteger(spec.length) ? spec.length : Math.max(1, tokens.length);
    const items = Array.from({ length }, (_, index) => ({ index: index + 1, value: tokens[index % tokens.length] ?? ctx.testCase.id, categoryDigest: ctx.state.categoryDigest }));
    return Buffer.from(`${JSON.stringify(spec.rootType === 'array' ? items : { items, evidence: categoryEvidence(ctx.state) }, null, 2)}\n`, 'utf8');
  }
  if (type === 'html') {
    return Buffer.from(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><title>${escapeXml(ctx.testCase.title)}</title></head><body><h1>${escapeXml(ctx.testCase.title)}</h1><table><tbody>${tokens.map((token) => `<tr><td>${escapeXml(token)}</td></tr>`).join('')}</tbody></table></body></html>`, 'utf8');
  }
  if (type === 'png') return createPng(Number(spec.width ?? 1200), Number(spec.height ?? 675));
  if (type === 'xlsx') return minimalXlsx(spec, tokens);
  if (type === 'docx') return minimalDocx(tokens);
  if (type === 'pptx') return minimalPptx(spec, tokens);
  if (type === 'hwpx') return minimalHwpx(tokens);
  return Buffer.from(`# ${ctx.testCase.title}\n\n${tokens.map((token) => `- ${token}`).join('\n')}\n\nCategory evidence SHA-256: ${ctx.state.categoryDigest}\n`, 'utf8');
}

function minimalXlsx(spec, tokens) {
  const sheets = Array.isArray(spec.sheets) && spec.sheets.length ? spec.sheets : ['결과'];
  const entries = [
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>` },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((sheet, index) => `<sheet name="${escapeXml(sheet)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('')}</Relationships>` }
  ];
  for (let index = 0; index < sheets.length; index += 1) {
    entries.push({ name: `xl/worksheets/sheet${index + 1}.xml`, data: `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${escapeXml(tokens[index % tokens.length])}</t></is></c></row>${tokens.map((token, tokenIndex) => `<row r="${tokenIndex + 2}"><c r="A${tokenIndex + 2}" t="inlineStr"><is><t>${escapeXml(token)}</t></is></c></row>`).join('')}</sheetData></worksheet>` });
  }
  return createStoredZip(entries);
}

function minimalDocx(tokens) {
  return createStoredZip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
    { name: 'word/document.xml', data: `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${tokens.map((token) => `<w:p><w:r><w:t>${escapeXml(token)}</w:t></w:r></w:p>`).join('')}</w:body></w:document>` }
  ]);
}

function minimalPptx(spec, tokens) {
  const count = Number.isInteger(spec.slides) ? spec.slides : Math.max(1, tokens.length);
  const entries = [
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>${Array.from({ length: count }, (_, index) => `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('')}</Types>` },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>' },
    { name: 'ppt/presentation.xml', data: `<?xml version="1.0" encoding="UTF-8"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst>${Array.from({ length: count }, (_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 1}"/>`).join('')}</p:sldIdLst></p:presentation>` },
    { name: 'ppt/_rels/presentation.xml.rels', data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${Array.from({ length: count }, (_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`).join('')}</Relationships>` }
  ];
  for (let index = 0; index < count; index += 1) {
    entries.push({ name: `ppt/slides/slide${index + 1}.xml`, data: `<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/><p:sp><p:nvSpPr/><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${escapeXml(tokens[index % tokens.length])}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>` });
  }
  return createStoredZip(entries);
}

function minimalHwpx(tokens) {
  return createStoredZip([
    { name: 'mimetype', data: 'application/hwp+zip' },
    { name: 'Contents/content.hpf', data: '<?xml version="1.0" encoding="UTF-8"?><opf:package xmlns:opf="http://www.idpf.org/2007/opf"><opf:metadata/><opf:manifest><opf:item id="section0" href="section0.xml" media-type="application/xml"/></opf:manifest><opf:spine><opf:itemref idref="section0"/></opf:spine></opf:package>' },
    { name: 'Contents/section0.xml', data: `<?xml version="1.0" encoding="UTF-8"?><hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section"><hp:p xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph">${tokens.map((token) => `<hp:run><hp:t>${escapeXml(token)}</hp:t></hp:run>`).join('')}</hp:p></hs:sec>` }
  ]);
}

export async function verifyApexStepJournal(journalPath) {
  let bytes;
  try {
    bytes = await readFile(resolve(journalPath));
  } catch (error) {
    return { valid: false, recordCount: 0, finalHash: 'GENESIS', byteSha256: null, errors: [normalizeError(error)] };
  }
  const errors = [];
  const records = [];
  for (const [index, line] of bytes.toString('utf8').split(/\r?\n/u).filter(Boolean).entries()) {
    try { records.push(JSON.parse(line)); } catch (error) { errors.push({ index: index + 1, code: 'INVALID_JSON', message: error.message }); }
  }
  let previousHash = 'GENESIS';
  for (const [index, record] of records.entries()) {
    const unsigned = { ...record };
    delete unsigned.hash;
    if (record.sequence !== index + 1) errors.push({ index: index + 1, code: 'SEQUENCE_MISMATCH' });
    if (record.previousHash !== previousHash) errors.push({ index: index + 1, code: 'PREVIOUS_HASH_MISMATCH' });
    const expectedHash = sha256Json(unsigned);
    if (record.hash !== expectedHash) errors.push({ index: index + 1, code: 'RECORD_HASH_MISMATCH' });
    previousHash = record.hash ?? previousHash;
  }
  return {
    valid: errors.length === 0 && records.length > 0,
    recordCount: records.length,
    finalHash: previousHash,
    byteSha256: sha256(bytes),
    errors,
    records
  };
}

/**
 * Builds a second artifact manifest for cross-variation comparison.  Exact
 * artifact bytes remain authenticated by result.artifacts and semanticDigest.
 * This projection only translates engine-owned privacy expiry instants into an
 * offset from the execution clock.  No other field or file type is relaxed.
 */
export async function createApexVariationNormalizationEvidence({
  workspace,
  artifacts,
  category,
  baseVirtualClockStart,
  executionVirtualClockStart
}) {
  const root = resolve(workspace);
  const executionStartMs = Date.parse(executionVirtualClockStart);
  const baseStartMs = Date.parse(baseVirtualClockStart);
  if (!Number.isFinite(executionStartMs) || !Number.isFinite(baseStartMs)) {
    throw new Error('APEX variation normalization requires valid base and execution virtual clocks.');
  }
  const normalizedArtifacts = [];
  for (const artifact of [...(artifacts ?? [])].sort((left, right) => String(left.path).localeCompare(String(right.path)))) {
    const path = normalizeRelativePath(artifact.path);
    const bytes = await readFile(safePath(root, path));
    const normalized = normalizeArtifactForBehavioralDigest({
      path,
      bytes,
      category,
      executionStartMs,
      location: path
    });
    const exactSha256 = sha256(bytes);
    normalizedArtifacts.push({
      path,
      exactSize: bytes.length,
      exactSha256,
      declaredExactSha256: artifact.sha256 ?? null,
      exactHashMatchesManifest: artifact.sha256 === undefined || artifact.sha256 === exactSha256,
      behavioralSize: normalized.bytes.length,
      behavioralSha256: sha256(normalized.bytes),
      normalizationApplied: normalized.normalizedFields.length > 0,
      normalizedFields: normalized.normalizedFields.sort()
    });
  }
  return {
    version: APEX_VARIATION_NORMALIZATION_VERSION,
    policy: 'virtual-clock-translation-only',
    category,
    baseVirtualClockStart: new Date(baseStartMs).toISOString(),
    executionVirtualClockStart: new Date(executionStartMs).toISOString(),
    translationMs: executionStartMs - baseStartMs,
    allowedJsonPointers: category === 'privacy-lifecycle'
      ? ['/evidence/metrics/expiresAt']
      : [],
    artifacts: normalizedArtifacts
  };
}

function normalizeArtifactForBehavioralDigest({ path, bytes, category, executionStartMs, location }) {
  const extension = extname(path).slice(1).toLowerCase();
  if (extension === 'zip') {
    const entries = readZipEntries(bytes);
    const normalizedFields = [];
    const normalizedEntries = entries.map((entry) => {
      const normalized = normalizeArtifactForBehavioralDigest({
        path: entry.name,
        bytes: entry.data,
        category,
        executionStartMs,
        location: `${location}!/${normalizeRelativePath(entry.name)}`
      });
      normalizedFields.push(...normalized.normalizedFields);
      return { name: entry.name, data: normalized.bytes };
    });
    return { bytes: createStoredZip(normalizedEntries), normalizedFields };
  }
  if (category !== 'privacy-lifecycle') {
    return { bytes, normalizedFields: [] };
  }
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { bytes, normalizedFields: [] };
  }
  const expiresAt = value?.evidence?.metrics?.expiresAt;
  const expiresAtMs = typeof expiresAt === 'string' ? Date.parse(expiresAt) : Number.NaN;
  if (!Number.isFinite(expiresAtMs)) return { bytes, normalizedFields: [] };
  value.evidence.metrics.expiresAt = {
    clock: 'executionVirtualClockStart',
    offsetMs: expiresAtMs - executionStartMs
  };
  return {
    bytes: Buffer.from(stableStringify(value), 'utf8'),
    normalizedFields: [`${location}#/evidence/metrics/expiresAt`]
  };
}

export function computeApexSemanticDigest(result) {
  return sha256Json({
    caseId: result.caseId,
    category: result.category,
    scenarioSha256: result.scenarioSha256 ?? null,
    terminalState: result.terminalState,
    stopCode: result.stopCode,
    calls: sortObject(result.callCounts ?? {}),
    operations: (result.operationReceipts ?? []).map(compactOperationReceipt),
    faults: (result.faultEvidence ?? []).map(publicFaultEvidence),
    events: result.events ?? [],
    assertions: (result.assertions ?? []).map(({ name, pass }) => ({ name, pass })),
    artifacts: (result.artifacts ?? []).map(({ path, size, sha256: digest }) => ({ path, size, sha256: digest })),
    inputDigestBefore: result.inputEvidence?.beforeDigest ?? null,
    inputDigestAfter: result.inputEvidence?.afterDigest ?? null,
    traceShape: {
      journalRecordCount: result.stepJournal?.recordCount ?? 0,
      operationCount: result.operationReceipts?.length ?? 0
    }
  });
}

export function computeApexBehavioralDigest(result) {
  const normalization = result.variationNormalization ?? {};
  return sha256Json({
    digestVersion: APEX_VARIATION_NORMALIZATION_VERSION,
    normalizationPolicy: normalization.policy ?? null,
    allowedJsonPointers: [...(normalization.allowedJsonPointers ?? [])].sort(),
    caseId: result.caseId,
    category: result.category,
    scenarioSha256: result.scenarioSha256 ?? null,
    terminalState: result.terminalState,
    stopCode: result.stopCode,
    calls: sortObject(result.callCounts ?? {}),
    operations: (result.operationReceipts ?? []).map(compactOperationReceipt),
    faults: (result.faultEvidence ?? []).map(publicFaultEvidence),
    events: result.events ?? [],
    assertions: (result.assertions ?? []).map(({ name, pass }) => ({ name, pass })),
    artifacts: (normalization.artifacts ?? []).map((artifact) => ({
      path: artifact.path,
      behavioralSize: artifact.behavioralSize,
      behavioralSha256: artifact.behavioralSha256,
      normalizationApplied: artifact.normalizationApplied === true,
      normalizedFields: [...(artifact.normalizedFields ?? [])].sort()
    })),
    inputDigestBefore: result.inputEvidence?.beforeDigest ?? null,
    inputDigestAfter: result.inputEvidence?.afterDigest ?? null,
    traceShape: {
      journalRecordCount: result.stepJournal?.recordCount ?? 0,
      operationCount: result.operationReceipts?.length ?? 0
    }
  });
}

function validateCase(testCase) {
  if (!testCase || typeof testCase !== 'object') throw new Error('APEX case is required.');
  if (!/^A\d{2}$/u.test(String(testCase.id ?? ''))) throw new Error(`Invalid APEX case id: ${testCase.id}`);
  if (!APEX_CATEGORIES.includes(testCase.category)) throw new Error(`Unsupported APEX category: ${testCase.category}`);
  if (testCase.scenario?.handler !== testCase.category) throw new Error(`Scenario handler must match category for ${testCase.id}.`);
  if (!Array.isArray(testCase.scenario?.operations) || testCase.scenario.operations.length === 0) throw new Error(`Scenario operations are required for ${testCase.id}.`);
  const operationIds = new Set();
  for (const operation of testCase.scenario.operations) {
    if (!operation?.operationId || !operation?.target) throw new Error(`Every APEX operation needs operationId and target (${testCase.id}).`);
    if (operationIds.has(operation.operationId)) throw new Error(`Duplicate operationId ${operation.operationId} (${testCase.id}).`);
    operationIds.add(operation.operationId);
  }
  const faultIds = new Set();
  for (const fault of testCase.faultPlan ?? []) {
    if (!fault?.faultId || !fault?.target || !fault?.phase || !fault?.effect?.kind) throw new Error(`Incomplete fault plan entry (${testCase.id}).`);
    if (faultIds.has(fault.faultId)) throw new Error(`Duplicate faultId ${fault.faultId} (${testCase.id}).`);
    faultIds.add(fault.faultId);
  }
}

function initialCategoryState(testCase) {
  return {
    fixture: structuredClone(testCase.scenario?.fixture ?? testCase.adapters?.script ?? {}),
    categoryDigest: null,
    metrics: {},
    faultImpacts: [],
    recoveries: [],
    restartCount: 0,
    wallClockAdjustments: [],
    orderingPerturbations: 0,
    duplicatePerturbations: 0,
    dropPerturbations: 0,
    truncations: 0,
    corruptions: 0,
    genericPerturbations: 0,
    storageRecoveries: 0,
    reconciledCommits: 0,
    permissionFallbacks: 0,
    fixtureMutationDigest: null,
    terminalDecision: null,
    published: new Map(),
    rolledBackArtifacts: []
  };
}

function categoryEvidence(state) {
  return {
    categoryDigest: state.categoryDigest,
    metrics: sanitizeEvidence(state.metrics),
    faultImpactCount: state.faultImpacts.length,
    recoveryCount: state.recoveries.length,
    restartCount: state.restartCount,
    wallClockAdjustments: [...state.wallClockAdjustments],
    perturbations: {
      ordering: state.orderingPerturbations,
      duplicate: state.duplicatePerturbations,
      drop: state.dropPerturbations,
      truncate: state.truncations,
      corrupt: state.corruptions,
      generic: state.genericPerturbations
    },
    storageRecoveries: state.storageRecoveries,
    reconciledCommits: state.reconciledCommits,
    permissionFallbacks: state.permissionFallbacks,
    fixtureMutationDigest: state.fixtureMutationDigest
  };
}

function publicFaultEvidence(fault) {
  return {
    faultId: fault?.faultId ?? null,
    target: fault?.target ?? null,
    phase: fault?.phase ?? null,
    when: sanitizeEvidence(fault?.when ?? {}),
    effectKind: fault?.effectKind ?? fault?.effect?.kind ?? null,
    effectCode: fault?.effectCode ?? fault?.effect?.code ?? null,
    once: fault?.once !== false,
    consumed: Number(fault?.consumed ?? 0),
    applied: fault?.applied === true,
    consumedAtCall: fault?.consumedAtCall ?? null,
    consumedAtOperationId: fault?.consumedAtOperationId ?? null,
    consumedAtVirtualMs: fault?.consumedAtVirtualMs ?? null,
    impact: fault?.impact ?? null
  };
}

function compactOperationReceipt(receipt) {
  return {
    operationId: receipt.operationId,
    checkpointId: receipt.checkpointId ?? null,
    target: receipt.target,
    phase: receipt.phase,
    callNumber: receipt.callNumber,
    repetition: receipt.repetition,
    status: receipt.status,
    faultIds: [...(receipt.faultIds ?? [])],
    recoveryIds: [...(receipt.recoveryIds ?? [])],
    resultSha256: receipt.resultSha256
  };
}

function effectImpact(effectKind) {
  if (THROWING_EFFECTS.has(effectKind)) return 'recovery-branch';
  if (/reorder|duplicate|drop/iu.test(effectKind)) return 'ordering-or-cardinality-change';
  if (/clock|delay/iu.test(effectKind)) return 'time-model-change';
  if (/corrupt|truncate|replace|mutate/iu.test(effectKind)) return 'data-shape-or-integrity-change';
  return 'state-perturbation';
}

function summarizeOperationValue(value) {
  if (Buffer.isBuffer(value)) return { type: 'buffer', size: value.length, sha256: sha256(value) };
  if (typeof value === 'string') return { type: 'string', size: value.length, sha256: sha256(value) };
  return sanitizeEvidence(value);
}

function sanitizeEvidence(value, depth = 0) {
  if (depth > 8) return '[MAX_DEPTH]';
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeEvidence(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 200).map(([key, child]) => [
      key,
      SECRET_KEY.test(key) ? '[REDACTED]' : sanitizeEvidence(child, depth + 1)
    ]));
  }
  if (typeof value === 'string' && value.length > 1000) return `${value.slice(0, 500)}…[${sha256(value)}]`;
  return value;
}

function containsSecret(value) {
  const serialized = JSON.stringify(value ?? {});
  return /(?:bearer\s+[a-z0-9._~+/=-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:password|secret|api.?key|authorization|cookie)\s*[=:]\s*(?!\[REDACTED\])["']?[a-z0-9._~+/=-]{8,})/iu.test(serialized);
}

function normalizeEdges(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => Array.isArray(entry)
    ? [String(entry[0]), String(entry[1])]
    : [String(entry?.from ?? entry?.source ?? ''), String(entry?.to ?? entry?.target ?? '')])
    .filter(([from, to]) => from && to);
}

function topologicalOrder(edges, extraNodes = []) {
  const nodes = new Set(extraNodes.map(String));
  const outgoing = new Map();
  const indegree = new Map();
  for (const [from, to] of edges) {
    nodes.add(from); nodes.add(to);
    if (!outgoing.has(from)) outgoing.set(from, new Set());
    if (!outgoing.get(from).has(to)) {
      outgoing.get(from).add(to);
      indegree.set(to, (indegree.get(to) ?? 0) + 1);
      indegree.set(from, indegree.get(from) ?? 0);
    }
  }
  for (const node of nodes) indegree.set(node, indegree.get(node) ?? 0);
  const ready = [...nodes].filter((node) => indegree.get(node) === 0).sort();
  const order = [];
  while (ready.length) {
    const node = ready.shift();
    order.push(node);
    for (const child of [...(outgoing.get(node) ?? [])].sort()) {
      indegree.set(child, indegree.get(child) - 1);
      if (indegree.get(child) === 0) ready.push(child);
    }
    ready.sort();
  }
  return { order, cycleDetected: order.length !== nodes.size, nodeCount: nodes.size };
}

function collectScalarValues(value, output = [], depth = 0) {
  if (depth > 10) return output;
  if (Array.isArray(value)) {
    for (const item of value) collectScalarValues(item, output, depth + 1);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectScalarValues(item, output, depth + 1);
  } else if (value !== undefined && value !== null) output.push(value);
  return output;
}

function collectObjectValues(value, output = [], depth = 0) {
  if (depth > 10) return output;
  if (Array.isArray(value)) {
    for (const item of value) collectObjectValues(item, output, depth + 1);
  } else if (value && typeof value === 'object') {
    output.push(value);
    for (const item of Object.values(value)) collectObjectValues(item, output, depth + 1);
  }
  return output;
}

function arrayOfObjects(value) {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object' && !Array.isArray(item)) : [];
}

function asStrings(value) {
  if (!Array.isArray(value)) return value === undefined || value === null ? [] : [String(value)];
  return value.map(String).filter(Boolean);
}

function normalizeUrl(value) {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.href;
  } catch {
    return String(value);
  }
}

async function inventorySelectedInputs(workspace, paths) {
  const entries = [];
  for (const relativePath of paths.map(normalizeRelativePath).sort()) {
    const target = safePath(workspace, relativePath);
    try {
      const details = await stat(target);
      if (details.isFile()) {
        const bytes = await readFile(target);
        entries.push({ path: relativePath, size: details.size, sha256: sha256(bytes) });
      } else if (details.isDirectory()) {
        const nested = await inventoryTree(target);
        for (const item of nested) entries.push({ ...item, path: normalizeRelativePath(join(relativePath, item.path)) });
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

async function findPublishedSource(workspace, published, entryName) {
  const normalized = normalizeRelativePath(entryName);
  if (published.has(normalized)) return published.get(normalized);
  const direct = safePath(workspace, normalized);
  if (await pathExists(direct)) return direct;
  const wanted = basename(normalized).toLowerCase();
  const matches = [...published.entries()].filter(([path]) => basename(path).toLowerCase() === wanted);
  return matches.length === 1 ? matches[0][1] : null;
}

function normalizedType(spec) {
  const supplied = String(spec?.type ?? '').toLowerCase();
  if (supplied) return supplied === 'txt' ? 'text' : supplied;
  const ext = extname(String(spec?.path ?? '')).slice(1).toLowerCase();
  return ext === 'txt' || ext === 'md' ? 'text' : ext;
}

function isAbsentSpec(spec) {
  return spec?.mustBeAbsent === true || spec?.absent === true;
}

function safePath(root, candidate) {
  const resolvedRoot = resolve(root);
  const target = resolve(resolvedRoot, String(candidate));
  const rel = relative(resolvedRoot, target);
  if (!isSafeRelative(rel)) throw new Error(`path outside workspace: ${candidate}`);
  return target;
}

function isSafeRelative(value) {
  const normalized = String(value).replaceAll('\\', '/');
  return normalized !== '..' && !normalized.startsWith('../') && !normalized.includes('/../') && !/^[A-Za-z]:\//u.test(normalized) && !normalized.startsWith('/');
}

function normalizeRelativePath(value) {
  return String(value).replaceAll('\\', '/').replace(/^\.\//u, '');
}

function isSubsequence(expected, actual) {
  let cursor = 0;
  for (const value of actual) if (value === expected[cursor]) cursor += 1;
  return cursor === expected.length;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function csvCell(value) {
  const text = String(value);
  const escaped = /^[=+\-@]/u.test(text) ? `'${text}` : text;
  return /[",\r\n]/u.test(escaped) ? `"${escaped.replaceAll('"', '""')}"` : escaped;
}

function escapeXml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

async function atomicWriteJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rm(path, { force: true });
  await import('node:fs/promises').then(({ rename }) => rename(temporary, path));
}

async function pathExists(path) {
  try { await stat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function sortObject(value) {
  return Object.fromEntries(Object.entries(value ?? {}).sort(([left], [right]) => left.localeCompare(right)));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    if (value instanceof Map) return Object.fromEntries([...value.entries()].sort(([left], [right]) => String(left).localeCompare(String(right))).map(([key, child]) => [key, canonicalize(child)]));
    return Object.fromEntries(Object.keys(value).filter((key) => value[key] !== undefined && !key.startsWith('_')).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  return createHash('sha256').update(Buffer.isBuffer(value) ? value : String(value)).digest('hex');
}

function sha256Json(value) {
  return sha256(Buffer.from(stableStringify(value), 'utf8'));
}

function normalizeError(error) {
  return {
    name: String(error?.name ?? 'Error'),
    code: String(error?.code ?? 'APEX_ERROR'),
    message: String(error?.message ?? error).slice(0, 500)
  };
}
