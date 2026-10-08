import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  APEX_WORKFLOW_CATEGORIES,
  APEX_WORKFLOW_CORPUS_SHA256,
  APEX_WORKFLOW_CORPUS_VERSION,
  APEX_WORKFLOW_ISOLATION,
  APEX_WORKFLOW_SCENARIO_VERSION,
  APEX_WORKFLOW_SEED,
  APEX_WORKFLOW_VIRTUAL_CLOCK,
  apexCases,
  apexCorpus,
  createApexWorkflowCorpusFingerprint,
  stableStringifyApexWorkflow
} from '../scripts/apex-workflow-50-cases.mjs';
import { EXTREME_WORKFLOW_CATEGORIES, extremeCases } from '../scripts/extreme-workflow-50-cases.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');

test('apex corpus contains A01-A50 in ten balanced new categories', () => {
  assert.equal(apexCases.length, 50);
  assert.deepEqual(
    apexCases.map((item) => item.id),
    Array.from({ length: 50 }, (_, index) => `A${String(index + 1).padStart(2, '0')}`)
  );
  assert.equal(new Set(apexCases.map((item) => item.id)).size, 50);
  assert.equal(new Set(apexCases.map((item) => item.title)).size, 50);
  assert.equal(APEX_WORKFLOW_CATEGORIES.length, 10);

  const counts = Object.fromEntries(APEX_WORKFLOW_CATEGORIES.map((category) => [
    category,
    apexCases.filter((item) => item.category === category).length
  ]));
  assert.deepEqual(Object.values(counts), Array(10).fill(5));
  assert.deepEqual(new Set(apexCases.map((item) => item.category)), new Set(APEX_WORKFLOW_CATEGORIES));
});

test('apex identities, titles, and categories do not duplicate the extreme corpus', () => {
  const extremeIds = new Set(extremeCases.map((item) => item.id));
  const extremeTitles = new Set(extremeCases.map((item) => item.title));
  const extremeCategories = new Set(EXTREME_WORKFLOW_CATEGORIES);
  assert.equal(apexCases.some((item) => extremeIds.has(item.id)), false);
  assert.equal(apexCases.some((item) => extremeTitles.has(item.title)), false);
  assert.equal(APEX_WORKFLOW_CATEGORIES.some((category) => extremeCategories.has(category)), false);
});

test('every apex mission has seven Korean steps, explicit operations, and two real fault contracts', () => {
  for (const item of apexCases) {
    assert.match(item.command, /[가-힣]/u, `${item.id} must contain Korean instructions`);
    assert.ok(item.scenario.checkpoints.length >= 6, `${item.id} needs at least six checkpoints`);
    assert.equal(item.scenario.operations.length, item.scenario.checkpoints.length);
    assert.ok(item.scenario.operations.length >= 6);
    assert.ok(item.faultPlan.length >= 2, `${item.id} needs at least two faults`);

    const operationTargets = new Set(item.scenario.operations.map((operation) => operation.target));
    assert.equal(new Set(item.scenario.operations.map((operation) => operation.operationId)).size, item.scenario.operations.length);
    item.scenario.operations.forEach((operation, index) => {
      assert.equal(operation.operationId, `O${index + 1}`);
      assert.equal(operation.checkpointId, `S${index + 1}`);
      assert.equal(operation.phase, 'execute');
      assert.equal(operation.repeat, 1);
    });
    item.faultPlan.forEach((fault, index) => {
      assert.equal(fault.faultId, `${item.id}-F${index + 1}`);
      assert.equal(fault.once, true);
      assert.ok(operationTargets.has(fault.target), `${item.id} fault target ${fault.target} must be scheduled`);
      assert.ok(fault.effect?.kind);
      assert.deepEqual(fault.when, { call: 1 });
    });

    assert.ok(item.expected.orderedEvents.includes('operation:O1:started'));
    assert.ok(item.expected.orderedEvents.includes('artifacts:verified'));
    for (const fault of item.faultPlan) {
      assert.ok(item.expected.orderedEvents.includes(`fault:${fault.faultId}`));
      assert.ok(item.expected.orderedEvents.includes(`recovery:${fault.faultId}`));
    }
  }
});

test('every mission fixes deterministic fixture, scheduler, resource, and verification profiles', () => {
  for (const item of apexCases) {
    assert.equal(item.adapters.mode, 'in-memory-fixture');
    assert.match(item.adapters.fixtureSha256, /^[a-f0-9]{64}$/u);
    assert.equal(
      item.adapters.fixtureSha256,
      digest(Buffer.from(stableStringifyApexWorkflow(item.adapters.script), 'utf8')),
      `${item.id} fixture digest must bind the complete fixture`
    );
    assert.equal(item.scenario.version, APEX_WORKFLOW_SCENARIO_VERSION);
    assert.equal(item.scenario.handler, item.category);
    assert.equal(item.scenario.profile.mode, 'isolated-deterministic');
    assert.equal(item.scenario.profile.seed, APEX_WORKFLOW_SEED);
    assert.deepEqual(item.scenario.profile.virtualClock, APEX_WORKFLOW_VIRTUAL_CLOCK);
    assert.equal(item.scenario.profile.network, 'deny-except-loopback');
    assert.equal(item.scenario.profile.externalSideEffects, 'forbid');
    assert.equal(item.scenario.profile.providerMode, 'in-memory');
    assert.equal(item.scheduler.mode, 'scripted');
    assert.equal(item.scheduler.seed, APEX_WORKFLOW_SEED);
    assert.ok(Number.isFinite(item.scenario.fixture.records));
    assert.equal(typeof item.scenario.fixture.values, 'object');
    assert.ok(Array.isArray(item.scenario.verification) && item.scenario.verification.length >= 3);
    assert.ok(item.budgets.maxActions >= item.scenario.operations.length);
    assert.ok(item.budgets.maxWallElapsedMs > 0);
    assert.ok(item.budgets.maxResidentSetBytes > 0);
  }
});

test('terminal distribution distinguishes recovery, safe stops, and rollback', () => {
  const terminals = apexCases.reduce((counts, item) => {
    counts[item.expected.terminalState] = (counts[item.expected.terminalState] ?? 0) + 1;
    return counts;
  }, {});
  assert.deepEqual(terminals, { COMPLETED: 32, BLOCKED: 13, ROLLED_BACK: 5 });
  assert.deepEqual(
    apexCases.filter((item) => item.expected.terminalState === 'ROLLED_BACK').map((item) => item.id),
    ['A10', 'A19', 'A25', 'A39', 'A49']
  );

  for (const item of apexCases) {
    assert.ok(['COMPLETED', 'BLOCKED', 'ROLLED_BACK'].includes(item.expected.terminalState));
    assert.ok(['SUCCESS', 'EXPECTED_STOP'].includes(item.expected.outcome));
    assert.ok(Array.isArray(item.expected.files) && item.expected.files.length > 0);
    assert.ok(Array.isArray(item.expected.diagnosticFiles));
    assert.equal(typeof item.expected.exactCallCounts, 'object');
    if (item.expected.terminalState === 'COMPLETED') {
      assert.equal(item.expected.stopCode, null);
      assert.equal(item.expected.status, 'COMPLETED');
      assert.equal(item.expected.outcome, 'SUCCESS');
      assert.equal(item.expected.files.some((file) => file.mustBeAbsent), false);
      assert.equal(item.expected.orderedEvents.at(-1), 'scenario:completed');
    } else {
      assert.match(item.expected.stopCode, /^[A-Z][A-Z0-9_]+$/u);
      assert.equal(item.expected.status, 'EXPECTED_STOP');
      assert.ok(item.expected.files.every((file) => file.absent === true && file.mustBeAbsent === true));
      assert.ok(item.expected.diagnosticFiles.length > 0);
      assert.equal(item.expected.orderedEvents.at(-1), item.expected.terminalState === 'BLOCKED' ? 'scenario:blocked' : 'scenario:rolled-back');
    }
  }
});

test('mission invariants and call-count oracles are complete without driving execution', () => {
  for (const item of apexCases) {
    assert.ok(item.expected.invariants.length >= 12);
    assert.ok(item.expected.invariants.includes('NO_REAL_EXTERNAL_EFFECT'));
    assert.ok(item.expected.invariants.includes('FAULT_PLAN_FULLY_CONSUMED'));
    assert.ok(item.expected.invariants.includes('DETERMINISTIC_REPLAY'));
    const expectedCounts = item.scenario.operations.reduce((counts, operation) => {
      counts[operation.target] = (counts[operation.target] ?? 0) + operation.repeat;
      return counts;
    }, {});
    assert.deepEqual(item.expected.exactCallCounts, expectedCounts);
  }
  assert.equal(apexCases.find((item) => item.id === 'A50').faultPlan.length, 8);
});

test('canonical corpus SHA binds controls, operations, faults, fixture, and expectations', () => {
  const first = createApexWorkflowCorpusFingerprint();
  const cloned = createApexWorkflowCorpusFingerprint(structuredClone(apexCases), {
    seed: APEX_WORKFLOW_SEED,
    virtualClock: structuredClone(APEX_WORKFLOW_VIRTUAL_CLOCK),
    isolation: structuredClone(APEX_WORKFLOW_ISOLATION)
  });
  assert.equal(first.canonicalJson, cloned.canonicalJson);
  assert.equal(first.corpusSha256, cloned.corpusSha256);
  assert.equal(first.corpusSha256, APEX_WORKFLOW_CORPUS_SHA256);
  assert.equal(first.corpusSha256, '32258626d178e7a67cf8a5c4019915f3a4500399e7a7d589ed7bd19f658626e0');
  assert.equal(apexCorpus.corpusSha256, APEX_WORKFLOW_CORPUS_SHA256);
  assert.equal(apexCorpus.schemaVersion, APEX_WORKFLOW_CORPUS_VERSION);
  assert.equal(apexCorpus.totalCaseCount, 50);

  const operationChanged = structuredClone(apexCases);
  operationChanged[0].scenario.operations[0].target = 'tampered.operation';
  assert.notEqual(createApexWorkflowCorpusFingerprint(operationChanged).corpusSha256, first.corpusSha256);
  const faultChanged = structuredClone(apexCases);
  faultChanged[0].faultPlan[0].effect.kind = 'tampered-fault';
  assert.notEqual(createApexWorkflowCorpusFingerprint(faultChanged).corpusSha256, first.corpusSha256);
  const expectedChanged = structuredClone(apexCases);
  expectedChanged[0].expected.invariants.push('TAMPERED_INVARIANT');
  assert.notEqual(createApexWorkflowCorpusFingerprint(expectedChanged).corpusSha256, first.corpusSha256);
});

test('top-level and per-case isolation forbid every real outbound effect', () => {
  assert.deepEqual(APEX_WORKFLOW_ISOLATION, {
    network: 'deny-except-loopback',
    externalSideEffects: 'forbid',
    providerMode: 'in-memory',
    realCredentialAccess: false,
    realEmailDelivery: false,
    realCalendarMutation: false,
    realUploadMutation: false,
    realPaymentMutation: false,
    realMessageDelivery: false
  });
  for (const item of apexCases) {
    assert.equal(item.scenario.profile.externalSideEffects, 'forbid');
    assert.equal(item.scenario.profile.realCredentialAccess, false);
    assert.equal(item.scenario.profile.realEmailDelivery, false);
    assert.equal(item.scenario.profile.realCalendarMutation, false);
    assert.equal(item.scenario.profile.realUploadMutation, false);
    assert.equal(item.scenario.profile.realPaymentMutation, false);
    assert.equal(item.scenario.profile.realMessageDelivery, false);
  }
});
