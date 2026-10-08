import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  EXTREME_WORKFLOW_CATEGORIES,
  EXTREME_WORKFLOW_CORPUS_SHA256,
  EXTREME_WORKFLOW_CORPUS_VERSION,
  EXTREME_WORKFLOW_ISOLATION,
  EXTREME_WORKFLOW_SEED,
  EXTREME_WORKFLOW_VIRTUAL_CLOCK,
  createExtremeWorkflowCorpusFingerprint,
  extremeCases,
  extremeCorpus,
  stableStringifyExtremeWorkflow
} from '../scripts/extreme-workflow-50-cases.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');

test('extreme corpus contains E01-E50 in ten balanced categories', () => {
  assert.equal(extremeCases.length, 50);
  assert.deepEqual(extremeCases.map((item) => item.id),
    Array.from({ length: 50 }, (_, index) => `E${String(index + 1).padStart(2, '0')}`));
  assert.equal(new Set(extremeCases.map((item) => item.id)).size, 50);

  const categoryCounts = Object.fromEntries(EXTREME_WORKFLOW_CATEGORIES.map((category) => [
    category,
    extremeCases.filter((item) => item.category === category).length
  ]));
  assert.equal(EXTREME_WORKFLOW_CATEGORIES.length, 10);
  assert.deepEqual(new Set(extremeCases.map((item) => item.category)), new Set(EXTREME_WORKFLOW_CATEGORIES));
  assert.deepEqual(Object.values(categoryCounts), Array(10).fill(5));
});

test('every case carries a Korean workflow and complete deterministic resilience metadata', () => {
  for (const item of extremeCases) {
    assert.match(item.command, /[가-힣]/u, `${item.id} command must contain Korean text`);
    if (item.expected.terminalState === 'BLOCKED') {
      assert.match(item.command, /중단/u, `${item.id} blocked command must state its safe-stop behavior`);
    } else {
      assert.match(item.command, /다시/u, `${item.id} command must include rediscovery or reread verification`);
    }
    assert.equal(item.adapters.mode, 'in-memory-fixture');
    assert.match(item.adapters.fixtureSha256, /^[a-f0-9]{64}$/u);
    assert.equal(
      item.adapters.fixtureSha256,
      digest(Buffer.from(stableStringifyExtremeWorkflow(item.adapters.script), 'utf8')),
      `${item.id} fixture digest must bind the complete adapter script`
    );
    assert.equal(item.scheduler.mode, 'scripted');
    assert.equal(item.scheduler.seed, EXTREME_WORKFLOW_SEED);
    assert.ok(Array.isArray(item.scheduler.barriers));
    assert.ok(Array.isArray(item.faultPlan) && item.faultPlan.length > 0);
    assert.ok(item.faultPlan.every((entry) => (
      entry.faultId.startsWith(`${item.id}-F`)
      && entry.once === true
      && entry.target
      && entry.phase
      && entry.when
      && entry.effect?.kind
    )));
    assert.ok(Number.isInteger(item.budgets.maxAttempts) && item.budgets.maxAttempts > 0);
    assert.ok(Number.isInteger(item.budgets.maxActions) && item.budgets.maxActions > 0);
    assert.ok(Number.isInteger(item.budgets.maxVirtualElapsedMs) && item.budgets.maxVirtualElapsedMs > 0);
    assert.ok(Number.isInteger(item.budgets.maxWallElapsedMs) && item.budgets.maxWallElapsedMs > 0);
    assert.ok(Array.isArray(item.expected.files));
    assert.ok(Array.isArray(item.expected.invariants) && item.expected.invariants.length >= 7);
    assert.ok(item.expected.invariants.includes('NO_REAL_EXTERNAL_EFFECT'));
    assert.ok(item.expected.invariants.includes('FAULT_PLAN_FULLY_CONSUMED'));
    assert.ok(['SUCCESS', 'EXPECTED_STOP'].includes(item.expected.outcome));
    assert.ok(['COMPLETED', 'BLOCKED', 'ROLLED_BACK'].includes(item.expected.terminalState));
    assert.ok(Array.isArray(item.expected.orderedEvents) && item.expected.orderedEvents.length > 0);
    assert.equal(typeof item.expected.exactCallCounts, 'object');
  }
});

test('outcome and terminal-state distribution encodes recovery, rollback, and safe stops', () => {
  const outcomeCounts = Object.groupBy
    ? Object.fromEntries(Object.entries(Object.groupBy(extremeCases, (item) => item.expected.outcome)).map(([key, values]) => [key, values.length]))
    : extremeCases.reduce((counts, item) => ({ ...counts, [item.expected.outcome]: (counts[item.expected.outcome] ?? 0) + 1 }), {});
  const terminalCounts = extremeCases.reduce((counts, item) => {
    counts[item.expected.terminalState] = (counts[item.expected.terminalState] ?? 0) + 1;
    return counts;
  }, {});

  assert.deepEqual(outcomeCounts, { SUCCESS: 38, EXPECTED_STOP: 12 });
  assert.deepEqual(terminalCounts, { COMPLETED: 34, BLOCKED: 12, ROLLED_BACK: 4 });
  assert.deepEqual(
    extremeCases.filter((item) => item.expected.terminalState === 'ROLLED_BACK').map((item) => item.id),
    ['E31', 'E32', 'E34', 'E48']
  );
  for (const item of extremeCases.filter((entry) => entry.expected.terminalState === 'ROLLED_BACK')) {
    assert.equal(item.expected.outcome, 'SUCCESS');
    assert.ok(item.expected.files.length > 0);
    assert.ok(item.expected.files.every((file) => file.absent === true && file.mustBeAbsent === true));
  }
});

test('canonical corpus SHA is deterministic and binds global controls, faults, and expected results', () => {
  const first = createExtremeWorkflowCorpusFingerprint();
  const cloned = createExtremeWorkflowCorpusFingerprint(structuredClone(extremeCases), {
    seed: EXTREME_WORKFLOW_SEED,
    virtualClock: structuredClone(EXTREME_WORKFLOW_VIRTUAL_CLOCK),
    isolation: structuredClone(EXTREME_WORKFLOW_ISOLATION)
  });

  assert.equal(first.canonicalJson, cloned.canonicalJson);
  assert.equal(first.corpusSha256, cloned.corpusSha256);
  assert.equal(first.corpusSha256, EXTREME_WORKFLOW_CORPUS_SHA256);
  assert.equal(first.corpusSha256, '90dad1d23741d63535f74d33aabebe7edd61fda214fd15aa1796607dbf607edd');
  assert.equal(extremeCorpus.corpusSha256, EXTREME_WORKFLOW_CORPUS_SHA256);
  assert.equal(extremeCorpus.schemaVersion, EXTREME_WORKFLOW_CORPUS_VERSION);
  assert.equal(extremeCorpus.totalCaseCount, 50);

  const reorderedClock = { timezone: EXTREME_WORKFLOW_VIRTUAL_CLOCK.timezone, start: EXTREME_WORKFLOW_VIRTUAL_CLOCK.start };
  assert.equal(
    createExtremeWorkflowCorpusFingerprint(extremeCases, { virtualClock: reorderedClock }).corpusSha256,
    first.corpusSha256,
    'object key insertion order must not affect the canonical hash'
  );

  assert.notEqual(createExtremeWorkflowCorpusFingerprint(extremeCases, { seed: EXTREME_WORKFLOW_SEED + 1 }).corpusSha256, first.corpusSha256);
  assert.notEqual(createExtremeWorkflowCorpusFingerprint(extremeCases, {
    virtualClock: { ...EXTREME_WORKFLOW_VIRTUAL_CLOCK, timezone: 'UTC' }
  }).corpusSha256, first.corpusSha256);
  assert.notEqual(createExtremeWorkflowCorpusFingerprint(extremeCases, {
    isolation: { ...EXTREME_WORKFLOW_ISOLATION, network: 'allow-all' }
  }).corpusSha256, first.corpusSha256);

  const faultChanged = structuredClone(extremeCases);
  faultChanged[0].faultPlan[0].effect.fixtureRef = 'tampered-fixture';
  assert.notEqual(createExtremeWorkflowCorpusFingerprint(faultChanged).corpusSha256, first.corpusSha256);

  const expectedChanged = structuredClone(extremeCases);
  expectedChanged[0].expected.invariants.push('TAMPERED_EXPECTATION');
  assert.notEqual(createExtremeWorkflowCorpusFingerprint(expectedChanged).corpusSha256, first.corpusSha256);
});

test('the top-level isolation contract forbids real outbound effects', () => {
  assert.deepEqual(EXTREME_WORKFLOW_ISOLATION, {
    network: 'deny-except-loopback',
    externalSideEffects: 'forbid',
    providerMode: 'in-memory',
    realCredentialAccess: false,
    realEmailDelivery: false,
    realCalendarMutation: false,
    realUploadMutation: false
  });
  assert.equal(extremeCases.some((item) => item.allowExternalSend === true), false);
});
