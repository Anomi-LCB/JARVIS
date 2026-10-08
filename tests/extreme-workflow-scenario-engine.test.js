import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extremeCases } from '../scripts/extreme-workflow-50-cases.mjs';
import { runExtremeWorkflowCase } from '../scripts/extreme-workflow-scenario-engine.mjs';

const byId = (id) => extremeCases.find((item) => item.id === id);

test('extreme engine executes completed, blocked, and rolled-back terminal contracts exactly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-extreme-terminals-'));
  try {
    const completed = await runExtremeWorkflowCase(byId('E01'), { caseRoot: join(root, 'E01') });
    const blocked = await runExtremeWorkflowCase(byId('E05'), { caseRoot: join(root, 'E05') });
    const rolledBack = await runExtremeWorkflowCase(byId('E31'), { caseRoot: join(root, 'E31') });
    assert.equal(completed.outcome, 'SUCCESS');
    assert.equal(completed.terminalState, 'COMPLETED');
    assert.equal(blocked.outcome, 'EXPECTED_STOP');
    assert.equal(blocked.terminalState, 'BLOCKED');
    assert.equal(blocked.stopCode, 'REQUIRED_FIELD_MISSING');
    assert.equal(rolledBack.outcome, 'SUCCESS');
    assert.equal(rolledBack.terminalState, 'ROLLED_BACK');
    assert.equal([completed, blocked, rolledBack].every((item) => item.behavioralPass), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('extreme engine creates and independently verifies the eight-format package', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-extreme-formats-'));
  try {
    const result = await runExtremeWorkflowCase(byId('E46'), { caseRoot: join(root, 'E46') });
    assert.equal(result.behavioralPass, true);
    assert.equal(result.outcome, 'SUCCESS');
    assert.equal(result.artifacts.some((item) => item.path === 'multiformat-package.zip'), true);
    assert.equal(result.assertions.filter((item) => item.name.startsWith('valid ') && !item.pass).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('extreme engine semantic digest repeats across isolated roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-extreme-repeat-'));
  try {
    const first = await runExtremeWorkflowCase(byId('E13'), { caseRoot: join(root, 'first'), cycle: 1 });
    const second = await runExtremeWorkflowCase(byId('E13'), { caseRoot: join(root, 'second'), cycle: 2 });
    assert.equal(first.behavioralPass, true);
    assert.equal(second.behavioralPass, true);
    assert.equal(first.semanticDigest, second.semanticDigest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('extreme engine streams one million rows within the declared memory and wall budgets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-extreme-million-'));
  try {
    const result = await runExtremeWorkflowCase(byId('E43'), { caseRoot: join(root, 'E43') });
    assert.equal(result.behavioralPass, true);
    assert.equal(result.details.streaming.rows, 1_000_000);
    assert.equal(result.details.streaming.total, 4_995_000_000);
    assert.equal(result.details.streaming.groups, 96);
    assert.ok(result.details.streaming.peakRssDelta < byId('E43').budgets.maxResidentSetBytes);
    assert.ok(result.wallElapsedMs < byId('E43').budgets.maxWallElapsedMs);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
