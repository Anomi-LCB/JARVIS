import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRecoveryScenario, candidateIdentity } from '../scripts/lib/recovery-comparison-adapter.mjs';

test('buffer arms read the complete input twice with bounded buffers and real G', async () => {
  const reference = await evaluateRecoveryScenario({ scenario: 'hash-input-evidence', arm: 'reference-64k' });
  const candidate = await evaluateRecoveryScenario({ scenario: 'hash-input-evidence', arm: 'buffered-read' });
  for (const result of [reference, candidate]) {
    assert.equal(result.status, 'recovered');
    assert.equal(result.ioMetrics.bytesRead, 4 * 1024 * 1024);
    assert.equal(result.duplicateExecutionCount, 0);
    assert.equal(result.evidence.verificationCalls, 1);
    assert.equal(result.evidence.verification.stub, false);
    assert.ok(result.recoveryElapsedMs >= 0);
    assert.ok(result.ioMetrics.maxRequestedBytes <= result.ioMetrics.configuredChunkBytes);
  }
  assert.equal(reference.ioMetrics.configuredChunkBytes, 64 * 1024);
  assert.equal(candidate.ioMetrics.configuredChunkBytes, 1024 * 1024);
  assert.ok(candidate.ioMetrics.readCalls < reference.ioMetrics.readCalls);
});

test('during-read fixture changes the original tail and grows the file before the next read', async () => {
  for (const arm of ['reference-64k', 'buffered-read']) {
    const result = await evaluateRecoveryScenario({ scenario: 'hash-mutation-during-read', arm });
    assert.equal(result.status, 'blocked');
    assert.equal(result.errorCode, 'A_MISSION_RECOVERY_ARTIFACT_CHANGED');
    assert.deepEqual(result.evidence.duringReadMutation, {
      applied: true, originalTailBytesWritten: 1, appendedBytes: 1
    });
    assert.equal(result.evidence.verificationCalls, 0);
    assert.equal(result.duplicateExecutionCount, 0);
  }
});

test('empty files and over-budget files remain distinct under buffered recovery', async () => {
  const empty = await evaluateRecoveryScenario({ scenario: 'hash-empty', arm: 'buffered-read' });
  const oversized = await evaluateRecoveryScenario({ scenario: 'hash-over-budget', arm: 'buffered-read' });
  assert.equal(empty.status, 'recovered');
  assert.equal(empty.ioMetrics.bytesRead, 0);
  assert.equal(empty.ioMetrics.readCalls, 1);
  assert.equal(oversized.status, 'blocked');
  assert.equal(oversized.ioMetrics.bytesRead, 0);
  assert.equal(oversized.ioMetrics.readCalls, 0);
  assert.equal(oversized.evidence.verificationCalls, 0);
});

test('adapter calls production recovery and independent G for a completed Core fixture', async () => {
  const result = await evaluateRecoveryScenario({ scenario: 'completed-core' });
  assert.equal(result.status, 'recovered');
  assert.equal(result.source, 'core-completed-task');
  assert.equal(result.errorCode, null);
  assert.equal(result.duplicateExecutionCount, 0);
  assert.equal(result.evidence.receiptLookup, 0);
  assert.equal(result.evidence.persistedCheckpointRead, true);
  assert.equal(result.evidence.verification.stub, false);
  assert.ok(result.evidence.verification.checkCount > 5);
  assert.deepEqual(result.evidence.verification.failedCheckIds, []);
  assert.deepEqual(result.metrics, { externalModelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, costBasis: 'local-no-model' });
});

test('receipt branch reads the durable local receipt and the adapter discloses its scope', async () => {
  const result = await evaluateRecoveryScenario({ scenario: 'durable-remote' });
  assert.equal(result.status, 'recovered');
  assert.equal(result.source, 'pc-task-receipt');
  assert.equal(result.evidence.receiptLookup, 1);
  assert.ok(result.limitations.some(item => item.includes('not an actual remote PC service')));
  assert.equal(result.duplicateExecutionCount, 0);
});

test('artifact mutation reaches real hash checks and negative control alters only the reported result', async () => {
  const current = await evaluateRecoveryScenario({ scenario: 'changed-artifact' });
  const negative = await evaluateRecoveryScenario({ scenario: 'changed-artifact', arm: 'negative-control' });
  assert.equal(current.status, 'blocked');
  assert.equal(current.errorCode, 'A_MISSION_RECOVERY_ARTIFACT_CHANGED');
  assert.equal(current.evidence.verification.checkCount, 0);
  assert.equal(negative.status, 'recovered');
  assert.equal(negative.observedProductStatus, 'blocked');
  assert.equal(negative.controlMutationApplied, true);
  assert.equal(negative.productOptimizationCandidate, false);
  assert.equal(negative.duplicateExecutionCount, 0);
  assert.ok(negative.limitations.some(item => item.includes('NEGATIVE CONTROL ONLY')));
});

test('G failure is produced by the actual verifier rather than a preselected failed verdict', async () => {
  const result = await evaluateRecoveryScenario({ scenario: 'verification-failed' });
  assert.equal(result.status, 'blocked');
  assert.equal(result.errorCode, 'A_MISSION_RECOVERY_VERIFICATION_FAILED');
  assert.ok(result.evidence.verification.failedCheckIds.includes('execution_evidence_status_success'));
  assert.equal(result.evidence.verification.stub, false);
});

test('never-dispatched stimulus preserves its distinct state and ignores evaluator expected fields', async () => {
  const scenario = { id: 'never-dispatched' };
  Object.defineProperty(scenario, 'expected', { get() { assert.fail('adapter must not read the expected outcome'); } });
  const result = await evaluateRecoveryScenario({ scenario, arm: 'negative-control' });
  assert.equal(result.status, 'not_dispatched');
  assert.equal(result.controlMutationApplied, false);
  assert.equal(result.duplicateExecutionCount, 0);
  assert.equal(result.evidence.taskLookup, 0);
});

test('candidate identities bind direct runtime sources and distinguish the invalid negative control', async () => {
  const current = await candidateIdentity();
  const again = await candidateIdentity('current');
  const negative = await candidateIdentity('negative-control');
  assert.equal(current.sha256, again.sha256);
  assert.notEqual(current.sha256, negative.sha256);
  assert.deepEqual(current.sourceFiles, negative.sourceFiles);
  assert.ok(current.sourceFiles.some(file => file.path.endsWith('mission-action-recovery.js')));
  assert.ok(current.sourceFiles.every(file => /^[a-f0-9]{64}$/.test(file.sha256)));
  assert.equal(negative.negativeControl, true);
  assert.equal(negative.productOptimizationCandidate, false);
});

test('invalid scenario and candidate names are rejected before fixture creation', async () => {
  await assert.rejects(evaluateRecoveryScenario({ scenario: '../outside' }), { code: 'RECOVERY_COMPARISON_SCENARIO_INVALID' });
  await assert.rejects(evaluateRecoveryScenario({ scenario: 'completed-core', arm: 'pretend-improvement' }), { code: 'RECOVERY_COMPARISON_ARM_INVALID' });
});
