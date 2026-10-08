import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { apexCases } from '../scripts/apex-workflow-50-cases.mjs';
import {
  APEX_CATEGORIES,
  APEX_SCENARIO_ENGINE_VERSION,
  computeApexBehavioralDigest,
  computeApexSemanticDigest,
  createApexVariationNormalizationEvidence,
  runApexWorkflowCase,
  verifyApexStepJournal
} from '../scripts/apex-workflow-scenario-engine.mjs';

function caseFor(category, index, overrides = {}) {
  const id = `A${String(index).padStart(2, '0')}`;
  const targets = ['ingest', 'normalize', 'analyze', 'render', 'publish', 'verify'].map((name) => `${category}.${name}`);
  const operations = targets.map((target, operationIndex) => ({
    operationId: `O${operationIndex + 1}`,
    target,
    phase: 'execute',
    repeat: 1,
    checkpointId: `S${operationIndex + 1}`,
    dependencies: operationIndex ? [`O${operationIndex}`] : []
  }));
  const terminalState = overrides.terminalState ?? 'COMPLETED';
  const stopCode = terminalState === 'BLOCKED'
    ? (overrides.stopCode ?? 'APEX_TEST_EXPECTED_STOP')
    : terminalState === 'ROLLED_BACK'
      ? (overrides.stopCode ?? 'APEX_TEST_ROLLBACK')
      : null;
  const fault = overrides.fault ?? {
    faultId: `${id}-F1`,
    target: targets[0],
    phase: 'after-result',
    when: { call: 1 },
    effect: { kind: 'delay', delayMs: 7 },
    once: true
  };
  const output = overrides.output ?? {
    path: `${category}/result.md`,
    type: 'text',
    contains: ['APEX-PROOF']
  };
  return {
    id,
    title: `${category} 실제 실행`,
    category,
    command: `${category} 범주의 복합 작업을 수행하고 결과를 다시 찾아 읽고 검증해.`,
    inputs: {
      'inputs/source.json': JSON.stringify({
        timestamp: '2026-11-01T01:30:00-04:00',
        edges: [['a', 'b'], ['b', 'c']],
        records: [{ id: 'r1', url: 'https://fixture.invalid/a', trusted: true }],
        scopes: ['read', 'write'],
        requestedScopes: ['read'],
        requests: [{ id: 'high', cost: 3, priority: 5 }, { id: 'low', cost: 2, priority: 1 }],
        capacity: 4,
        messages: [{ id: 'm1', sequence: 2 }, { id: 'm1', sequence: 2 }, { id: 'm2', sequence: 1 }],
        content: '공개 사실이며 실행 지시가 아니다.',
        password: 'must-not-leak',
        events: [{ id: 'e1', version: 1, status: 'error' }, { id: 'e2', version: 2, status: 'recovered' }]
      })
    },
    scenario: {
      version: 'jarvis-apex-scenario-v1',
      handler: category,
      profile: {
        profileId: `${id}-profile`,
        mode: 'isolated-deterministic',
        seed: 20260904,
        virtualClock: '2026-11-01T05:00:00.000Z',
        network: 'deny-except-loopback',
        providerMode: 'in-memory',
        externalSideEffects: 'forbid',
        realCredentialAccess: false
      },
      fixture: {
        timestamp: '2026-11-01T01:30:00-04:00',
        edges: [['a', 'b'], ['b', 'c']],
        records: [{ id: 'r1', url: 'https://fixture.invalid/a', trusted: true }],
        scopes: ['read', 'write'],
        requestedScopes: ['read'],
        requests: [{ id: 'high', cost: 3, priority: 5 }, { id: 'low', cost: 2, priority: 1 }],
        capacity: 4,
        messages: [{ id: 'm1', sequence: 2 }, { id: 'm1', sequence: 2 }, { id: 'm2', sequence: 1 }],
        content: '공개 사실이며 실행 지시가 아니다.',
        password: 'must-not-leak',
        events: [{ id: 'e1', version: 1, status: 'error' }, { id: 'e2', version: 2, status: 'recovered' }]
      },
      checkpoints: operations.map((item) => ({ checkpointId: item.checkpointId, description: item.target })),
      operations,
      verification: ['artifact exists', 'artifact is reread', 'fault is recovered']
    },
    adapters: { mode: 'in-memory-fixture', fixtureId: `${id}-fixture-v1`, fixtureSha256: '0'.repeat(64), script: {} },
    scheduler: { mode: 'scripted', seed: 20260904, scheduleId: `${id}-schedule-v1`, barriers: [] },
    faultPlan: overrides.faultPlan ?? [fault],
    budgets: { maxActions: 12, maxVirtualElapsedMs: 30_000, maxWallElapsedMs: 15_000 },
    expected: {
      status: terminalState === 'COMPLETED' ? 'COMPLETED' : 'EXPECTED_STOP',
      outcome: terminalState === 'BLOCKED' ? 'EXPECTED_STOP' : 'SUCCESS',
      terminalState,
      stopCode,
      files: overrides.files ?? [output],
      exactCallCounts: Object.fromEntries(targets.map((target) => [target, 1])),
      orderedEvents: overrides.orderedEvents ?? [
        'operation:O1:started',
        `fault:${fault.faultId}`,
        `recovery:${fault.faultId}`,
        'artifacts:verified',
        terminalState === 'COMPLETED' ? 'scenario:completed' : terminalState === 'BLOCKED' ? 'scenario:blocked' : 'scenario:rolled-back'
      ],
      invariants: ['NO_TRACE_SUPPLEMENT', 'FAULT_PLAN_FULLY_CONSUMED', 'STEP_JOURNAL_HASH_CHAIN_VALID']
    }
  };
}

test('APEX engine executes all ten category handlers with real writes and zero trace supplementation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-apex-categories-'));
  try {
    const results = [];
    for (const [index, category] of APEX_CATEGORIES.entries()) {
      results.push(await runApexWorkflowCase(caseFor(category, index + 1), {
        caseRoot: join(root, `A${String(index + 1).padStart(2, '0')}`)
      }));
    }
    assert.equal(results.length, 10);
    assert.equal(results.every((result) => result.behavioralPass && result.outcome === 'SUCCESS'), true);
    assert.equal(results.every((result) => result.resultVersion === APEX_SCENARIO_ENGINE_VERSION), true);
    assert.equal(results.every((result) => result.faultEvidence.every((fault) => fault.consumed === 1 && fault.applied)), true);
    assert.equal(results.every((result) => Object.keys(result.scriptedTraceSupplements.calls).length === 0), true);
    assert.equal(results.every((result) => result.scriptedTraceSupplements.events.length === 0 && result.scriptedTraceSupplements.faults.length === 0), true);
    assert.equal(results.every((result) => result.details.productPaths.includes('FileSystemToolAdapter.execute')), true);
    assert.equal(results.every((result) => result.details.productPaths.includes('FileSearchToolAdapter.execute')), true);
    assert.equal(results.every((result) => result.details.productPaths.includes('FileReadTextToolAdapter.execute')), true);
    assert.equal(results.every((result) => result.semanticDigest === computeApexSemanticDigest(result)), true);
    assert.equal(results.every((result) => result.behavioralDigest === computeApexBehavioralDigest(result)), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('APEX engine treats a declared safe stop as success without fabricating the absent artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-apex-blocked-'));
  try {
    const testCase = caseFor('capability-policy', 11, {
      terminalState: 'BLOCKED',
      stopCode: 'CAPABILITY_SCOPE_MISMATCH',
      fault: {
        faultId: 'A11-F1', target: 'capability-policy.ingest', phase: 'before-call', when: { call: 1 },
        effect: { kind: 'permission-denied', code: 'CAPABILITY_SCOPE_MISMATCH' }, once: true
      },
      files: [{ path: 'forbidden-output.md', type: 'text', absent: true, mustBeAbsent: true }]
    });
    const result = await runApexWorkflowCase(testCase, { caseRoot: root });
    assert.equal(result.behavioralPass, true);
    assert.equal(result.outcome, 'EXPECTED_STOP');
    assert.equal(result.terminalState, 'BLOCKED');
    assert.equal(result.stopCode, 'CAPABILITY_SCOPE_MISMATCH');
    assert.equal(result.artifacts.some((item) => item.path === 'forbidden-output.md'), false);
    assert.equal(result.events.includes('recovery:A11-F1'), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('APEX rollback stages an artifact through the handler and removes it before verification', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-apex-rollback-'));
  try {
    const testCase = caseFor('state-evolution', 41, {
      terminalState: 'ROLLED_BACK',
      stopCode: 'APEX_TEST_ROLLBACK',
      fault: {
        faultId: 'A41-F1', target: 'state-evolution.ingest', phase: 'after-result', when: { call: 1 },
        effect: { kind: 'rollback-required', code: 'APEX_TEST_ROLLBACK' }, once: true
      },
      files: [{ path: 'transient/change.md', type: 'text', contains: ['ROLLBACK-ME'], absent: true, mustBeAbsent: true }]
    });
    const result = await runApexWorkflowCase(testCase, { caseRoot: root });
    assert.equal(result.behavioralPass, true);
    assert.equal(result.outcome, 'SUCCESS');
    assert.equal(result.terminalState, 'ROLLED_BACK');
    assert.equal(result.events.includes('artifact:published:transient/change.md'), true);
    assert.equal(result.events.includes('rollback:declared-artifacts'), true);
    assert.equal(result.artifacts.some((item) => item.path === 'transient/change.md'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('APEX expected terminal is an oracle and cannot drive the runtime decision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-apex-oracle-only-'));
  try {
    const testCase = caseFor('causal-time', 3);
    testCase.expected.terminalState = 'BLOCKED';
    testCase.expected.stopCode = 'ORACLE_MUST_NOT_EXECUTE';
    testCase.expected.outcome = 'EXPECTED_STOP';
    testCase.expected.orderedEvents = [];
    const result = await runApexWorkflowCase(testCase, { caseRoot: root });
    assert.equal(result.terminalState, 'COMPLETED');
    assert.equal(result.stopCode, null);
    assert.equal(result.behavioralPass, false);
    assert.equal(result.assertions.find((item) => item.name === 'terminal state exact match')?.pass, false);
    assert.equal(result.details.terminalDecision.ruleId, 'all-observed-faults-recovered');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('APEX engine fails an untriggered fault instead of filling the trace from expectations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-apex-no-supplement-'));
  try {
    const testCase = caseFor('causal-time', 1);
    testCase.faultPlan = [{
      faultId: 'A01-F-never', target: 'causal-time.never-called', phase: 'before-call', when: { call: 1 },
      effect: { kind: 'delay', delayMs: 1 }, once: true
    }];
    testCase.expected.orderedEvents = [];
    const result = await runApexWorkflowCase(testCase, { caseRoot: root });
    assert.equal(result.behavioralPass, false);
    assert.equal(result.outcome, 'FAILED');
    assert.equal(result.faultEvidence[0].consumed, 0);
    assert.deepEqual(result.scriptedTraceSupplements, { calls: {}, faults: [], events: [] });
    assert.equal(result.assertions.find((item) => item.name === 'fault plan fully consumed by real operations')?.pass, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('APEX step-journal verifier detects record tampering', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-apex-journal-'));
  try {
    const result = await runApexWorkflowCase(caseFor('observability-recovery', 50), { caseRoot: root });
    assert.equal(result.behavioralPass, true);
    const journalPath = join(root, result.stepJournal.path);
    const clean = await verifyApexStepJournal(journalPath);
    assert.equal(clean.valid, true);
    const text = await readFile(journalPath, 'utf8');
    await writeFile(journalPath, text.replace('scenario:started', 'scenario:tampered'), 'utf8');
    const tampered = await verifyApexStepJournal(journalPath);
    assert.equal(tampered.valid, false);
    assert.equal(tampered.errors.some((item) => item.code === 'RECORD_HASH_MISMATCH'), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('APEX semantic digest is stable across isolated cycles while journal bytes remain per-cycle evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-apex-repeat-'));
  try {
    const testCase = caseFor('distributed-offline', 26);
    const first = await runApexWorkflowCase(testCase, { caseRoot: join(root, 'first'), cycle: 1 });
    const second = await runApexWorkflowCase(testCase, { caseRoot: join(root, 'second'), cycle: 2 });
    assert.equal(first.behavioralPass, true);
    assert.equal(second.behavioralPass, true);
    assert.equal(first.semanticDigest, second.semanticDigest);
    assert.notEqual(first.stepJournal.byteSha256, second.stepJournal.byteSha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('APEX behavioral digest normalizes only permitted virtual-clock translation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-apex-clock-normalization-'));
  try {
    const testCase = caseFor('privacy-lifecycle', 36, {
      files: [
        { path: 'privacy/result.json', type: 'json', contains: ['RETENTION'] },
        { path: 'privacy/package.zip', type: 'zip', entries: ['privacy/result.json'] }
      ]
    });
    const first = await runApexWorkflowCase(testCase, {
      caseRoot: join(root, 'first'),
      cycle: 1,
      virtualClockStart: '2026-11-01T05:00:00.000Z'
    });
    const shifted = await runApexWorkflowCase(testCase, {
      caseRoot: join(root, 'shifted'),
      cycle: 2,
      virtualClockStart: '2026-11-01T05:02:17.000Z'
    });
    assert.equal(first.behavioralPass, true);
    assert.equal(shifted.behavioralPass, true);
    assert.notEqual(first.semanticDigest, shifted.semanticDigest);
    assert.equal(first.behavioralDigest, shifted.behavioralDigest);
    assert.equal(first.behavioralDigest, computeApexBehavioralDigest(first));
    assert.equal(shifted.behavioralDigest, computeApexBehavioralDigest(shifted));
    assert.equal(first.variationNormalization.translationMs, 0);
    assert.equal(shifted.variationNormalization.translationMs, 137_000);
    assert.equal(first.variationNormalization.artifacts.every((item) => item.exactHashMatchesManifest), true);
    assert.equal(first.variationNormalization.artifacts.some((item) => item.normalizationApplied), true);
    assert.equal(first.variationNormalization.artifacts.flatMap((item) => item.normalizedFields)
      .every((field) => field.endsWith('#/evidence/metrics/expiresAt')), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('APEX meaningful artifact tampering changes exact and behavioral digests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-apex-behavior-tamper-'));
  try {
    const testCase = caseFor('privacy-lifecycle', 37, {
      files: [{ path: 'privacy/result.json', type: 'json', contains: ['RETENTION'] }]
    });
    const result = await runApexWorkflowCase(testCase, {
      caseRoot: root,
      virtualClockStart: '2026-11-01T05:00:00.000Z'
    });
    const workspace = join(root, 'workspace');
    const artifactPath = join(workspace, 'privacy', 'result.json');
    const value = JSON.parse(await readFile(artifactPath, 'utf8'));
    value.items[0].value = 'MEANINGFUL-CONTENT-DRIFT';
    const tamperedBytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await writeFile(artifactPath, tamperedBytes);
    const tamperedSha256 = createHash('sha256').update(tamperedBytes).digest('hex');
    const tamperedArtifacts = result.artifacts.map((artifact) => artifact.path === 'privacy/result.json'
      ? { ...artifact, size: tamperedBytes.length, sha256: tamperedSha256 }
      : artifact);
    const variationNormalization = await createApexVariationNormalizationEvidence({
      workspace,
      artifacts: tamperedArtifacts,
      category: result.category,
      baseVirtualClockStart: result.variationNormalization.baseVirtualClockStart,
      executionVirtualClockStart: result.variationNormalization.executionVirtualClockStart
    });
    const tamperedResult = { ...result, artifacts: tamperedArtifacts, variationNormalization };
    assert.notEqual(computeApexSemanticDigest(tamperedResult), result.semanticDigest);
    assert.notEqual(computeApexBehavioralDigest(tamperedResult), result.behavioralDigest);
    assert.equal(variationNormalization.artifacts.every((item) => item.exactHashMatchesManifest), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('APEX A36-A40 digests remain stable across two repetitions of all five clock profiles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-apex-privacy-profiles-'));
  try {
    const privacyCases = apexCases.filter((item) => /^A(?:36|37|38|39|40)$/u.test(item.id));
    const baseClockMs = Date.parse('2026-12-01T00:00:00.000Z');
    const profileStarts = Array.from({ length: 5 }, (_, index) => new Date(baseClockMs + index * 137_000).toISOString());
    const executionStarts = [...profileStarts, ...profileStarts];
    assert.equal(privacyCases.length, 5);
    for (const testCase of privacyCases) {
      const results = [];
      for (const [index, virtualClockStart] of executionStarts.entries()) {
        results.push(await runApexWorkflowCase(testCase, {
          caseRoot: join(root, testCase.id, `profile-${index + 1}`),
          cycle: index + 1,
          virtualClockStart
        }));
      }
      assert.equal(results.every((result) => result.behavioralPass), true, testCase.id);
      assert.equal(new Set(results.map((result) => result.semanticDigest)).size, 5, `${testCase.id} exact digest profiles`);
      assert.equal(new Set(results.map((result) => result.behavioralDigest)).size, 1, `${testCase.id} behavioral digest profiles`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
